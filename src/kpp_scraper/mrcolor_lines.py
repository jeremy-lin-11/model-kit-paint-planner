"""Mr. Color specialty lines (GX, GX Clear, GX Metal, Crystal, Super Metallic 2, Velvet, GGX,
Gundam Color UG, C511–530, Lascivus) from Mr. Hobby's per-line "color lineup" chart images.

Codes, names and finishes are transcribed from the charts in data/sources/mrcolor_lines.csv.
Swatch positions are detected automatically, and each chart must yield exactly as many swatches
as it has codes, or the scrape fails rather than mislabeling colors.

Chart kinds:
  grid  - bordered chip boxes (like the C1–C189 chart). Solid chips are detected, the grid is
          inferred from them, and white/black chips the detector can't see are found by checking
          for a dark cell border around each inferred cell.
  blobs - photographed painted samples (GX Metal spheres, GX Clear discs) on a plain background.
  pairs - Mr. Crystal Color: each paint shown over a white and over a black undercoat.
"""

from __future__ import annotations

import csv
import re
import statistics
from collections import deque

from PIL import Image

from .common import ROOT, Paint, fetch_image, fetch_text, rgb_to_hex, srgb_to_lab

BRAND = "Mr. Color"
DETAIL = "https://www.mr-hobby.com/ja/products/detail/{page}"
LINES_CSV = ROOT / "data" / "sources" / "mrcolor_lines.csv"

CHARTS: dict[int, dict] = {
    11: {"line": "Mr. Color GX", "kind": "grid"},
    12: {"line": "Mr. Color GX Clear", "kind": "blobs"},
    16: {"line": "Mr. Color GX Metal", "kind": "blobs"},
    33: {"line": "Mr. Crystal Color", "kind": "pairs"},
    21: {"line": "Mr. Color Super Metallic 2", "kind": "grid"},
    2504: {"line": "Mr. Color Velvet", "kind": "grid"},
    2947: {"line": "Mr. Color GGX", "kind": "grid"},
    90: {"line": "Gundam Color (UG)", "kind": "grid"},
    3: {"line": "Mr. Color (C511–530 AFV)", "kind": "grid"},
    5: {"line": "Mr. Color Lascivus", "kind": "grid"},
}


# ------------------------------------------------------------------ detection helpers

def _diff(a, b) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def _background(img: Image.Image, tol: int = 30) -> list[bytearray]:
    """Pixels connected to the image border with the border's dominant color."""
    w, h = img.size
    px = img.load()
    border = [px[x, 0] for x in range(w)] + [px[x, h - 1] for x in range(w)] + \
             [px[0, y] for y in range(h)] + [px[w - 1, y] for y in range(h)]
    bg_color = max(set(border), key=border.count)
    bg = [bytearray(w) for _ in range(h)]
    q = deque()
    for x in range(w):
        q.extend([(x, 0), (x, h - 1)])
    for y in range(h):
        q.extend([(0, y), (w - 1, y)])
    while q:
        x, y = q.popleft()
        if bg[y][x] or _diff(px[x, y], bg_color) >= tol:
            continue
        bg[y][x] = 1
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny][nx]:
                q.append((nx, ny))
    return bg


def _components(img: Image.Image, bg: list[bytearray], step: int, min_area: int):
    """Smooth-color connected components outside the background: (x, y, w, h, fill)."""
    w, h = img.size
    px = img.load()
    seen = [bytearray(w) for _ in range(h)]
    out = []
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or bg[sy][sx]:
                continue
            seen[sy][sx] = 1
            q = deque([(sx, sy)])
            n, x0, y0, x1, y1 = 0, sx, sy, sx, sy
            while q:
                x, y = q.popleft()
                n += 1
                x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and not bg[ny][nx] \
                            and _diff(px[x, y], px[nx, ny]) < step:
                        seen[ny][nx] = 1
                        q.append((nx, ny))
            if n >= min_area:
                bw, bh = x1 - x0 + 1, y1 - y0 + 1
                out.append((x0, y0, bw, bh, n / (bw * bh)))
    return out


