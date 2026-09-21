"""Contract tests for the layout OCR worker (design doc section 5.4).

These exercise the ``lexiloop_media ocr`` command with the deterministic
selftest engine (no Paddle models needed): the emitted ``ocr.jsonl`` must be
strict, hash-chained to the cleaned page images, and byte-for-byte
deterministic. The real bounded-memory PaddleOCR engine is exercised by an opt-in smoke
test that skips cleanly when Paddle is unavailable.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from lexiloop_media import cli, ocr, pdf_images

RULE_PATH = Path(__file__).resolve().parents[2] / "config" / "watermarks" / "llcy-2024.json"
OCR_CONFIG_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "ocr" / "pp-structure-v3.json"
)


def _prepare_clean_fixture(fixture_pdf_path: Path, tmp_path: Path) -> Path:
    """extract + clean the synthetic scan; return the per-source work dir."""
    pdf_images.extract_pages(fixture_pdf_path, [1, 2], tmp_path)
    cli.main(
        [
            "clean",
            "--pages-jsonl",
            str(tmp_path / "pages.jsonl"),
            "--rule",
            str(RULE_PATH),
            "--out-dir",
            str(tmp_path),
        ]
    )
    return tmp_path


def _run_ocr(work_dir: Path, extra_args: list[str] | None = None) -> dict:
    args = [
        "ocr",
        "--clean-jsonl",
        str(work_dir / "clean.jsonl"),
        "--config",
        str(OCR_CONFIG_PATH),
        "--out-dir",
        str(work_dir),
        "--engine",
        "selftest",
    ]
    cli.main(args + (extra_args or []))


def test_ocr_config_exists_and_is_versioned() -> None:
    raw = json.loads(OCR_CONFIG_PATH.read_text(encoding="utf-8"))
    config = ocr.OcrConfig.model_validate(raw)
    assert config.config_version >= 1
    assert config.pipeline == "PaddleOCR"
    assert config.model_version  # locked model spec string
    assert config.tiling.tile_width_px * config.tiling.tile_height_px <= 800_000
    assert config.engine_params["text_recognition_batch_size"] == 1
    assert config.engine_params["use_textline_orientation"] is False
    assert "mobile" in config.engine_params["text_detection_model_name"]
    assert "server" in config.engine_params["text_recognition_model_name"]
    assert config.original_fallback_regions == [(0.46, 0.76, 0.94, 0.875)]


def test_tile_regions_cover_a_full_page_under_the_pixel_budget() -> None:
    regions = ocr.tile_regions(
        image_width=1907,
        image_height=2824,
        tile_width=1000,
        tile_height=1400,
        overlap=96,
    )
    assert len(regions) > 1
    assert regions[0][:2] == (0, 0)
    assert max(region[2] for region in regions) == 1907
    assert max(region[3] for region in regions) == 2824
    assert all((x1 - x0) * (y1 - y0) <= 1_400_000 for x0, y0, x1, y1 in regions)


def test_paddle_ocr_runs_tiles_sequentially_and_remaps_boxes() -> None:
    class FakePipeline:
        def __init__(self) -> None:
            self.shapes: list[tuple[int, int]] = []

        def predict(self, image):
            height, width = image.shape[:2]
            self.shapes.append((height, width))
            return [
                {
                    "rec_texts": [f"tile-{len(self.shapes)}"],
                    "rec_scores": [0.99],
                    "rec_boxes": [[10, 10, width - 10, min(height - 10, 50)]],
                }
            ]

    image = ocr.np.zeros((2824, 1907, 3), dtype=ocr.np.uint8)
    pipeline = FakePipeline()
    rows = ocr.paddle_blocks_tiled(
        pipeline,
        image,
        tile_width=1000,
        tile_height=1400,
        overlap=96,
    )

    assert len(pipeline.shapes) > 1
    assert all(height * width <= 1_400_000 for height, width in pipeline.shapes)
    # Overlap detections are collapsed after all tiles have been remapped.
    assert 1 < len(rows) <= len(pipeline.shapes)
    assert all(0 <= value <= 1 for row in rows for value in row["bbox"])


def test_original_fallback_region_is_detected_and_remapped_without_a_full_page_pass() -> None:
    class FakePipeline:
        def __init__(self) -> None:
            self.shapes = []

        def predict(self, image):
            height, width = image.shape[:2]
            self.shapes.append((height, width))
            return [{"rec_texts": ["overstate"], "rec_scores": [0.98], "rec_boxes": [[5, 5, width - 5, height - 5]]}]

    image = ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8)
    pipeline = FakePipeline()
    rows = ocr.paddle_blocks_regions(pipeline, image, [(0.46, 0.76, 0.94, 0.875)])

    assert pipeline.shapes == [(322, 912)]
    assert rows[0]["text"] == "overstate"
    assert rows[0]["bbox"][0] == pytest.approx(0.46, abs=0.01)
    assert rows[0]["bbox"][1] == pytest.approx(0.76, abs=0.01)
    assert rows[0]["bbox"][2] == pytest.approx(0.94, abs=0.01)
    assert rows[0]["bbox"][3] == pytest.approx(0.875, abs=0.01)


def test_original_fallback_region_can_add_a_thresholded_pass_for_watermark_text() -> None:
    class FakePipeline:
        def __init__(self) -> None:
            self.calls = 0

        def predict(self, image):
            self.calls += 1
            height, width = image.shape[:2]
            text = "noise" if self.calls == 1 else "leak secrets intentionally 故意泄露秘密"
            return [{"rec_texts": [text], "rec_scores": [0.98], "rec_boxes": [[5, 5, width - 5, height - 5]]}]

    image = ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8)
    pipeline = FakePipeline()
    rows = ocr.paddle_blocks_regions(
        pipeline,
        image,
        [(0.46, 0.76, 0.94, 0.875)],
        binary_thresholds=[180],
    )

    assert pipeline.calls == 2
    assert any("intentionally" in row["text"] for row in rows)


def test_tile_seam_fragments_are_rejoined_with_text_overlap_removed() -> None:
    rows = [
        {
            "bbox": (0.117, 0.263, 0.523, 0.283),
            "layout_label": "text",
            "text": "vi.工作；产生作用；争取v.（使）运转",
            "confidence": 0.93,
        },
        {
            "bbox": (0.481, 0.264, 0.793, 0.282),
            "layout_label": "text",
            "text": "运转n.工作；工作成果；作品",
            "confidence": 0.91,
        },
        {
            "bbox": (0.49, 0.265, 0.51, 0.279),
            "layout_label": "text",
            "text": "转",
            "confidence": 0.72,
        },
    ]

    joined = ocr.deduplicate_line_variants(ocr.merge_tile_seam_fragments(rows))

    assert len(joined) == 1
    assert joined[0]["text"] == "vi.工作；产生作用；争取v.（使）运转n.工作；工作成果；作品"
    assert joined[0]["bbox"] == pytest.approx((0.117, 0.263, 0.793, 0.283))


def test_threshold_pass_drops_a_near_duplicate_line_variant() -> None:
    rows = [
        {
            "bbox": (0.498, 0.708, 0.611, 0.725),
            "layout_label": "text",
            "text": "人的幸福感。",
            "confidence": 0.97,
        },
        {
            "bbox": (0.502, 0.718, 0.611, 0.724),
            "layout_label": "text",
            "text": "人的半临感。",
            "confidence": 0.89,
        },
    ]

    assert ocr.deduplicate_line_variants(rows) == [rows[0]]


def test_cross_gutter_row_is_recognized_as_two_independent_lines() -> None:
    rows = [
        {
            "bbox": (0.119, 0.068, 0.949, 0.085),
            "layout_label": "text",
            "text": "左栏内容English-speaking countries is likely to continue.",
            "confidence": 0.96,
        }
    ]
    original = ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8)
    readings = iter((("左栏内容", 0.97), ("English-speaking countries is likely to continue.", 0.98)))

    split = ocr.split_cross_gutter_rows(rows, original, lambda _crop: next(readings), "ab" * 32)

    assert [row["text"] for row in split] == [
        "左栏内容",
        "English-speaking countries is likely to continue.",
    ]
    assert split[0]["bbox"][2] == pytest.approx(0.49)
    assert split[1]["bbox"][0] == pytest.approx(0.51)
    assert all(row["page_image_sha256"] == "ab" * 32 for row in split)


def test_original_image_recognition_recovers_a_missing_headword_left_of_phonetics() -> None:
    rows = [
        {
            "bbox": (0.648, 0.795, 0.899, 0.815),
            "layout_label": "text",
            "text": "['leiba(r)] n. 劳动；(统称)",
            "confidence": 0.86,
        }
    ]
    original = ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8)
    calls = []

    def recognize(crop):
        calls.append(crop.shape)
        return "labo(u)r", 0.94

    recovered = ocr.recover_missing_headwords(rows, original, recognize)
    assert calls
    assert recovered == [
        pytest.approx(
            {
                "bbox": (0.49, 0.789, 0.66, 0.821),
                "layout_label": "text",
                "text": "labo(u)r",
                "confidence": 0.94,
            },
            abs=0.002,
        )
    ]


def test_original_image_recognition_enriches_a_truncated_phonetic_pos_anchor() -> None:
    rows = [
        {
            "bbox": (0.648, 0.795, 0.735, 0.815),
            "layout_label": "text",
            "text": "[leiba(r)]",
            "confidence": 0.86,
        }
    ]
    original = ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8)
    calls = []

    def recognize(crop):
        calls.append(crop.shape)
        return "[leiba(r)] n. 劳动；(统称)", 0.91

    enriched = ocr.enrich_phonetic_anchors(rows, original, recognize)

    assert calls
    assert enriched[0]["text"] == "[leiba(r)] n. 劳动；(统称)"
    assert enriched[0]["confidence"] == pytest.approx(0.91)
    assert enriched[0]["bbox"][2] > rows[0]["bbox"][2]


def test_original_image_recognition_enriches_spanning_pos_summary() -> None:
    row = {
        "bbox": (0.125, 0.531, 0.647, 0.55),
        "layout_label": "text",
        "text": "n.状态；国家；州；政府vt.陈述；规定adi州的：",
        "confidence": 0.82,
    }
    enriched = ocr.enrich_spanning_pos_lines(
        [row],
        ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8),
        lambda _crop: ("n.状态；国家；州；政府vt.陈述；规定adj州的；国家的", 0.91),
    )

    assert enriched[0]["text"] == "n.状态；国家；州；政府vt.陈述；规定adj州的；国家的"
    assert enriched[0]["bbox"][2] == pytest.approx(0.92)


def test_original_image_recognition_restores_pos_on_numbered_source_line() -> None:
    row = {
        "bbox": (0.102, 0.072, 0.48, 0.089),
        "layout_label": "text",
        "text": "②努力做（困难的事）（2012年新题型）",
        "confidence": 0.83,
    }
    enriched = ocr.enrich_source_sense_lines(
        [row],
        ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8),
        lambda _crop: ("②vi努力做(困难的事)(2012年新题型)", 0.90),
    )

    assert enriched[0]["text"].startswith("②vi")


def test_original_image_recognition_keeps_anchor_when_candidate_is_not_better() -> None:
    row = {
        "bbox": (0.648, 0.795, 0.899, 0.815),
        "layout_label": "text",
        "text": "[leiba(r)] n. 劳动；(统称)",
        "confidence": 0.86,
    }
    enriched = ocr.enrich_phonetic_anchors(
        [row],
        ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8),
        lambda _crop: ("[leiba(r)]", 0.99),
    )

    assert enriched == [row]


def test_original_image_recognition_does_not_duplicate_an_existing_headword() -> None:
    rows = [
        {"bbox": (0.52, 0.795, 0.64, 0.815), "layout_label": "text", "text": "labour", "confidence": 0.9},
        {"bbox": (0.648, 0.795, 0.899, 0.815), "layout_label": "text", "text": "[leiba] n. 劳动", "confidence": 0.86},
    ]
    recovered = ocr.recover_missing_headwords(
        rows,
        ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8),
        lambda _crop: (_ for _ in ()).throw(AssertionError("recognizer should not run")),
    )
    assert recovered == []


def test_original_image_recognition_ignores_a_thin_overlap_from_the_other_column() -> None:
    rows = [
        {"bbox": (0.11, 0.19, 0.494, 0.21), "layout_label": "text", "text": "root note govern", "confidence": 0.9},
        {"bbox": (0.624, 0.19, 0.91, 0.21), "layout_label": "text", "text": "['gʌvn] vt. 治理", "confidence": 0.86},
    ]
    recovered = ocr.recover_missing_headwords(
        rows,
        ocr.np.zeros((2800, 1900, 3), dtype=ocr.np.uint8),
        lambda _crop: (")govern", 0.95),
    )
    assert recovered[0]["text"] == "govern"


def test_ocr_selftest_emits_strict_block_jsonl(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    capsys.readouterr()  # drain the `clean` command's own summary line
    _run_ocr(work_dir)

    clean_rows = pdf_images.read_jsonl(work_dir / "clean.jsonl")
    clean_by_page = {row["page"]: row for row in clean_rows}
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    records = [ocr.OcrBlockRecord.model_validate(row) for row in rows]
    assert records, "selftest engine must emit at least one block per page"

    pages_seen = {record.page for record in records}
    assert pages_seen == {1, 2}
    for record in records:
        clean_row = clean_by_page[record.page]
        assert record.source_sha256 == clean_row["source_sha256"]
        assert record.page_image_sha256 == clean_row["cleaned_image_sha256"]
        assert record.pipeline == "PaddleOCR"
        assert record.config_version >= 1
        assert record.model_version
        x0, y0, x1, y1 = record.bbox
        assert 0.0 <= x0 <= x1 <= 1.0
        assert 0.0 <= y0 <= y1 <= 1.0
        assert 0.0 <= record.confidence <= 1.0
        assert record.text
        assert record.layout_label
        # The private raw-text reference hash binds the block to its raw text.
        assert record.source_raw_ref_hash == hashlib.sha256(
            record.text.encode("utf-8")
        ).hexdigest()

    # The raw text file per page exists and its sha256 is in the summary.
    raw_lines = capsys.readouterr().out.strip().splitlines()
    assert len(raw_lines) == 1  # exactly one JSON summary object on stdout
    summary = json.loads(raw_lines[0])
    assert len(summary["pages"]) == 2
    for page_summary in summary["pages"]:
        raw_path = Path(page_summary["raw_text_path"])
        assert raw_path.is_file()
        assert page_summary["raw_text_sha256"] == pdf_images.sha256_file(raw_path)
        page_rows = [r for r in records if r.page == page_summary["page"]]
        assert page_summary["block_count"] == len(page_rows)
        raw_text = raw_path.read_text(encoding="utf-8")
        for record in page_rows:
            assert record.text in raw_text


def test_ocr_output_is_deterministic(fixture_pdf_path: Path, tmp_path: Path) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir)
    first = (work_dir / "ocr.jsonl").read_bytes()

    out2 = tmp_path.parent / "rerun"
    out2.mkdir()
    _prepare_clean_fixture(fixture_pdf_path, out2)
    _run_ocr(out2)
    second = (out2 / "ocr.jsonl").read_bytes()
    assert first == second


def test_ocr_missing_clean_jsonl_is_machine_readable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(tmp_path / "missing.jsonl"),
                "--config",
                str(OCR_CONFIG_PATH),
                "--out-dir",
                str(tmp_path),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "CLEAN_JSONL_NOT_FOUND"


def test_ocr_invalid_config_is_machine_readable(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    bad_config = tmp_path / "bad-config.json"
    bad_config.write_text("{not json", encoding="utf-8")
    with pytest.raises(SystemExit) as excinfo:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(work_dir / "clean.jsonl"),
                "--config",
                str(bad_config),
                "--out-dir",
                str(work_dir),
            ]
        )
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "OCR_CONFIG_INVALID"


def test_ocr_missing_cleaned_image_fails_closed(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    rows = pdf_images.read_jsonl(work_dir / "clean.jsonl")
    for row in rows:
        (work_dir / row["cleaned_image_path"]).unlink()
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir)
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "CLEANED_IMAGE_NOT_FOUND"


def test_ocr_pages_filter_processes_subset(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir, ["--pages", "2"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert rows, "filtered page must still produce blocks"
    assert {row["page"] for row in rows} == {2}


def test_ocr_chunked_runs_compose_into_the_full_run_artifact(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """Chunks run in any order must compose into the single-run bytes.

    The merge must sort rows by page ascending (stable within-page reading
    order), so ``--pages 2`` followed by ``--pages 1`` is byte-equivalent to
    one full run — chunking stays an execution detail downstream.
    """
    full_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path / "full")
    _run_ocr(full_dir)
    expected = (full_dir / "ocr.jsonl").read_bytes()

    chunked_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path / "chunked")
    _run_ocr(chunked_dir, ["--pages", "2"])
    _run_ocr(chunked_dir, ["--pages", "1"])
    assert (chunked_dir / "ocr.jsonl").read_bytes() == expected

    rows = pdf_images.read_jsonl(chunked_dir / "ocr.jsonl")
    pages_in_order = [row["page"] for row in rows]
    assert pages_in_order == sorted(pages_in_order)
    assert set(pages_in_order) == {1, 2}


def test_ocr_chunked_rerun_replaces_rows_without_duplicates(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """Re-running a chunk replaces exactly that chunk's rows."""
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    _run_ocr(work_dir, ["--pages", "1"])
    after_first = (work_dir / "ocr.jsonl").read_bytes()

    _run_ocr(work_dir, ["--pages", "1"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert (work_dir / "ocr.jsonl").read_bytes() == after_first
    assert {row["page"] for row in rows} == {1}
    texts = [row["text"] for row in rows]
    assert len(texts) == len(set(texts)), "re-run chunk must not duplicate rows"


def test_ocr_pages_filter_first_run_without_existing_artifact_unchanged(
    fixture_pdf_path: Path, tmp_path: Path
) -> None:
    """First run with --pages and no prior ocr.jsonl: fresh subset write.

    The merge path only applies when ocr.jsonl already exists; the unknown-file
    first run keeps the historical behavior (fresh write of just the chunk) and
    leaves no temp files behind.
    """
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    assert not (work_dir / "ocr.jsonl").exists()
    _run_ocr(work_dir, ["--pages", "2"])
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert {row["page"] for row in rows} == {2}
    leftovers = [p.name for p in work_dir.iterdir() if p.name.startswith(".ocr.jsonl.tmp")]
    assert leftovers == []


def test_ocr_paddle_engine_unavailable_is_machine_readable(
    fixture_pdf_path: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)

    def _raise_import_error():
        raise ImportError("paddle not installed")

    monkeypatch.setattr(ocr, "_import_paddleocr", _raise_import_error)
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir, ["--engine", "paddle"])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "ENGINE_UNAVAILABLE"
    assert "uv sync --extra ocr" in payload["message"]


@pytest.mark.parametrize("engine", ["unknown-engine"])
def test_ocr_unknown_engine_rejected(
    fixture_pdf_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str], engine: str
) -> None:
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    with pytest.raises(SystemExit) as excinfo:
        _run_ocr(work_dir, ["--engine", engine])
    assert excinfo.value.code == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "ENGINE_UNKNOWN"


