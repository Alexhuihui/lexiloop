"""Synthetic two-page scan fixture for media worker tests.

Builds a 2-page PDF whose pages are full-page embedded raster images (like the
real book, which is a pure image scan): body text in the middle band plus
repeated fake-watermark text in the top banner, bottom promo, and bottom
footer bands. The fake watermarks are drawn in light gray so watermark
cleanup code can be tested against a realistic layout.

The fixture is cached under the system temp directory; the file is only
written when missing. Creating THIS fixture PDF is the only sanctioned PDF
writing in the media tests — production modules under ``lexiloop_media`` must
never write a PDF (enforced by a source-scanning test).

Run directly to print the cached fixture path::

    uv run python tests/fixtures/media/make_fixture.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PAGE_WIDTH = 1240
PAGE_HEIGHT = 1754
WHITE = (255, 255, 255)
BODY_COLOR = (28, 28, 30)
WATERMARK_COLOR = (208, 208, 208)

FIXTURE_DIR = Path(tempfile.gettempdir()) / "lexiloop-media-fixture"
FIXTURE_NAME = "two-page-scan.pdf"


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 fallback
        return ImageFont.load_default()


def _draw_page(page_number: int) -> Image.Image:
    image = Image.new("RGB", (PAGE_WIDTH, PAGE_HEIGHT), WHITE)
    draw = ImageDraw.Draw(image)

    # ---- body text: middle band only (rows ~0.16H .. 0.72H) ----
    body_font = _font(30)
    sentences = [
        f"Page {page_number}: the quick brown fox jumps over the lazy dog.",
        "Pack my box with five dozen liquor jugs. 0123456789",
        "How vexingly quick daft zebras jump when quiz night returns!",
        "The body region must survive watermark cleanup pixel for pixel.",
        "Bright vixens jump; dozy fowl quack. Sphinx of black quartz.",
    ]
    y = int(0.16 * PAGE_HEIGHT)
    for i in range(14):
        text = sentences[(i + page_number) % len(sentences)]
        x = int(0.10 * PAGE_WIDTH) if i % 3 else int(0.14 * PAGE_WIDTH)
        draw.text((x, y), text, fill=BODY_COLOR, font=body_font)
        y += 52
        if y > int(0.72 * PAGE_HEIGHT):
            break

    # ---- fake watermarks (repeated top / bottom regions) ----
    wm_font_small = _font(26)
    wm_font_large = _font(46)

    # Top banner, centered.
    banner = f"FAKE WATERMARK TOP BANNER - PAGE {page_number} - GET MORE RESOURCES"
    bbox = draw.textbbox((0, 0), banner, font=wm_font_small)
    draw.text(
        ((PAGE_WIDTH - (bbox[2] - bbox[0])) // 2, int(0.042 * PAGE_HEIGHT)),
        banner,
        fill=WATERMARK_COLOR,
        font=wm_font_small,
    )

    # Bottom promo block, right half, two large lines.
    draw.text(
        (int(0.52 * PAGE_WIDTH), int(0.795 * PAGE_HEIGHT)),
        "FAKE PROMO WATERMARK ONE",
        fill=WATERMARK_COLOR,
        font=wm_font_large,
    )
    draw.text(
        (int(0.52 * PAGE_WIDTH), int(0.835 * PAGE_HEIGHT)),
        "FAKE PROMO WATERMARK TWO",
        fill=WATERMARK_COLOR,
        font=wm_font_large,
    )

    # Bottom footer strip: left / center / right light-gray snippets.
    footer_y = int(0.932 * PAGE_HEIGHT)
    draw.text(
        (int(0.16 * PAGE_WIDTH), footer_y),
        "FAKE WATERMARK FOOTER",
        fill=WATERMARK_COLOR,
        font=wm_font_small,
    )
    draw.text(
        (int(0.44 * PAGE_WIDTH), footer_y),
        "SERVICE WX: ABC123",
        fill=WATERMARK_COLOR,
        font=wm_font_small,
    )
    draw.text(
        (int(0.68 * PAGE_WIDTH), footer_y),
        "QQ GROUP: 12345678",
        fill=WATERMARK_COLOR,
        font=wm_font_small,
    )
    return image


def build_fixture(force: bool = False) -> Path:
    """Return the cached fixture PDF path, creating it when missing."""
    import io

    import pymupdf

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = FIXTURE_DIR / FIXTURE_NAME
    if pdf_path.exists() and not force:
        return pdf_path

    doc = pymupdf.open()
    for page_number in (1, 2):
        buffer = io.BytesIO()
        _draw_page(page_number).save(buffer, format="PNG")
        page = doc.new_page(width=595, height=842)
        # Embed the raster as a full-page image like a flatbed scan would.
        page.insert_image(page.rect, stream=buffer.getvalue())
    doc.save(str(pdf_path))
    doc.close()
    return pdf_path


if __name__ == "__main__":
    print(build_fixture())
    sys.exit(0)
