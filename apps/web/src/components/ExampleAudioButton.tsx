import { useEffect, useRef, useState } from "react";

export function ExampleAudioButton({ url }: { url: string }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);

  async function play(): Promise<void> {
    setFailed(false);
    try {
      await audioRef.current?.play();
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className="example-audio-control">
      <audio ref={audioRef} src={url} preload="none" hidden onError={() => setFailed(true)} />
      <button
        type="button"
        className="example-audio-button"
        aria-label="播放真题句音频"
        onClick={() => void play()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 10v4h4l5 4V6l-5 4H5Z" />
          <path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
        </svg>
        <span>听原句</span>
      </button>
      {failed ? <span role="status" className="example-audio-error">音频暂不可用</span> : null}
    </span>
  );
}
