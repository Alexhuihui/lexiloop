"""Synthetic scan fixtures for media worker tests.

``build_fixture`` renders a 2-page PDF whose pages are full-page embedded
raster images (like the real book, which is a pure image scan): body text in
the middle band plus repeated fake-watermark text in the top banner, bottom
promo, and bottom footer bands, drawn in light gray so watermark cleanup code
can be tested against a realistic layout.

``build_render_fallback_fixture`` renders a 4-page PDF that hits every
embedded-extraction bail-out, one per page: a rotated page, a page tiled
from two half-page images (no single >=98% dominant image), a page whose
image carries a transparency soft mask, and a CMYK page. Extraction must
fall back to exactly one render per page for all of them.

Fixtures are cached under the system temp directory, keyed on the SHA-256 of
this script so stale or concurrently-written caches cannot happen; writes
are atomic (temp file + rename). Creating these fixture PDFs is the only
sanctioned PDF writing in the media tests — production modules under
``lexiloop_media`` must never write a PDF (enforced by a source-scanning
test).

Run directly to print the cached fixture paths::

    uv run python tests/fixtures/media/make_fixture.py
"""

from __future__ import annotations

import hashlib
import io
import os
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
_SCRIPT_KEY = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]


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


def _save_pdf_atomically(doc, pdf_path: Path) -> None:
    """Write the fixture PDF via a unique temp file + atomic rename."""
    import tempfile as _tempfile

    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = _tempfile.mkstemp(suffix=".pdf", dir=pdf_path.parent)
    os.close(handle)
    try:
        doc.save(tmp_name)
        os.replace(tmp_name, pdf_path)
    except BaseException:
        os.unlink(tmp_name)
        raise


def _page_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def build_fixture(force: bool = False) -> Path:
    """Return the cached 2-page scan fixture, creating it when missing."""
    import pymupdf

    pdf_path = FIXTURE_DIR / f"two-page-scan-{_SCRIPT_KEY}.pdf"
    if pdf_path.exists() and not force:
        return pdf_path

    doc = pymupdf.open()
    for page_number in (1, 2):
        page = doc.new_page(width=595, height=842)
        # Embed the raster as a full-page image like a flatbed scan would.
        page.insert_image(page.rect, stream=_page_png(_draw_page(page_number)))
    _save_pdf_atomically(doc, pdf_path)
    doc.close()
    return pdf_path


def _fallback_page_raster(label: str, mode: str) -> Image.Image:
    """Distinct simple raster content per render-fallback variant."""
    colors = {
        "rotated": (120, 160, 200),
        "halves-left": (200, 120, 120),
        "halves-right": (120, 200, 120),
        "smask": (160, 140, 220),
        "cmyk": (230, 180, 90),
    }
    image = Image.new(mode, (PAGE_WIDTH, PAGE_HEIGHT), colors[label])
    draw = ImageDraw.Draw(image)
    draw.text(
        (int(0.4 * PAGE_WIDTH), int(0.45 * PAGE_HEIGHT)),
        f"FALLBACK {label}",
        fill=(20, 20, 20) if mode in ("RGB", "L") else (0, 0, 0, 255),
        font=_font(48),
    )
    return image


def build_render_fallback_fixture(force: bool = False) -> Path:
    """Return a cached 4-page fixture hitting every extraction bail-out.

    Page order: rotated page, two half-page images, transparency (smask)
    page, CMYK page. Extraction must render each of them once.
    """
    import pymupdf

    pdf_path = FIXTURE_DIR / f"render-fallback-{_SCRIPT_KEY}.pdf"
    if pdf_path.exists() and not force:
        return pdf_path

    doc = pymupdf.open()

    # 1. Rotated page: displayed orientation differs from the raw image.
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=_page_png(_fallback_page_raster("rotated", "RGB")))
    page.set_rotation(90)

    # 2. Two half-page images: no single image covers >=98% of the page.
    page = doc.new_page(width=595, height=842)
    mid = pymupdf.Rect(0, 0, 595, 842)
    left = pymupdf.Rect(mid.x0, mid.y0, mid.x0 + mid.width / 2, mid.y1)
    right = pymupdf.Rect(mid.x0 + mid.width / 2, mid.y0, mid.x1, mid.y1)
    page.insert_image(left, stream=_page_png(_fallback_page_raster("halves-left", "RGB")))
    page.insert_image(right, stream=_page_png(_fallback_page_raster("halves-right", "RGB")))

    # 3. Transparency: an RGBA raster is stored with a soft mask (smask).
    page = doc.new_page(width=595, height=842)
    rgba = _fallback_page_raster("smask", "RGBA")
    page.insert_image(page.rect, stream=_page_png(rgba))

    # 4. CMYK colorspace: extract_image reports a non-RGB separation.
    page = doc.new_page(width=595, height=842)
    buffer = io.BytesIO()
    _fallback_page_raster("cmyk", "CMYK").save(buffer, format="JPEG")
    page.insert_image(page.rect, stream=buffer.getvalue())

    _save_pdf_atomically(doc, pdf_path)
    doc.close()
    return pdf_path


if __name__ == "__main__":
    print(build_fixture())
    print(build_render_fallback_fixture())
    sys.exit(0)


if __name__ == "__main__":
    print(build_fixture())
    sys.exit(0)
