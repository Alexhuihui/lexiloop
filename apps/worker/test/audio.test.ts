import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReleaseRepository,
  StudySessionRepository,
  UserRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { audioAsset } from "@lexiloop/db";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { buildApp, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { SESSION_COOKIE } from "../src/auth/session";

/**
 * Task 12 audio acceptance tests (spec 8.2/10): the private R2 bucket is only
 * reachable behind an authenticated session, for assets that belong to the
 * active (or session-pinned, retained) release; responses carry a
 * content-hash ETag, long immutable caching, and byte-range support.
 */

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const ORIGIN = "https://lexiloop.example";
const PASSWORD = "correct horse battery staple";

const ACTIVE_RELEASE = "rel-active-1";
const READY_RELEASE = "rel-ready-2";
const RETIRED_RELEASE = "rel-retired-3";

const WORD_ASSET_KEY = "audio/ab/abandon-1.wav";
const RETIRED_ASSET_KEY = "audio/rr/retired-abandon.wav";
const READY_ASSET_KEY = "audio/nn/never-activated.wav";
const GONE_ASSET_KEY = "audio/ab/gone-from-r2.wav";

/** Sixteen deterministic "WAV" bytes. */
const AUDIO_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);
const AUDIO_SHA256 = createHash("sha256").update(AUDIO_BYTES).digest("hex");

/** R2 fake with the range semantics the audio route relies on. */
class FakeR2Bucket {
  public operations = 0;
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, value);
  }

  async head(key: string): Promise<{ size: number } | null> {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length } : null;
  }

  async get(
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } },
  ): Promise<{
    body: ReadableStream;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  } | null> {
    this.operations += 1;
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    let start = 0;
    let end = bytes.length - 1;
    const range = options?.range;
    if (range) {
      if (range.suffix !== undefined) {
        start = Math.max(0, bytes.length - range.suffix);
      } else {
        start = Math.min(range.offset ?? 0, bytes.length);
        end = range.length !== undefined ? start + range.length - 1 : bytes.length - 1;
      }
      end = Math.min(end, bytes.length - 1);
    }
    const slice = bytes.subarray(start, end + 1);
    const copy = new Uint8Array(slice);
    return {
      body: new Blob([copy]).stream(),
      size: bytes.length,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    };
  }
}

class FakeRateLimiter implements LoginRateLimiter {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

interface AudioFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  logs: string[];
  deps: WorkerDeps;
  app: ReturnType<typeof buildApp>;
  bucket: FakeR2Bucket;
  clock: { now: number };
  alice: { userId: string };
  aliceCookie: string;
}

async function seedUser(db: LexiloopDatabase, username: string): Promise<{ userId: string }> {
  const hashed = await hashPassword(PASSWORD);
  const userId = `user-${username}`;
  await new UserRepository(db).create({
    userId,
    normalizedUsername: username,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: T0,
  });
  return { userId };
}

async function loginAs(app: AudioFixture["app"], username: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.split(",").find((part) => part.trim().startsWith(SESSION_COOKIE));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0]!;
}

async function createAsset(db: LexiloopDatabase, releaseId: string, assetKey: string): Promise<void> {
  await db.insert(audioAsset).values({
    releaseId,
    assetKey,
    contentSha256: AUDIO_SHA256,
    textHash: "d".repeat(64),
    provider: "mimo",
    modelId: "mimo-audio",
    voice: "lexi",
    synthesisConfigVersion: "tts-v1",
    formatContainer: "wav",
    sampleRateHz: 24000,
    channels: 1,
    encoding: "pcm_s16le",
    durationMs: 640,
    validation: "PASSED",
  });
}

async function createFixture(): Promise<AudioFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const logs: string[] = [];
  const clock = { now: T0 };
  const alice = await seedUser(db, "alice");
  const bucket = new FakeR2Bucket();
  await bucket.put(WORD_ASSET_KEY, AUDIO_BYTES);
  await bucket.put(RETIRED_ASSET_KEY, AUDIO_BYTES);

  const releases = new ReleaseRepository(db);
  const base = {
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    createdAt: T0,
    manifestSha256: "b".repeat(64),
  };
  await releases.create({ releaseId: RETIRED_RELEASE, ...base, status: "READY" });
  await releases.create({ releaseId: ACTIVE_RELEASE, ...base, status: "READY" });
  await releases.create({ releaseId: READY_RELEASE, ...base, status: "READY" });
  await releases.setActive(RETIRED_RELEASE, T0);
  await releases.setActive(ACTIVE_RELEASE, T0 + 1);

  await createAsset(db, ACTIVE_RELEASE, WORD_ASSET_KEY);
  await createAsset(db, ACTIVE_RELEASE, GONE_ASSET_KEY);
  await createAsset(db, RETIRED_RELEASE, RETIRED_ASSET_KEY);
  await createAsset(db, READY_RELEASE, READY_ASSET_KEY);

  // A study session pinned to the retained release.
  await new StudySessionRepository(db).create({ userId: alice.userId }, {
    sessionId: "sess-alice-live",
    mode: "NEW_WORDS",
    releaseId: RETIRED_RELEASE,
    queueSnapshot: { version: 1, release_id: RETIRED_RELEASE, cards: [{ canonical_card_key: "card-1", presented_card_key: "card-1" }] },
    createdAt: T0,
    expiresAt: T0 + HOUR,
  });

  const deps: WorkerDeps = {
    db,
    audioBucket: bucket as unknown as R2Bucket,
    loginRateLimiter: new FakeRateLimiter(),
    allowedOrigins: [ORIGIN],
    logWrite: (line: string) => logs.push(line),
    now: () => clock.now,
  };
  const app = buildApp(deps);
  const aliceCookie = await loginAs(app, "alice");
  return { env, db, logs, deps, app, bucket, clock, alice, aliceCookie };
}

