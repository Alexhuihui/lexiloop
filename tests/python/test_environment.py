"""Environment smoke tests.

Minimal placeholder so `pnpm test:python` reports success before the Content
Compiler Python media workers land in Phase 2. It only verifies that the
locked third-party dependencies import cleanly in the uv-managed venv.
"""

import ffmpeg  # ffmpeg-python wrapper
import cv2
import fitz  # PyMuPDF
import pydantic
import soundfile
from PIL import Image


def test_python_environment_imports() -> None:
    assert pydantic.__version__
    assert ffmpeg.__name__ == "ffmpeg"
    assert fitz.__doc__ is not None
    assert soundfile.__libsndfile_version__
    assert Image is not None
    assert cv2.__version__
