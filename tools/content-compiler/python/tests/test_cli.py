"""End-to-end tests for the media CLI itself (``lexiloop_media`` argparse).

These execute the real ``cmd_extract``/``cmd_clean`` code paths against the
synthetic fixture and assert the emitted artifacts (pages.jsonl, cleaned
images, clean.jsonl rows parsing into the pydantic ``CleanRecord`` model).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from lexiloop_media import cli, pdf_images, watermarks

RULE_PATH = Path(__file__).resolve().parents[2] / "config" / "watermarks" / "llcy-2024.json"


def test_cli_clean_end_to_end_on_fixture(fixture_pdf_path: Path, tmp_path: Path) -> None:
    out_dir = tmp_path / "work"
    pdf_images.extract_pages(fixture_pdf_path, [1, 2], out_dir)

    cli.main(
        [
            "clean",
            "--pages-jsonl",
            str(out_dir / "pages.jsonl"),
            "--rule",
            str(RULE_PATH),
            "--out-dir",
            str(out_dir),
        ]
    )

    rows = pdf_images.read_jsonl(out_dir / "clean.jsonl")
    records = [watermarks.CleanRecord.model_validate(row) for row in rows]
    assert [record.page for record in records] == [1, 2]
    for record in records:
        assert record.changed_pixels_outside == 0
        assert record.changed_pixels > 0  # watermark ink was removed
        assert record.cleaned_image_sha256 == pdf_images.sha256_file(
            out_dir / record.cleaned_image_path
        )
        assert record.original_image_sha256 == pdf_images.sha256_file(
            out_dir / record.original_image_path
        )
        assert (out_dir / record.cleaned_image_path).is_file()
    # The 2-page fixture's top banner differs per page -> distinct rasters.
    assert records[0].cleaned_image_sha256 != records[1].cleaned_image_sha256


def test_cli_clean_reports_machine_readable_errors(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "clean",
                "--pages-jsonl",
                str(tmp_path / "missing.jsonl"),
                "--rule",
                str(RULE_PATH),
                "--out-dir",
                str(tmp_path),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip())
    assert payload["error"] == "PAGES_JSONL_NOT_FOUND"


def test_cli_extract_summary_is_single_json_line(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(
        [
            "extract",
            "--source",
            str(fixture_pdf_path),
            "--pages",
            "1,2",
            "--out-dir",
            str(tmp_path),
        ]
    )
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1  # exactly one JSON summary object on stdout
    summary = json.loads(lines[0])
    assert [page["page"] for page in summary["pages"]] == [1, 2]
    assert (tmp_path / "pages.jsonl").is_file()


# ---------------------------------------------------------------------------
# fingerprint (source inventory: sha-256 + page count, read-only)
# ---------------------------------------------------------------------------


def test_cli_fingerprint_reports_hash_and_page_count(
    fixture_pdf_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["fingerprint", "--source", str(fixture_pdf_path)])
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1  # exactly one JSON summary object on stdout
    summary = json.loads(lines[0])
    assert summary["algorithm"] == "sha256"
    assert summary["source_sha256"] == pdf_images.sha256_file(fixture_pdf_path)
    assert summary["page_count"] == 2


def test_cli_fingerprint_missing_source_fails_closed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["fingerprint", "--source", str(tmp_path / "missing.pdf")])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip())
    assert payload["error"] == "SOURCE_NOT_FOUND"


def test_cli_fingerprint_non_pdf_fails_closed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    not_a_pdf = tmp_path / "not-a-pdf.pdf"
    not_a_pdf.write_bytes(b"definitely not a pdf")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["fingerprint", "--source", str(not_a_pdf)])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip())
    assert payload["error"] == "SOURCE_UNREADABLE"
