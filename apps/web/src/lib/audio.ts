/**
 * Word-audio playback helper (spec 9.4/10): `S` plays the current card's
 * headword audio. A playback failure is surfaced through the `onFailed`
 * callback and NEVER thrown into the caller — per spec 10 an audio failure
 * must not block reading (可重试或继续学习). Starting a new playback stops
 * the previous element so rapid presses don't overlap.
 */

export interface AudioPlayer {
  /** Starts (and replaces) playback; failures go to `onFailed`. */
  play(url: string): void;
  /** Stops playback and drops the element reference. */
  dispose(): void;
}

export interface AudioPlayerOptions {
  /** Invoked once per failed playback (never throws). */
  onFailed?: () => void;
  /** Element factory; injectable for tests, defaults to `new Audio(url)`. */
  createEl?: (url: string) => HTMLAudioElement;
}

function defaultCreateEl(url: string): HTMLAudioElement {
  return new Audio(url);
}

export function createAudioPlayer(options: AudioPlayerOptions = {}): AudioPlayer {
  const createEl = options.createEl ?? defaultCreateEl;
  let current: HTMLAudioElement | null = null;

  return {
    play(url: string): void {
      const element = createEl(url);
      current?.pause();
      current = element;
      try {
        // play() returns a promise in browsers; keep a sync throw safe too.
        Promise.resolve(element.play()).catch(() => options.onFailed?.());
      } catch {
        options.onFailed?.();
      }
    },
    dispose(): void {
      current?.pause();
      current = null;
    },
  };
}