def _reading_order(boxes):
    """Sort boxes into rows (by vertical overlap), then left to right."""
    boxes = sorted(boxes, key=lambda b: b[1])
    rows: list[list] = []
    for b in boxes:
        if rows and abs(b[1] - rows[-1][0][1]) < b[3] / 2:
            rows[-1].append(b)
        else:
            rows.append([b])
    return [b for row in rows for b in sorted(row, key=lambda b: b[0])]


def _cluster(values: list[int], tol: int = 6) -> list[int]:
    out: list[int] = []
    for v in sorted(values):
        if not out or v - out[-1] > tol:
            out.append(v)
    return out


def _dark_ring(img: Image.Image, box, dark: int = 140) -> bool:
    """True if at least 3 sides of the box have a thin dark line just outside them (a drawn cell
    border): dark within 1-3 px, but lighter again 5-7 px out. A large dark area (a decorative
    panel) is dark at both distances and doesn't count."""
    x, y, w, h = box
    px = img.load()
    W, H = img.size
    lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]  # noqa: E731

    def side_lum(side: str, dists) -> float | None:
        vals = []
        for i in range(0, w if side in "tb" else h, 2):
            best = 255.0
            for d in dists:
                cx, cy = {"t": (x + i, y - d), "b": (x + i, y + h - 1 + d),
                          "l": (x - d, y + i), "r": (x + w - 1 + d, y + i)}[side]
                if 0 <= cx < W and 0 <= cy < H:
                    best = min(best, lum(px[cx, cy]))
            vals.append(best)
        return statistics.median(vals) if vals else None

    hits = 0
    for side in "tblr":
        near, far = side_lum(side, (1, 2, 3)), side_lum(side, (5, 6, 7))
        if near is not None and near < dark and (far is None or far > near + 40):
            hits += 1
    return hits >= 3


