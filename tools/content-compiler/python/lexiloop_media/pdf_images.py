"""Original page-image extraction (design doc section 5.3).

The source is a pure image scan: each page mainly carries one embedded
picture and no reusable text layer. Extraction therefore pulls the page's
dominant embedded image *without re-encoding* (the original stream bytes are
written verbatim); when no single image covers the page (or the page needs
rotation/transparency/colorspace handling), the page is rendered exactly once
at a configured DPI into a lossless PNG.

For every requested page a record is emitted (JSONL) holding the PDF hash,
1-based page index, pixel dimensions, image hash, extraction method, and the
relative file path of the extracted image.

This module never writes a PDF: it only reads the source and writes page
image files (see the source-scanning test in the test suite).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal, Sequence

import pydantic
import pymupdf

Method = Literal["embedded", "rendered"]

# Embedded streams we may keep verbatim. Anything exotic (JBIG2/CCITT raw,
# unsupported containers) falls back to a single lossless render.
ALLOWED_EMBEDDED_EXT = {"png", "jpeg", "jpg", "jp2", "jpx", "tiff", "bmp"}
DOMINANT_COVERAGE = 0.98
_HASH_PATTERN = pydantic.Field(pattern=r"^[0-9a-f]{64}$")


class PageRecord(pydantic.BaseModel):
    """One line of ``pages.jsonl`` (paths relative to its own directory)."""

    model_config = pydantic.ConfigDict(extra="forbid")

    source_sha256: str = _HASH_PATTERN
    page: int = pydantic.Field(ge=1)
    width_px: int = pydantic.Field(ge=1)
    height_px: int = pydantic.Field(ge=1)
    method: Method
    image_sha256: str = _HASH_PATTERN
    image_path: str = pydantic.Field(min_length=1)
    dpi: int | None = None
    ext: str = pydantic.Field(min_length=1)


class SourcePageError(ValueError):
    """Raised for invalid page selections (out of range, duplicated, ...)."""


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------


def write_jsonl(path: str | Path, rows: Sequence[dict[str, Any]]) -> None:
    jsonl_path = Path(path)
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    with open(jsonl_path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    """Parse a JSONL file, raising ``ValueError`` with the offending line."""
    jsonl_path = Path(path)
    rows: list[dict[str, Any]] = []
    with open(jsonl_path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{jsonl_path}: line {number} is not valid JSON: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"{jsonl_path}: line {number} is not a JSON object")
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _dominant_embedded_xref(page: "pymupdf.Page") -> int | None:
    """XRef of the single image covering the page, or None.

    Scans frequently tile pages or layer masks; only a lone image covering
    (almost) the entire page qualifies for verbatim extraction.
    """
    if page.rotation != 0:
        return None  # rotated placement: render instead of guessing orientation
    page_area = abs(page.rect)
    if page_area <= 0:
        return None
    candidates: list[int] = []
    for image in page.get_images(full=True):
        xref = image[0]
        rects = page.get_image_rects(xref)
        if not rects:
            continue
        covered = sum(abs(rect & page.rect) for rect in rects)
        if covered / page_area >= DOMINANT_COVERAGE:
            candidates.append(xref)
    if len(candidates) == 1:
        return candidates[0]
    return None


def _extract_embedded(
    doc: "pymupdf.Document",
    page_number: int,
    xref: int,
    source_sha256: str,
    out_dir: Path,
    rel_prefix: str = "",
) -> PageRecord | None:
    """Write the embedded stream verbatim; None when it needs special care."""
    info = doc.extract_image(xref)
    ext = info.get("ext", "")
    if ext not in ALLOWED_EMBEDDED_EXT:
        return None
    if info.get("smask", 0):
        return None  # soft mask (transparency) — render the composited page
    if info.get("colorspace") not in (1, 3):
        return None  # CMYK/ICC separations — render instead
    image_path = f"{rel_prefix}page-{page_number:04d}.original.{ext}"
    (out_dir / image_path).parent.mkdir(parents=True, exist_ok=True)
    (out_dir / image_path).write_bytes(info["image"])
    return PageRecord(
        source_sha256=source_sha256,
        page=page_number,
        width_px=int(info["width"]),
        height_px=int(info["height"]),
        method="embedded",
        image_sha256=sha256_bytes(info["image"]),
        image_path=image_path,
        dpi=None,
        ext=ext,
    )


def _render_page(
    page: "pymupdf.Page",
    page_number: int,
    source_sha256: str,
    out_dir: Path,
    dpi: int,
    rel_prefix: str = "",
) -> PageRecord:
    """Render the page exactly once at ``dpi`` into a lossless PNG."""
    pixmap = page.get_pixmap(dpi=dpi, alpha=False, colorspace=pymupdf.csRGB)
    image_path = f"{rel_prefix}page-{page_number:04d}.rendered.png"
    destination = out_dir / image_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    pixmap.save(str(destination))
    return PageRecord(
        source_sha256=source_sha256,
        page=page_number,
        width_px=pixmap.width,
        height_px=pixmap.height,
        method="rendered",
        image_sha256=sha256_bytes((out_dir / image_path).read_bytes()),
        image_path=image_path,
        dpi=dpi,
        ext="png",
    )


def extract_page(
    doc: "pymupdf.Document",
    page_number: int,
    source_sha256: str,
    out_dir: Path,
    dpi: int = 300,
    prefer_render: bool = False,
    rel_prefix: str = "",
) -> PageRecord:
    page_count = doc.page_count
    if not 1 <= page_number <= page_count:
        raise SourcePageError(
            f"page {page_number} out of range (document has {page_count} page(s))"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    page = doc[page_number - 1]
    if not prefer_render:
        xref = _dominant_embedded_xref(page)
        if xref is not None:
            record = _extract_embedded(
                doc, page_number, xref, source_sha256, out_dir, rel_prefix
            )
            if record is not None:
                return record
    return _render_page(page, page_number, source_sha256, out_dir, dpi, rel_prefix)


def extract_pages(
    pdf_path: str | Path,
    pages: Sequence[int],
    out_dir: str | Path,
    dpi: int = 300,
    prefer_render: bool = False,
    pages_jsonl_path: str | Path | None = None,
) -> list[PageRecord]:
    """Extract the requested 1-based pages in the requested order.

    ``out_dir`` is the per-source work directory: images land under
    ``<out_dir>/pages/`` and ``pages.jsonl`` under ``<out_dir>/``; every
    record's ``image_path`` is relative to the JSONL's own directory (e.g.
    ``pages/page-0001.original.jpeg``).
    """
    requested = list(pages)
    if len(set(requested)) != len(requested):
        raise SourcePageError(f"duplicate page number(s) in request: {requested}")
    if not requested:
        raise SourcePageError("page request is empty")
    source = Path(pdf_path)
    if not source.is_file():
        raise FileNotFoundError(f"source PDF not found: {source}")

    work_dir = Path(out_dir)
    source_sha256 = sha256_file(source)
    doc = pymupdf.open(source)
    try:
        records = [
            extract_page(
                doc,
                page_number,
                source_sha256,
                work_dir,
                dpi=dpi,
                prefer_render=prefer_render,
                rel_prefix="pages/",
            )
            for page_number in requested
        ]
    finally:
        doc.close()

    jsonl_path = Path(pages_jsonl_path) if pages_jsonl_path else work_dir / "pages.jsonl"
    write_jsonl(jsonl_path, [record.model_dump() for record in records])
    return records
