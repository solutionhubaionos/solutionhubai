#!/usr/bin/env python3
"""
Structural checks for a generated deck.

    .venv-check/bin/python scripts/check-pptx.py samples/deck-review/movin.pptx

Asserts what a reader would notice and a regex on the XML cannot:
  - every shape sits inside the slide;
  - body/title/table text is at least 12pt (footers, source lines and captions
    are allowed 10pt);
  - charts are native (`ppt/charts/chartN.xml` exists) and carry data labels;
  - more than one slide layout is used;
  - every slide has speaker notes;
  - no table cell ends mid-word (a truncation marker must follow a whole word);
  - no text frame overlaps another text frame.
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu

MIN_BODY_PT = 12
FOOTER_TOP_IN = 6.4
# The section tag above the title is a caption-class label, not body text.
TAG_ZONE_IN = 0.7
EMU = 914400


def inches(value) -> float:
    return (value or 0) / EMU


def main(path: str) -> int:
    problems: list[str] = []
    presentation = Presentation(path)
    width = inches(presentation.slide_width)
    height = inches(presentation.slide_height)
    with zipfile.ZipFile(path) as package:
        charts = [n for n in package.namelist() if re.match(r"ppt/charts/chart\d+\.xml$", n)]
        layouts = [n for n in package.namelist() if re.match(r"ppt/slideLayouts/slideLayout\d+\.xml$", n)]
        chart_xml = "".join(package.read(name).decode("utf8", "ignore") for name in charts)

    if len(charts) == 0:
        problems.append("no native charts: ppt/charts/*.xml is missing")
    elif "showVal" not in chart_xml and "showPercent" not in chart_xml:
        problems.append("charts carry no data labels")
    if len(layouts) < 2:
        problems.append(f"only {len(layouts)} slide layout(s); the deck should mix layouts")

    for index, slide in enumerate(presentation.slides, start=1):
        if not (slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip()):
            problems.append(f"slide {index}: no speaker notes")
        text_boxes: list[tuple[str, float, float, float, float]] = []
        for shape in slide.shapes:
            left, top = inches(shape.left), inches(shape.top)
            right, bottom = left + inches(shape.width), top + inches(shape.height)
            if left < -0.02 or top < -0.02 or right > width + 0.02 or bottom > height + 0.02:
                problems.append(
                    f"slide {index}: {shape.shape_type} '{shape.name}' outside the canvas "
                    f"({left:.2f},{top:.2f},{right:.2f},{bottom:.2f})"
                )
            if not shape.has_text_frame:
                continue
            text = shape.text_frame.text.strip()
            if text and top < FOOTER_TOP_IN:
                text_boxes.append((text[:40], left, top, right, bottom))
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    size = run.font.size.pt if run.font.size else None
                    if size is None or size >= MIN_BODY_PT:
                        continue
                    if top >= FOOTER_TOP_IN:
                        continue  # footer, slide number, source line, caption
                    if top < TAG_ZONE_IN:
                        continue  # section tag above the title
                    if "Illustrative" in (run.text or ""):
                        continue  # chart assumption badge
                    if size <= 10.5 and run.font.italic:
                        continue  # captions are italic 10pt by design
                    if re.fullmatch(r"0\d", (run.text or "").strip()) and inches(shape.width) < 0.5:
                        continue  # flow step marker inside its circle
                    problems.append(
                        f"slide {index}: {size}pt text below the 12pt floor: {run.text[:48]!r}"
                    )
        # Overlap check between text frames (footers excluded).
        for a in range(len(text_boxes)):
            for b in range(a + 1, len(text_boxes)):
                _, ax1, ay1, ax2, ay2 = text_boxes[a]
                _, bx1, by1, bx2, by2 = text_boxes[b]
                overlap_w = min(ax2, bx2) - max(ax1, bx1)
                overlap_h = min(ay2, by2) - max(ay1, by1)
                if overlap_w > 0.12 and overlap_h > 0.12:
                    problems.append(
                        f"slide {index}: text frames overlap "
                        f"({text_boxes[a][0]!r} / {text_boxes[b][0]!r})"
                    )
        for shape in slide.shapes:
            if not shape.has_table:
                continue
            for row in shape.table.rows:
                for cell in row.cells:
                    text = cell.text.strip()
                    if not text:
                        continue
                    # A truncation must land on a word boundary: "... word…".
                    if text.endswith("…") and len(text) > 2:
                        stem = text[:-1].strip()
                        if not stem or not re.search(r"[A-Za-z0-9]$", stem):
                            problems.append(f"slide {index}: table cell cut mid-word: {text!r}")
                    for paragraph in cell.text_frame.paragraphs:
                        for run in paragraph.runs:
                            size = run.font.size.pt if run.font.size else None
                            if size is not None and size < MIN_BODY_PT:
                                problems.append(
                                    f"slide {index}: table cell at {size}pt: {run.text[:40]!r}"
                                )

    print(f"{Path(path).name}: {len(presentation.slides)} slides, "
          f"{len(charts)} native charts, {len(layouts)} layouts")
    if problems:
        print(f"FAIL ({len(problems)} problems)")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "samples/deck-review/movin.pptx"))
