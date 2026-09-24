/**
 * Task 17 acceptance tests for the audio player helper (spec 10): playback
 * failures surface through the failure callback and NEVER throw into the
 * caller (audio must not block reading), and starting a new playback stops
 * the previous element.
 */

import { describe, expect, it, vi } from "vitest";
import { createAudioPlayer } from "./audio";

interface FakeElement {
  src: string;
  playCalls: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
}

function fakeElement(src: string): FakeElement {
  const element: FakeElement = {
    src,
    playCalls: 0,
    paused: true,
    play() {
      element.playCalls += 1;
      element.paused = false;
      return Promise.resolve();
    },
    pause() {
      element.paused = true;
    },
  };
  return element;
}

describe("audio player", () => {
  it("plays a URL through a fresh element", () => {
    const created: FakeElement[] = [];
    const player = createAudioPlayer({
      createEl: (src) => {
        const element = fakeElement(src);
        created.push(element);
        return element as unknown as HTMLAudioElement;
      },
    });
    player.play("https://lexiloop.test/api/audio/a.wav");
    expect(created).toHaveLength(1);
    expect(created[0]?.playCalls).toBe(1);
    expect(created[0]?.src).toBe("https://lexiloop.test/api/audio/a.wav");
  });

  it("stops the previous element when a new playback starts", () => {
    const created: FakeElement[] = [];
    const player = createAudioPlayer({
      createEl: (src) => {
        const element = fakeElement(src);
        created.push(element);
        return element as unknown as HTMLAudioElement;
      },
    });
    player.play("https://lexiloop.test/api/audio/a.wav");
    player.play("https://lexiloop.test/api/audio/b.wav");
    expect(created).toHaveLength(2);
    expect(created[0]?.paused).toBe(true);
    expect(created[1]?.paused).toBe(false);
  });

  it("reports a rejected play() through onFailed instead of throwing", async () => {
    const onFailed = vi.fn();
    const player = createAudioPlayer({
      createEl: () =>
        ({
          play: () => Promise.reject(new Error("no decoder")),
          pause() {},
        }) as unknown as HTMLAudioElement,
      onFailed,
    });
    expect(() => player.play("https://lexiloop.test/api/audio/broken.wav")).not.toThrow();
    await vi.waitFor(() => {
      expect(onFailed).toHaveBeenCalledTimes(1);
    });
  });

  it("survives a synchronous play() that throws", () => {
    const onFailed = vi.fn();
    const player = createAudioPlayer({
      createEl: () =>
        ({
          play() {
            throw new Error("sync failure");
          },
          pause() {},
        }) as unknown as HTMLAudioElement,
      onFailed,
    });
    expect(() => player.play("https://lexiloop.test/api/audio/x.wav")).not.toThrow();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("pauses everything on dispose", () => {
    const created: FakeElement[] = [];
    const player = createAudioPlayer({
      createEl: (src) => {
        const element = fakeElement(src);
        created.push(element);
        return element as unknown as HTMLAudioElement;
      },
    });
    player.play("https://lexiloop.test/api/audio/a.wav");
    player.dispose();
    expect(created[0]?.paused).toBe(true);
  });
});
