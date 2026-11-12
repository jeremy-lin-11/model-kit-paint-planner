"""Gaia Color (Gaia Notes) — every series on the official color chart page.

Colors: the hex value the chart page itself uses for each swatch block
(`<div style="background-color:#...">`). Pure white/black values on paints that aren't
white/black are treated as placeholders and flagged low-confidence. (Sampling the bottle
photos was tried and rejected: caps are shaded or not color-matched at all.)
Names: Japanese only (the site has no English names in text form).
"""

from __future__ import annotations

import html
import re
import sys

from .common import Paint, fetch_text

BRAND = "Gaia"
BASE = "https://www.gaianotes.com/products/"
CHART_URL = BASE + "gaia-color_chart.html"
SKIP_SERIES = {"-", "Gaia Enamel Color"}  # placeholders; enamel is a different paint system

ITEM_RE = re.compile(
    r'<li>\s*<img src="([^"]+)">\s*<p class="number">([^<]*)</p>\s*'
    r'<p class="series">([^<]*)</p>\s*<div style="background-color:([^"]*)"></div>\s*'
    r'<p class="name">(.*?)</p>', re.S)

NON_COLOR_WORDS = ("フラットベース", "フラットクリアー", "Ex-クリアー")


def infer_finish(series: str, name: str) -> tuple[str | None, bool]:
    """Return (finish, is_color) from the series label and Japanese name keywords."""
    if any(w in name for w in NON_COLOR_WORDS) or name.strip() in ("クリアー", "Ex-クリアー"):
        return "clear", False
    if "クリアー" in name or series == "Clear Color":
        return "clear-color", True
    if "パール" in name or series in ("Pearl Color", "Prism Color"):
        return "pearl", True
    if "蛍光" in name or series == "Fluorescent Color":
        return "fluorescent", True
    if series == "Metallic Color" or re.search(
            r"メタリック|シルバー|ゴールド|ガンメタ|カッパー|ブラス|アイアン|ジュラルミン|ステンレス|クローム", name):
        return "metallic", True
    if re.search(r"つや消し|フラット", name):
        return "flat", True
    if "半光沢" in name:
        return "semi-gloss", True
    if series in ("Basic Color", "Primary Color Series", "Premium Series", "Ex Series"):
        return "gloss", True
    return None, True  # military/railroad/tactical: finish not stated on the chart



def scrape() -> list[Paint]:
    page = fetch_text(CHART_URL)
    paints: dict[str, Paint] = {}
    for img_src, number, series, bg, name_html in ITEM_RE.findall(page):
        series, number = series.strip(), number.strip()
        name = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", name_html))).strip()
        if series in SKIP_SERIES or name in ("", "-"):
            continue
        notes: list[str] = []
        stem = img_src.rsplit("/", 1)[-1].split(".")[0]
        if number.isdigit() and stem.isdigit() and len(stem) == 3 and stem != number:
            notes.append(f"chart labels this {number}, image file says {stem}; using {stem}")
            number = stem
        finish, is_color = infer_finish(series, name)
        official_hex = bg.strip()
        image_url = BASE + img_src

        confidence = "medium"
        if (official_hex.upper() in ("#FFFFFF", "#000000") and is_color
                and finish not in ("clear", "clear-color")
                and not re.search(r"ホワイト|ブラック|白|黒", name)):
            confidence = "low"
            notes.append(f"chart hex {official_hex} looks like a placeholder for a non-white/black paint")

        code = number
        if code in paints:
            print(f"  [gaia] duplicate chart entry {code} ({name}); keeping {paints[code].name}", file=sys.stderr)
            continue
        paints[code] = Paint(
            brand=BRAND, line=f"Gaia Color — {series}", code=code, name=name, name_ja=name,
            hex=official_hex, finish=finish,
            finish_source="inferred" if finish else "unknown",
            source_url=CHART_URL, image_url=image_url,
            source_method="chart page swatch hex",
            confidence=confidence, is_color=is_color, notes=notes,
        )
    return list(paints.values())
