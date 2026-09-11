"""Deterministic audio inspection worker (spec 5.8).

The audio gate runs DETERMINISTIC checks only — no ASR, no audio read-back,
and no network access. For every row of the private audio manifest (written
by the TS ``TTS_SYNTHESIZE`` stage) it verifies:

- the asset file exists and its SHA-256 matches the manifest;
- the container decodes (ffprobe + soundfile) with the contracted container,
  codec, sample rate, and channel count;
- the duration lies inside the lenient band computed from the text length
  (the band is computed TS-side and carried per manifest row);
- the audio is non-empty and not all-silent, and head/tail silence stays
  inside the RMS-window thresholds;
- peak level, clipping ratio, and file size are not anomalous;
- the ``text_hash`` in the WAV metadata (RIFF LIST/INFO ``ICMT``) matches the
  content record's text SHA-256.

One strict manifest row in, one inspection row out (``inspection.jsonl``);
the run summary is a single JSON object on stdout, failures are a single-line
JSON error on stderr with exit code 2. Nothing here ever writes a PDF, and
no ASR dependency, command, field, or optional hook exists in this module.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pydantic
import soundfile as sf

_HASH_PATTERN = pydantic.Field(pattern=r"^[0-9a-f]{64}$")

#: Full-scale distance at/after which a sample counts as clipped.
CLIP_LEVEL = 0.999


def _fail(code: str, message: str) -> None:
    sys.stderr.write(json.dumps({"error": code, "message": message}, ensure_ascii=False) + "\n")
    raise SystemExit(2)


# ---------------------------------------------------------------------------
# Versioned audio-gate policy (the ``audio_gate`` block of the TTS config)
# ---------------------------------------------------------------------------


class SilencePolicy(pydantic.BaseModel):
    """RMS-window silence thresholds."""

    model_config = pydantic.ConfigDict(extra="forbid")

    window_seconds: float = pydantic.Field(default=0.02, gt=0.0)
    rms_threshold: float = pydantic.Field(default=0.005, gt=0.0)
    max_head_seconds: float = pydantic.Field(default=2.0, ge=0.0)
    max_tail_seconds: float = pydantic.Field(default=2.0, ge=0.0)


class LevelPolicy(pydantic.BaseModel):
    """Peak/clipping sanity bounds."""

    model_config = pydantic.ConfigDict(extra="forbid")

    min_peak: float = pydantic.Field(default=0.01, ge=0.0)
    max_clipping_ratio: float = pydantic.Field(default=0.001, ge=0.0, le=1.0)


class AudioGatePolicy(pydantic.BaseModel):
    """Deterministic audio-gate policy (spec 5.8); no ASR field exists.

    Defaults mirror ``config/tts/mimo-v2.5.json`` (v1) so the policy is fully
    usable standalone; the config file always wins when provided.
    """

    model_config = pydantic.ConfigDict(extra="forbid")

    container: str = pydantic.Field(default="wav", min_length=1)
    codec: str = pydantic.Field(default="pcm_s16le", min_length=1)
    sample_rate_hz: int = pydantic.Field(default=24000, gt=0)
    channels: int = pydantic.Field(default=1, gt=0)
    silence: SilencePolicy = pydantic.Field(default_factory=SilencePolicy)
    levels: LevelPolicy = pydantic.Field(default_factory=LevelPolicy)


def load_audio_gate_policy(path: str | Path) -> AudioGatePolicy:
    """Load and validate the ``audio_gate`` block of the versioned TTS config."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return AudioGatePolicy.model_validate(raw["audio_gate"])


# ---------------------------------------------------------------------------
# Private audio manifest (mirrors the Zod row in src/tts/cache.ts)
# ---------------------------------------------------------------------------


class AudioManifestRow(pydantic.BaseModel):
    """One strict row of ``audio/manifest.jsonl``."""

    model_config = pydantic.ConfigDict(extra="forbid")

    cache_key: str = _HASH_PATTERN
    object_key: str = pydantic.Field(min_length=1)
    wav_path: str = pydantic.Field(min_length=1)
    text_sha256: str = _HASH_PATTERN
    text_chars: int = pydantic.Field(gt=0)
    min_seconds: float = pydantic.Field(ge=0.0)
    max_seconds: float = pydantic.Field(gt=0.0)
    sha256: str = _HASH_PATTERN
    bytes: int = pydantic.Field(gt=0)
    provider: str = pydantic.Field(min_length=1)
    model: str = pydantic.Field(min_length=1)
    voice: str = pydantic.Field(min_length=1)
    synthesis_config_version: str = pydantic.Field(min_length=1)


