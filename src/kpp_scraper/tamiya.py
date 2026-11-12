"""Tamiya — Lacquer (LP), Acrylic (X / XF) and Spray (TS) lines.

Colors: the official hexagon color chip on each product's listing image.
Names: the listing title. Finish: inferred from the code prefix, the name, and the
one-line description on the product page. Equivalent sprays come from the product page.
"""

from __future__ import annotations

import html
import re

from .common import Paint, fetch_image, fetch_text, rgb_to_hex, sample_chip

BRAND = "Tamiya"
SITE = "https://www.tamiya.com"
LIST_URL = SITE + "/english/products/list.html?field_sort=d&cmdarticlesearch=1&genre_item={genre}&absolutepage={page}"
GENRES = {
    "e_504005": "Tamiya Color Lacquer (LP)",
    "e_504009": "Tamiya Color Acrylic (X/XF)",
    "e_504010": "Tamiya Color Acrylic (X/XF)",  # "Mini" listing has ~23 colors the main one lacks
    "e_504030": "Tamiya Color Spray (TS)",
}
CODE_RE = re.compile(r"\b((?:LP|XF|X|TS)-\d+[A-Z]?)\s+(.+)$")  # titles may have an "ACRYLIC MINI" prefix
ITEM_RE = re.compile(
    r'data-article="(\d+)".*?<img[^>]+src="([^"]+?)\s*".*?</span>\s*([^<]+?)\s*</h3>', re.S)
CHIP_FRAC = (0.22, 0.20, 0.50, 0.60)  # inside the hexagon, clear of the code label
MAX_PAGES = 15

METALLIC_WORDS = r"METALLIC|SILVER|GOLD|ALUMIN|GUN ?METAL|CHROME|TITANIUM|COPPER|BRONZE|BRASS|MICA|IRON"
NOT_PAINT = re.compile(r"THINNER|RETARDER|STIRR|\bSET\b|PRIMER|SURFACER|POLISH", re.I)


def infer_finish(code: str, name: str, desc: str) -> tuple[str, bool, list[str]]:
    """Return (finish, is_color, notes)."""
    n, d = name.upper(), desc.lower()
    notes: list[str] = []
    if re.fullmatch(r"(FLAT |SEMI[- ]GLOSS |GLOSS )?CLEAR( \(GLOSS\))?|FLAT BASE", n):
        return "clear", False, notes
    if "PEARL CLEAR" in n:
        return "pearl", False, ["pearl topcoat, applied over a base color"]
    if "CANDY" in n:
        return "clear-color", True, ["candy color: transparent tint, best over a metallic base"]
    if "CLEAR" in n or "SMOKE" in n:
        return "clear-color", True, notes
    if "FLUORESCENT" in n:
        return "fluorescent", True, notes
    if "PEARL" in n:
        return "pearl", True, notes
    if re.search(METALLIC_WORDS, n):
        return "metallic", True, notes
    if re.search(r"\bFLAT\b|\bMATT", n) or code.startswith("XF-"):
        return "flat", True, notes
    if re.search(r"SEMI[- ]?GLOSS", n):
        return "semi-gloss", True, notes
    # Name says nothing; fall back to description wording.
    if "semi-gloss" in d or "semi gloss" in d:
        return "semi-gloss", True, notes
    if "flat finish" in d or "matt finish" in d:
        return "flat", True, notes
    if "pearl" in d:
        return "pearl", True, notes
    return "gloss", True, notes


def _item_details(item_id: str) -> tuple[str, list[str]]:
    """Return (one-line description, equivalent codes) from a product page."""
    page = fetch_text(f"{SITE}/english/products/{item_id}/index.html")
    text = html.unescape(re.sub(r"<[^>]+>", "\n", page))
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    desc = next((ln for ln in lines if re.search(r"contents\s*:", ln, re.I)), "")
    desc = re.sub(r"[^\x20-\x7e]+", " ", desc)
    desc = re.split(r"(?i)\b(bottle|can|spray)? ?contents\s*:", desc)[0].strip(" .") + "."
    equivalents: list[str] = []
    for i, ln in enumerate(lines):
        if ln.startswith("Equivalent Tamiya Color"):
            for nxt in lines[i + 1:i + 8]:
                m = CODE_RE.search(nxt)
                if m:
                    equivalents.append(m.group(1))
    return (desc if desc != "." else ""), equivalents


def _list_items(genre: str) -> list[tuple[str, str, str, str]]:
    """All (item_id, image_url, code, name) in a listing genre, across pages."""
    seen: dict[str, tuple[str, str, str, str]] = {}
    for page in range(1, MAX_PAGES + 1):
        html_text = fetch_text(LIST_URL.format(genre=genre, page=page))
        new = 0
        for item_id, img, title in ITEM_RE.findall(html_text):
            title = re.sub(r"\s+", " ", html.unescape(title)).strip()
            m = CODE_RE.search(title)
            if not m or NOT_PAINT.search(title) or item_id in seen:
                continue
            img_url = ("https:" + img) if img.startswith("//") else img
            seen[item_id] = (item_id, img_url, m.group(1), m.group(2).strip())
            new += 1
        if new == 0 or f"absolutepage={page + 1}" not in html_text:
            break
    return list(seen.values())


def scrape() -> list[Paint]:
    paints: dict[str, Paint] = {}
    for genre, line in GENRES.items():
        for item_id, img_url, code, name in _list_items(genre):
            if code in paints:
                continue
            desc, equivalents = _item_details(item_id)
            finish, is_color, notes = infer_finish(code, name, desc)
            img = fetch_image(img_url)
            w, h = img.size
            box = (int(CHIP_FRAC[0] * w), int(CHIP_FRAC[1] * h), int(CHIP_FRAC[2] * w), int(CHIP_FRAC[3] * h))
            chip = sample_chip(img, box)
            paints[code] = Paint(
                brand=BRAND, line=line, code=code, name=name.title(),
                hex=rgb_to_hex(chip.rgb), finish=finish, finish_source="inferred",
                source_url=f"{SITE}/english/products/{item_id}/index.html", image_url=img_url,
                source_method=f"product chip median, box {box}",
                confidence="medium", is_color=is_color,
                description=desc or None, equivalents=[e for e in dict.fromkeys(equivalents) if e != code],
                notes=notes,
            )
    return list(paints.values())
