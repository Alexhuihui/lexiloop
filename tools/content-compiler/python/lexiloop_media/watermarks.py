"""Versioned watermark masks and in-mask cleanup (design doc section 5.3).

Watermarks are burned into the scanned page bitmaps, so they are removed by
image processing only:

1. Page coordinates are normalized to ``[0, 1] x [0, 1]``; candidate regions
   (top banner, bottom promo, footer, ...) come from a versioned rule file.
2. A region only becomes part of the mask when it shows the watermark ink
   repeatedly across pages (cross-page repeated-texture evidence). OCR-hit
   confirmation joins once the OCR stage exists.
3. Cleanup changes pixels strictly inside the mask. Fill modes: ``selective``
   (only light watermark-colored ink inside the region is inpainted, dark
   body text is preserved), ``background`` (the whole region is replaced by a
   background estimate), and ``inpaint`` (content-aware fill of the region).
4. ``changed_pixels_outside`` / ``assert_change_confined`` enforce the
   changed-pixel boundary: anything outside the declared mask stays untouched.

This module never touches PDFs; it operates on decoded page images only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal, Sequence

import cv2
import numpy as np
import pydantic

UnitFloat = Annotated[float, pydantic.Field(ge=0.0, le=1.0)]
FillMode = Literal["selective", "background", "inpaint"]

DEFAULT_RING_RADIUS_PX = 25


class RectRegion(pydantic.BaseModel):
    """Axis-aligned normalized rectangle: ``box = (x0, y0, x1, y1)``."""

    kind: Literal["rect"] = "rect"
    name: str = pydantic.Field(min_length=1)
    box: tuple[UnitFloat, UnitFloat, UnitFloat, UnitFloat]
    fill_mode: FillMode | None = None

    @pydantic.model_validator(mode="after")
    def _box_ordered(self) -> "RectRegion":
        x0, y0, x1, y1 = self.box
        if x1 <= x0 or y1 <= y0:
            raise ValueError(f"rect {self.name!r} must satisfy x0 < x1 and y0 < y1: {self.box}")
        return self


class PolygonRegion(pydantic.BaseModel):
    """Normalized polygon (at least 3 points)."""

    kind: Literal["polygon"] = "polygon"
    name: str = pydantic.Field(min_length=1)
    points: Annotated[list[tuple[UnitFloat, UnitFloat]], pydantic.Field(min_length=3)]
    fill_mode: FillMode | None = None


Region = Annotated[RectRegion | PolygonRegion, pydantic.Field(discriminator="kind")]


class FillConfig(pydantic.BaseModel):
    default_mode: FillMode = "selective"
    inpaint_radius: int = pydantic.Field(default=3, ge=1)


class EvidenceConfig(pydantic.BaseModel):
    """Thresholds for cross-page repeated-region evidence and selective fill.

    ``max_chroma_spread`` separates neutral watermark ink (gray on paper,
    channel spread ~0) from chromatic body text (teal headlines, spread 40+).
    """

    min_page_fraction: float = pydantic.Field(default=0.6, ge=0.0, le=1.0)
    min_ink_ratio: float = pydantic.Field(default=0.002, ge=0.0, le=1.0)
    ink_threshold: int = pydantic.Field(default=24, ge=0, le=255)
    luminance_split: int = pydantic.Field(default=140, ge=0, le=255)
    max_chroma_spread: int = pydantic.Field(default=32, ge=0, le=255)
    dark_text_max_ratio: float = pydantic.Field(default=0.02, gt=0.0, le=1.0)
    min_chromatic_pixels: int = pydantic.Field(default=400, ge=1)


class WatermarkRule(pydantic.BaseModel):
    """Versioned mask rule. Regions only — never source/book text content."""

    model_config = pydantic.ConfigDict(extra="forbid")

    rule_version: int = pydantic.Field(ge=1)
    book_key: str = pydantic.Field(min_length=1)
    notes: str | None = None
    fill: FillConfig = pydantic.Field(default_factory=FillConfig)
    evidence: EvidenceConfig = pydantic.Field(default_factory=EvidenceConfig)
    regions: Annotated[list[Region], pydantic.Field(min_length=1)]


def load_rule(path: str | Path) -> WatermarkRule:
    """Load and schema-validate a versioned watermark rule file."""
    rule_path = Path(path)
    with open(rule_path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return WatermarkRule.model_validate(payload)


# ---------------------------------------------------------------------------
# Masks
# ---------------------------------------------------------------------------


def build_mask(shape: tuple[int, ...], regions: Sequence[RectRegion | PolygonRegion]) -> np.ndarray:
    """Rasterize normalized regions into a boolean mask of ``shape[:2]``."""
    height, width = int(shape[0]), int(shape[1])
    mask = np.zeros((height, width), dtype=bool)
    for region in regions:
        if isinstance(region, RectRegion):
            x0, y0, x1, y1 = region.box
            col0, col1 = int(x0 * width), int(np.ceil(x1 * width))
            row0, row1 = int(y0 * height), int(np.ceil(y1 * height))
            mask[row0:max(row1, row0 + 1), col0 : max(col1, col0 + 1)] = True
        else:
            points = np.array(
                [[round(x * width), round(y * height)] for x, y in region.points],
                dtype=np.int32,
            )
            polygon = np.zeros((height, width), dtype=np.uint8)
            cv2.fillPoly(polygon, [points], 1)
            mask |= polygon.astype(bool)
    return mask


def mask_bounds(mask: np.ndarray) -> tuple[float, float, float, float]:
    """Normalized ``(x0, y0, x1, y1)`` bounding box of a non-empty mask."""
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        raise ValueError("mask_bounds requires a non-empty mask")
    height, width = mask.shape[:2]
    row_indices = np.flatnonzero(rows)
    col_indices = np.flatnonzero(cols)
    r0, r1 = int(row_indices[0]), int(row_indices[-1]) + 1
    c0, c1 = int(col_indices[0]), int(col_indices[-1]) + 1
    return (c0 / width, r0 / height, c1 / width, r1 / height)


# ---------------------------------------------------------------------------
# Cross-page repeated-region evidence
# ---------------------------------------------------------------------------


def _gray_of(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def _ink_ratio(image: np.ndarray, region_mask: np.ndarray, evidence: EvidenceConfig) -> float:
    gray = _gray_of(image)
    region_pixels = int(np.count_nonzero(region_mask))
    if region_pixels == 0:
        return 0.0
    background = float(np.median(gray[region_mask]))
    deviation = np.abs(gray.astype(np.int16) - int(background))
    ink = (deviation > evidence.ink_threshold) & region_mask
    return float(np.count_nonzero(ink)) / region_pixels


def confirm_regions(
    images: Sequence[np.ndarray],
    rule: WatermarkRule,
) -> dict[str, bool]:
    """Cross-page evidence per region: ink present on >= min_page_fraction pages."""
    if not images:
        return {region.name: False for region in rule.regions}
    evidence = rule.evidence
    confirmed: dict[str, bool] = {}
    for region in rule.regions:
        pages_with_ink = 0
        for image in images:
            region_mask = build_mask(image.shape[:2], [region])
            if _ink_ratio(image, region_mask, evidence) >= evidence.min_ink_ratio:
                pages_with_ink += 1
        confirmed[region.name] = (pages_with_ink / len(images)) >= evidence.min_page_fraction
    return confirmed


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def _background_color(image: np.ndarray, region_mask: np.ndarray) -> tuple[int, int, int]:
    """Median color of a ring just outside the region (paper estimate)."""
    ring = cv2.dilate(
        region_mask.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=DEFAULT_RING_RADIUS_PX,
    ).astype(bool)
    ring &= ~region_mask
    source = image if image.ndim == 3 else np.repeat(image[:, :, None], 3, axis=2)
    if not ring.any():
        values = np.median(source.reshape(-1, source.shape[2]), axis=0)
    else:
        values = np.median(source[ring].reshape(-1, source.shape[2]), axis=0)
    return tuple(int(v) for v in values)


def _channel_spread(image: np.ndarray) -> np.ndarray:
    """Per-pixel chroma spread (max-min channel); 0 for neutral gray ink."""
    if image.ndim == 2:
        return np.zeros_like(image, dtype=np.int16)
    return image.max(axis=2).astype(np.int16) - image.min(axis=2).astype(np.int16)


def _fill_region(
    cleaned: np.ndarray,
    original: np.ndarray,
    region_mask: np.ndarray,
    mode: FillMode,
    rule: WatermarkRule,
) -> None:
    radius = rule.fill.inpaint_radius
    evidence = rule.evidence
    if mode == "background":
        background = _background_color(original, region_mask)
        cleaned[region_mask] = background
        return

    gray = _gray_of(original)
    if mode == "inpaint":
        fill_mask = region_mask
    else:  # selective: only watermark-colored ink; body text pixels survive
        background_gray = float(np.median(gray[region_mask]))
        deviation = np.abs(gray.astype(np.int16) - int(background_gray))
        ink = (deviation > evidence.ink_threshold) & region_mask
        light = ink & (gray >= evidence.luminance_split)
        if not light.any():
            return
        spread = _channel_spread(original)
        if float(np.median(spread[light])) <= evidence.max_chroma_spread:
            # Watermark ink is neutral gray on paper: remove only neutral
            # pixels so chromatic body text (teal headlines, seals) survives.
            fill_mask = light & (spread <= evidence.max_chroma_spread)
        else:
            # The watermark is burned over chromatic artwork (covers): every
            # light ink pixel inside the region is watermark.
            fill_mask = light
        if not fill_mask.any():
            return
        # Swallow the anti-aliased ring around each glyph so the fill does
        # not feed on watermark-colored halo pixels (stays inside the region).
        fill_mask = (
            cv2.dilate(fill_mask.astype(np.uint8), np.ones((3, 3), dtype=np.uint8), iterations=2)
            .astype(bool)
            & region_mask
        )
    result = cv2.inpaint(
        original,
        (fill_mask.astype(np.uint8)) * 255,
        radius,
        cv2.INPAINT_TELEA,
    )
    cleaned[fill_mask] = result[fill_mask]


def clean_watermarks(
    image: np.ndarray,
    rule: WatermarkRule,
    evidence_images: Sequence[np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Clean one page image; return ``(cleaned, mask)``.

    ``evidence_images`` is the pool of page images used for cross-page
    confirmation (defaults to just this page). Only confirmed regions enter
    the mask, and only masked pixels are ever modified.
    """
    pool = list(evidence_images) if evidence_images else [image]
    confirmed = confirm_regions(pool, rule)
    active = [region for region in rule.regions if confirmed[region.name]]
    mask = build_mask(image.shape[:2], active)
    cleaned = image.copy()
    for region in active:
        region_mask = build_mask(image.shape[:2], [region])
        mode = region.fill_mode or rule.fill.default_mode
        _fill_region(cleaned, image, region_mask, mode, rule)
    return cleaned, mask


