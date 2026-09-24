"""Bounded-memory PaddleOCR worker over cleaned page images (design 5.4).

Reads the ``clean.jsonl`` manifest written by the watermark worker, runs the
locked PaddleOCR pipeline over every cleaned page image, and writes:

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
import gc
import hashlib
import json
import os
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Sequence

# Set CPU-runtime limits before importing NumPy/Paddle. Thread-local math
# workspaces were a major part of the previous 8+ GiB RSS peak.
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "2")

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


class OcrTilingConfig(pydantic.BaseModel):
    """Sequential tile dimensions that bound peak detector memory."""

    model_config = pydantic.ConfigDict(extra="forbid")

    tile_width_px: int = pydantic.Field(ge=256, le=2048)
    tile_height_px: int = pydantic.Field(ge=256, le=2048)
    overlap_px: int = pydantic.Field(ge=0, le=256)

    @pydantic.model_validator(mode="after")
    def _overlap_smaller_than_tile(self) -> "OcrTilingConfig":
        if self.overlap_px >= min(self.tile_width_px, self.tile_height_px):
            raise ValueError("overlap_px must be smaller than both tile dimensions")
        return self


class OcrConfig(pydantic.BaseModel):
    """Versioned bounded-memory PaddleOCR configuration (config/ocr/*.json)."""

    model_config = pydantic.ConfigDict(extra="ignore")

    config_version: int = pydantic.Field(ge=1)
    pipeline: str = pydantic.Field(min_length=1)
    pipeline_version: str = pydantic.Field(min_length=1)
    model_version: str = pydantic.Field(min_length=1)
    device: str = "cpu"
    tiling: OcrTilingConfig
    original_fallback_regions: list[tuple[float, float, float, float]] = pydantic.Field(
        default_factory=list
    )
    original_fallback_binary_thresholds: list[int] = pydantic.Field(default_factory=list)
    #: Keyword arguments passed verbatim to the PaddleOCR constructor.
    engine_params: dict[str, Any] = pydantic.Field(default_factory=dict)

    @pydantic.field_validator("original_fallback_regions")
    @classmethod
    def _check_original_regions(
        cls, regions: list[tuple[float, float, float, float]]
    ) -> list[tuple[float, float, float, float]]:
        for x0, y0, x1, y1 in regions:
            if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
                raise ValueError("original fallback regions must be normalized non-empty boxes")
        return regions


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
def _import_paddleocr() -> type:
    """Import and return the lightweight text-only PaddleOCR pipeline class.

    Split into a module-level function so tests can monkeypatch it to prove
    the ENGINE_UNAVAILABLE path without installing Paddle.
    """
    from paddleocr import PaddleOCR

    return PaddleOCR


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
    raise TypeError(f"unsupported PaddleOCR result type: {type(result).__name__}")


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


def _paddle_rows(pipeline: Any, image: "np.ndarray") -> list[dict[str, Any]]:
    """Recognize one already-bounded tile and return pixel-coordinate rows."""
    height, width = image.shape[:2]
    results = list(pipeline.predict(image))
    if not results:
        return []
    data = _result_to_dict(results[0])
    # PP-Structure wrapped OCR under overall_ocr_res; text-only PaddleOCR puts
    # the same arrays at the result root. Accept both shapes so provenance from
    # an older test double remains readable while production uses the lighter
    # root form.
    ocr = data.get("overall_ocr_res") or data
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
        rows.append(
            {
                "bbox_px": (x0, y0, x1, y1),
                "layout_label": "text",
                "text": raw,
                "confidence": _round(min(1.0, max(0.0, float(score)))),
            }
        )
    del results, data
    return rows


def _axis_starts(length: int, tile: int, overlap: int) -> list[int]:
    if length <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, max(1, length - tile + 1), step))
    last = length - tile
    if starts[-1] != last:
        starts.append(last)
    return starts


def tile_regions(
    *, image_width: int, image_height: int, tile_width: int, tile_height: int, overlap: int
) -> list[tuple[int, int, int, int]]:
    """Cover a page with deterministic overlapping tiles under a fixed size."""
    if image_width < 1 or image_height < 1:
        raise ValueError("image dimensions must be positive")
    if tile_width < 1 or tile_height < 1 or overlap < 0:
        raise ValueError("tile dimensions must be positive and overlap non-negative")
    if overlap >= min(tile_width, tile_height):
        raise ValueError("overlap must be smaller than both tile dimensions")
    xs = _axis_starts(image_width, min(tile_width, image_width), overlap)
    ys = _axis_starts(image_height, min(tile_height, image_height), overlap)
    return [
        (x0, y0, min(image_width, x0 + tile_width), min(image_height, y0 + tile_height))
        for y0 in ys
        for x0 in xs
    ]


def _bbox_iou(left: Sequence[float], right: Sequence[float]) -> float:
    ix0, iy0 = max(left[0], right[0]), max(left[1], right[1])
    ix1, iy1 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    if intersection <= 0:
        return 0.0
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union > 0 else 0.0


def _deduplicate_tile_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse overlap duplicates, retaining the higher-confidence reading."""
    accepted: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: (-float(item["confidence"]), item["text"])):
        duplicate = next(
            (
                prior
                for prior in accepted
                if _bbox_iou(row["bbox"], prior["bbox"]) >= 0.45
                and (row["text"] == prior["text"] or _bbox_iou(row["bbox"], prior["bbox"]) >= 0.8)
            ),
            None,
        )
        if duplicate is None:
            accepted.append(row)
    return accepted


def _join_overlapping_text(left: str, right: str) -> str:
    """Join adjacent OCR fragments, removing an exact suffix/prefix overlap."""
    left, right = left.rstrip(), right.lstrip()
    for size in range(min(len(left), len(right)), 0, -1):
        if left[-size:] == right[:size]:
            return left + right[size:]
    separator = " " if left[-1:].isalnum() and right[:1].isalnum() else ""
    return left + separator + right


def merge_tile_seam_fragments(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rejoin one printed line split by the horizontal tile overlap seam.

    With a 1000px tile on this 1907px raster, the two horizontal tiles overlap
    around normalized x=0.5. A long line can therefore be detected as a left
    and a right fragment. Only pairs that meet inside that narrow seam and
    overlap strongly vertically are joined; ordinary two-column rows retain
    their gutter and remain separate.
    """
    ordered = sorted(rows, key=lambda row: (row["bbox"][1], row["bbox"][0]))
    consumed: set[int] = set()
    merged: list[dict[str, Any]] = []
    for left_index, left in enumerate(ordered):
        if left_index in consumed:
            continue
        lx0, ly0, lx1, ly1 = left["bbox"]
        best: tuple[int, float] | None = None
        if lx0 < 0.475 and 0.475 <= lx1 <= 0.55:
            for right_index, right in enumerate(ordered):
                if right_index == left_index or right_index in consumed:
                    continue
                rx0, _ry0, rx1, _ry1 = right["bbox"]
                gap = rx0 - lx1
                if (
                    0.45 <= rx0 <= 0.525
                    and rx1 > 0.525
                    and -0.10 <= gap <= 0.015
                    and _vertical_overlap_ratio(left["bbox"], right["bbox"]) >= 0.65
                    and (best is None or abs(gap) < best[1])
                ):
                    best = (right_index, abs(gap))
        if best is None:
            merged.append(left)
            continue
        right = ordered[best[0]]
        consumed.add(best[0])
        merged.append(
            {
                **left,
                "bbox": (
                    _round(min(lx0, right["bbox"][0])),
                    _round(min(ly0, right["bbox"][1])),
                    _round(max(lx1, right["bbox"][2])),
                    _round(max(ly1, right["bbox"][3])),
                ),
                "text": _join_overlapping_text(str(left["text"]), str(right["text"])),
                "confidence": _round(min(float(left["confidence"]), float(right["confidence"]))),
            }
        )
    return merged


def deduplicate_line_variants(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop smaller duplicate detections nested in the same printed line.

    Overlap tiles sometimes emit a complete line plus short, low-quality edge
    readings (single letters or a partial clause). Prefer the widest line and
    suppress a strongly overlapping narrower variant; ordinary adjacent
    column items have little or no horizontal overlap and remain untouched.
    """
    ranked = sorted(
        rows,
        key=lambda row: (
            -(row["bbox"][2] - row["bbox"][0]),
            -len(str(row["text"])),
            -float(row["confidence"]),
        ),
    )
    accepted: list[dict[str, Any]] = []
    for row in ranked:
        width = row["bbox"][2] - row["bbox"][0]
        duplicate = False
        for prior in accepted:
            if _vertical_overlap_ratio(row["bbox"], prior["bbox"]) < 0.75:
                continue
            prior_width = prior["bbox"][2] - prior["bbox"][0]
            overlap = max(
                0.0,
                min(row["bbox"][2], prior["bbox"][2])
                - max(row["bbox"][0], prior["bbox"][0]),
            )
            overlap_of_smaller = overlap / min(width, prior_width) if min(width, prior_width) > 0 else 0
            same_or_contained_text = (
                str(row["text"]) in str(prior["text"])
                or str(prior["text"]) in str(row["text"])
            )
            near_identical_text = (
                overlap_of_smaller >= 0.85
                and SequenceMatcher(
                    None,
                    str(row["text"]).strip(),
                    str(prior["text"]).strip(),
                    autojunk=False,
                ).ratio()
                >= 0.65
            )
            if (
                _bbox_iou(row["bbox"], prior["bbox"]) >= 0.50
                or same_or_contained_text
                or near_identical_text
                or (width <= prior_width * 0.65 and overlap_of_smaller >= 0.65)
            ):
                duplicate = True
                break
        if not duplicate:
            accepted.append(row)
    return accepted


def paddle_blocks_tiled(
    pipeline: Any,
    image: "np.ndarray",
    *,
    tile_width: int,
    tile_height: int,
    overlap: int,
) -> list[dict[str, Any]]:
    """OCR one page tile-by-tile so detector peak memory is size-bounded."""
    page_height, page_width = image.shape[:2]
    rows: list[dict[str, Any]] = []
    for x0, y0, x1, y1 in tile_regions(
        image_width=page_width,
        image_height=page_height,
        tile_width=tile_width,
        tile_height=tile_height,
        overlap=overlap,
    ):
        tile = np.ascontiguousarray(image[y0:y1, x0:x1])
        for row in _paddle_rows(pipeline, tile):
            bx0, by0, bx1, by1 = row.pop("bbox_px")
            row["bbox"] = (
                _round(min(1.0, max(0.0, (bx0 + x0) / page_width))),
                _round(min(1.0, max(0.0, (by0 + y0) / page_height))),
                _round(min(1.0, max(0.0, (bx1 + x0) / page_width))),
                _round(min(1.0, max(0.0, (by1 + y0) / page_height))),
            )
            rows.append(row)
        del tile
        # Paddle's CPU allocator may retain its arena, but deleting every tile
        # and collecting Python objects keeps live page/result buffers bounded.
        gc.collect()
    return deduplicate_line_variants(
        merge_tile_seam_fragments(_deduplicate_tile_rows(rows))
    )


def paddle_blocks(pipeline: Any, image: "np.ndarray") -> list[dict[str, Any]]:
    """Compatibility helper for callers that explicitly request one tile."""
    height, width = image.shape[:2]
    return paddle_blocks_tiled(
        pipeline,
        image,
        tile_width=width,
        tile_height=height,
        overlap=0,
    )


_WATERMARK_FALLBACK_RE = re.compile(r"(?:神灯|精神家园|客服微信|QQ群|KYFT\d*)", re.I)


def paddle_blocks_regions(
    pipeline: Any,
    image: "np.ndarray",
    regions: Sequence[tuple[float, float, float, float]],
    binary_thresholds: Sequence[int] = (),
) -> list[dict[str, Any]]:
    """OCR small normalized regions from the original page and remap boxes."""
    page_height, page_width = image.shape[:2]
    rows: list[dict[str, Any]] = []
    for nx0, ny0, nx1, ny1 in regions:
        x0, x1 = int(nx0 * page_width), int(nx1 * page_width)
        y0, y1 = int(ny0 * page_height), int(ny1 * page_height)
        crop = np.ascontiguousarray(image[y0:y1, x0:x1])
        if crop.size == 0:
            continue
        variants = [crop]
        if binary_thresholds:
            import cv2

            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            for threshold in binary_thresholds:
                _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
                variants.append(cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR))
        for variant in variants:
            for row in _paddle_rows(pipeline, variant):
                bx0, by0, bx1, by1 = row.pop("bbox_px")
                row["bbox"] = (
                    _round((bx0 + x0) / page_width),
                    _round((by0 + y0) / page_height),
                    _round((bx1 + x0) / page_width),
                    _round((by1 + y0) / page_height),
                )
                if not _WATERMARK_FALLBACK_RE.search(str(row["text"])):
                    rows.append(row)
        del crop
        gc.collect()
    return deduplicate_line_variants(rows)


_PHONETIC_ANCHOR_RE = re.compile(r"^\s*(?:\[[^\]]{2,}\]|/[^/]{2,}/)")
_HEADWORD_ONLY_RE = re.compile(r"[A-Za-z][A-Za-z()'’\-]{1,30}")
_POS_MARKER_RE = re.compile(
    r"(?:^|[^A-Za-z])(?:n|v|vi|vt|adj|adv|prep|conj|pron|interj|art|num|aux|modal|abbr|phr)\."
)
_NUMBERED_SOURCE_RE = re.compile(r"^[①②③④⑤⑥⑦⑧⑨⑩].*\d{4}年")


def _vertical_overlap_ratio(left: Sequence[float], right: Sequence[float]) -> float:
    overlap = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
    smaller = min(left[3] - left[1], right[3] - right[1])
    return overlap / smaller if smaller > 0 else 0.0


def enrich_phonetic_anchors(
    rows: Sequence[dict[str, Any]],
    original_image: "np.ndarray",
    recognize: Callable[["np.ndarray"], tuple[str, float]],
    original_sha256: str | None = None,
) -> list[dict[str, Any]]:
    """Re-read truncated phonetic/POS lines from a narrow original crop.

    Watermark cleaning can preserve the phonetic at a line's left edge while
    erasing the POS/gloss farther right. Reusing the already-loaded mobile
    recognizer on that one-line original crop restores the complete anchor
    without loading a second detector or a full-resolution page tensor.
    """
    image_height, image_width = original_image.shape[:2]
    enriched: list[dict[str, Any]] = []
    for row in rows:
        current = str(row.get("text", "")).strip()
        if not _PHONETIC_ANCHOR_RE.search(current):
            enriched.append(row)
            continue
        ax0, ay0, _ax1, ay1 = row["bbox"]
        column_end = 0.49 if ax0 < 0.5 else 0.92
        crop_bbox = (
            max(0.0, ax0 - 0.005),
            max(0.0, ay0 - 0.006),
            min(column_end, ax0 + 0.30),
            min(1.0, ay1 + 0.006),
        )
        px0, px1 = int(crop_bbox[0] * image_width), int(crop_bbox[2] * image_width)
        py0, py1 = int(crop_bbox[1] * image_height), int(crop_bbox[3] * image_height)
        crop = np.ascontiguousarray(original_image[py0:py1, px0:px1])
        if crop.size == 0:
            enriched.append(row)
            continue
        candidate, score = recognize(crop)
        candidate = candidate.strip()
        if (
            score < 0.65
            or not _PHONETIC_ANCHOR_RE.search(candidate)
            or len(candidate) <= len(current) + 2
        ):
            enriched.append(row)
            continue
        replacement = {
            **row,
            "bbox": tuple(_round(value) for value in crop_bbox),
            "text": candidate,
            "confidence": _round(score),
        }
        if original_sha256 is not None:
            replacement["page_image_sha256"] = original_sha256
        enriched.append(replacement)
    return enriched


_FULL_WIDTH_HEADING_RE = re.compile(r"^(?:Unit\s*\d+|Chapter\s*\d+|索引)$", re.I)


def split_cross_gutter_rows(
    rows: Sequence[dict[str, Any]],
    original_image: "np.ndarray",
    recognize: Callable[["np.ndarray"], tuple[str, float]],
    original_sha256: str | None = None,
) -> list[dict[str, Any]]:
    """Split detector rows that accidentally joined both textbook columns.

    The two columns can contain unrelated lines at the same y position. A
    detector tile occasionally returns one box spanning the gutter and the
    recognizer then concatenates both lines. Re-recognizing the left and right
    halves separately is bounded to two narrow, single-line crops and reuses
    the already loaded recognition model.
    """
    image_height, image_width = original_image.shape[:2]
    split: list[dict[str, Any]] = []
    for row in rows:
        x0, y0, x1, y1 = row["bbox"]
        current = str(row.get("text", "")).strip()
        if (
            x0 > 0.45
            or x1 < 0.55
            or _FULL_WIDTH_HEADING_RE.fullmatch(current) is not None
        ):
            split.append(row)
            continue
        crop_y0 = max(0.0, y0 - 0.004)
        crop_y1 = min(1.0, y1 + 0.004)
        candidates: list[dict[str, Any]] = []
        for crop_x0, crop_x1 in (
            (max(0.0, x0 - 0.005), 0.49),
            (0.51, min(1.0, x1 + 0.005)),
        ):
            px0, px1 = int(crop_x0 * image_width), int(crop_x1 * image_width)
            py0, py1 = int(crop_y0 * image_height), int(crop_y1 * image_height)
            crop = np.ascontiguousarray(original_image[py0:py1, px0:px1])
            text, score = recognize(crop) if crop.size else ("", 0.0)
            text = text.strip()
            if score < 0.60 or len(text) < 2:
                continue
            replacement = {
                **row,
                "bbox": tuple(_round(value) for value in (crop_x0, crop_y0, crop_x1, crop_y1)),
                "text": text,
                "confidence": _round(score),
            }
            if original_sha256 is not None:
                replacement["page_image_sha256"] = original_sha256
            candidates.append(replacement)
        if (
            len(candidates) == 2
            and sum(len(str(candidate["text"])) for candidate in candidates)
            >= len(current) * 0.55
        ):
            split.extend(candidates)
        else:
            split.append(row)
    return split


def enrich_spanning_pos_lines(
    rows: Sequence[dict[str, Any]],
    original_image: "np.ndarray",
    recognize: Callable[["np.ndarray"], tuple[str, float]],
    original_sha256: str | None = None,
) -> list[dict[str, Any]]:
    """Re-read cross-column POS summaries as one narrow original-image line."""
    image_height, image_width = original_image.shape[:2]
    enriched: list[dict[str, Any]] = []
    for row in rows:
        x0, y0, x1, y1 = row["bbox"]
        current = str(row.get("text", "")).strip()
        if not (x0 < 0.4 and x1 > 0.6 and _POS_MARKER_RE.search(current)):
            enriched.append(row)
            continue
        crop_bbox = (max(0.08, x0 - 0.02), max(0.0, y0 - 0.006), 0.92, min(1.0, y1 + 0.004))
        px0, px1 = int(crop_bbox[0] * image_width), int(crop_bbox[2] * image_width)
        py0, py1 = int(crop_bbox[1] * image_height), int(crop_bbox[3] * image_height)
        crop = np.ascontiguousarray(original_image[py0:py1, px0:px1])
        candidate, score = recognize(crop) if crop.size else ("", 0.0)
        candidate = candidate.strip()
        if score < 0.72 or not _POS_MARKER_RE.search(candidate) or len(candidate) < len(current) * 0.7:
            enriched.append(row)
            continue
        replacement = {
            **row,
            "bbox": tuple(_round(value) for value in crop_bbox),
            "text": candidate,
            "confidence": _round(score),
        }
        if original_sha256 is not None:
            replacement["page_image_sha256"] = original_sha256
        enriched.append(replacement)
    return enriched


def enrich_source_sense_lines(
    rows: Sequence[dict[str, Any]],
    original_image: "np.ndarray",
    recognize: Callable[["np.ndarray"], tuple[str, float]],
    original_sha256: str | None = None,
) -> list[dict[str, Any]]:
    """Restore colored POS glyphs omitted from numbered exam-sense labels."""
    image_height, image_width = original_image.shape[:2]
    enriched: list[dict[str, Any]] = []
    for row in rows:
        current = str(row.get("text", "")).strip()
        if not _NUMBERED_SOURCE_RE.search(current):
            enriched.append(row)
            continue
        x0, y0, _x1, y1 = row["bbox"]
        column_end = 0.49 if x0 < 0.5 else 0.92
        crop_bbox = (
            max(0.08 if x0 < 0.5 else 0.51, x0 - 0.01),
            max(0.0, y0 - 0.012),
            column_end,
            min(1.0, y1 + 0.006),
        )
        px0, px1 = int(crop_bbox[0] * image_width), int(crop_bbox[2] * image_width)
        py0, py1 = int(crop_bbox[1] * image_height), int(crop_bbox[3] * image_height)
        crop = np.ascontiguousarray(original_image[py0:py1, px0:px1])
        candidate, score = recognize(crop) if crop.size else ("", 0.0)
        candidate = candidate.strip()
        if score < 0.72 or not _NUMBERED_SOURCE_RE.search(candidate) or len(candidate) < len(current) * 0.7:
            enriched.append(row)
            continue
        replacement = {
            **row,
            "bbox": tuple(_round(value) for value in crop_bbox),
            "text": candidate,
            "confidence": _round(score),
        }
        if original_sha256 is not None:
            replacement["page_image_sha256"] = original_sha256
        enriched.append(replacement)
    return enriched


def recover_missing_headwords(
    rows: Sequence[dict[str, Any]],
    original_image: "np.ndarray",
    recognize: Callable[["np.ndarray"], tuple[str, float]],
) -> list[dict[str, Any]]:
    """Recognize a missing word immediately left of a phonetic/POS block.

    The watermark cleaner occasionally removes a headword while leaving its
    phonetic/POS block. Detection already gives us a precise spatial anchor;
    recognition-only fallback on the corresponding ORIGINAL-image crop
    recovers the word without loading the memory-heavy server detector.
    """
    image_height, image_width = original_image.shape[:2]
    recovered: list[dict[str, Any]] = []
    for anchor in rows:
        if not _PHONETIC_ANCHOR_RE.search(str(anchor.get("text", ""))):
            continue
        ax0, ay0, _ax1, ay1 = anchor["bbox"]
        # Detector boxes for the coloured headword and phonetic often overlap
        # by a few pixels. Include that overlap; stopping strictly before the
        # phonetic box clipped the final letter ("govern" -> "gover").
        candidate_x1 = min(1.0, ax0 + 0.012)
        column_start = 0.08 if ax0 < 0.5 else 0.49
        candidate_x0 = max(column_start, candidate_x1 - 0.17)
        candidate_y0 = max(0.0, ay0 - 0.006)
        candidate_y1 = min(1.0, ay1 + 0.006)
        candidate_bbox = (candidate_x0, candidate_y0, candidate_x1, candidate_y1)
        candidate_width = candidate_x1 - candidate_x0
        already_present = any(
            other is not anchor
            and bool(re.search(r"[A-Za-z]", str(other.get("text", ""))))
            and _vertical_overlap_ratio(candidate_bbox, other["bbox"]) >= 0.45
            and (
                max(
                    0.0,
                    min(candidate_x1, other["bbox"][2])
                    - max(candidate_x0, other["bbox"][0]),
                )
                / candidate_width
                >= 0.35
            )
            for other in rows
        )
        if already_present:
            continue
        px0, px1 = int(candidate_x0 * image_width), int(candidate_x1 * image_width)
        py0, py1 = int(candidate_y0 * image_height), int(candidate_y1 * image_height)
        crop = np.ascontiguousarray(original_image[py0:py1, px0:px1])
        if crop.size == 0:
            continue
        text, score = recognize(crop)
        text = text.strip()
        tokens = _HEADWORD_ONLY_RE.findall(text)
        if score < 0.65 or not tokens:
            continue
        text = max(tokens, key=len)
        recovered.append(
            {
                "bbox": tuple(_round(value) for value in candidate_bbox),
                "layout_label": "text",
                "text": text,
                "confidence": _round(score),
            }
        )
    return recovered


def _recognize_with_pipeline(pipeline: Any, crop: "np.ndarray") -> tuple[str, float]:
    """Reuse PaddleOCR's already-loaded mobile recognizer for one crop."""
    rec_model = pipeline.paddlex_pipeline._pipeline.text_rec_model
    result = next(iter(rec_model(crop, batch_size=1)), None)
    if result is None:
        return "", 0.0
    return str(result.get("rec_text") or ""), float(result.get("rec_score") or 0.0)


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
        pipeline = _import_paddleocr()(**dict(config.engine_params))

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
            image = _decode_image(image_path)
            blocks = paddle_blocks_tiled(
                pipeline,
                image,
                tile_width=config.tiling.tile_width_px,
                tile_height=config.tiling.tile_height_px,
                overlap=config.tiling.overlap_px,
            )
            del image
            gc.collect()
            original_rel = str(row.get("original_image_path", ""))
            original_path = out_dir / original_rel
            if not original_path.is_file():
                raise FileNotFoundError(f"page {page}: original image not found: {original_rel}")
            original_sha256 = pdf_images.sha256_file(original_path)
            if original_sha256 != row.get("original_image_sha256"):
                raise ValueError(f"page {page}: original image hash mismatch for {original_rel}")
            original_image = _decode_image(original_path)
            fallback_blocks = paddle_blocks_regions(
                pipeline,
                original_image,
                config.original_fallback_regions,
                config.original_fallback_binary_thresholds,
            )
            for block in fallback_blocks:
                block["page_image_sha256"] = original_sha256
            blocks = deduplicate_line_variants([*blocks, *fallback_blocks])
            recognize = lambda crop: _recognize_with_pipeline(pipeline, crop)
            blocks = split_cross_gutter_rows(
                blocks,
                original_image,
                recognize,
                original_sha256,
            )
            blocks = enrich_spanning_pos_lines(
                blocks,
                original_image,
                recognize,
                original_sha256,
            )
            blocks = enrich_source_sense_lines(
                blocks,
                original_image,
                recognize,
                original_sha256,
            )
            blocks = enrich_phonetic_anchors(
                blocks,
                original_image,
                recognize,
                original_sha256,
            )
            blocks = deduplicate_line_variants(blocks)
            recovered = recover_missing_headwords(
                blocks,
                original_image,
                recognize,
            )
            for block in recovered:
                block["page_image_sha256"] = original_sha256
            blocks.extend(recovered)
            del original_image
            gc.collect()

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
                    page_image_sha256=str(block.get("page_image_sha256", page_image_sha256)),
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
        help="bounded-memory OCR over cleaned page images (PaddleOCR)",
        description="Bounded-memory OCR over cleaned page images (PaddleOCR)",
    )
    _add_arguments(parser)
    parser.set_defaults(func=cmd_ocr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lexiloop_media ocr",
        description="Bounded-memory OCR over cleaned page images (PaddleOCR)",
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
            _import_paddleocr()
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
