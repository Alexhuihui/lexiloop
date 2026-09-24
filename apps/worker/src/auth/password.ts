/**
 * Password hashing for preseeded accounts (spec 7.1).
 *
 * PBKDF2-SHA256 via Web Crypto (`crypto.subtle`) — the same primitive runs in
 * the Workers runtime and under Node for local seeding/tests. Parameters are
 * versioned: the verifier is stored as the envelope
 * `pbkdf2-sha256$<params-version>$<base64>` so future iteration upgrades can
 * coexist with existing rows; an unknown version simply fails verification.
 *
 * D1 never stores plaintext passwords. Comparison is constant-time over the
 * derived bytes.
 */

const textEncoder = new TextEncoder();

/** Iteration parameters per version (spec 7.1: versioned, stored alongside). */
export interface PasswordKdfParams {
  readonly version: number;
  readonly iterations: number;
  readonly hash: "SHA-256";
  readonly lengthBytes: number;
}

export const PASSWORD_KDF_VERSIONS: readonly PasswordKdfParams[] = [
  { version: 1, iterations: 100_000, hash: "SHA-256", lengthBytes: 32 },
];

/** Params version used for all newly issued verifiers. */
export const CURRENT_PASSWORD_KDF_VERSION = 1;

const VERIFIER_PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KDF_BY_VERSION = new Map<number, PasswordKdfParams>(PASSWORD_KDF_VERSIONS.map((params) => [params.version, params]));

export interface HashedPassword {
  /** Base64-encoded random salt (per account, per rotation). */
  salt: string;
  /** `pbkdf2-sha256$<version>$<base64>` envelope; opaque to the DB layer. */
  verifier: string;
  kdfVersion: number;
}

/** Login/seed username normalization (spec 6.3 unique normalized value). */
export function normalizeUsername(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Decodes base64 into a fresh ArrayBuffer-backed view (Web Crypto BufferSource). */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time byte comparison; returns false immediately only on length mismatch. */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function deriveVerifier(password: string, saltB64: string, params: PasswordKdfParams): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: params.hash, salt: fromBase64(saltB64), iterations: params.iterations },
    key,
    params.lengthBytes * 8,
  );
  return `${VERIFIER_PREFIX}$${params.version}$${toBase64(new Uint8Array(bits))}`;
}

/** Hashes a password with a fresh random salt and the current params version. */
export async function hashPassword(password: string): Promise<HashedPassword> {
  const params = KDF_BY_VERSION.get(CURRENT_PASSWORD_KDF_VERSION);
  if (!params) {
    throw new Error(`password kdf version ${CURRENT_PASSWORD_KDF_VERSION} is not configured`);
  }
  const salt = toBase64(randomBytes(SALT_BYTES));
  const verifier = await deriveVerifier(password, salt, params);
  return { salt, verifier, kdfVersion: params.version };
}

/** Recomputes the verifier and compares envelopes in constant time. */
export async function verifyPassword(password: string, stored: { salt: string; verifier: string }): Promise<boolean> {
  const parts = stored.verifier.split("$");
  if (parts.length !== 3 || parts[0] !== VERIFIER_PREFIX) {
    return false;
  }
  const version = Number(parts[1]);
  const params = KDF_BY_VERSION.get(version);
  if (!params) {
    return false;
  }
  const derived = await deriveVerifier(password, stored.salt, params);
  return constantTimeEquals(textEncoder.encode(derived), textEncoder.encode(stored.verifier));
}
