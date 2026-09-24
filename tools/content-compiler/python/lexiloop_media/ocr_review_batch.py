"""Bounded original-page OCR review and persistent, non-authoritative comparison.

The existing ``ocr.jsonl`` stays immutable. One model runs per process, one
original page is decoded at a time, and each page is checkpointed atomically.
Model agreement is evidence for triage, never an automatic PASS or correction.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Sequence

from lexiloop_media import ocr, pdf_images

MODELS = {
    "en": "en_PP-OCRv5_mobile_rec",
    "mobile": "PP-OCRv5_mobile_rec",
    "server": "PP-OCRv5_server_rec",
}
PHONETIC_RE = re.compile(r"\[[^\]\n]{2,40}\]")


def header_crop_box(
    bbox: Sequence[float], width: int, height: int
) -> tuple[int, int, int, int]:
    """Keep one review crop within the header even if bbox includes a gloss."""
    x0, y0, x1, y1 = bbox
    header_y1 = min(y1, y0 + 0.035) if y1 - y0 > 0.038 else y1
    return (
        max(0, int(x0 * width) - 14),
        max(0, int(y0 * height) - 6),
        min(width, int(x1 * width) + 14),
        min(height, int(header_y1 * height) + 6),
    )


def _atomic_jsonl(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        pdf_images.write_jsonl(temporary, rows)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _packet_rows(work_dir: Path, *, include_resolved: bool) -> list[dict[str, Any]]:
    queue = work_dir / "agent-queue" / "visual-ocr"
    packets = pdf_images.read_jsonl(queue / "packets.jsonl")
    resolved = {
        row["packet_id"] for row in pdf_images.read_jsonl(queue / "results.jsonl")
    }
    return [
        row for row in packets
        if include_resolved or row["packet"]["packet_id"] not in resolved
    ]


def checkpoint_matches(
    previous: Sequence[dict[str, Any]],
    expected_packets: dict[str, str],
    image_hash: str,
    config_hash: str,
    model: str,
) -> bool:
    actual_packets = {
        packet["id"]: packet.get("packet_hash")
        for row in previous for packet in row["packets"]
    }
    return (
        actual_packets == expected_packets
        and all(
            row.get("original_image_sha256") == image_hash
            and row.get("config_sha256") == config_hash
            and row.get("model") == model
            for row in previous
        )
    )


def run_model(
    work_dir: Path,
    config_path: Path,
    output_dir: Path,
    model: str,
    *,
    include_resolved: bool = False,
    limit_pages: int | None = None,
) -> dict[str, int]:
    """Run one model over queued headers, checkpointing each page."""
    if model not in MODELS:
        raise ValueError(f"unknown model: {model}")
    config = ocr.load_config(config_path)
    config_hash = pdf_images.sha256_file(config_path)
    source_rows = {
        int(row["page"]): row
        for row in pdf_images.read_jsonl(work_dir / "clean.jsonl")
    }
    grouped: dict[int, dict[tuple[float, ...], list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for stored in _packet_rows(work_dir, include_resolved=include_resolved):
        packet = stored["packet"]
        grouped[int(packet["page_number"])][tuple(packet["bbox"])].append(stored)
    pages = sorted(grouped)
    if limit_pages is not None:
        pages = pages[:limit_pages]
    params = dict(config.engine_params)
    params["text_recognition_model_name"] = MODELS[model]
    pipeline = ocr._import_paddleocr()(**params)
    counts = {"pages": 0, "reused": 0, "packets": 0}
    for page in pages:
        source = source_rows[page]
        image_path = work_dir / source["original_image_path"]
        image_hash = pdf_images.sha256_file(image_path)
        if image_hash != source["original_image_sha256"]:
            raise ValueError(f"page {page}: original image hash mismatch")
        expected_packets = {
            stored["packet"]["packet_id"]: stored["packet_hash"]
            for items in grouped[page].values()
            for stored in items
        }
        out_path = output_dir / "models" / model / f"page-{page:04d}.jsonl"
        if out_path.exists():
            previous = pdf_images.read_jsonl(out_path)
            if checkpoint_matches(previous, expected_packets, image_hash, config_hash, model):
                counts["reused"] += 1
                counts["packets"] += len(expected_packets)
                continue
        image = ocr._decode_image(image_path)
        height, width = image.shape[:2]
        page_rows: list[dict[str, Any]] = []
        for bbox, items in sorted(grouped[page].items()):
            x0, y0, x1, y1 = header_crop_box(bbox, width, height)
            crop = ocr.np.ascontiguousarray(image[y0:y1, x0:x1])
            if crop.size == 0:
                raise ValueError(f"page {page}: empty review crop for {bbox}")
            import cv2

            enlarged = cv2.resize(crop, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
            text, score = ocr._recognize_with_pipeline(pipeline, enlarged)
            page_rows.append(
                {
                    "source_sha256": source["source_sha256"],
                    "original_image_sha256": image_hash,
                    "config_sha256": config_hash,
                    "model": model,
                    "page": page,
                    "bbox": list(bbox),
                    "crop_px": [x0, y0, x1, y1],
                    "packets": [
                        {
                            "id": item["packet"]["packet_id"],
                            "packet_hash": item["packet_hash"],
                            "field": item["packet"]["field"],
                            "current": item["packet"]["current_text"],
                        }
                        for item in items
                    ],
                    "review_text": text,
                    "review_score": score,
                }
            )
            del crop, enlarged
        _atomic_jsonl(out_path, page_rows)
        counts["pages"] += 1
        counts["packets"] += len(expected_packets)
        del image
        gc.collect()
    return counts


def select_example_line_rows(
    lines: Sequence[dict[str, Any]],
    examples: Sequence[dict[str, Any]],
    *,
    exclude_long_lines: bool = False,
) -> list[dict[str, Any]]:
    """Select small physical OCR lines wholly inside normalized examples."""
    regions: dict[int, list[Sequence[float]]] = defaultdict(list)
    for example in examples:
        regions[int(example["page_number"])].append(example["bbox"])
    selected = []
    for row in lines:
        x0, y0, x1, y1 = row["bbox"]
        if x1 - x0 > 0.6 or y1 - y0 > 0.06:
            continue
        # This pass repairs English word boundaries. Pure Chinese labels,
        # page numbers, phonetics and single-word badges add OCR cost only.
        if sum(char.isascii() and char.isalpha() for char in row["text"]) < 5:
            continue
        if exclude_long_lines and re.search(r"[A-Za-z]{12}", row["text"]):
            continue
        if any(
            x0 >= a - 0.005 and x1 <= c + 0.005
            and y0 >= b - 0.005 and y1 <= d + 0.005
            for a, b, c, d in regions[int(row["page"])]
        ):
            selected.append(row)
    return selected


def run_long_lines(
    work_dir: Path, config_path: Path, output_dir: Path, model: str = "server",
    *, example_bboxes_path: Path | None = None,
    exclude_long_lines: bool = False,
) -> dict[str, int]:
    """Re-read suspicious long lines at 2x from original pages, then checkpoint.

    The recognizer sees only one line crop at a time. The full page lives only
    as a decoded image, and a new image replaces it before the next page.
    ``ocr.jsonl`` is never changed by this pass.
    """
    if model not in MODELS:
        raise ValueError(f"unknown model: {model}")
    config = ocr.load_config(config_path)
    config_hash = pdf_images.sha256_file(config_path)
    source_rows = {
        int(row["page"]): row
        for row in pdf_images.read_jsonl(work_dir / "clean.jsonl")
    }
    selected: dict[int, list[dict[str, Any]]] = defaultdict(list)
    raw_lines = pdf_images.read_jsonl(work_dir / "ocr.jsonl")
    if example_bboxes_path is not None:
        examples = pdf_images.read_jsonl(example_bboxes_path)
        if any(example["source_pdf_sha256"] != source_rows[int(example["page_number"])]["source_sha256"] for example in examples):
            raise ValueError("example regions have a different source PDF")
        rows = select_example_line_rows(raw_lines, examples, exclude_long_lines=exclude_long_lines)
    else:
        rows = [row for row in raw_lines if
                re.search(r"[A-Za-z]{12}", row["text"])
                and row["bbox"][2] - row["bbox"][0] <= 0.6
                and row["bbox"][3] - row["bbox"][1] <= 0.06]
    for row in rows:
        selected[int(row["page"])].append(row)
    pipeline: Any = None
    counts = {"selected_lines": sum(map(len, selected.values())), "new_pages": 0, "reused_pages": 0}
    for page in sorted(selected):
        source = source_rows[page]
        image_path = work_dir / source["original_image_path"]
        image_hash = pdf_images.sha256_file(image_path)
        if image_hash != source["original_image_sha256"]:
            raise ValueError(f"page {page}: original image hash mismatch")
        page_rows = selected[page]
        target = output_dir / f"page-{page:04d}.jsonl"
        if target.exists():
            prior = pdf_images.read_jsonl(target)
            if len(prior) == len(page_rows) and all(
                prior[index].get("bbox") == row["bbox"]
                and prior[index].get("source_raw_ref_hash") == row["source_raw_ref_hash"]
                and prior[index].get("original_image_sha256") == image_hash
                and prior[index].get("config_sha256") == config_hash
                and prior[index].get("model", "server") == model
                for index, row in enumerate(page_rows)
            ):
                counts["reused_pages"] += 1
                continue
        if pipeline is None:
            params = dict(config.engine_params)
            params["text_recognition_model_name"] = MODELS[model]
            pipeline = ocr._import_paddleocr()(**params)
        import cv2

        image = ocr._decode_image(image_path)
        height, width = image.shape[:2]
        result_rows = []
        for row in page_rows:
            x0, y0, x1, y1 = row["bbox"]
            left = max(0, int(x0 * width) - 8)
            right = min(width, int(x1 * width) + 8)
            top = max(0, int(y0 * height) - 5)
            bottom = min(height, int(y1 * height) + 5)
            crop = ocr.np.ascontiguousarray(image[top:bottom, left:right])
            if crop.size == 0:
                raise ValueError(f"page {page}: empty long-line crop")
            enlarged = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            text, score = ocr._recognize_with_pipeline(pipeline, enlarged)
            result_rows.append(
                {
                    "page": page,
                    "bbox": row["bbox"],
                    "source_raw_ref_hash": row["source_raw_ref_hash"],
                    "original_image_sha256": image_hash,
                    "config_sha256": config_hash,
                    "model": model,
                    "old_text": row["text"],
                    "old_score": row["confidence"],
                    "review_text": text,
                    "review_score": score,
                    "crop_px": [left, top, right, bottom],
                }
            )
            del crop, enlarged
        _atomic_jsonl(target, result_rows)
        counts["new_pages"] += 1
        del image
        gc.collect()
    return counts


def _phonetic(text: str) -> str:
    match = PHONETIC_RE.search(text)
    return match.group(0) if match else ""


def _normalized(value: str) -> str:
    return re.sub(r"[^\w()]+", "", value.casefold()).replace("ː", "")


def _chars_and_gaps(value: str) -> tuple[list[str], list[str]]:
    chars: list[str] = []
    gaps = [""]
    for char in value:
        if char.isspace():
            gaps[-1] += char
        else:
            chars.append(char)
            gaps.append("")
    return chars, gaps


def merge_candidate_spaces(original: str, reread: str) -> str | None:
    """Propose added English spaces only when both readings have identical chars.

    The original OCR characters and all of its existing whitespace are kept.
    This is a candidate for review, not a validated source correction: OCR can
    hallucinate a split inside a real word even when it reads every glyph.
    """
    original_chars, original_gaps = _chars_and_gaps(original)
    reread_chars, reread_gaps = _chars_and_gaps(reread)
    if original_chars != reread_chars:
        return None
    output = [original_gaps[0]]
    for index, char in enumerate(original_chars):
        output.append(char)
        gap = original_gaps[index + 1]
        if (
            index + 1 < len(original_chars)
            and not gap
            and reread_gaps[index + 1]
            and char.isascii() and char.isalpha()
            and original_chars[index + 1].isascii()
            and original_chars[index + 1].isalpha()
        ):
            gap = " "
        output.append(gap)
    return "".join(output)


def merge_agreed_spaces(original: str, first: str, second: str) -> str | None:
    """Keep source spaces plus only English splits shared by two OCR models."""
    original_chars, original_gaps = _chars_and_gaps(original)
    first_chars, first_gaps = _chars_and_gaps(first)
    second_chars, second_gaps = _chars_and_gaps(second)
    if original_chars != first_chars or original_chars != second_chars:
        return None
    output = [original_gaps[0]]
    for index, char in enumerate(original_chars):
        output.append(char)
        gap = original_gaps[index + 1]
        if (
            index + 1 < len(original_chars)
            and not gap
            and first_gaps[index + 1]
            and second_gaps[index + 1]
            and char.isascii() and char.isalpha()
            and original_chars[index + 1].isascii()
            and original_chars[index + 1].isalpha()
        ):
            gap = " "
        output.append(gap)
    return "".join(output)


def aggregate_readings(
    readings: dict[str, list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    """Join models by packet identity; all outputs remain UNREVIEWED."""
    indexed: dict[str, dict[str, tuple[dict[str, Any], dict[str, Any]]]] = {}
    for model, rows in readings.items():
        by_id = {}
        for row in rows:
            for packet in row["packets"]:
                packet_id = packet["id"]
                if packet_id in by_id:
                    raise ValueError(f"duplicate packet {packet_id} in {model}")
                by_id[packet_id] = (row, packet)
        indexed[model] = by_id
    if not indexed:
        return []
    first_model = next(iter(indexed))
    ids = set(indexed[first_model])
    if any(set(model_rows) != ids for model_rows in indexed.values()):
        raise ValueError("packet sets differ between OCR models")
    result = []
    for packet_id in sorted(ids):
        first, first_packet = indexed[first_model][packet_id]
        raw = {}
        candidates = []
        for model, model_rows in indexed.items():
            row, packet = model_rows[packet_id]
            if (
                row["page"] != first["page"]
                or row["bbox"] != first["bbox"]
                or packet["field"] != first_packet["field"]
                or packet["current"] != first_packet["current"]
            ):
                raise ValueError(f"packet {packet_id}: OCR model identity mismatch")
            candidate = _phonetic(str(row["review_text"])) if packet["field"] == "phonetic" else ""
            raw[model] = {
                "text": row["review_text"],
                "score": row["review_score"],
                "candidate": candidate,
            }
            if candidate:
                candidates.append((model, candidate))
        best: tuple[str, str] | None = None
        matches = 0
        for model, candidate in candidates:
            count = sum(
                SequenceMatcher(None, _normalized(candidate), _normalized(other)).ratio()
                >= 0.82
                for _other_model, other in candidates
            )
            if count > matches:
                best = (model, candidate)
                matches = count
        agreement = (
            "THREE_MODEL_AGREEMENT" if matches >= 3 else
            "TWO_MODEL_AGREEMENT" if matches == 2 else "CONFLICT"
        )
        result.append(
            {
                "packet_id": packet_id,
                "packet_hash": first_packet.get("packet_hash"),
                "page": first["page"],
                "bbox": first["bbox"],
                "field": first_packet["field"],
                "current_text": first_packet["current"],
                "candidate": best[1] if best and matches >= 2 else "",
                "agreement": agreement,
                "verdict": "UNREVIEWED",
                "readings": raw,
            }
        )
    return sorted(result, key=lambda row: (row["page"], row["packet_id"]))


def _read_input(path: Path) -> list[dict[str, Any]]:
    if path.is_dir():
        rows = []
        for page_path in sorted(path.glob("page-*.jsonl")):
            rows.extend(pdf_images.read_jsonl(page_path))
        return rows
    return pdf_images.read_jsonl(path)


def write_report(
    inputs: dict[str, Path], output_dir: Path, source_sha256: str
) -> dict[str, Any]:
    readings = {model: _read_input(path) for model, path in inputs.items()}
    rows = aggregate_readings(readings)
    output_dir.mkdir(parents=True, exist_ok=True)
    _atomic_jsonl(output_dir / "aggregate.jsonl", rows)
    source_hashes = {}
    for model, path in inputs.items():
        if path.is_file():
            source_hashes[model] = pdf_images.sha256_file(path)
        else:
            digest = hashlib.sha256()
            for file in sorted(path.glob("page-*.jsonl")):
                digest.update(file.name.encode())
                digest.update(bytes.fromhex(pdf_images.sha256_file(file)))
            source_hashes[model] = digest.hexdigest()
    summary = {
        "source_sha256": source_sha256,
        "input_sha256": source_hashes,
        "packet_count": len(rows),
        "agreement": dict(Counter(row["agreement"] for row in rows)),
        "verdict": "UNREVIEWED",
        "aggregate_sha256": pdf_images.sha256_file(output_dir / "aggregate.jsonl"),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def write_line_spacing_report(input_dir: Path, output_dir: Path) -> dict[str, Any]:
    """Collect character-preserving spacing candidates from saved page OCR."""
    files = sorted(input_dir.glob("page-*.jsonl"))
    if not files:
        raise ValueError(f"no page OCR results under {input_dir}")
    candidates = []
    examined = 0
    input_digest = hashlib.sha256()
    for file in files:
        input_digest.update(file.name.encode())
        input_digest.update(bytes.fromhex(pdf_images.sha256_file(file)))
        for row in pdf_images.read_jsonl(file):
            examined += 1
            merged = merge_candidate_spaces(row["old_text"], row["review_text"])
            if (
                merged is None or merged == row["old_text"]
                or float(row["review_score"]) < 0.90
            ):
                continue
            candidates.append(
                {
                    "page": row["page"],
                    "bbox": row["bbox"],
                    "source_raw_ref_hash": row["source_raw_ref_hash"],
                    "original_image_sha256": row["original_image_sha256"],
                    "old_text": row["old_text"],
                    "reread_text": row["review_text"],
                    "candidate_text": merged,
                    "review_score": row["review_score"],
                    "verdict": "UNREVIEWED",
                }
            )
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "spacing-candidates.jsonl"
    _atomic_jsonl(target, candidates)
    summary = {
        "examined_lines": examined,
        "candidate_lines": len(candidates),
        "input_sha256": input_digest.hexdigest(),
        "candidates_sha256": pdf_images.sha256_file(target),
        "verdict": "UNREVIEWED",
    }
    (output_dir / "spacing-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def write_dual_spacing_report(
    first_dir: Path, second_dir: Path, output_dir: Path
) -> dict[str, Any]:
    """Collect source-character-preserving splits supported by both models."""
    first_files = sorted(first_dir.glob("page-*.jsonl"))
    second_files = sorted(second_dir.glob("page-*.jsonl"))
    if not first_files or [x.name for x in first_files] != [x.name for x in second_files]:
        raise ValueError("long-line OCR page sets differ between models")
    candidates = []
    examined = 0
    digest = hashlib.sha256()
    for first_file, second_file in zip(first_files, second_files):
        first_rows = pdf_images.read_jsonl(first_file)
        second_rows = pdf_images.read_jsonl(second_file)
        if len(first_rows) != len(second_rows):
            raise ValueError(f"{first_file.name}: OCR row counts differ")
        for file in (first_file, second_file):
            digest.update(file.name.encode())
            digest.update(bytes.fromhex(pdf_images.sha256_file(file)))
        for first, second in zip(first_rows, second_rows):
            examined += 1
            identity = ("page", "bbox", "source_raw_ref_hash", "original_image_sha256", "old_text")
            if any(first[field] != second[field] for field in identity):
                raise ValueError(f"{first_file.name}: OCR source row identities differ")
            merged = merge_agreed_spaces(
                first["old_text"], first["review_text"], second["review_text"]
            )
            if (
                merged is None or merged == first["old_text"]
                or min(float(first["review_score"]), float(second["review_score"])) < 0.90
            ):
                continue
            candidates.append(
                {
                    "page": first["page"],
                    "bbox": first["bbox"],
                    "source_raw_ref_hash": first["source_raw_ref_hash"],
                    "original_image_sha256": first["original_image_sha256"],
                    "old_text": first["old_text"],
                    "first_text": first["review_text"],
                    "second_text": second["review_text"],
                    "candidate_text": merged,
                    "first_score": first["review_score"],
                    "second_score": second["review_score"],
                    "verdict": "UNREVIEWED",
                }
            )
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "dual-spacing-candidates.jsonl"
    _atomic_jsonl(target, candidates)
    summary = {
        "examined_lines": examined,
        "candidate_lines": len(candidates),
        "input_sha256": digest.hexdigest(),
        "candidates_sha256": pdf_images.sha256_file(target),
        "verdict": "UNREVIEWED",
    }
    (output_dir / "dual-spacing-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="bounded original-page OCR, one model per process")
    run.add_argument("--work-dir", type=Path, required=True)
    run.add_argument("--config", type=Path, required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    run.add_argument("--model", choices=sorted(MODELS), required=True)
    run.add_argument("--include-resolved", action="store_true")
    run.add_argument("--limit-pages", type=int)
    long_lines = sub.add_parser("run-lines", help="bounded original-page reread of long OCR lines")
    long_lines.add_argument("--work-dir", type=Path, required=True)
    long_lines.add_argument("--config", type=Path, required=True)
    long_lines.add_argument("--output-dir", type=Path, required=True)
    long_lines.add_argument("--model", choices=sorted(MODELS), default="server")
    long_lines.add_argument("--examples", type=Path, help="normalized example JSONL for a targeted pass")
    long_lines.add_argument("--exclude-long-lines", action="store_true", help="reuse earlier long-line results")
    report = sub.add_parser("report", help="combine immutable model readings")
    report.add_argument("--source-sha256", required=True)
    report.add_argument("--output-dir", type=Path, required=True)
    report.add_argument("--input", action="append", required=True, help="MODEL=FILE_OR_DIR")
    lines = sub.add_parser("report-lines", help="summarize saved long-line OCR")
    lines.add_argument("--input-dir", type=Path, required=True)
    lines.add_argument("--output-dir", type=Path, required=True)
    dual = sub.add_parser("report-lines-dual", help="compare two saved long-line OCR models")
    dual.add_argument("--first-dir", type=Path, required=True)
    dual.add_argument("--second-dir", type=Path, required=True)
    dual.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "run":
        summary = run_model(
            args.work_dir, args.config, args.output_dir, args.model,
            include_resolved=args.include_resolved, limit_pages=args.limit_pages,
        )
    elif args.command == "run-lines":
        summary = run_long_lines(
            args.work_dir, args.config, args.output_dir, args.model,
            example_bboxes_path=args.examples, exclude_long_lines=args.exclude_long_lines,
        )
    elif args.command == "report":
        inputs = {}
        for item in args.input:
            model, separator, file_name = item.partition("=")
            if not separator or not file_name or model in inputs:
                parser.error(f"invalid --input {item!r}; expected unique MODEL=PATH")
            inputs[model] = Path(file_name)
        summary = write_report(inputs, args.output_dir, args.source_sha256)
    elif args.command == "report-lines":
        summary = write_line_spacing_report(args.input_dir, args.output_dir)
    else:
        summary = write_dual_spacing_report(args.first_dir, args.second_dir, args.output_dir)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