let fx: AudioFixture;

beforeEach(async () => {
  fx = await createFixture();
});

afterEach(() => {
  fx.env.cleanup();
});

async function getAudio(assetKey: string, headers: Record<string, string> = {}, extra = ""): Promise<Response> {
  return await fx.app.request(`/api/audio/${assetKey}${extra}`, {
    headers: { cookie: fx.aliceCookie, ...headers },
  });
}

describe("GET /api/audio authorization and release association", () => {
  it("rejects unauthenticated requests before touching R2", async () => {
    const res = await fx.app.request(`/api/audio/${WORD_ASSET_KEY}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
    expect(fx.bucket.operations).toBe(0);
  });

  it("serves only assets of the active release; foreign-release assets are 404", async () => {
    const ok = await getAudio(WORD_ASSET_KEY);
    expect(ok.status).toBe(200);

    // Same bytes, but this asset belongs to a READY release: never reachable.
    const ready = await getAudio(READY_ASSET_KEY);
    expect(ready.status).toBe(404);
    expect(((await ready.json()) as { code: string }).code).toBe("CONTENT_AUDIO_NOT_FOUND");

    const unknown = await getAudio("audio/xx/nope.wav");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("CONTENT_AUDIO_NOT_FOUND");
  });

  it("answers 404 with a distinct code when the R2 object is missing", async () => {
    const res = await getAudio(GONE_ASSET_KEY);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("CONTENT_AUDIO_OBJECT_MISSING");
  });

  it("serves session-pinned assets from the retained release", async () => {
    const res = await getAudio(RETIRED_ASSET_KEY, {}, "?session=sess-alice-live");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(AUDIO_BYTES));
  });

  it("rejects an invalid study session like the content routes", async () => {
    const res = await getAudio(WORD_ASSET_KEY, {}, "?session=sess-nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("CONTENT_SESSION_INVALID");
  });
});

describe("GET /api/audio streaming, ETag, and ranges", () => {
  it("streams the object with content-hash ETag and long immutable caching", async () => {
    const res = await getAudio(WORD_ASSET_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("etag")).toBe(`"${AUDIO_SHA256}"`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO_BYTES);
  });

  it("answers 304 for a matching If-None-Match and 200 otherwise", async () => {
    const notModified = await getAudio(WORD_ASSET_KEY, { "if-none-match": `"${AUDIO_SHA256}"` });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(`"${AUDIO_SHA256}"`);
    expect(notModified.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);

    const listMatch = await getAudio(WORD_ASSET_KEY, { "if-none-match": `"other-tag", "${AUDIO_SHA256}"` });
    expect(listMatch.status).toBe(304);

    const stale = await getAudio(WORD_ASSET_KEY, { "if-none-match": `"${"0".repeat(64)}"` });
    expect(stale.status).toBe(200);
  });

  it("serves byte ranges as 206 with Content-Range", async () => {
    const head = await getAudio(WORD_ASSET_KEY, { range: "bytes=0-3" });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-3/${AUDIO_BYTES.length}`);
    expect(new Uint8Array(await head.arrayBuffer())).toEqual(AUDIO_BYTES.subarray(0, 4));

    const tail = await getAudio(WORD_ASSET_KEY, { range: "bytes=12-" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes 12-15/${AUDIO_BYTES.length}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(AUDIO_BYTES.subarray(12));

    const suffix = await getAudio(WORD_ASSET_KEY, { range: "bytes=-3" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes 13-15/${AUDIO_BYTES.length}`);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(AUDIO_BYTES.subarray(13));
  });

  it("ignores malformed ranges but rejects unsatisfiable ones with 416", async () => {
    const malformed = await getAudio(WORD_ASSET_KEY, { range: "bytes=zzz" });
    expect(malformed.status).toBe(200);
    expect(new Uint8Array(await malformed.arrayBuffer())).toEqual(AUDIO_BYTES);

    const unsatisfiable = await getAudio(WORD_ASSET_KEY, { range: "bytes=999-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${AUDIO_BYTES.length}`);
    expect(((await unsatisfiable.json()) as { code: string }).code).toBe("CONTENT_RANGE_NOT_SATISFIABLE");
  });
});
