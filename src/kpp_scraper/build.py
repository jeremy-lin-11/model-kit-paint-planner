"""Run the scrapers, write data/paints.json, and render QA contact sheets.

    uv run python -I -m kpp_scraper.build            # all brands
    uv run python -I -m kpp_scraper.build gaia       # one brand
    uv run python -I -m kpp_scraper.build --refresh  # ignore the download cache
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import date

from PIL import Image, ImageDraw, ImageFont

from . import common, gaia, mrcolor, tamiya
from .common import CACHE_DIR, ROOT, Paint, fetch_image, hex_to_rgb

SCRAPERS = {"mrcolor": mrcolor, "tamiya": tamiya, "gaia": gaia}
OUT = ROOT / "data" / "paints.json"
QA_DIR = CACHE_DIR / "qa"  # derived from manufacturer images, so kept out of git

META = {
    "disclaimer": (
        "Colors come from manufacturers' published swatches (chart chips, product chips, "
        "web hex values), not from measuring dried paint. Treat them as screen approximations."
    ),
    "sources": {
        "Mr. Color": "https://www.mr-hobby.com/ (GSI Creos color lineup chart + English color list PDF)",
        "Tamiya": "https://www.tamiya.com/english/ (product color chips and pages)",
        "Gaia": "https://www.gaianotes.com/products/gaia-color_chart.html (chart swatch hex values)",
    },
}


def natural_key(code: str) -> list:
    """Sort C2 before C10 and LP-2 before LP-10."""
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", code)]


def qa_sheet(brand: str, paints: list[Paint]) -> None:
    """One row per paint: [source image region][extracted color] code name finish."""
    rows = sorted(paints, key=lambda p: natural_key(p.code))
    W, H, cols = 360, 48, 4
    sheet = Image.new("RGB", (W * cols, H * ((len(rows) + cols - 1) // cols)), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for i, p in enumerate(rows):
        x, y = (i % cols) * W, (i // cols) * H
        try:
            src = fetch_image(p.image_url) if p.image_url else None
        except Exception:  # noqa: BLE001
            src = None
        if src is not None:
            m = re.search(r"box \((\d+), (\d+), (\d+), (\d+)\)", p.source_method)
            crop = src.crop(tuple(map(int, m.groups()))) if m else src
            crop.thumbnail((60, 44))
            sheet.paste(crop, (x + 2, y + 2))
        draw.rectangle((x + 64, y + 2, x + 124, y + 44), fill=hex_to_rgb(p.hex), outline="black")
        flag = "" if p.confidence == "medium" else " [LOW]"
        draw.text((x + 130, y + 4), f"{p.code}  {p.hex}{flag}", fill="black", font=font)
        draw.text((x + 130, y + 18), p.name[:34], fill="black", font=font)
        draw.text((x + 130, y + 32), f"{p.finish or '?'}{'' if p.is_color else ' (non-color)'}",
                  fill="gray", font=font)
    QA_DIR.mkdir(parents=True, exist_ok=True)
    path = QA_DIR / f"{brand}.png"
    sheet.save(path)
    print(f"  QA sheet: {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("brands", nargs="*", help=f"subset of: {', '.join(SCRAPERS)} (default: all)")
    ap.add_argument("--refresh", action="store_true", help="re-download instead of using .cache/")
    ap.add_argument("--no-qa", action="store_true")
    args = ap.parse_args()
    if unknown := set(args.brands) - set(SCRAPERS):
        ap.error(f"unknown brand(s): {', '.join(sorted(unknown))}")
    common.REFRESH = args.refresh

    existing = json.loads(OUT.read_text())["paints"] if OUT.exists() else []
    by_brand: dict[str, list[dict]] = {}
    for d in existing:
        by_brand.setdefault(d["brand"], []).append(d)

    for key in args.brands or SCRAPERS:
        mod = SCRAPERS[key]
        print(f"[{key}] scraping…", file=sys.stderr)
        paints = mod.scrape()
        by_brand[mod.BRAND] = [p.to_dict() for p in paints]
        c = Counter(p.finish for p in paints)
        low = sum(p.confidence == "low" for p in paints)
        print(f"  {len(paints)} paints, {low} low-confidence; finishes: {dict(c)}", file=sys.stderr)
        if not args.no_qa:
            qa_sheet(key, paints)

    all_paints = sorted((d for ds in by_brand.values() for d in ds), key=lambda d: (d["brand"], natural_key(d["code"])))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(
        {"generated": date.today().isoformat(), **META, "count": len(all_paints), "paints": all_paints},
        ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {len(all_paints)} paints to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
