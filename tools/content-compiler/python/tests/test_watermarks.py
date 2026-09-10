"""Tests for watermark mask construction and cleanup (spec 5.3).

Masks are normalized versioned regions confirmed by cross-page repeated
evidence; cleanup only ever changes pixels inside the declared mask (the
changed-pixel boundary assertion), must remove the synthetic watermark ink,
and must preserve body-region pixels exactly.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pydantic
import pytest

from lexiloop_media.watermarks import (
    EvidenceConfig,
    FillConfig,
    PageSelector,
    PolygonRegion,
    RectRegion,
    WatermarkRule,
    active_regions_for,
    assert_change_confined,
    build_mask,
    changed_pixels_outside,
    clean_watermarks,
    confirm_regions,
    detect_body_overlap,
    load_rule,
    mask_bounds,
)

# Row slice of the fixture that holds body text only (no watermark bands).
BODY_ROWS = slice(int(0.16 * 1754), int(0.72 * 1754))


def _ink_pixels(image: np.ndarray, background: int = 255, tolerance: int = 24) -> int:
    deviation = np.abs(image.astype(np.int16) - background).max(axis=2)
    return int(np.count_nonzero(deviation > tolerance))


# ---------------------------------------------------------------------------
# Normalized masks
# ---------------------------------------------------------------------------


def test_rect_region_maps_normalized_bounds_to_pixels() -> None:
    region = RectRegion(name="band", box=(0.25, 0.10, 0.75, 0.20))
    mask = build_mask((100, 80), [region])
    assert mask.shape == (100, 80)
    expected = np.zeros((100, 80), dtype=bool)
    expected[10:20, 20:60] = True  # floor(y0*H):floor(y1*H), floor(x0*W):floor(x1*W)
    assert np.array_equal(mask, expected)


def test_polygon_region_masks_interior_not_corners() -> None:
    region = PolygonRegion(
        name="triangle",
        points=[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)],
    )
    mask = build_mask((10, 10), [region])
    assert mask[2, 2]  # interior of the triangle
    assert not mask[9, 9]  # far corner outside the triangle


def test_mask_bounds_are_normalized_and_inside_union_of_regions() -> None:
    regions = [
        RectRegion(name="top", box=(0.10, 0.02, 0.90, 0.09)),
        RectRegion(name="bottom", box=(0.20, 0.90, 0.80, 0.97)),
    ]
    mask = build_mask((1000, 800), regions)
    x0, y0, x1, y1 = mask_bounds(mask)
    assert 0.0 <= x0 <= x1 <= 1.0 and 0.0 <= y0 <= y1 <= 1.0
    assert x0 == pytest.approx(0.10, abs=1 / 800)
    assert y1 == pytest.approx(0.97, abs=1 / 1000)


# ---------------------------------------------------------------------------
# Cross-page repeated-region evidence
# ---------------------------------------------------------------------------


def test_confirm_regions_requires_cross_page_repetition(scan_page, rule) -> None:
    blank = np.full_like(scan_page, 255)
    # Watermark present on 2 of 3 pages.
    confirmed = confirm_regions([(1, scan_page), (2, scan_page), (3, blank)], rule)
    assert confirmed.keys() == {r.name for r in rule.regions}
    assert all(confirmed.values())
    # With a 0.99 threshold the missing third page vetoes every region...
    strict = rule.model_copy(
        update={"evidence": EvidenceConfig(min_page_fraction=0.99)},
        deep=True,
    )
    assert not any(confirm_regions([(1, scan_page), (2, scan_page), (3, blank)], strict).values())
    # ...and a fully watermarked set confirms every region at any threshold.
    assert all(confirm_regions([(1, scan_page), (2, scan_page), (3, scan_page)], strict).values())


def test_confirm_regions_only_counts_selector_matched_pages(scan_page, rule) -> None:
    cover_rule = rule.model_copy(deep=True)
    cover_rule.regions[0].page_selector = PageSelector(kind="pages", pages=[1])
    blank = np.full_like(scan_page, 255)
    # Page 1 (the only matched page) has ink -> confirmed even though the
    # other pool pages are blank and would drag a global ratio down.
    confirmed = confirm_regions([(1, scan_page), (2, blank), (3, blank)], cover_rule)
    assert confirmed["top-banner"] is True
    # ...but the matched page must itself carry the watermark ink.
    assert confirm_regions([(1, blank), (2, scan_page), (3, scan_page)], cover_rule)[
        "top-banner"
    ] is False


def test_regions_without_ink_are_not_confirmed(scan_page, rule) -> None:
    blank = np.full_like(scan_page, 255)
    confirmed = confirm_regions([(1, blank), (2, blank)], rule)
    assert not any(confirmed.values())


# ---------------------------------------------------------------------------
# Cleanup: removal + strict change confinement
# ---------------------------------------------------------------------------


def test_cleanup_changes_only_declared_regions(scan_page, rule) -> None:
    cleaned, mask = clean_watermarks(scan_page, rule)
    assert np.array_equal(cleaned[BODY_ROWS], scan_page[BODY_ROWS])
    assert changed_pixels_outside(scan_page, cleaned, mask) == 0
    assert_change_confined(scan_page, cleaned, mask)  # must not raise


def test_cleanup_removes_watermark_ink(scan_page, rule) -> None:
    cleaned, mask = clean_watermarks(scan_page, rule)
    top_band = slice(int(0.02 * 1754), int(0.09 * 1754))
    before = _ink_pixels(scan_page[top_band])
    after = _ink_pixels(cleaned[top_band])
    assert before > 500  # the fake banner was there
    assert after < before // 10  # and is gone after cleanup
    assert mask[top_band].any()

    promo_band = slice(int(0.77 * 1754), int(0.88 * 1754))
    assert _ink_pixels(cleaned[promo_band]) < _ink_pixels(scan_page[promo_band]) // 10


def test_background_fill_mode_also_stays_confined(scan_page, rule) -> None:
    background_rule = rule.model_copy(
        update={"fill": FillConfig(default_mode="background")}, deep=True
    )
    cleaned, mask = clean_watermarks(scan_page, background_rule)
    assert np.array_equal(cleaned[BODY_ROWS], scan_page[BODY_ROWS])
    assert changed_pixels_outside(scan_page, cleaned, mask) == 0
    top_band = slice(int(0.02 * 1754), int(0.09 * 1754))
    assert _ink_pixels(cleaned[top_band]) < _ink_pixels(scan_page[top_band]) // 10


def test_unconfirmed_regions_mean_no_changes(scan_page, rule) -> None:
    blank = np.full_like(scan_page, 255)
    vetoed = rule.model_copy(
        update={"evidence": EvidenceConfig(min_page_fraction=1.0)}, deep=True
    )
    # The watermark is missing on the second page, so with a unanimity
    # threshold no region is confirmed and nothing may change at all.
    confirmed = confirm_regions([(1, scan_page), (2, blank)], vetoed)
    cleaned, mask = clean_watermarks(
        scan_page,
        vetoed,
        active_regions=active_regions_for(confirmed, vetoed, 1),
        page_number=1,
    )
    assert not mask.any()
    assert np.array_equal(cleaned, scan_page)


def test_page_selector_scopes_cleanup_to_selected_pages(scan_page, rule) -> None:
    # Region applies only to page 2: page 1 must be untouched, page 2 cleaned.
    scoped = rule.model_copy(deep=True)
    for region in scoped.regions:
        region.page_selector = PageSelector(kind="pages", pages=[2])

    cleaned_page1, mask_page1 = clean_watermarks(scan_page, scoped, page_number=1)
    assert not mask_page1.any()
    assert np.array_equal(cleaned_page1, scan_page)

    cleaned_page2, mask_page2 = clean_watermarks(scan_page, scoped, page_number=2)
    assert mask_page2.any()
    assert np.any(cleaned_page2 != scan_page)

    # "except" scoping: cover-only exclusion of page 1 behaves identically.
    except_rule = rule.model_copy(deep=True)
    for region in except_rule.regions:
        region.page_selector = PageSelector(kind="except", pages=[1])
    cleaned_cover, mask_cover = clean_watermarks(scan_page, except_rule, page_number=1)
    assert not mask_cover.any()
    assert np.array_equal(cleaned_cover, scan_page)


def test_exclusion_holes_are_never_changed(scan_page, rule) -> None:
    hole = (0.25, 0.03, 0.75, 0.069)  # covers the whole fixture banner
    holed = rule.model_copy(deep=True)
    holed.regions[0].exclude = [hole]
    cleaned, mask = clean_watermarks(scan_page, holed, page_number=1)

    hole_mask = build_mask(scan_page.shape[:2], [RectRegion(name="hole", box=hole)])
    changed = np.any(scan_page != cleaned, axis=2)
    # Zero changed pixels inside the hole, and the hole is not in the mask.
    assert int(np.count_nonzero(changed & hole_mask)) == 0
    assert not (mask & hole_mask).any()
    # Cleanup still happened elsewhere (other regions remain active).
    assert int(np.count_nonzero(changed)) > 0
    assert changed_pixels_outside(scan_page, cleaned, mask) == 0


def test_background_fill_preserves_near_black_print() -> None:
    # The footer repair uses flat background fill: light watermark remnants
    # and the orphaned speck are flattened, near-black genuine text survives.
    image = np.full((200, 200, 3), 255, dtype=np.uint8)
    image[20:30, 10:180] = (205, 205, 205)  # watermark remnant strip
    image[40:50, 10:120] = (30, 30, 30)  # genuine near-black print
    image[60:64, 130:150] = (150, 150, 150)  # orphaned mid-gray speck
    rule = WatermarkRule(
        rule_version=2,
        book_key="footer-case",
        fill=FillConfig(default_mode="background"),
        evidence=EvidenceConfig(),
        regions=[RectRegion(name="footer", box=(0.0, 0.0, 1.0, 0.5))],
    )
    cleaned, mask = clean_watermarks(image, rule, page_number=32)
    assert changed_pixels_outside(image, cleaned, mask) == 0
    assert np.array_equal(cleaned[40:50, 10:120], image[40:50, 10:120])  # print kept
    assert _ink_pixels(cleaned[20:30, 10:180]) == 0  # remnant flattened
    assert _ink_pixels(cleaned[60:64, 130:150]) == 0  # speck flattened


def test_selective_fill_preserves_dark_text_inside_region() -> None:
    # A watermark region that also contains genuine dark body text: selective
    # fill must remove the light watermark but keep the dark text pixels.
    image = np.full((200, 200, 3), 255, dtype=np.uint8)
    image[20:30, 10:180] = (205, 205, 205)  # light watermark strip
    image[40:50, 10:120] = (30, 30, 30)  # dark genuine text inside the region
    rule = WatermarkRule(
        rule_version=1,
        book_key="overlap-case",
        fill=FillConfig(default_mode="selective"),
        evidence=EvidenceConfig(),
        regions=[RectRegion(name="strip", box=(0.0, 0.0, 1.0, 0.4))],
    )
    cleaned, mask = clean_watermarks(image, rule)
    assert changed_pixels_outside(image, cleaned, mask) == 0
    assert np.array_equal(cleaned[40:50, 10:120], image[40:50, 10:120])  # text kept
    assert not np.array_equal(cleaned[20:30, 10:180], image[20:30, 10:180])  # ink gone
    # The watermark strip itself is replaced by background: almost no ink left.
    assert _ink_pixels(cleaned[20:30, 10:180]) < 100


def test_selective_fill_preserves_chromatic_body_text_and_flags_overlap() -> None:
    # The real book renders headlines in teal: light but chromatic. The
    # neutral watermark must go while the teal headline survives, and the
    # watermark/body overlap must be flagged for the agent repair loop.
    image = np.full((200, 200, 3), 255, dtype=np.uint8)
    image[20:30, 10:180] = (205, 205, 205)  # neutral watermark strip
    image[40:50, 10:120] = (100, 170, 170)  # teal headline: light + chromatic
    rule = WatermarkRule(
        rule_version=1,
        book_key="chromatic-case",
        fill=FillConfig(default_mode="selective"),
        evidence=EvidenceConfig(),
        regions=[RectRegion(name="strip", box=(0.0, 0.0, 1.0, 0.4))],
    )
    cleaned, mask = clean_watermarks(image, rule)
    assert changed_pixels_outside(image, cleaned, mask) == 0
    assert np.array_equal(cleaned[40:50, 10:120], image[40:50, 10:120])  # teal kept
    assert not np.array_equal(cleaned[20:30, 10:180], image[20:30, 10:180])  # wm gone
    assert detect_body_overlap(image, mask, rule.evidence) is True

    # Without the headline there is nothing to flag.
    plain = np.full((200, 200, 3), 255, dtype=np.uint8)
    plain[20:30, 10:180] = (205, 205, 205)
    plain_mask = build_mask(plain.shape[:2], rule.regions)
    assert detect_body_overlap(plain, plain_mask, rule.evidence) is False


def test_detect_body_overlap_flags_dark_text_inside_mask() -> None:
    image = np.full((200, 200, 3), 255, dtype=np.uint8)
    image[40:50, 10:120] = (30, 30, 30)
    mask = np.zeros((200, 200), dtype=bool)
    mask[0:80, :] = True
    assert detect_body_overlap(image, mask) is True
    light_only = np.full((200, 200, 3), 255, dtype=np.uint8)
    light_only[20:30, :] = (205, 205, 205)
    assert detect_body_overlap(light_only, mask) is False


def test_changed_pixels_outside_counts_only_outside_changes() -> None:
    original = np.zeros((10, 10, 3), dtype=np.uint8)
    cleaned = original.copy()
    cleaned[0, 0] = 9  # inside mask
    cleaned[9, 9] = 7  # outside mask
    mask = np.zeros((10, 10), dtype=bool)
    mask[0, 0] = True
    assert changed_pixels_outside(original, cleaned, mask) == 1


def test_assert_change_confined_raises_on_outside_change() -> None:
    original = np.zeros((5, 5, 3), dtype=np.uint8)
    cleaned = original.copy()
    cleaned[4, 4] = 3  # change lands outside the mask below
    mask = np.ones((5, 5), dtype=bool)
    mask[4, 4] = False
    with pytest.raises(AssertionError):
        assert_change_confined(original, cleaned, mask)


# ---------------------------------------------------------------------------
# Versioned rule schema
# ---------------------------------------------------------------------------


def test_rule_requires_version_and_normalized_regions() -> None:
    with pytest.raises(pydantic.ValidationError):
        WatermarkRule(  # type: ignore[call-arg]
            book_key="x",
            regions=[RectRegion(name="r", box=(0.0, 0.0, 0.5, 0.5))],
        )
    with pytest.raises(pydantic.ValidationError):
        RectRegion(name="r", box=(0.0, 0.0, 1.5, 0.5))  # x1 out of [0, 1]
    with pytest.raises(pydantic.ValidationError):
        RectRegion(name="r", box=(0.6, 0.0, 0.5, 0.5))  # x1 < x0
    with pytest.raises(pydantic.ValidationError):
        PolygonRegion(name="p", points=[(0.0, 0.0), (1.0, 0.5)])  # too few points


def test_repo_llcy_rule_loads_and_has_versioned_regions(repo_rule: WatermarkRule) -> None:
    assert repo_rule.rule_version >= 1
    assert repo_rule.book_key == "llcy-2024"
    assert len(repo_rule.regions) >= 1
    for region in repo_rule.regions:
        if isinstance(region, RectRegion):
            assert all(0.0 <= v <= 1.0 for v in region.box)
        else:
            assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in region.points)


def test_load_rule_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_rule(tmp_path / "absent.json")
