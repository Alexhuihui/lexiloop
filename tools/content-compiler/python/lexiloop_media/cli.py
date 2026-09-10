"""Thin stdlib CLI for the media workers.

Every subcommand prints exactly ONE JSON summary object on stdout (logs and
errors go to stderr, errors as single-line JSON with a stable ``error`` code
and a non-zero exit). The TypeScript side spawns this module with an argument
array (``python -m lexiloop_media <command> ...``), parses the summary, and
validates the JSONL artifacts on disk before advancing the ledger.

There is deliberately no command that produces a PDF.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn, Sequence

import cv2
import numpy as np

from lexiloop_media import pdf_images, watermarks
from lexiloop_media.watermarks import WatermarkRule

MAX_PREVIEW_DIM = 1400


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def _emit(summary: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")


def _fail(code: str, message: str, exit_code: int = 2) -> NoReturn:
    sys.stderr.write(
        json.dumps({"error": code, "message": message}, ensure_ascii=False) + "\n"
    )
    raise SystemExit(exit_code)


def _parse_pages(value: str) -> list[int]:
    text = (value or "").strip()
    if text.lower() == "all":
        return []  # resolved by the caller against the document
    try:
        pages = [int(item) for item in text.split(",") if item.strip()]
    except ValueError as exc:
        raise ValueError(f"--pages must be a comma-separated list of integers: {exc}") from exc
    if not pages:
        raise ValueError("--pages is empty")
    if any(page < 1 for page in pages):
        raise ValueError("--pages must be 1-based page numbers")
    return pages


def _imread(path: Path) -> np.ndarray:
    # np.fromfile/imdecode keeps non-ASCII paths working everywhere.
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        _fail("IMAGE_UNREADABLE", f"cannot decode image: {path}")
    return image


def _imwrite(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buffer = cv2.imencode(path.suffix, image)
    if not ok:
        _fail("IMAGE_WRITE_FAILED", f"cannot encode image: {path}")
    buffer.tofile(str(path))


def _write_preview(path: Path, image: np.ndarray) -> None:
    height, width = image.shape[:2]
    scale = MAX_PREVIEW_DIM / max(height, width)
    preview = image if scale >= 1.0 else cv2.resize(image, (int(width * scale), int(height * scale)))
    ok, buffer = cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        _fail("IMAGE_WRITE_FAILED", f"cannot encode preview: {path}")
    buffer.tofile(str(path))


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------


def cmd_extract(args: argparse.Namespace) -> None:
    source = Path(args.source)
    if not source.is_file():
        _fail("SOURCE_NOT_FOUND", f"source PDF not found: {source}")
    out_dir = Path(args.out_dir)
    try:
        pages = _parse_pages(args.pages)
    except ValueError as exc:
        _fail("PAGES_INVALID", str(exc))
    if not pages:  # "all"
        import pymupdf

        handle = pymupdf.open(source)
        try:
            pages = list(range(1, handle.page_count + 1))
        finally:
            handle.close()
    try:
        records = pdf_images.extract_pages(
            source,
            pages,
            out_dir,
            dpi=args.dpi,
            pages_jsonl_path=out_dir / "pages.jsonl",
        )
    except pdf_images.SourcePageError as exc:
        _fail("PAGES_INVALID", str(exc))
    _emit(
        {
            "pages_jsonl": str((out_dir / "pages.jsonl").resolve()),
            "pages_dir": str((out_dir / "pages").resolve()),
            "pages": [record.model_dump() for record in records],
        }
    )


# ---------------------------------------------------------------------------
# clean
# ---------------------------------------------------------------------------


def cmd_clean(args: argparse.Namespace) -> None:
    pages_jsonl = Path(args.pages_jsonl)
    if not pages_jsonl.is_file():
        _fail("PAGES_JSONL_NOT_FOUND", f"pages.jsonl not found: {pages_jsonl}")
    try:
        rule: WatermarkRule = watermarks.load_rule(args.rule)
    except FileNotFoundError:
        _fail("RULE_NOT_FOUND", f"watermark rule not found: {args.rule}")
    except Exception as exc:  # pydantic.ValidationError and JSON errors
        _fail("RULE_INVALID", f"watermark rule invalid: {exc}")

    base_dir = pages_jsonl.parent
    try:
        extract_rows = pdf_images.read_jsonl(pages_jsonl)
    except ValueError as exc:
        _fail("PAGES_JSONL_INVALID", str(exc))
    try:
        extract_records = [pdf_images.PageRecord.model_validate(row) for row in extract_rows]
    except Exception as exc:
        _fail("PAGES_JSONL_INVALID", f"page record failed schema: {exc}")
    if not extract_records:
        _fail("PAGES_JSONL_EMPTY", f"no page records in {pages_jsonl}")

    # Pass 1 — streaming cross-page evidence: hold one page in memory at a
    # time and accumulate per-region ink counts, so a full 440-page run never
    # materializes the whole page-image pool. This matches
    # watermarks.confirm_regions exactly (same helper, same thresholds).
    matched = {region.name: 0 for region in rule.regions}
    with_ink = {region.name: 0 for region in rule.regions}
    for record in extract_records:
        image = _imread(base_dir / record.image_path)
        for region in rule.regions:
            if not region.page_selector.matches(record.page):
                continue
            matched[region.name] += 1
            if watermarks.region_has_ink(image, region, rule.evidence):
                with_ink[region.name] += 1
        del image
    confirmed = {
        name: matched[name] > 0
        and (with_ink[name] / matched[name]) >= rule.evidence.min_page_fraction
        for name in matched
    }

    out_dir = Path(args.out_dir)
    clean_dir = out_dir / "pages-clean"

    # Pass 2 — clean page by page with only the current page in memory; the
    # cross-page confirmation is computed once and reused for every page.
    clean_rows: list[dict[str, Any]] = []
    overlap_pages: list[int] = []
    for record in extract_records:
        original = _imread(base_dir / record.image_path)
        active = watermarks.active_regions_for(confirmed, rule, record.page)
        cleaned, mask = watermarks.clean_watermarks(
            original, rule, active_regions=active, page_number=record.page
        )
        outside = watermarks.changed_pixels_outside(original, cleaned, mask)
        if outside != 0:
            _fail(
                "CHANGES_OUTSIDE_MASK",
                f"page {record.page}: {outside} changed pixel(s) outside the declared mask",
            )
        overlap = watermarks.detect_body_overlap(original, mask, rule.evidence)
        if overlap:
            overlap_pages.append(record.page)
        cleaned_rel = f"pages-clean/page-{record.page:04d}.cleaned.png"
        changed = int(np.count_nonzero(np.any(original != cleaned, axis=2)))
        _imwrite(out_dir / cleaned_rel, cleaned)
        row = watermarks.CleanRecord(
            source_sha256=record.source_sha256,
            page=record.page,
            rule_version=rule.rule_version,
            original_image_path=record.image_path,
            original_image_sha256=record.image_sha256,
            cleaned_image_path=cleaned_rel,
            mask_bounds=list(watermarks.mask_bounds(mask)) if mask.any() else None,
            region_names=[region.name for region in active],
            changed_pixels=changed,
            changed_pixels_outside=outside,
            body_overlap_detected=overlap,
            cleaned_image_sha256=pdf_images.sha256_file(out_dir / cleaned_rel),
        ).model_dump()
        clean_rows.append(row)
        del original, cleaned

    pdf_images.write_jsonl(out_dir / "clean.jsonl", clean_rows)
    _emit(
        {
            "clean_jsonl": str((out_dir / "clean.jsonl").resolve()),
            "clean_dir": str(clean_dir.resolve()),
            "rule_version": rule.rule_version,
            "pages_cleaned": len(clean_rows),
            "body_overlap_pages": overlap_pages,
            "pages": clean_rows,
        }
    )


# ---------------------------------------------------------------------------
# qa-packets
# ---------------------------------------------------------------------------


def cmd_qa_packets(args: argparse.Namespace) -> None:
    clean_jsonl = Path(args.clean_jsonl)
    if not clean_jsonl.is_file():
        _fail("CLEAN_JSONL_NOT_FOUND", f"clean.jsonl not found: {clean_jsonl}")
    try:
        clean_rows = pdf_images.read_jsonl(clean_jsonl)
    except ValueError as exc:
        _fail("CLEAN_JSONL_INVALID", str(exc))

    pages_filter: set[int] | None = None
    if args.pages:
        try:
            pages_filter = set(_parse_pages(args.pages))
        except ValueError as exc:
            _fail("PAGES_INVALID", str(exc))

    base_dir = clean_jsonl.parent
    qa_dir = Path(args.out_dir)
    packets: list[dict[str, Any]] = []
    for row in clean_rows:
        page = int(row.get("page", 0))
        if pages_filter is not None and page not in pages_filter:
            continue
        packet_dir = qa_dir / f"page-{page:04d}"
        packet_dir.mkdir(parents=True, exist_ok=True)
        cleaned_image = base_dir / str(row.get("cleaned_image_path", ""))
        packet = {
            "page": page,
            "source_sha256": row.get("source_sha256"),
            "rule_version": row.get("rule_version"),
            "mask_bounds": row.get("mask_bounds"),
            "region_names": row.get("region_names"),
            "changed_pixels": row.get("changed_pixels"),
            "body_overlap_detected": row.get("body_overlap_detected"),
            "cleaned_image": str(cleaned_image.resolve()),
            "cleaned_preview": str((packet_dir / "cleaned-preview.jpg").resolve()),
        }
        original_row = row.get("original_image_path")
        if original_row:
            original_image = base_dir / str(original_row)
            packet["original_image"] = str(original_image.resolve())
            packet["original_preview"] = str((packet_dir / "original-preview.jpg").resolve())
            _write_preview(Path(packet["original_preview"]), _imread(original_image))
        _write_preview(Path(packet["cleaned_preview"]), _imread(cleaned_image))
        (packet_dir / "packet.json").write_text(
            json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        packets.append({**packet, "packet_json": str((packet_dir / "packet.json").resolve())})

    if pages_filter is not None and not packets:
        _fail("PAGES_INVALID", f"no cleaned pages matched: {sorted(pages_filter)}")

    pdf_images.write_jsonl(qa_dir / "packets.jsonl", packets)
    _emit(
        {
            "qa_dir": str(qa_dir.resolve()),
            "packets_jsonl": str((qa_dir / "packets.jsonl").resolve()),
            "packets": packets,
        }
    )


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def cmd_selftest_sleep(args: argparse.Namespace) -> None:
    """Bridge liveness/timeout probe: emits nothing, sleeps, exits 0."""
    import time

    time.sleep(args.seconds)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lexiloop_media",
        description="LexiLoop media workers: page extraction, watermark cleanup, QA packets",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    extract = sub.add_parser("extract", help="extract original page images from the source PDF")
    extract.add_argument("--source", required=True, help="path to the source PDF")
    extract.add_argument(
        "--pages", required=True, help="comma-separated 1-based page numbers, or 'all'"
    )
    extract.add_argument("--out-dir", required=True, help="per-source work directory")
    extract.add_argument("--dpi", type=int, default=300, help="DPI for the render fallback")
    extract.set_defaults(func=cmd_extract)

    clean = sub.add_parser("clean", help="remove watermarks strictly inside declared masks")
    clean.add_argument("--pages-jsonl", required=True, help="pages.jsonl from extract")
    clean.add_argument("--rule", required=True, help="versioned watermark rule JSON")
    clean.add_argument("--out-dir", required=True, help="per-source work directory")
    clean.set_defaults(func=cmd_clean)

    qa = sub.add_parser("qa-packets", help="emit visual-QA packets for cleaned pages")
    qa.add_argument("--clean-jsonl", required=True, help="clean.jsonl from clean")
    qa.add_argument("--pages", default="", help="optional comma-separated page filter")
    qa.add_argument("--out-dir", required=True, help="QA packet output directory")
    qa.set_defaults(func=cmd_qa_packets)

    sleep = sub.add_parser(
        "selftest-sleep",
        help="bridge test hook: sleep for --seconds then exit 0 (timeout probes)",
    )
    sleep.add_argument("--seconds", type=float, default=1.0)
    sleep.set_defaults(func=cmd_selftest_sleep)

    return parser


def main(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
