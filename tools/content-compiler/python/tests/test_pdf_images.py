"""Tests for original page-image extraction (spec 5.3).

Extraction must pull each page's dominant embedded image without re-encoding
when possible (rendering once at a configured DPI only as a fallback), emit a
validated ``pages.jsonl`` with PDF hash, page index, dimensions, image hash,
extraction method, and file path, and never expose any API that writes a PDF.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pydantic
import pytest

from lexiloop_media import pdf_images


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Fixture sanity
# ---------------------------------------------------------------------------


def test_fixture_is_a_two_page_image_scan(fixture_pdf_path: Path) -> None:
    import pymupdf

    doc = pymupdf.open(fixture_pdf_path)
    try:
        assert doc.page_count == 2
        for page in doc:
            assert len(page.get_images(full=True)) == 1  # one full-page raster
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def test_extract_preserves_requested_page_order(extracted: dict) -> None:
    records = extracted["records"]
    assert [record.page for record in records] == [1, 2]
    # Distinct pages carry distinct rasters.
    assert records[0].image_sha256 != records[1].image_sha256


def test_extract_prefers_dominant_embedded_image_without_reencoding(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    records = pdf_images.extract_pages(fixture_pdf_path, [1], tmp_path)
    assert len(records) == 1
    record = records[0]
    # The fixture embeds one full-page PNG per page: extraction must reuse it
    # instead of rendering, and must not re-encode it into another format.
    assert record.method == "embedded"
    assert record.dpi is None
    assert record.ext == "png"

    image_file = tmp_path / record.image_path
    assert image_file.is_file()
    assert _sha256_file(image_file) == record.image_sha256
    assert (record.width_px, record.height_px) == (1240, 1754)  # original raster size

    import pymupdf

    doc = pymupdf.open(fixture_pdf_path)
    try:
        original = doc.extract_image(doc[0].get_images(full=True)[0][0])["image"]
    finally:
        doc.close()
    assert hashlib.sha256(original).hexdigest() == record.image_sha256  # byte-identical


def test_extract_can_render_once_at_configured_dpi(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    records = pdf_images.extract_pages(fixture_pdf_path, [1], tmp_path, prefer_render=True, dpi=150)
    record = records[0]
    assert record.method == "rendered"
    assert record.dpi == 150
    assert record.ext == "png"
    image_file = tmp_path / record.image_path
    assert image_file.is_file()
    assert _sha256_file(image_file) == record.image_sha256
    # 595pt x 842pt at 150 dpi (±2 px rounding).
    assert abs(record.width_px - 1240) <= 2 and abs(record.height_px - 1754) <= 2


def test_pages_jsonl_has_required_fields(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    jsonl_path = tmp_path / "pages.jsonl"
    pdf_images.extract_pages(fixture_pdf_path, [1, 2], tmp_path, pages_jsonl_path=jsonl_path)

    lines = jsonl_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    expected_keys = {
        "source_sha256",
        "page",
        "width_px",
        "height_px",
        "method",
        "image_sha256",
        "image_path",
        "dpi",
        "ext",
    }
    for line, page_number in zip(lines, [1, 2], strict=True):
        record = json.loads(line)
        assert set(record) == expected_keys
        assert record["page"] == page_number
        assert record["source_sha256"] == _sha256_file(fixture_pdf_path)
        assert re.fullmatch(r"[0-9a-f]{64}", record["image_sha256"])
        assert (tmp_path / record["image_path"]).is_file()
        assert record["method"] in {"embedded", "rendered"}


def test_extract_rejects_out_of_range_page_numbers(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    with pytest.raises(ValueError, match="page"):
        pdf_images.extract_pages(fixture_pdf_path, [3], tmp_path)
    with pytest.raises(ValueError, match="page"):
        pdf_images.extract_pages(fixture_pdf_path, [0], tmp_path)


def test_extract_rejects_duplicate_pages(fixture_pdf_path: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="duplicate"):
        pdf_images.extract_pages(fixture_pdf_path, [1, 1], tmp_path)


# ---------------------------------------------------------------------------
# Automatic render fallback (every embedded-extraction bail-out)
# ---------------------------------------------------------------------------


def test_render_fallback_rotated_page(render_fallback_pdf_path: Path, tmp_path: Path) -> None:
    (record,) = pdf_images.extract_pages(render_fallback_pdf_path, [1], tmp_path)
    assert record.page == 1
    assert record.method == "rendered"
    assert record.dpi == 300
    assert record.ext == "png"
    assert _sha256_file(tmp_path / record.image_path) == record.image_sha256


def test_render_fallback_tiled_half_page_images(
    render_fallback_pdf_path: Path, tmp_path: Path
) -> None:
    (record,) = pdf_images.extract_pages(render_fallback_pdf_path, [2], tmp_path)
    assert record.page == 2
    assert record.method == "rendered"  # two ~50% images: no >=98% dominant


def test_render_fallback_transparent_smask_image(
    render_fallback_pdf_path: Path, tmp_path: Path
) -> None:
    (record,) = pdf_images.extract_pages(render_fallback_pdf_path, [3], tmp_path)
    assert record.page == 3
    assert record.method == "rendered"  # image carries a soft mask


def test_render_fallback_cmyk_colorspace(render_fallback_pdf_path: Path, tmp_path: Path) -> None:
    (record,) = pdf_images.extract_pages(render_fallback_pdf_path, [4], tmp_path)
    assert record.page == 4
    assert record.method == "rendered"  # DeviceCMYK separation


def test_render_fallback_preserves_page_count_order_and_hashes(
    render_fallback_pdf_path: Path, tmp_path: Path
) -> None:
    records = pdf_images.extract_pages(render_fallback_pdf_path, [4, 3, 2, 1], tmp_path)
    assert [record.page for record in records] == [4, 3, 2, 1]  # requested order
    assert all(record.method == "rendered" for record in records)
    hashes = {record.image_sha256 for record in records}
    assert len(hashes) == 4  # distinct rasters
    for record in records:
        assert (tmp_path / record.image_path).is_file()
        assert _sha256_file(tmp_path / record.image_path) == record.image_sha256
    jsonl_rows = pdf_images.read_jsonl(tmp_path / "pages.jsonl")
    assert [row["page"] for row in jsonl_rows] == [4, 3, 2, 1]


# ---------------------------------------------------------------------------
# No PDF writer anywhere (spec: never reassemble a PDF from source material)
# ---------------------------------------------------------------------------


def test_media_package_contains_no_pdf_writer_or_pdf_output_path() -> None:
    package_dir = Path(pdf_images.__file__).resolve().parent
    forbidden_apis = (
        "convert_to_pdf",
        "writePDF",
        "insert_pdf",
        "xbf_sha_pdf",  # paranoia guard
    )
    forbidden_literals = ('.pdf"', "'.pdf'", ".PDF")
    forbidden_calls = ("save_pdf", "write_pdf", "export_pdf", "to_pdf")
    for source_file in sorted(package_dir.rglob("*.py")):
        text = source_file.read_text(encoding="utf-8")
        for needle in forbidden_apis + forbidden_literals + forbidden_calls:
            assert needle not in text, f"{source_file.name} must not contain {needle!r}"
        # No `doc.save(`/`document.save(` style call that could emit a PDF.
        assert not re.search(r"\b(doc(ument)?\.save)\s*\(", text), source_file.name


def test_page_record_model_rejects_bad_method() -> None:
    with pytest.raises(pydantic.ValidationError):
        pdf_images.PageRecord(
            source_sha256="a" * 64,
            page=1,
            width_px=10,
            height_px=10,
            method="reencoded",  # type: ignore[arg-type]
            image_sha256="b" * 64,
            image_path="pages/p.png",
            dpi=None,
            ext="png",
        )
