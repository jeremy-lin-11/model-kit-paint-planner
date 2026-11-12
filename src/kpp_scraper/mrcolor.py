"""Mr. Color (GSI Creos) basic line C1–C189.

Colors: the official "color lineup" chart image on mr-hobby.com (one chip per paint).
Names and finishes: the official English color list PDF, which tags each paint with
G / SG / M / ME / PA.
"""

from __future__ import annotations

import io
import logging
import re

from pypdf import PdfReader

from .common import Paint, fetch, fetch_image, fetch_text, rgb_to_hex, sample_chip

BRAND = "Mr. Color"
LINE = "Mr. Color (C)"
DETAIL_PAGE = "https://www.mr-hobby.com/ja/products/detail/1"
COLOR_LIST_PDF = "https://www.mr-hobby.com/en/record-download/catalog/23"

# Reading order of the chart image, transcribed and checked by eye. None = note cell.
LAYOUT: list[list[int | None]] = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    [21, 22, 23, 25, 26, 27, 28, 29, 30, 31],
    [32, 33, 34, 35, 36, 37, 38, 39, 40, 41],
    [42, 43, 44, 45, 46, 47, 48, 49, 50, 51],
    [52, 54, 55, 56, 57, 58, 59, 60, 61, 62],
    [63, 64, 65, 66, 67, 68, 69, 70, 71, 72],
    [73, 74, 75, 76, 77, 78, 79, 80, 81, 90],
    [92, 97, 100, 101, 104, 107, 108, 109, 110, 111],
    [112, 113, 114, 115, 116, 117, 118, 119, 120, 121],
    [122, 123, 124, 125, 126, 127, 128, 129, 130, 131],
    [132, 135, 136, 137, 138, 151, 156, 158, 159, 171],
    [172, 173, 174, 175, None, 181, 182, 183, 188, 189],
]
# Cell geometry of the 1178x1085 chart (measured from the white gutters).
EXPECTED_SIZE = (1178, 1085)
COL_X = [14, 130, 246, 362, 477, 594, 710, 826, 941, 1057]
ROW_Y = [8, 90, 172, 255, 338, 420, 503, 586, 668, 751, 834, 916, 999]
CHIP_BOX = (40, 4, 102, 40)  # chip area relative to the cell's top-left corner

PDF_FINISH = {"G": "gloss", "SG": "semi-gloss", "M": "flat", "ME": "metallic",
              "MG": "metallic", "PA": "pearl"}

NON_COLORS = {30: "flat base", 46: "clear", 181: "clear", 182: "clear", 183: "clear",
              188: "flat base", 189: "flat base"}
CLEAR_COLORS = {47, 48, 49, 50, 138}
FLUORESCENT = {171, 172, 173, 174, 175}
# Codes on the chart but absent from the color list PDF (name read off the chart).
MANUAL_NAMES = {172: ("Fluorescent Yellow", "fluorescent")}


def _clean_name(parts: list[str]) -> str:
    s = " ".join(p.strip() for p in parts)
    s = s.replace("ʢ", "(").replace("ʣ", ")").replace("ᶘ", "").replace("ᶚ", "")
    s = re.sub(r"\s+", " ", s).replace(" )", ")").replace("( ", "(").strip()
    return s.title().replace("Rlm", "RLM").replace("Ijn", "IJN").replace("Ija", "IJA")


def parse_color_list(pdf_bytes: bytes) -> dict[int, tuple[str, str]]:
    """Return {code: (english_name, finish)} for codes 1–189 from the color list PDF."""
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(pdf_bytes)).pages)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out: dict[int, tuple[str, str]] = {}
    i = 0
    while i < len(lines):
        tok = lines[i]
        if tok.isdigit() and 1 <= int(tok) <= 189 and int(tok) not in out:
            name_parts: list[str] = []
            j = i + 1
            while j < len(lines) and j <= i + 6:
                t = lines[j]
                if t in PDF_FINISH:
                    break
                if "ɾ" in t:            # usage tags like "USɾA" — not part of the name
                    j += 1
                    continue
                if not re.fullmatch(r"[A-Zʢʣᶘᶚ0-9 .()'&\-]+", t):
                    name_parts = []
                    break
                name_parts.append(t)
                j += 1
            if name_parts and j < len(lines) and lines[j] in PDF_FINISH:
                out[int(tok)] = (_clean_name(name_parts), PDF_FINISH[lines[j]])
                i = j
        i += 1
    return out


def lineup_image_url() -> str:
    html = fetch_text(DETAIL_PAGE)
    m = re.search(r'https://www\.mr-hobby\.com/uploads/products/color_lineup/[A-Z0-9]+\.png', html)
    if not m:
        raise RuntimeError("Mr. Color lineup image not found on detail page; layout may have changed")
    return m.group(0)


def scrape() -> list[Paint]:
    img_url = lineup_image_url()
    img = fetch_image(img_url)
    if img.size != EXPECTED_SIZE:
        raise RuntimeError(f"Mr. Color chart is {img.size}, expected {EXPECTED_SIZE}; re-measure the grid")
    names = parse_color_list(fetch(COLOR_LIST_PDF))
    manual = {k: v for k, v in MANUAL_NAMES.items() if k not in names}

    paints: list[Paint] = []
    for r, row in enumerate(LAYOUT):
        for c, code in enumerate(row):
            if code is None:
                continue
            x0, y0 = COL_X[c], ROW_Y[r]
            box = (x0 + CHIP_BOX[0], y0 + CHIP_BOX[1], x0 + CHIP_BOX[2], y0 + CHIP_BOX[3])
            chip = sample_chip(img, box)
            name, finish = names.get(code) or manual.get(code) or (f"C{code}", None)
            notes = []
            if code in manual:
                notes.append("not in color list PDF; name taken from the chart image")
            elif code not in names:
                notes.append("name/finish missing from color list PDF")
            if code in CLEAR_COLORS:
                finish = "clear-color"
            elif code in NON_COLORS:
                finish = "clear" if NON_COLORS[code] == "clear" else finish
                notes.append(NON_COLORS[code])
            elif code in FLUORESCENT:
                finish = "fluorescent"
            paints.append(Paint(
                brand=BRAND, line=LINE, code=f"C{code}", name=name,
                hex=rgb_to_hex(chip.rgb), finish=finish,
                finish_source="official" if code in names else ("manual" if code in manual else "unknown"),
                source_url=DETAIL_PAGE, image_url=img_url,
                source_method=f"chart chip median, box {box}",
                confidence="medium", is_color=code not in NON_COLORS,
                sheen_lab_range=(chip.lab_p10, chip.lab_p90) if finish in ("metallic", "pearl") else None,
                notes=notes,
            ))
    return paints
