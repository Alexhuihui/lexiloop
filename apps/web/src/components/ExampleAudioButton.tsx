import { AudioButton } from "./AudioButton";

export function ExampleAudioButton({ url }: { url: string }): React.JSX.Element {
  return (
    <span className="example-audio-control">
      <AudioButton url={url} label="听原句" ariaLabel="播放真题句音频" />
    </span>
  );
}