def grid_cells(img: Image.Image) -> list[tuple[int, int, int, int]]:
    w, h = img.size
    bg = _background(img)
    comps = [c for c in _components(img, bg, step=18, min_area=max(400, w * h // 2000))
             if c[4] >= 0.9 and c[2] >= 20 and c[3] >= 20]
    if not comps:
        raise RuntimeError("no solid chips found")
    mw = statistics.median(c[2] for c in comps)
    mh = statistics.median(c[3] for c in comps)
    chips = [c for c in comps if abs(c[2] - mw) <= 0.12 * mw and abs(c[3] - mh) <= 0.12 * mh]
    cw, ch = round(statistics.median(c[2] for c in chips)), round(statistics.median(c[3] for c in chips))

    def axis(found: list[int], size: int, limit: int) -> list[int]:
        """Evenly spaced positions through the detected ones, extended to the image edges.
        Pitch comes only from gaps at least a chip wide (detections wobble by a few px)."""
        found = _cluster(found, tol=max(6, int(size * 0.3)))
        gaps = [b - a for a, b in zip(found, found[1:]) if b - a >= 0.8 * size]
        if not gaps:
            return found
        smallest = min(gaps)
        pitch = statistics.median([g for g in gaps if g <= smallest * 1.25])
        k0 = -int(found[0] // pitch)
        out = []
        k = k0
        while True:
            expect = found[0] + k * pitch
            if expect + size > limit:
                break
            snap = [f for f in found if abs(f - expect) <= pitch * 0.25]
            out.append(snap[0] if snap else round(expect))
            k += 1
        return out

    cols = axis([c[0] for c in chips], cw, w)
    rows = axis([c[1] for c in chips], ch, h)
    cells = []
    for y in rows:
        for x in cols:
            near = any(abs(x - c[0]) <= cw * 0.25 and abs(y - c[1]) <= ch * 0.25 for c in chips)
            if near or _dark_ring(img, (x, y, cw, ch)):
                cells.append((x, y, cw, ch))
    return _reading_order(cells)


def blob_cells(img: Image.Image) -> list[tuple[int, int, int, int]]:
    w, h = img.size
    bg = _background(img)
    blobs = [c[:4] for c in _components(img, bg, step=30, min_area=3000)
             if c[3] > 50 and 0.55 <= c[4] <= 0.9]
    return _reading_order(blobs)


# Mr. Crystal Color chart (1000x270): 4x2 cells, each with an over-white and an over-black sample.
CRYSTAL_SIZE = (1000, 270)
CRYSTAL_X = {"over white": 21, "over black": 131}
CRYSTAL_PITCH_X, CRYSTAL_ROWS_Y, CRYSTAL_BOX = 250, (37, 170), (96, 54)


def sample(img: Image.Image, box, ellipse: bool) -> tuple[tuple[int, int, int], tuple, tuple]:
    """Median RGB inside the box (inset 15%; inscribed ellipse at 80% for round samples)."""
    x, y, w, h = box
    px = img.load()
    cx, cy = x + w / 2, y + h / 2
    pts = []
    for yy in range(y + int(h * 0.15), y + h - int(h * 0.15)):
        for xx in range(x + int(w * 0.15), x + w - int(w * 0.15)):
            if ellipse and ((xx - cx) / (w * 0.4)) ** 2 + ((yy - cy) / (h * 0.4)) ** 2 > 1:
                continue
            pts.append(px[xx, yy])
    med = tuple(int(statistics.median(c)) for c in zip(*pts))
    labs = sorted((srgb_to_lab(p) for p in pts), key=lambda lab: lab[0])
    return med, labs[len(labs) // 10], labs[(len(labs) * 9) // 10]  # type: ignore[return-value]


def load_items() -> dict[int, list[dict]]:
    items: dict[int, list[dict]] = {}
    with LINES_CSV.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            items.setdefault(int(row["page"]), []).append(row)
    return items


def chart_url(page: int) -> str:
    html = fetch_text(DETAIL.format(page=page))
    m = re.search(r"https://www\.mr-hobby\.com/uploads/products/color_lineup/[A-Z0-9]+\.(?:png|jpg)", html)
    if not m:
        raise RuntimeError(f"no lineup chart on {DETAIL.format(page=page)}")
    return m.group(0)


def scrape() -> list[Paint]:
    items = load_items()
    paints: list[Paint] = []
    for page, cfg in CHARTS.items():
        rows = items.get(page, [])
        url = chart_url(page)
        img = fetch_image(url)
        samples_by_code: dict[str, dict[str, str]] = {}
        if cfg["kind"] == "pairs":
            if img.size != CRYSTAL_SIZE:
                raise RuntimeError(f"{cfg['line']}: chart is {img.size}, expected {CRYSTAL_SIZE}")
            boxes = []
            for k, row in enumerate(rows):
                r, c = divmod(k, 4)
                pair = {name: (x0 + c * CRYSTAL_PITCH_X, CRYSTAL_ROWS_Y[r], *CRYSTAL_BOX) for name, x0 in CRYSTAL_X.items()}
                samples_by_code[row["code"]] = {name: rgb_to_hex(sample(img, b, True)[0]) for name, b in pair.items()}
                boxes.append(pair["over black"])  # the colored effect is what shows on a kit
        else:
            boxes = grid_cells(img) if cfg["kind"] == "grid" else blob_cells(img)
        if len(boxes) != len(rows):
            raise RuntimeError(f"{cfg['line']}: found {len(boxes)} swatches for {len(rows)} codes; chart layout changed?")
        for row, box in zip(rows, boxes):
            rgb, p10, p90 = sample(img, box, ellipse=cfg["kind"] != "grid")
            finish = row["finish"] or None
            notes = [row["note"]] if row["note"] else []
            paints.append(Paint(
                brand=BRAND, line=cfg["line"], code=row["code"], name=row["name"], name_ja=row["name_ja"],
                name_sources={"chart (translated)": row["name"]},
                hex=rgb_to_hex(rgb), finish=finish, finish_source="official",
                source_url=DETAIL.format(page=page), image_url=url,
                source_method=f"{cfg['kind']} chart sample, box ({box[0]}, {box[1]}, {box[0] + box[2]}, {box[1] + box[3]})",
                confidence="medium", is_color=row["is_color"] == "true",
                sheen_lab_range=(p10, p90) if finish in ("metallic", "pearl") else None,
                samples=samples_by_code.get(row["code"], {}),
                notes=notes,
            ))
    return paints