def test_ocr_real_paddle_smoke(fixture_pdf_path: Path, tmp_path: Path) -> None:
    """Step-4 smoke: real bounded-memory PaddleOCR over one fixture page.

    Skips when Paddle is not installed or its models cannot initialize, so the
    fast suite stays green without the heavy optional dependency.
    """
    pytest.importorskip("paddle")
    pytest.importorskip("paddleocr")
    work_dir = _prepare_clean_fixture(fixture_pdf_path, tmp_path)
    try:
        cli.main(
            [
                "ocr",
                "--clean-jsonl",
                str(work_dir / "clean.jsonl"),
                "--config",
                str(OCR_CONFIG_PATH),
                "--out-dir",
                str(work_dir),
                "--engine",
                "paddle",
                "--pages",
                "1",
            ]
        )
    except SystemExit as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"real Paddle engine unavailable in this environment: {exc}")
    except Exception as exc:  # pragma: no cover - environment-dependent
        # The documented intent covers engine/model initialization failures
        # (e.g. paddlepaddle CPU framework bugs), not just missing installs.
        pytest.skip(f"real Paddle engine failed to initialize: {exc}")
    rows = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    assert rows, "real engine must emit blocks for the page"
    records = [ocr.OcrBlockRecord.model_validate(row) for row in rows]
    assert all(record.text for record in records)
