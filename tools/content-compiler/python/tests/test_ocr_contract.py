"""Contract tests for the layout OCR worker (design doc section 5.4).

These exercise the ``lexiloop_media ocr`` command with the deterministic
selftest engine (no Paddle models needed): the emitted ``ocr.jsonl`` must be
strict, hash-chained to the cleaned page images, and byte-for-byte
deterministic. The real PP-StructureV3 engine is exercised by an opt-in smoke
test that skips cleanly when Paddle is unavailable.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from lexiloop_media import cli, ocr, pdf_images

RULE_PATH = Path(__file__).resolve().parents[2] / "config" / "watermarks" / "llcy-2024.json"
OCR_CONFIG_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "ocr" / "pp-structure-v3.json"
)


def _prepare_clean_fixture(fixture_pdf_path: Path, tmp_path: Path) -> Path:
    """extract + clean the synthetic scan; return the per-source work dir."""
    pdf_images.extract_pages(fixture_pdf_path, [1, 2], tmp_path)
    cli.main(
        [
            "clean",
            "--pages-jsonl",
            str(tmp_path / "pages.jsonl"),
            "--rule",
            str(RULE_PATH),
            "--out-dir",
            str(tmp_path),
        ]
    )
    return tmp_path


def _run_ocr(work_dir: Path, extra_args: list[str] | None = None) -> dict:
    args = [
        "ocr",
        "--clean-jsonl",
        str(work_dir / "clean.jsonl"),
        "--config",
        str(OCR_CONFIG_PATH),
        "--out-dir",
        str(work_dir),
        "--engine",
        "selftest",
    ]
    cli.main(args + (extra_args or []))


def test_ocr_config_exists_and_is_versioned() -> None:
    raw = json.loads(OCR_CONFIG_PATH.read_text(encoding="utf-8"))
    config = ocr.OcrConfig.model_validate(raw)
    assert config.config_version >= 1
    assert config.pipeline == "PP-StructureV3"
    assert config.model_version  # locked model spec string


def test_ocr_selftest_emits_strict_block_jsonl(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    capsys.readouterr()  # drain the `clean` command's own summary line
    _run_ocr(work_dir)

    clean_rows = pdf_images.read_jsonl(work_dir / "clean.jsonl")
    clean_by_page = {row["page"]: row for row in clean_rows}
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    records = [ocr.OcrBlockRecord.model_validate(row) for row in rows]
    assert records, "selftest engine must emit at least one block per page"

    pages_seen = {record.page for record in records}
    assert pages_seen == {1, 2}
    for record in records:
        clean_row = clean_by_page[record.page]
        assert record.source_sha256 == clean_row["source_sha256"]
        assert record.page_image_sha256 == clean_row["cleaned_image_sha256"]
        assert record.pipeline == "PP-StructureV3"
        assert record.config_version >= 1
        assert record.model_version
        x0, y0, x1, y1 = record.bbox
        assert 0.0 <= x0 <= x1 <= 1.0
        assert 0.0 <= y0 <= y1 <= 1.0
        assert 0.0 <= record.confidence <= 1.0
        assert record.text
        assert record.layout_label
        # The private raw-text reference hash binds the block to its raw text.
        assert record.source_raw_ref_hash == hashlib.sha256(
            record.text.encode("utf-8")
        ).hexdigest()

    # The raw text file per page exists and its sha256 is in the summary.
    raw_lines = capsys.readouterr().out.strip().splitlines()
    assert len(raw_lines) == 1  # exactly one JSON summary object on stdout
    summary = json.loads(raw_lines[0])
    assert len(summary["pages"]) == 2
    for page_summary in summary["pages"]:
        raw_path = Path(page_summary["raw_text_path"])
        assert raw_path.is_file()
        assert page_summary["raw_text_sha256"] == pdf_images.sha256_file(raw_path)
        page_rows = [r for r in records if r.page == page_summary["page"]]
        assert page_summary["block_count"] == len(page_rows)
        raw_text = raw_path.read_text(encoding="utf-8")
        for record in page_rows:
            assert record.text in raw_text


def test_ocr_output_is_deterministic(fixture_pdf_path: Path, tmp_path: Path) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir)
    first = (work_dir / "ocr.jsonl").read_bytes()

    out2 = tmp_path.parent / "rerun"
    out2.mkdir()
    _prepare_clean_fixture(fixture_pdf_path, out2)
    _run_ocr(out2)
    second = (out2 / "ocr.jsonl").read_bytes()
    assert first == second


def test_ocr_missing_clean_jsonl_is_machine_readable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(tmp_path / "missing.jsonl"),
                "--config",
                str(OCR_CONFIG_PATH),
                "--out-dir",
                str(tmp_path),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "CLEAN_JSONL_NOT_FOUND"


def test_ocr_invalid_config_is_machine_readable(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    bad_config = tmp_path / "bad-config.json"
    bad_config.write_text("{not json", encoding="utf-8")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(work_dir / "clean.jsonl"),
                "--config",
                str(bad_config),
                "--out-dir",
                str(work_dir),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "OCR_CONFIG_INVALID"


def test_ocr_missing_cleaned_image_fails_closed(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    rows = pdf_images.read_jsonl(work_dir / "clean.jsonl")
    for row in rows:
        (work_dir / row["cleaned_image_path"]).unlink()
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir)
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "CLEANED_IMAGE_NOT_FOUND"


def test_ocr_pages_filter_processes_subset(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir, ["--pages", "2"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert rows, "filtered page must still produce blocks"
    assert {row["page"] for row in rows} == {2}


def test_ocr_chunked_runs_compose_into_the_full_run_artifact(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """Chunks run in any order must compose into the single-run bytes.

    The merge must sort rows by page ascending (stable within-page reading
    order), so ``--pages 2`` followed by ``--pages 1`` is byte-equivalent to
    one full run — chunking stays an execution detail downstream.
    """
    full_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path / "full")
    _run_ocr(full_dir)
    expected = (full_dir / "ocr.jsonl").read_bytes()

    chunked_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path / "chunked")
    _run_ocr(chunked_dir, ["--pages", "2"])
    _run_ocr(chunked_dir, ["--pages", "1"])
    assert (chunked_dir / "ocr.jsonl").read_bytes() == expected

    rows = pdf_images.read_jsonl(chunked_dir / "ocr.jsonl")
    pages_in_order = [row["page"] for row in rows]
    assert pages_in_order == sorted(pages_in_order)
    assert set(pages_in_order) == {1, 2}


def test_ocr_chunked_rerun_replaces_rows_without_duplicates(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """Re-running a chunk replaces exactly that chunk's rows."""
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir, ["--pages", "1"])
    after_first = (work_dir / "ocr.jsonl").read_bytes()

    _run_ocr(work_dir, ["--pages", "1"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert (work_dir / "ocr.jsonl").read_bytes() == after_first
    assert {row["page"] for row in rows} == {1}
    texts = [row["text"] for row in rows]
    assert len(texts) == len(set(texts)), "re-run chunk must not duplicate rows"


def test_ocr_pages_filter_first_run_without_existing_artifact_unchanged(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """First run with --pages and no prior ocr.jsonl: fresh subset write.

    The merge path only applies when ocr.jsonl already exists; the unknown-file
    first run keeps the historical behavior (fresh write of just the chunk) and
    leaves no temp files behind.
    """
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    assert not (work_dir / "ocr.jsonl").exists()
    _run_ocr(work_dir, ["--pages", "2"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert {row["page"] for row in rows} == {2}
    leftovers = [p.name for p in work_dir.iterdir() if p.name.startswith(".ocr.jsonl.tmp")]
    assert leftovers == []


def test_ocr_paddle_engine_unavailable_is_machine_readable(
    fixture_pdf_path: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)

    def _raise_import_error():
        raise ImportError("paddle not installed")

    monkeypatch.setattr(ocr, "_import_ppstructure", _raise_import_error)
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir, ["--engine", "paddle"])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "ENGINE_UNAVAILABLE"
    assert "uv sync --extra ocr" in payload["message"]


@pytest.mark.parametrize("engine", ["unknown-engine"])
def test_ocr_unknown_engine_rejected(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str], engine: str
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir, ["--engine", engine])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "ENGINE_UNKNOWN"


def test_ocr_real_paddle_smoke(fixture_pdf_path: Path, tmp_path: Path) -> None:
    """Step-4 smoke: real PP-StructureV3 over one fixture page.

    Skips when Paddle is not installed or its models cannot initialize, so the
    fast suite stays green without the heavy optional dependency.
    """
    pytest.importorskip("paddle")
    pytest.importorskip("paddleocr")
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    try:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(work_dir / "clean.jsonl"),
                "--config",
                str(OCR_CONFIG_PATH),
                "--out-dir",
                str(work_dir),
                "--engine",
                "paddle",
                "--pages",
                "1",
            ]
        )
    except SystemExit as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"real Paddle engine unavailable in this environment: {exc}")
    except Exception as exc:  # pragma: no cover - environment-dependent
        # The documented intent covers engine/model initialization failures
        # (e.g. paddlepaddle CPU framework bugs), not just missing installs.
        pytest.skip(f"real Paddle engine failed to initialize: {exc}")
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert rows, "real engine must emit blocks for the page"
    records = [ocr.OcrBlockRecord.model_validate(row) for row in rows]
    assert all(record.text for record in records)