def changed_pixels_outside(
    original: np.ndarray,
    cleaned: np.ndarray,
    mask: np.ndarray,
) -> int:
    """Count pixels modified outside the declared mask (must always be 0)."""
    if original.ndim == 2:
        changed = original != cleaned
    else:
        changed = np.any(original != cleaned, axis=2)
    return int(np.count_nonzero(changed & ~mask))


def assert_change_confined(
    original: np.ndarray,
    cleaned: np.ndarray,
    mask: np.ndarray,
) -> None:
    """Changed-pixel boundary assertion (spec 5.3): fail closed on any leak."""
    outside = changed_pixels_outside(original, cleaned, mask)
    if outside != 0:
        raise AssertionError(
            f"{outside} pixel(s) changed outside the declared watermark mask"
        )


def detect_body_overlap(
    image: np.ndarray,
    mask: np.ndarray,
    evidence: EvidenceConfig | None = None,
) -> bool:
    """True when the mask overlaps body-like ink (spec 5.3 overlap).

    Flags pages that must not silently pass cleanup and route to the agent
    repair loop:
    - dark body-like ink inside the mask (black text under the watermark);
    - chromatic body-colored ink inside a neutral watermark region (teal
      headlines sharing the banner band);
    - chromatic-dominant light ink, i.e. the watermark burned over artwork
      (covers), where any fill risks visible damage.
    """
    config = evidence or EvidenceConfig()
    if not mask.any():
        return False
    gray = _gray_of(image)
    background_gray = float(np.median(gray[mask]))
    deviation = np.abs(gray.astype(np.int16) - int(background_gray))
    ink = (deviation > config.ink_threshold) & mask
    if not ink.any():
        return False
    dark = ink & (gray < config.luminance_split)
    dark_ratio = float(np.count_nonzero(dark)) / float(np.count_nonzero(mask))
    if dark_ratio > config.dark_text_max_ratio:
        return True
    light = ink & (gray >= config.luminance_split)
    if not light.any():
        return False
    spread = _channel_spread(image)
    if float(np.median(spread[light])) > config.max_chroma_spread:
        return True  # watermark over artwork: cleanup is inherently risky
    chromatic = light & (spread > config.max_chroma_spread)
    chromatic_ratio = float(np.count_nonzero(chromatic)) / float(np.count_nonzero(mask))
    if chromatic_ratio > config.dark_text_max_ratio:
        return True
    # Body-colored text inside the band: flag when it is substantial in
    # absolute terms too (the mask is large, so ratios alone under-flag).
    return int(np.count_nonzero(chromatic)) >= config.min_chromatic_pixels
