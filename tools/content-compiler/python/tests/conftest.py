"""Test bootstrap for the Content Compiler media workers.

Inserts ``tools/content-compiler/python`` into ``sys.path`` so
``lexiloop_media`` imports without installing the package, and makes the
synthetic scan fixture builder importable from ``tests/fixtures/media``.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PYTHON_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_DIR.parents[2]
_FIXTURES_DIR = _REPO_ROOT / "tests" / "fixtures" / "media"

for entry in (str(_PYTHON_DIR), str(_FIXTURES_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import cv2 as cv2  # noqa: E402  (import after sys.path setup for readability)
import numpy as np  # noqa: E402
import pytest  # noqa: E402

from lexiloop_media import pdf_images  # noqa: E402
from lexiloop_media.watermarks import (  # noqa: E402
    EvidenceConfig,
    FillConfig,
    RectRegion,
    WatermarkRule,
    load_rule,
)

make_fixture = pytest.importorskip("make_fixture")

# The repo-level watermark rule config for the real source book.
REPO_RULE_PATH = (
    _REPO_ROOT / "tools" / "content-compiler" / "config" / "watermarks" / "llcy-2024.json"
)


@pytest.fixture(scope="session")
def fixture_pdf_path() -> Path:
    return make_fixture.build_fixture()


@pytest.fixture(scope="session")
def extracted(fixture_pdf_path: Path, tmp_path_factory: pytest.TempPathFactory) -> dict:
    """Extract both fixture pages once; expose records and page images."""
    out_dir = tmp_path_factory.mktemp("extracted")
    records = pdf_images.extract_pages(fixture_pdf_path, [1, 2], out_dir)
    images = {
        record.page: cv2.imread(str(out_dir / record.image_path), cv2.IMREAD_COLOR)
        for record in records
    }
    assert all(image is not None for image in images.values())
    return {"records": records, "images": images, "out_dir": out_dir}


@pytest.fixture(scope="session")
def scan_page(extracted: dict) -> np.ndarray:
    """Page 1 of the synthetic scan as a BGR ndarray."""
    return extracted["images"][1]


@pytest.fixture()
def rule() -> WatermarkRule:
    """Candidate regions matching the fixture's fake-watermark layout."""
    return WatermarkRule(
        rule_version=1,
        book_key="fixture-scan",
        fill=FillConfig(default_mode="selective"),
        evidence=EvidenceConfig(),
        regions=[
            RectRegion(name="top-banner", box=(0.15, 0.02, 0.85, 0.09)),
            RectRegion(name="bottom-promo", box=(0.45, 0.77, 0.95, 0.88)),
            RectRegion(name="bottom-footer", box=(0.10, 0.905, 0.92, 0.97)),
        ],
    )


@pytest.fixture()
def repo_rule() -> WatermarkRule:
    """The versioned llcy-2024 rule shipped in the repo, schema-checked."""
    return load_rule(REPO_RULE_PATH)
