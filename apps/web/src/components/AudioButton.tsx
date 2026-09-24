import { useEffect, useRef, useState } from "react";

export interface AudioButtonProps {
  url: string;
  /** Visible label while playback is idle, for example “听单词”. */
  label: string;
  /** Accessible idle-state label. */
  ariaLabel: string;
}

type PlaybackState = "idle" | "loading" | "playing" | "failed";

/**
 * One compact audio control shared by headwords and example sentences.
 * The media element deliberately keeps `preload="none"`: page-level idle
 * prefetching warms the Service Worker/browser cache without allowing each
 * mounted media element to compete with the first render.
 */
export function AudioButton({ url, label, ariaLabel }: AudioButtonProps): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlaybackState>("idle");

  useEffect(() => {
    setState("idle");
  }, [url]);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) {
      setState("failed");
      return;
    }
    if (!audio.paused) {
      audio.pause();
      setState("idle");
      return;
    }

    setState("loading");
    try {
      await audio.play();
      setState("playing");
    } catch {
      setState("failed");
    }
  }

  const visibleLabel =
    state === "loading" ? "加载中…" : state === "playing" ? "暂停" : label;
  const accessibleLabel = state === "playing" ? `暂停${label.replace(/^听/, "")}` : ariaLabel;

  return (
    <span className="audio-control">
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        hidden
        onPlay={() => setState("playing")}
        onPause={() => setState((current) => (current === "failed" ? current : "idle"))}
        onEnded={() => setState("idle")}
        onError={() => setState("failed")}
      />
      <button
        type="button"
        className="audio-button"
        aria-label={accessibleLabel}
        aria-pressed={state === "playing"}
        disabled={state === "loading"}
        onClick={() => void togglePlayback()}
      >
        {state === "playing" ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M5 10v4h4l5 4V6l-5 4H5Z" />
            <path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
          </svg>
        )}
        <span>{visibleLabel}</span>
      </button>
      {state === "failed" ? (
        <span role="status" className="audio-error">
          音频暂时无法播放，可先继续学习。
        </span>
      ) : null}
    </span>
  );
}
