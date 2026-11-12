"""English names (and finish words) for Gaia paints from the Newtype retail store.

newtype.us lists Gaia paints with titles like "Gaia 004 Gloss Ultrablue". Product URLs
come from the store's sitemaps (robots.txt allows them; search pages are disallowed).
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from .common import fetch_text

SITEMAP_INDEX = "https://newtype.us/sitemap.xml"
HANDLE_RE = re.compile(r"https://newtype\.us/products/(gaia-((?:gp|ex|tl)-\d+|\d{3,4})-[^<\s]+)")
TITLE_RE = re.compile(r"<title>([^<]+)</title>")
FINISH_WORDS = {
    "gloss": "gloss", "semi-gloss": "semi-gloss", "semi gloss": "semi-gloss",
    "flat": "flat", "matte": "flat", "matt": "flat",
    "metallic": "metallic", "pearl": "pearl", "fluorescent": "fluorescent",
}


@dataclass
class RetailName:
    code: str
    title: str              # full product title, e.g. "Gaia 004 Gloss Ultrablue"
    name: str               # title minus brand, code, a leading "Gloss", and size suffix
    finish: str | None      # finish word from the title, normalized
    url: str


def _normalize_code(raw: str) -> str:
    raw = raw.upper()
    return "Ex-" + raw[3:] if raw.startswith("EX-") else raw


def _product_urls() -> dict[str, str]:
    """{gaia code: first product URL} from all product sitemaps."""
    index = fetch_text(SITEMAP_INDEX)
    urls: dict[str, str] = {}
    for sm in re.findall(r"<loc>(https://newtype\.us/sitemap/products/\d+\.xml)</loc>", index):
        for handle, code in HANDLE_RE.findall(fetch_text(sm)):
            urls.setdefault(_normalize_code(code), f"https://newtype.us/products/{handle}")
    return urls


def _parse_title(code: str, title: str) -> tuple[str, str | None]:
    title = title.split("|")[0].strip()
    rest = re.sub(rf"^Gaia\s+{re.escape(code)}\s+", "", title, flags=re.I).strip()
    rest = re.sub(r"\s+\d+\s*ml$", "", rest, flags=re.I)  # "Premium Glass Pearl 30ml"
    finish = None
    for word in sorted(FINISH_WORDS, key=len, reverse=True):
        if rest.lower().startswith(word + " "):
            finish = FINISH_WORDS[word]
            if finish == "gloss":  # "Gloss Bright Red" -> "Bright Red"; keep "Flat White", "Pearl Silver"
                rest = rest[len(word):].strip()
            break
    return rest, finish


def lookup(codes: list[str]) -> dict[str, RetailName]:
    urls = _product_urls()
    out: dict[str, RetailName] = {}
    for code in codes:
        url = urls.get(code)
        if not url:
            continue
        m = TITLE_RE.search(fetch_text(url))
        if not m:
            continue
        title = html.unescape(m.group(1)).split("|")[0].strip()
        name, finish = _parse_title(code, title)
        if name:
            out[code] = RetailName(code=code, title=title, name=name, finish=finish, url=url)
    return out
