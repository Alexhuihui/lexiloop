"""Contract tests for the deterministic audio inspection worker (spec 5.8).

The audio gate is deterministic ONLY: ffprobe/soundfile decode + format
checks, duration bounds computed from text length, RMS silence windows,
peak/clipping/size sanity, and the ``text_hash`` WAV metadata check. There is
no ASR dependency anywhere in this worker, and a source-scan test below keeps
it that way.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from lexiloop_media import audio, cli

TTS_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "tts" / "mimo-v2.5.json"

SAMPLE_RATE = 24000
TEXT_SHA = hashlib.sha256("He abandoned the plan.".encode("utf-8")).hexdigest()


def write_wav(
    path: Path,
    seconds: float,
    *,
    freq: float = 440.0,
    amplitude: float = 0.4,
    lead_silence: float = 0.0,
    tail_silence: float = 0.0,
    kind: str = "sine",
    subtype: str = "PCM_16",
) -> bytes:
    """Write a WAV fixture; returns the raw file bytes."""
    rate = SAMPLE_RATE
    total = int(seconds * rate)
    lead = int(lead_silence * rate)
    tail = int(tail_silence * rate)
    tone_length = max(0, total - lead - tail)
    t = np.arange(tone_length, dtype=np.float64) / rate
    if kind == "square":
        tone = np.sign(np.sin(2.0 * np.pi * freq * t)) * amplitude
    else:
        tone = np.sin(2.0 * np.pi * freq * t) * amplitude
    data = np.concatenate(
        [np.zeros(lead), tone, np.zeros(tail)]
    ).astype(np.float64)
    sf.write(path, data, rate, subtype=subtype, format="WAV")
    return path.read_bytes()


def make_row(
    path: Path,
    *,
    cache_key: str = "a" * 64,
    text_sha256: str | None = TEXT_SHA,
    text_chars: int = 22,
    min_seconds: float = 0.3,
    max_seconds: float = 180.0,
    wav_bytes: bytes | None = None,
    **overrides: object,
) -> dict:
    """One manifest row whose integrity fields match the file on disk."""
    raw = path.read_bytes() if wav_bytes is None else wav_bytes
    row = {
        "cache_key": cache_key,
        "object_key": f"audio/{cache_key[:2]}/{cache_key}.wav",
        "wav_path": path.name,
        "text_sha256": text_sha256 if text_sha256 is not None else TEXT_SHA,
        "text_chars": text_chars,
        "min_seconds": min_seconds,
        "max_seconds": max_seconds,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
        "provider": "mimo",
        "model": "mimo-v2.5-tts",
        "voice": "Mia",
        "synthesis_config_version": "mimo-v2.5-tts-1",
    }
    row.update(overrides)
    return row


def expect_check_error(row: dict, code: str, tmp_path: Path) -> None:
    with pytest.raises(audio.AudioCheckError) as excinfo:
        audio.inspect_row(audio.AudioManifestRow.model_validate(row), audio.AudioGatePolicy(), tmp_path)
    assert excinfo.value.code == code


# ---------------------------------------------------------------------------
# Versioned policy + module hygiene
# ---------------------------------------------------------------------------


def test_repo_tts_config_carries_the_audio_gate_policy() -> None:
    raw = json.loads(TTS_CONFIG_PATH.read_text(encoding="utf-8"))
    policy = audio.load_audio_gate_policy(TTS_CONFIG_PATH)
    assert policy.sample_rate_hz == raw["audio_gate"]["sample_rate_hz"]
    assert policy.channels == raw["audio_gate"]["channels"]
    assert policy.codec == raw["audio_gate"]["codec"]
    assert policy.container == raw["audio_gate"]["container"]
    # The policy is re-validated verbatim from the config block.
    assert audio.AudioGatePolicy.model_validate(raw["audio_gate"]) == policy
    assert policy.silence.max_head_seconds > 0
    assert policy.levels.max_clipping_ratio < 1.0


def test_audio_module_has_no_asr_dependency() -> None:
    """No ASR dependency, command, field, or optional hook may exist.

    The scan looks at the module's CODE surface — every identifier, import,
    function name, and CLI flag — so prose in docstrings cannot mask a real
    dependency, and a stray prose mention cannot fail the scan either.
    """
    source = (Path(audio.__file__)).read_text(encoding="utf-8")
    tree = ast.parse(source)
    identifiers: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            identifiers.add(node.id)
        elif isinstance(node, ast.Attribute):
            identifiers.add(node.attr)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            identifiers.add(node.name)
        elif isinstance(node, ast.arg):
            identifiers.add(node.arg)
        elif isinstance(node, ast.Import):
            identifiers.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            identifiers.add(node.module or "")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # CLI flags and file/field names are code surface; docstrings are not.
            value = node.value
            if value.startswith("--") or value.endswith(".jsonl") or value.endswith(".json"):
                identifiers.add(value)
    banned = re.compile(r"\b(asr|whisper|vosk|deepspeech|speech_recognition|paddlespeech)\b", re.IGNORECASE)
    offenders = sorted(name for name in identifiers if banned.search(name))
    assert offenders == []
    # Only ffprobe/soundfile decode audio; there is no network client at all.
    assert "ffprobe" in source
    assert "soundfile" in source
    assert "requests" not in identifiers
    assert "httpx" not in identifiers


# ---------------------------------------------------------------------------
# WAV metadata (text_hash) round trip
# ---------------------------------------------------------------------------


def test_wav_info_comment_roundtrip_stays_decodable(tmp_path: Path) -> None:
    wav_path = tmp_path / "plain.wav"
    raw = write_wav(wav_path, 0.5)
    assert audio.read_info_comment(raw) is None

    marked = audio.with_info_comment(raw, TEXT_SHA)
    assert audio.read_info_comment(marked) == TEXT_SHA
    # Re-marking replaces the comment instead of stacking chunks.
    remarked = audio.with_info_comment(marked, "f" * 64)
    assert audio.read_info_comment(remarked) == "f" * 64
    assert remarked.count(b"ICMT") == 1

    # The marked container still decodes with the same shape.
    original_info = sf.info(wav_path)
    marked_path = tmp_path / "marked.wav"
    marked_path.write_bytes(marked)
    marked_info = sf.info(marked_path)
    assert marked_info.frames == original_info.frames
    assert marked_info.samplerate == original_info.samplerate


# ---------------------------------------------------------------------------
# Per-asset deterministic checks
# ---------------------------------------------------------------------------


def test_valid_wav_passes_every_check(tmp_path: Path) -> None:
    wav_path = tmp_path / "valid.wav"
    raw = write_wav(wav_path, 1.2, amplitude=0.4)
    raw = audio.with_info_comment(raw, TEXT_SHA)
    wav_path.write_bytes(raw)
    row = make_row(wav_path)

    result = audio.inspect_row(audio.AudioManifestRow.model_validate(row), audio.AudioGatePolicy(), tmp_path)
    assert result["ok"] is True
    assert result["cache_key"] == row["cache_key"]
    assert result["text_sha256"] == TEXT_SHA
    assert result["container"] == "wav"
    assert result["codec"] == "pcm_s16le"
    assert result["sample_rate"] == SAMPLE_RATE
    assert result["channels"] == 1
    assert result["duration_seconds"] == pytest.approx(1.2, abs=0.05)
    assert result["peak"] == pytest.approx(0.4, abs=0.01)
    assert result["clipping_ratio"] == 0.0
    assert result["head_silence_seconds"] < 0.1
    assert result["tail_silence_seconds"] < 0.1
    assert result["rms"] > 0.0
    assert result["size_bytes"] == len(raw)


def test_corrupt_container_fails_decode(tmp_path: Path) -> None:
    junk = b"NOT-A-RIFF-CONTAINER" * 32
    path = tmp_path / "corrupt.wav"
    path.write_bytes(junk)
    row = make_row(path, wav_bytes=junk)
    expect_check_error(row, "DECODE_FAILED", tmp_path)


def test_sha256_mismatch_is_detected(tmp_path: Path) -> None:
    path = tmp_path / "tampered.wav"
    write_wav(path, 0.8)
    row = make_row(path, sha256="b" * 64)
    expect_check_error(row, "SHA_MISMATCH", tmp_path)


def test_missing_asset_is_reported(tmp_path: Path) -> None:
    row = make_row(tmp_path / "gone.wav", wav_bytes=b"referenced-but-absent")
    expect_check_error(row, "FILE_MISSING", tmp_path)


def test_all_silent_audio_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "silent.wav"
    raw = write_wav(path, 0.8, amplitude=0.0)
    raw = audio.with_info_comment(raw, TEXT_SHA)
    path.write_bytes(raw)
    row = make_row(path)
    expect_check_error(row, "ALL_SILENT", tmp_path)


def test_excessive_head_and_tail_silence_is_rejected(tmp_path: Path) -> None:
    head_path = tmp_path / "head.wav"
    raw = write_wav(head_path, 4.0, lead_silence=3.0, tail_silence=0.5)
    head_path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    expect_check_error(make_row(head_path), "HEAD_SILENCE_EXCESSIVE", tmp_path)

    tail_path = tmp_path / "tail.wav"
    raw = write_wav(tail_path, 4.0, lead_silence=0.1, tail_silence=3.0)
    tail_path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    expect_check_error(make_row(tail_path), "TAIL_SILENCE_EXCESSIVE", tmp_path)

    # Moderate lead/tail silence stays inside the lenient threshold.
    ok_path = tmp_path / "ok.wav"
    raw = write_wav(ok_path, 1.6, lead_silence=0.5, tail_silence=0.5)
    ok_path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    result = audio.inspect_row(
        audio.AudioManifestRow.model_validate(make_row(ok_path)), audio.AudioGatePolicy(), tmp_path
    )
    assert result["ok"] is True


def test_clipping_ratio_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "clipped.wav"
    raw = write_wav(path, 0.8, freq=220.0, amplitude=1.0, kind="square")
    path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    row = make_row(path)
    expect_check_error(row, "CLIPPING_EXCESSIVE", tmp_path)


def test_duration_bounds_are_enforced(tmp_path: Path) -> None:
    short_path = tmp_path / "short.wav"
    raw = write_wav(short_path, 0.05)
    short_path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    expect_check_error(make_row(short_path, min_seconds=1.0), "DURATION_OUT_OF_RANGE", tmp_path)

    long_path = tmp_path / "long.wav"
    raw = write_wav(long_path, 3.0)
    long_path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    expect_check_error(make_row(long_path, max_seconds=1.0), "DURATION_OUT_OF_RANGE", tmp_path)


def test_text_hash_metadata_must_match_the_content_record(tmp_path: Path) -> None:
    path = tmp_path / "meta.wav"
    raw = write_wav(path, 0.8)
    wrong = audio.with_info_comment(raw, "e" * 64)
    path.write_bytes(wrong)
    expect_check_error(make_row(path, wav_bytes=wrong), "TEXT_HASH_MISMATCH", tmp_path)

    # A file with no text_hash metadata at all fails the same check.
    path.write_bytes(raw)
    expect_check_error(make_row(path), "TEXT_HASH_MISMATCH", tmp_path)


def test_file_size_anomaly_check(tmp_path: Path) -> None:
    # 1.5 s at 24 kHz mono 16-bit ~= 72000 payload bytes.
    assert audio.check_size(72044, expected_bytes=72000) is None
    assert audio.check_size(64, expected_bytes=72000) == "FILE_SIZE_ANOMALY"
    assert audio.check_size(72_000_000, expected_bytes=72000) == "FILE_SIZE_ANOMALY"


# ---------------------------------------------------------------------------
# CLI boundary: manifest in, inspection JSONL out, single-line JSON errors
# ---------------------------------------------------------------------------


def write_manifest(tmp_path: Path, rows: list[dict]) -> Path:
    manifest = tmp_path / "audio" / "manifest.jsonl"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )
    return manifest


def run_inspect(tmp_path: Path, rows: list[dict]) -> None:
    manifest = write_manifest(tmp_path, rows)
    cli.main(
        [
            "inspect",
            "--manifest",
            str(manifest),
            "--out",
            str(tmp_path / "audio" / "inspection.jsonl"),
            "--policy",
            str(TTS_CONFIG_PATH),
        ]
    )


def test_inspect_cli_passes_valid_assets(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    rows: list[dict] = []
    for index, cache_key in enumerate(("a" * 64, "b" * 64)):
        path = tmp_path / "audio" / f"valid-{index}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = write_wav(path, 0.8 + index * 0.2)
        path.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
        rows.append(make_row(path, cache_key=cache_key))

    run_inspect(tmp_path, rows)

    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1  # exactly one JSON summary object on stdout
    summary = json.loads(lines[0])
    assert summary["ok"] is True
    assert summary["checked"] == 2
    inspection = tmp_path / "audio" / "inspection.jsonl"
    result_rows = [json.loads(line) for line in inspection.read_text().splitlines()]
    assert [row["cache_key"] for row in result_rows] == ["a" * 64, "b" * 64]
    assert all(row["ok"] for row in result_rows)
    assert all(row["text_sha256"] == TEXT_SHA for row in result_rows)


def test_inspect_cli_fails_machine_readable_and_writes_details(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "audio").mkdir(parents=True, exist_ok=True)
    good = tmp_path / "audio" / "good.wav"
    raw = write_wav(good, 0.8)
    good.write_bytes(audio.with_info_comment(raw, TEXT_SHA))
    bad = tmp_path / "audio" / "bad.wav"
    bad_raw = write_wav(bad, 0.8, amplitude=0.0)
    bad.write_bytes(audio.with_info_comment(bad_raw, TEXT_SHA))

    rows = [
        make_row(good, cache_key="a" * 64),
        make_row(bad, cache_key="b" * 64),
    ]
    with pytest.raises(SystemExit) as excinfo:
        run_inspect(tmp_path, rows)
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "AUDIO_INVALID"
    assert "b" * 12 in payload["message"]
    assert "ALL_SILENT" in payload["message"]

    # The per-row details are still on disk for the TS side to surface.
    inspection = tmp_path / "audio" / "inspection.jsonl"
    result_rows = [json.loads(line) for line in inspection.read_text().splitlines()]
    assert result_rows[0]["ok"] is True
    assert result_rows[1]["ok"] is False
    assert result_rows[1]["error"] == "ALL_SILENT"


def test_inspect_cli_reports_manifest_problems(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = tmp_path / "audio" / "manifest.jsonl"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("not json\n", encoding="utf-8")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "inspect",
                "--manifest",
                str(manifest),
                "--out",
                str(tmp_path / "audio" / "inspection.jsonl"),
                "--policy",
                str(TTS_CONFIG_PATH),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "AUDIO_MANIFEST_INVALID"
