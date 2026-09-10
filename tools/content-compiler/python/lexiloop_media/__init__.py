"""LexiLoop media workers: page-image extraction and watermark cleanup.

Design doc section 5.3. This package reads the source PDF and page images and
never produces a PDF; cleaned images are only used for OCR and agent QA.
"""

from lexiloop_media import pdf_images, watermarks

__all__ = ["pdf_images", "watermarks"]
