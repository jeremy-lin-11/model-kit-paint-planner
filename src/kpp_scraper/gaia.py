"""Gaia Color (Gaia Notes) — every series on the official color chart page.

Colors: the hex value the chart page itself uses for each swatch block
(`<div style="background-color:#...">`). Pure white/black values on paints that aren't
white/black are treated as placeholders and flagged low-confidence. (Sampling the bottle
photos was tried and rejected: caps are shaded or not color-matched at all.)
Names: the chart is Japanese-only, so English names come from two other sources:
  1. newtype.us retail listings (see newtype.py) — preferred display name
  2. the English printed on Gaia's own bottle labels, transcribed by hand into
     data/sources/gaia_labels.csv, which also holds English translations where the
     label is Japanese-only, romanized, or German (these take priority when present)
The two are cross-checked, and disagreements are noted on the paint.
Finish: the label's printed finish beats the retailer's title word, which beats inference.
"""

from __future__ import annotations

import csv
import html
import re
import sys
from difflib import SequenceMatcher

from . import newtype
from .common import ROOT, Paint, fetch_text

LABELS_CSV = ROOT / "data" / "sources" / "gaia_labels.csv"
LABEL_FINISH = {
    "gloss": "gloss", "semi gloss": "semi-gloss", "semigloss": "semi-gloss",
    "70 gloss level": "semi-gloss", "flat": "flat", "flat coat": "flat",
    "metallic": "metallic", "pearl color": "pearl", "polarization pearl color": "pearl",
    "polarized pearl": "pearl", "clear": "clear-color",
}
BASIC_FINISHES = (None, "gloss", "semi-gloss", "flat")  # safe to overwrite; special finishes aren't

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


def _title(s: str) -> str:
    """Title-case label text without mangling codes like FS34079, NATO, III, Ex-."""
    def word(w: str) -> str:
        if w.isupper() or any(ch.isdigit() for ch in w):
            return w
        lead = len(w) - len(w.lstrip("(/"))
        return w[:lead] + w[lead:lead + 1].upper() + w[lead + 1:]
    return " ".join(word(w) for w in s.split())


def _same_name(a: str, b: str) -> bool:
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower().replace("grey", "gray"))  # noqa: E731
    na, nb = norm(a), norm(b)
    return na in nb or nb in na or SequenceMatcher(None, na, nb).ratio() >= 0.8


def load_labels() -> dict[str, dict[str, str]]:
    with LABELS_CSV.open(encoding="utf-8") as f:
        return {row["code"]: row for row in csv.DictReader(f)}


def apply_english_names(paints: dict[str, Paint]) -> None:
    labels = load_labels()
    retail = newtype.lookup(list(paints))
    for code, p in paints.items():
        lab, rt = labels.get(code, {}), retail.get(code)
        label_name = _title(lab["label_name"]) if lab.get("label_name") else None
        translation = lab.get("translation") or None
        if rt:
            p.name_sources["newtype.us"] = rt.name
        if label_name:
            p.name_sources["bottle label"] = label_name
        if translation:
            p.name_sources["translated"] = translation

        # Translations exist only where the label/retailer name is Japanese or German, so they win.
        english = translation or (rt.name if rt else None) or label_name
        if english:
            p.name = english
        else:
            p.notes.append("no English name found; showing Japanese")
        if rt and label_name and not _same_name(rt.name, label_name):
            p.notes.append(f"names differ: newtype.us '{rt.name}' vs bottle label '{label_name}'")
        if lab.get("note"):
            p.notes.append(f"label: {lab['note']}")

        label_finish = LABEL_FINISH.get((lab.get("label_finish") or "").lower())
        if p.finish in BASIC_FINISHES and p.is_color:
            if label_finish in BASIC_FINISHES[1:]:
                if label_finish != p.finish:
                    p.finish = label_finish
                p.finish_source = "official"  # printed on the manufacturer's label
                if lab.get("label_finish", "").lower() == "70 gloss level":
                    p.notes.append("label says 70% gloss (between gloss and semi-gloss)")
            elif rt and rt.finish in BASIC_FINISHES[1:] and p.finish is None:
                p.finish, p.finish_source = rt.finish, "retailer"


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
    apply_english_names(paints)
    return list(paints.values())