class AudioCheckError(Exception):
    """One failed deterministic check with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# WAV LIST/INFO metadata (the text_hash channel)
# ---------------------------------------------------------------------------


def _find_chunk(data: bytes, start: int, end: int, chunk_id: bytes) -> tuple[int, int] | None:
    offset = start
    while offset + 8 <= end:
        current = data[offset : offset + 4]
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        if current == chunk_id:
            return (offset, size)
        offset += 8 + size + (size % 2)
    return None


def read_info_comment(wav: bytes) -> str | None:
    """Return the RIFF LIST/INFO ``ICMT`` comment, or None when absent."""
    if len(wav) < 12 or wav[0:4] != b"RIFF" or wav[8:12] != b"WAVE":
        return None
    riff_end = min(int.from_bytes(wav[4:8], "little") + 8, len(wav))
    found = _find_chunk(wav, 12, riff_end, b"LIST")
    if found is None:
        return None
    list_start, list_size = found
    list_end = min(list_start + 8 + list_size, riff_end)
    icmt = _find_chunk(wav, list_start + 12, list_end, b"ICMT")
    if icmt is None:
        return None
    icmt_start, icmt_size = icmt
    payload_end = min(icmt_start + 8 + icmt_size, list_end)
    return wav[icmt_start + 8 : payload_end].decode("utf-8").rstrip("\x00")


def with_info_comment(wav: bytes, comment: str) -> bytes:
    """Return ``wav`` with the LIST/INFO ``ICMT`` comment set (replaces any)."""
    if len(wav) < 12 or wav[0:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ValueError("with_info_comment requires a RIFF/WAVE buffer")
    payload = comment.encode("utf-8") + b"\x00"
    pad = b"\x00" if len(payload) % 2 else b""
    icmt = (
        b"ICMT"
        + len(payload).to_bytes(4, "little")
        + payload
        + pad
    )
    listing = b"INFO" + icmt
    list_chunk = b"LIST" + len(listing).to_bytes(4, "little") + listing

    riff_end = min(int.from_bytes(wav[4:8], "little") + 8, len(wav))
    kept: list[bytes] = []
    offset = 12
    while offset + 8 <= riff_end:
        chunk_id = wav[offset : offset + 4]
        size = int.from_bytes(wav[offset + 4 : offset + 8], "little")
        chunk_end = min(offset + 8 + size, riff_end)
        shadowed = (
            chunk_id == b"LIST"
            and chunk_end - (offset + 12) >= 4
            and wav[offset + 8 : offset + 12] == b"INFO"
            and _find_chunk(wav, offset + 12, chunk_end, b"ICMT") is not None
        )
        if not shadowed:
            kept.append(wav[offset:chunk_end])
            if size % 2 and offset + 8 + size < riff_end:
                kept.append(b"\x00")
        offset += 8 + size + (size % 2)
    body = b"WAVE" + list_chunk + b"".join(kept)
    return b"RIFF" + len(body).to_bytes(4, "little") + body


# ---------------------------------------------------------------------------
# Deterministic per-asset checks
# ---------------------------------------------------------------------------

#: ffprobe's JSON fields this worker relies on (container/codec/rate/channels).
_FFPROBE_ARGS = (
    "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
)


def probe_container(path: Path) -> dict[str, Any]:
    """Probe container/codec/sample-rate/channels with ffprobe (no decode)."""
    try:
        proc = subprocess.run(
            [*_FFPROBE_ARGS, str(path)],
            capture_output=True,
            text=True,
            check=True,
            shell=False,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AudioCheckError("DECODE_FAILED", f"ffprobe cannot read the container: {exc}") from exc
    try:
        data = json.loads(proc.stdout)
        stream = data["streams"][0]
        return {
            "container": str(data["format"]["format_name"]),
            "codec": str(stream["codec_name"]),
            "sample_rate": int(stream["sample_rate"]),
            "channels": int(stream["channels"]),
        }
    except (ValueError, KeyError, IndexError) as exc:
        raise AudioCheckError("DECODE_FAILED", f"ffprobe output unusable: {exc}") from exc


def check_size(size_bytes: int, *, expected_bytes: float) -> str | None:
    """Return 'FILE_SIZE_ANOMALY' when the size is implausible for the audio."""
    floor = 0.25 * expected_bytes
    ceiling = 4.0 * expected_bytes + 16384
    if size_bytes < floor or size_bytes > ceiling:
        return "FILE_SIZE_ANOMALY"
    return None


def _silence_windows(
    data: "np.ndarray", sample_rate: int, policy: SilencePolicy
) -> tuple[float, float, bool, float]:
    """Head/tail silence (seconds), all-silent flag, and overall RMS."""
    window = max(1, int(policy.window_seconds * sample_rate))
    flat = np.asarray(data, dtype=np.float64).reshape(-1)
    total = flat.shape[0]
    rms_values: list[float] = []
    for start in range(0, total, window):
        segment = flat[start : start + window]
        rms_values.append(float(math.sqrt(float(np.mean(segment * segment)))))
    silent = [rms < policy.rms_threshold for rms in rms_values]
    overall_rms = (
        float(math.sqrt(float(np.mean(flat * flat)))) if total > 0 else 0.0
    )
    if all(silent):
        return (0.0, 0.0, True, overall_rms)
    first = silent.index(False)
    last = len(silent) - 1 - silent[::-1].index(False)
    window_seconds = window / sample_rate
    head = first * window_seconds
    tail = (len(silent) - 1 - last) * window_seconds
    return (head, tail, False, overall_rms)


def inspect_row(row: AudioManifestRow, policy: AudioGatePolicy, base_dir: Path) -> dict[str, Any]:
    """Run every deterministic check for one manifest row.

    Raises :class:`AudioCheckError` on the first failing check; returns the
    measured inspection row on success. No ASR and no network access happens
    here — only ffprobe, soundfile, and hashing.
    """
    wav_path = base_dir / row.wav_path
    if not wav_path.is_file():
        raise AudioCheckError("FILE_MISSING", f"asset missing: {row.wav_path}")

    raw = wav_path.read_bytes()
    actual_sha = hashlib.sha256(raw).hexdigest()
    if actual_sha != row.sha256:
        raise AudioCheckError("SHA_MISMATCH", f"file hash mismatch for {row.wav_path}")

    # Container/codec/rate/channels via ffprobe, samples via soundfile.
    probed = probe_container(wav_path)
    if (
        policy.container not in probed["container"].split(",")
        or probed["codec"] != policy.codec
        or probed["sample_rate"] != policy.sample_rate_hz
        or probed["channels"] != policy.channels
    ):
        raise AudioCheckError(
            "FORMAT_MISMATCH",
            f"container={probed['container']} codec={probed['codec']} "
            f"rate={probed['sample_rate']} channels={probed['channels']} do not match the "
            f"contract ({policy.container}/{policy.codec}/{policy.sample_rate_hz}/{policy.channels})",
        )

    data, sample_rate = sf.read(str(wav_path), dtype="float64", always_2d=True)
    frames, channels = data.shape
    if frames == 0:
        raise AudioCheckError("EMPTY_AUDIO", "asset decodes to zero frames")

    duration_seconds = frames / sample_rate
    if duration_seconds < row.min_seconds or duration_seconds > row.max_seconds:
        raise AudioCheckError(
            "DURATION_OUT_OF_RANGE",
            f"duration {duration_seconds:.3f}s outside [{row.min_seconds}, {row.max_seconds}]s "
            f"for {row.text_chars} character(s)",
        )

    head, tail, all_silent, overall_rms = _silence_windows(
        data, sample_rate, policy.silence
    )
    if all_silent:
        raise AudioCheckError("ALL_SILENT", "asset is entirely silent")
    if head > policy.silence.max_head_seconds:
        raise AudioCheckError(
            "HEAD_SILENCE_EXCESSIVE",
            f"head silence {head:.3f}s above {policy.silence.max_head_seconds}s",
        )
    if tail > policy.silence.max_tail_seconds:
        raise AudioCheckError(
            "TAIL_SILENCE_EXCESSIVE",
            f"tail silence {tail:.3f}s above {policy.silence.max_tail_seconds}s",
        )

    peak = float(np.max(np.abs(data)))
    if peak < policy.levels.min_peak:
        raise AudioCheckError("PEAK_TOO_LOW", f"peak {peak:.6f} below {policy.levels.min_peak}")
    clipped = int(np.count_nonzero(np.abs(data) >= CLIP_LEVEL))
    clipping_ratio = clipped / float(frames * channels)
    if clipping_ratio > policy.levels.max_clipping_ratio:
        raise AudioCheckError(
            "CLIPPING_EXCESSIVE",
            f"clipping ratio {clipping_ratio:.6f} above {policy.levels.max_clipping_ratio}",
        )

    bytes_per_sample = _CODEC_TO_BYTES.get(probed["codec"], 2)
    expected_bytes = duration_seconds * sample_rate * channels * bytes_per_sample
    size_anomaly = check_size(len(raw), expected_bytes=expected_bytes)
    if size_anomaly is not None:
        raise AudioCheckError(
            "FILE_SIZE_ANOMALY",
            f"size {len(raw)}B implausible for {duration_seconds:.3f}s of audio",
        )

    metadata_hash = read_info_comment(raw)
    if metadata_hash != row.text_sha256:
        raise AudioCheckError(
            "TEXT_HASH_MISMATCH",
            "WAV metadata text_hash does not match the content record",
        )

    return {
        "cache_key": row.cache_key,
        "wav_path": row.wav_path,
        "ok": True,
        "container": probed["container"],
        "codec": probed["codec"],
        "sample_rate": probed["sample_rate"],
        "channels": probed["channels"],
        "duration_seconds": round(duration_seconds, 6),
        "peak": round(peak, 6),
        "clipping_ratio": round(clipping_ratio, 6),
        "head_silence_seconds": round(head, 6),
        "tail_silence_seconds": round(tail, 6),
        "rms": round(overall_rms, 6),
        "size_bytes": len(raw),
        "sha256": actual_sha,
        "text_sha256": row.text_sha256,
    }


#: ffprobe codec name -> bytes per sample (for the file-size sanity band).
_CODEC_TO_BYTES = {
    "pcm_u8": 1,
    "pcm_s16le": 2,
    "pcm_s24le": 3,
    "pcm_s32le": 4,
    "pcm_f32le": 4,
    "pcm_f64le": 8,
}


def run_inspect(
    rows: Sequence[AudioManifestRow], policy: AudioGatePolicy, base_dir: Path
) -> list[dict[str, Any]]:
    """Inspect every manifest row, capturing per-row failures as ok:false."""
    results: list[dict[str, Any]] = []
    for row in rows:
        try:
            results.append(inspect_row(row, policy, base_dir))
        except AudioCheckError as exc:
            results.append(
                {
                    "cache_key": row.cache_key,
                    "wav_path": row.wav_path,
                    "ok": False,
                    "error": exc.code,
                    "message": exc.message,
                }
            )
        except Exception as exc:  # decode/backend surprises stay machine-readable
            results.append(
                {
                    "cache_key": row.cache_key,
                    "wav_path": row.wav_path,
                    "ok": False,
                    "error": "DECODE_FAILED",
                    "message": str(exc),
                }
            )
    return results


def sha256_text(text: str) -> str:
    """SHA-256 of a text (the content record's ``text_hash``)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--manifest", required=True, help="audio/manifest.jsonl from TTS_SYNTHESIZE")
    parser.add_argument("--out", required=True, help="inspection.jsonl output path")
    parser.add_argument(
        "--policy", required=True, help="versioned TTS config JSON carrying audio_gate"
    )


def add_audio_subparser(
    sub: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    """Register the ``inspect`` subcommand on the shared ``lexiloop_media`` CLI."""
    parser = sub.add_parser(
        "inspect",
        help="deterministic audio-gate inspection over the private audio manifest",
        description="Deterministic audio inspection (no ASR, no network)",
    )
    _add_arguments(parser)
    parser.set_defaults(func=cmd_inspect)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lexiloop_media inspect",
        description="Deterministic audio inspection (no ASR, no network)",
    )
    _add_arguments(parser)
    return parser


def _read_manifest(path: Path) -> list[AudioManifestRow]:
    rows: list[AudioManifestRow] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except ValueError as exc:
            raise ValueError(f"line {index + 1} is not JSON: {exc}") from exc
        try:
            rows.append(AudioManifestRow.model_validate(raw))
        except Exception as exc:
            raise ValueError(f"line {index + 1} failed schema: {exc}") from exc
    if not rows:
        raise ValueError("manifest carries no rows")
    return rows


def cmd_inspect(args: argparse.Namespace) -> None:
    """Entry point shared by ``lexiloop_media inspect`` and the standalone parser."""
    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        _fail("AUDIO_MANIFEST_NOT_FOUND", f"audio manifest not found: {manifest_path}")
    try:
        rows = _read_manifest(manifest_path)
    except ValueError as exc:
        _fail("AUDIO_MANIFEST_INVALID", str(exc))
    try:
        policy = load_audio_gate_policy(args.policy)
    except FileNotFoundError:
        _fail("AUDIO_GATE_POLICY_NOT_FOUND", f"policy config not found: {args.policy}")
    except Exception as exc:  # JSON decode + pydantic validation errors
        _fail("AUDIO_GATE_POLICY_INVALID", f"audio gate policy invalid: {exc}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    results = run_inspect(rows, policy, manifest_path.parent)
    out_path.write_text(
        "".join(json.dumps(result, ensure_ascii=False) + "\n" for result in results),
        encoding="utf-8",
    )

    failed = [result for result in results if not result["ok"]]
    if failed:
        first = failed[0]
        _fail(
            "AUDIO_INVALID",
            f"{len(failed)} asset(s) failed deterministic inspection "
            f"(first: {first['cache_key'][:12]} {first['error']}: {first['message']})",
        )

    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "checked": len(results),
                "failed": 0,
                "inspection_jsonl": str(out_path.resolve()),
            },
            ensure_ascii=False,
        )
        + "\n"
    )


def main(argv: Sequence[str] | None = None) -> None:
    """Standalone entry point: ``python -m lexiloop_media.audio <args>``."""
    cmd_inspect(build_parser().parse_args(argv))
