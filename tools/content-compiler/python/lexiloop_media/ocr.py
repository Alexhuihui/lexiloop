"""Layout OCR worker: PP-StructureV3 over cleaned page images (design 5.4).

Reads the ``clean.jsonl`` manifest written by the watermark worker, runs the
locked PP-StructureV3 pipeline over every cleaned page image, and writes:

- ``ocr.jsonl``: one STRICT ``OcrBlockRecord`` per OCR text line — model/config
  version, source + page image SHA-256, 1-based page, normalized bbox, layout
  label, raw OCR text, confidence, and ``source_raw_ref_hash`` (the SHA-256 of
  the block's raw text, binding the row to the private raw-text artifact).
- ``ocr-raw/page-NNNN.txt``: the per-page raw OCR text (private provenance).

The raw OCR text is immutable source evidence: downstream agents may only add
separate correction records, never rewrite these rows (design 5.4).

Errors are single-line JSON on stderr with a stable ``error`` code and exit
code 2; the run summary is a single JSON object on stdout. The ``selftest``
engine derives deterministic synthetic blocks from the page image hash so the
contract tests need no Paddle models. Nothing here ever writes a PDF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pydantic

from lexiloop_media import pdf_images

_HASH_PATTERN = pydantic.Field(pattern=r"^[0-9a-f]{64}$")

#: Bounding boxes and confidences are rounded to this many decimals so the
#: selftest engine stays byte-deterministic across runs and platforms.
COORD_DECIMALS = 6


def _fail(code: str, message: str) -> None:
    sys.stderr.write(json.dumps({"error": code, "message": message}, ensure_ascii=False) + "\n")
    raise SystemExit(2)


class OcrConfig(pydantic.BaseModel):
    """Versioned PP-StructureV3 pipeline configuration (config/ocr/*.json)."""

    model_config = pydantic.ConfigDict(extra="ignore")

    config_version: int = pydantic.Field(ge=1)
    pipeline: str = pydantic.Field(min_length=1)
    pipeline_version: str = pydantic.Field(min_length=1)
    model_version: str = pydantic.Field(min_length=1)
    device: str = "cpu"
    #: Keyword arguments passed verbatim to the PPStructureV3 constructor.
    engine_params: dict[str, Any] = pydantic.Field(default_factory=dict)


class OcrBlockRecord(pydantic.BaseModel):
    """One strict row of ``ocr.jsonl`` (the TS side re-validates every line)."""

    model_config = pydantic.ConfigDict(extra="forbid")

    schema_version: int = 1
    pipeline: str = pydantic.Field(min_length=1)
    pipeline_version: str = pydantic.Field(min_length=1)
    model_version: str = pydantic.Field(min_length=1)
    config_version: int = pydantic.Field(ge=1)
    source_sha256: str = _HASH_PATTERN
    page: int = pydantic.Field(ge=1)
    page_image_sha256: str = _HASH_PATTERN
    bbox: tuple[float, float, float, float]
    layout_label: str = pydantic.Field(min_length=1)
    text: str = pydantic.Field(min_length=1)
    confidence: float = pydantic.Field(ge=0.0, le=1.0)
    #: SHA-256 of the block's raw OCR text (utf-8); the raw text itself stays
    #: in the private per-page raw files referenced by the run summary.
    source_raw_ref_hash: str = _HASH_PATTERN

    @pydantic.field_validator("bbox")
    @classmethod
    def _check_bbox(cls, value: tuple[float, ...]) -> tuple[float, ...]:
        x0, y0, x1, y1 = value
        if not all(0.0 <= v <= 1.0 for v in value):
            raise ValueError("bbox coordinates must lie in [0,1]")
        if x1 < x0 or y1 < y0:
            raise ValueError("bbox must satisfy x1 >= x0 and y1 >= y0")
        return value


def _round(value: float) -> float:
    return round(float(value), COORD_DECIMALS)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Selftest engine: deterministic synthetic blocks (no Paddle required)
# ---------------------------------------------------------------------------


def selftest_blocks(
    source_sha256: str, page: int, page_image_sha256: str
) -> list[dict[str, Any]]:
    """Derive deterministic blocks from the page image hash.

    The block count, bboxes, confidences, and texts are pure functions of
    ``(source_sha256, page, page_image_sha256)``, so the same cleaned page
    always yields byte-identical ``ocr.jsonl`` output.
    """
    seed = hashlib.sha256(
        f"{source_sha256}:{page}:{page_image_sha256}".encode("utf-8")
    ).digest()
    labels = ["title", "text", "text", "text", "text", "header", "footer"]
    rows: list[dict[str, Any]] = []
    for index in range(3 + seed[0] % 4):
        block_seed = hashlib.sha256(seed + bytes([index])).digest()
        x0 = 0.04 + (block_seed[0] / 255.0) * 0.4
        y0 = 0.04 + (block_seed[1] / 255.0) * 0.7
        x1 = min(0.98, x0 + 0.08 + (block_seed[2] / 255.0) * 0.3)
        y1 = min(0.99, y0 + 0.01 + (block_seed[3] / 255.0) * 0.06)
        confidence = 0.75 + (block_seed[4] / 255.0) * 0.24
        text = f"selftest p{page} b{index} government 词块 {index:02d}"
        rows.append(
            {
                "bbox": (_round(x0), _round(y0), _round(x1), _round(y1)),
                "layout_label": labels[index % len(labels)],
                "text": text,
                "confidence": _round(confidence),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Real Paddle engine
# ---------------------------------------------------------------------------

# paddlepaddle 3.x CPU builds crash inside the oneDNN instruction builder of
# the new PIR executor ("ConvertPirAttribute2RuntimeAttribute not support").
# paddlex picks run_mode=mkldnn on CPU by default; default to the plain
# `paddle` path instead (deterministic, avoids the crash). Operators can
# still opt back into MKLDNN by exporting the variable explicitly.
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")


def _import_ppstructure() -> type:
    """Import and return the PPStructureV3 pipeline class.

    Split into a module-level function so tests can monkeypatch it to prove
    the ENGINE_UNAVAILABLE path without installing Paddle.
    """
    from paddleocr import PPStructureV3

    return PPStructureV3


def _result_to_dict(result: Any) -> dict[str, Any]:
    """Normalize a pipeline result sample into a plain dict."""
    if isinstance(result, dict):
        return result
    json_attr = getattr(result, "json", None)
    if callable(json_attr):
        return dict(json_attr())
    if isinstance(json_attr, dict):
        return dict(json_attr)
    to_json = getattr(result, "to_json", None)
    if callable(to_json):
        return dict(to_json())
    raise TypeError(f"unsupported PP-StructureV3 result type: {type(result).__name__}")


def _layout_label_for(
    center_x: float,
    center_y: float,
    layout_boxes: list[dict[str, Any]],
    image_width: int,
    image_height: int,
) -> str:
    """Smallest layout region containing the text-line center, else 'text'."""
    best_label = "text"
    best_area = float("inf")
    for box in layout_boxes:
        bbox = box.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        nx0 = float(bbox[0]) / image_width
        ny0 = float(bbox[1]) / image_height
        nx1 = float(bbox[2]) / image_width
        ny1 = float(bbox[3]) / image_height
        if not (nx0 <= center_x <= nx1 and ny0 <= center_y <= ny1):
            continue
        area = max(0.0, nx1 - nx0) * max(0.0, ny1 - ny0)
        if area < best_area:
            best_area = area
            best_label = str(box.get("label") or "text")
    return best_label


def _as_array(value: Any) -> "np.ndarray":
    """Convert a possibly-None pipeline field to a 2D ndarray safely."""
    return np.asarray([] if value is None else value, dtype=object).reshape(-1)


def paddle_blocks(
    pipeline: Any,
    image: "np.ndarray",
) -> list[dict[str, Any]]:
    """Run one cleaned page image through PP-StructureV3 and emit block rows.

    One row per recognized text line (``overall_ocr_res``); the layout role is
    the smallest layout-detection region (``layout_det_res``) containing the
    line's center, defaulting to ``text``.
    """
    height, width = image.shape[:2]
    results = pipeline.predict(image)
    if not results:
        return []
    data = _result_to_dict(results[0])
    layout_det = data.get("layout_det_res") or {}
    layout_boxes = list(layout_det.get("boxes") or [])
    ocr = data.get("overall_ocr_res") or {}
    texts = _as_array(ocr.get("rec_texts")).tolist()
    scores = _as_array(ocr.get("rec_scores")).tolist()
    boxes = np.asarray(
        [] if ocr.get("rec_boxes") is None else ocr.get("rec_boxes"), dtype=float
    ).reshape(-1, 4)

    rows: list[dict[str, Any]] = []
    for text, score, bbox in zip(texts, scores, boxes):
        raw = str(text).strip()
        if not raw:
            continue
        x0, y0, x1, y1 = (float(v) for v in bbox)
        nx0 = min(1.0, max(0.0, x0 / width))
        ny0 = min(1.0, max(0.0, y0 / height))
        nx1 = min(1.0, max(0.0, x1 / width))
        ny1 = min(1.0, max(0.0, y1 / height))
        rows.append(
            {
                "bbox": (_round(nx0), _round(ny0), _round(nx1), _round(ny1)),
                "layout_label": _layout_label_for(
                    (nx0 + nx1) / 2.0, (ny0 + ny1) / 2.0, layout_boxes, width, height
                ),
                "text": raw,
                "confidence": _round(min(1.0, max(0.0, float(score)))),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Engine run
# ---------------------------------------------------------------------------


def _reading_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    """Deterministic in-page order: left column, then right, top to bottom.

    Full-width blocks (spanning the page center) come first so unit-title
    banners precede their column content; ties break on the raw text.
    """
    x0, y0, x1, _ = row["bbox"]
    center = 0.5
    if x0 < center and x1 > center:
        column = 0
    elif x1 <= center:
        column = 1
    else:
        column = 2
    return (column, y0, x0, row["text"])


def _decode_image(path: Path) -> "np.ndarray":
    import cv2

    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"cannot decode cleaned page image: {path}")
    return image


def _write_jsonl_atomic(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    """Write JSONL through a temp file in the same directory, then replace.

    A crashed worker must never leave a half-written ``ocr.jsonl`` behind: the
    chunked-resume merge reads this artifact, so it is only ever swapped in
    whole via ``os.replace``.
    """
    tmp_path = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        pdf_images.write_jsonl(tmp_path, rows)
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _merge_or_write_records(
    ocr_jsonl_path: Path, records: list[OcrBlockRecord], pages_filter: set[int] | None
) -> None:
    """Write ``ocr.jsonl``, merging into an existing artifact when chunked.

    Full runs (no ``--pages``) rewrite the artifact from scratch exactly as
    before. Chunked runs (``--pages`` given) whose artifact already exists
    MERGE: drop the rows of the pages being re-run (so re-running a chunk
    replaces its rows without duplicates), append this run's records, and sort
    by page ascending — Python's sort is stable, so the within-page reading
    order is preserved and the composed artifact is byte-identical to a
    single full run over the same pages. Existing rows are re-validated
    against the strict record model: a corrupt artifact fails closed instead
    of poisoning the merge.
    """
    if pages_filter is not None and ocr_jsonl_path.is_file():
        existing = (
            OcrBlockRecord.model_validate(row)
            for row in pdf_images.read_jsonl(ocr_jsonl_path)
        )
        merged = [record for record in existing if record.page not in pages_filter]
        merged.extend(records)
        merged.sort(key=lambda record: record.page)
        _write_jsonl_atomic(ocr_jsonl_path, [record.model_dump() for record in merged])
        return
    pdf_images.write_jsonl(ocr_jsonl_path, [record.model_dump() for record in records])


def run_ocr(
    clean_rows: list[dict[str, Any]],
    config: OcrConfig,
    out_dir: Path,
    engine: str,
    pages_filter: set[int] | None,
) -> dict[str, Any]:
    """Run the configured engine over the cleaned pages; write artifacts."""
    if engine not in ("selftest", "paddle"):
        raise ValueError(f"unknown engine: {engine}")

    pipeline: Any = None
    if engine == "paddle":
        pipeline = _import_ppstructure()(**dict(config.engine_params))

    records: list[OcrBlockRecord] = []
    page_summaries: list[dict[str, Any]] = []
    raw_dir = out_dir / "ocr-raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    for row in clean_rows:
        page = int(row["page"])
        if pages_filter is not None and page not in pages_filter:
            continue
        image_rel = str(row["cleaned_image_path"])
        image_path = out_dir / image_rel
        if not image_path.is_file():
            raise FileNotFoundError(f"page {page}: cleaned image not found: {image_rel}")
        page_image_sha256 = pdf_images.sha256_file(image_path)
        if page_image_sha256 != row.get("cleaned_image_sha256"):
            raise ValueError(f"page {page}: cleaned image hash mismatch for {image_rel}")

        if engine == "selftest":
            blocks = selftest_blocks(str(row["source_sha256"]), page, page_image_sha256)
        else:
            blocks = paddle_blocks(pipeline, _decode_image(image_path))

        blocks.sort(key=_reading_sort_key)
        raw_lines: list[str] = []
        for block in blocks:
            records.append(
                OcrBlockRecord(
                    pipeline=config.pipeline,
                    pipeline_version=config.pipeline_version,
                    model_version=config.model_version,
                    config_version=config.config_version,
                    source_sha256=str(row["source_sha256"]),
                    page=page,
                    page_image_sha256=page_image_sha256,
                    bbox=block["bbox"],
                    layout_label=block["layout_label"],
                    text=block["text"],
                    confidence=block["confidence"],
                    source_raw_ref_hash=sha256_text(block["text"]),
                )
            )
            raw_lines.append(block["text"])

        raw_path = raw_dir / f"page-{page:04d}.txt"
        raw_path.write_text("\n".join(raw_lines) + "\n", encoding="utf-8")
        page_summaries.append(
            {
                "page": page,
                "block_count": len(raw_lines),
                "raw_text_path": str(raw_path.resolve()),
                "raw_text_sha256": pdf_images.sha256_file(raw_path),
            }
        )

    if pages_filter is not None and not page_summaries:
        raise ValueError(f"no cleaned pages matched: {sorted(pages_filter)}")

    _merge_or_write_records(out_dir / "ocr.jsonl", records, pages_filter)
    return {
        "ok": True,
        "engine": engine,
        "ocr_jsonl": str((out_dir / "ocr.jsonl").resolve()),
        "raw_dir": str(raw_dir.resolve()),
        "pipeline": config.pipeline,
        "pipeline_version": config.pipeline_version,
        "model_version": config.model_version,
        "config_version": config.config_version,
        "block_count": len(records),
        "pages": page_summaries,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_config(path: str | Path) -> OcrConfig:
    """Load and validate the versioned OCR pipeline config."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return OcrConfig.model_validate(raw)


def _add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--clean-jsonl", required=True, help="clean.jsonl from clean")
    parser.add_argument("--config", required=True, help="versioned OCR pipeline config JSON")
    parser.add_argument("--out-dir", required=True, help="per-source work directory")
    parser.add_argument(
        "--engine",
        default="paddle",
        help="paddle (default) or selftest (deterministic blocks without Paddle)",
    )
    parser.add_argument("--pages", default="", help="optional comma-separated page filter")


def add_ocr_subparser(
    sub: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    """Register the ``ocr`` subcommand on the shared ``lexiloop_media`` CLI."""
    parser = sub.add_parser(
        "ocr",
        help="layout OCR over cleaned page images (PP-StructureV3)",
        description="Layout OCR over cleaned page images (PP-StructureV3)",
    )
    _add_arguments(parser)
    parser.set_defaults(func=cmd_ocr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lexiloop_media ocr",
        description="Layout OCR over cleaned page images (PP-StructureV3)",
    )
    _add_arguments(parser)
    return parser


ENGINES = ("paddle", "selftest")


def cmd_ocr(args: argparse.Namespace) -> None:
    """Entry point shared by ``lexiloop_media ocr`` and the standalone parser."""
    if args.engine not in ENGINES:
        # Validated here (not via argparse choices) so the failure stays a
        # machine-readable JSON line instead of argparse usage text.
        _fail("ENGINE_UNKNOWN", f"unknown engine: {args.engine} (expected one of {ENGINES})")

    clean_jsonl = Path(args.clean_jsonl)
    if not clean_jsonl.is_file():
        _fail("CLEAN_JSONL_NOT_FOUND", f"clean.jsonl not found: {clean_jsonl}")
    try:
        config = load_config(args.config)
    except FileNotFoundError:
        _fail("OCR_CONFIG_NOT_FOUND", f"OCR config not found: {args.config}")
    except Exception as exc:  # JSON decode + pydantic validation errors
        _fail("OCR_CONFIG_INVALID", f"OCR config invalid: {exc}")
    try:
        clean_rows = pdf_images.read_jsonl(clean_jsonl)
    except ValueError as exc:
        _fail("CLEAN_JSONL_INVALID", str(exc))

    pages_filter: set[int] | None = None
    if args.pages:
        try:
            pages_filter = {int(item) for item in args.pages.split(",") if item.strip()}
        except ValueError as exc:
            _fail("PAGES_INVALID", f"--pages must be comma-separated integers: {exc}")

    out_dir = Path(args.out_dir)
    # Fail closed before any engine work: every processed page needs its image.
    for row in clean_rows:
        page = int(row["page"])
        if pages_filter is not None and page not in pages_filter:
            continue
        image_path = out_dir / str(row.get("cleaned_image_path", ""))
        if not image_path.is_file():
            _fail(
                "CLEANED_IMAGE_NOT_FOUND",
                f"page {page}: cleaned image missing: {image_path}",
            )

    if args.engine == "paddle":
        try:
            _import_ppstructure()
        except ImportError as exc:
            _fail(
                "ENGINE_UNAVAILABLE",
                "Paddle is required for the real OCR engine; install it with "
                f"`uv sync --extra ocr` ({exc})",
            )

    try:
        summary = run_ocr(clean_rows, config, out_dir, args.engine, pages_filter)
    except FileNotFoundError as exc:
        _fail("CLEANED_IMAGE_NOT_FOUND", str(exc))
    except ValueError as exc:
        _fail("OCR_RUN_INVALID", str(exc))

    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")


def main(argv: Sequence[str] | None = None) -> None:
    """Standalone entry point: ``python -m lexiloop_media.ocr <args>``."""
    cmd_ocr(build_parser().parse_args(argv))
