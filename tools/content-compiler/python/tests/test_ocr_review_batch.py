"""The private OCR review batch is evidence, never an automatic correction."""

import json

import pytest

from lexiloop_media.ocr_review_batch import aggregate_readings, checkpoint_matches, header_crop_box, merge_candidate_spaces, merge_agreed_spaces, select_example_line_rows, write_dual_spacing_report


def _reading(model: str, text: str, *, packet_id: str = "p1", score: float = 0.9) -> dict:
    return {
        "page": 16,
        "bbox": [0.1, 0.2, 0.4, 0.23],
        "packets": [{"id": packet_id, "field": "phonetic", "current": "[?]"}],
        "review_text": text,
        "review_score": score,
        "model": model,
    }


def test_aggregate_keeps_three_raw_readings_and_does_not_auto_approve() -> None:
    rows = aggregate_readings(
        {
            "en": [_reading("en", "word [wɜ:d]")],
            "mobile": [_reading("mobile", "word [wɜ:d]")],
            "server": [_reading("server", "word [w3:d]")],
        }
    )
    assert len(rows) == 1
    assert rows[0]["agreement"] == "TWO_MODEL_AGREEMENT"
    assert rows[0]["candidate"] == "[wɜ:d]"
    assert rows[0]["verdict"] == "UNREVIEWED"
    assert rows[0]["readings"]["server"]["text"] == "word [w3:d]"


def test_aggregate_rejects_mismatched_packet_identity() -> None:
    with pytest.raises(ValueError, match="packet sets differ"):
        aggregate_readings(
            {"en": [_reading("en", "word [a]")], "server": [_reading("server", "word [a]", packet_id="p2")]}
        )


def test_header_crop_is_bounded_even_when_review_bbox_spans_gloss() -> None:
    assert header_crop_box([0.1, 0.2, 0.8, 0.5], 1907, 2824) == (
        176, 558, 1539, 669
    )


def test_checkpoint_is_invalidated_when_packet_hash_changes() -> None:
    previous = [{
        "model": "server", "original_image_sha256": "image", "config_sha256": "config",
        "packets": [{"id": "p1", "packet_hash": "old"}],
    }]
    assert checkpoint_matches(previous, {"p1": "old"}, "image", "config", "server")
    assert not checkpoint_matches(previous, {"p1": "new"}, "image", "config", "server")


def test_spacing_candidate_preserves_every_source_character_and_existing_space() -> None:
    assert merge_candidate_spaces("products aredesignedtobetter", "productsare designed to better") == (
        "products are designed to better"
    )
    assert merge_candidate_spaces("word hasbeen", "word has been changed") is None
    assert merge_candidate_spaces("词汇", "词 汇") == "词汇"


def test_dual_model_spacing_keeps_only_shared_new_boundaries() -> None:
    assert merge_agreed_spaces(
        "products aredesignedtobetter",
        "products are designedtobetter",
        "products are designed tobetter",
    ) == "products are designedtobetter"
    assert merge_agreed_spaces("word hasbeen", "word has been", "word has changed") is None


def test_dual_report_rejects_readings_from_different_source_images(tmp_path) -> None:
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()
    base = {
        "page": 1, "bbox": [0.1, 0.2, 0.4, 0.3], "source_raw_ref_hash": "raw",
        "old_text": "theyhave", "review_text": "they have", "review_score": 0.95,
    }
    (first_dir / "page-0001.jsonl").write_text(json.dumps({**base, "original_image_sha256": "image-a"}) + "\n")
    (second_dir / "page-0001.jsonl").write_text(json.dumps({**base, "original_image_sha256": "image-b"}) + "\n")
    with pytest.raises(ValueError, match="identities differ"):
        write_dual_spacing_report(first_dir, second_dir, tmp_path / "report")


def test_example_line_selection_limits_crops_to_source_example_regions() -> None:
    lines = [
        {"page": 17, "bbox": [0.11, 0.1, 0.45, 0.12], "text": "shortgluedwords"},
        {"page": 17, "bbox": [0.11, 0.8, 0.45, 0.82], "text": "unrelated"},
        {"page": 18, "bbox": [0.11, 0.1, 0.45, 0.12], "text": "otherpage"},
    ]
    examples = [{"page_number": 17, "bbox": [0.1, 0.09, 0.5, 0.2]}]
    assert select_example_line_rows(lines, examples) == [lines[0]]
    assert select_example_line_rows(lines, examples, exclude_long_lines=True) == []
