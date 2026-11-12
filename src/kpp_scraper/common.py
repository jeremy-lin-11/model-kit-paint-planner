"""Shared helpers: polite cached HTTP, color math, chip sampling, paint records."""

from __future__ import annotations

import hashlib
import io
import os
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image

ROOT = Path(os.environ.get("KPP_ROOT", Path(__file__).resolve().parents[2]))
CACHE_DIR = ROOT / ".cache"
USER_AGENT = "kit-paint-planner/0.1 (+https://github.com/jeremy-lin-11/kit-paint-planner)"
MIN_INTERVAL_S = 1.0  # per-host politeness delay

_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT
_last_hit: dict[str, float] = {}
REFRESH = False  # set by build.py --refresh


def fetch(url: str) -> bytes:
    """GET with an on-disk cache and a per-host rate limit."""
    host = urlparse(url).netloc
    key = hashlib.sha256(url.encode()).hexdigest()[:24]
    path = CACHE_DIR / host / key
    if path.exists() and not REFRESH:
        return path.read_bytes()
    wait = MIN_INTERVAL_S - (time.monotonic() - _last_hit.get(host, 0.0))
    if wait > 0:
        time.sleep(wait)
    for attempt in range(3):
        try:
            resp = _session.get(url, timeout=60)
            _last_hit[host] = time.monotonic()
            resp.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(resp.content)
    return resp.content


def fetch_text(url: str, encoding: str = "utf-8") -> str:
    return fetch(url).decode(encoding, errors="replace")


def fetch_image(url: str) -> Image.Image:
    return Image.open(io.BytesIO(fetch(url))).convert("RGB")


# ---------------------------------------------------------------- color math

def srgb_to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """sRGB (0-255) -> CIELAB, D65 white point."""

    def lin(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb)
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (round(116 * fy - 16, 2), round(500 * (fx - fy), 2), round(200 * (fy - fz), 2))


def delta_e2000(lab1: tuple[float, float, float], lab2: tuple[float, float, float]) -> float:
    """CIEDE2000 color difference (kL = kC = kH = 1)."""
    from math import atan2, cos, degrees, exp, radians, sin, sqrt

    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    C1, C2 = sqrt(a1 * a1 + b1 * b1), sqrt(a2 * a2 + b2 * b2)
    Cbar = (C1 + C2) / 2
    G = 0.5 * (1 - sqrt(Cbar**7 / (Cbar**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = sqrt(a1p * a1p + b1 * b1), sqrt(a2p * a2p + b2 * b2)
    h1p = degrees(atan2(b1, a1p)) % 360 if C1p else 0.0
    h2p = degrees(atan2(b2, a2p)) % 360 if C2p else 0.0
    dLp, dCp = L2 - L1, C2p - C1p
    if C1p * C2p == 0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    else:
        dhp = h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360
    dHp = 2 * sqrt(C1p * C2p) * sin(radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    else:
        hbp = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    T = (1 - 0.17 * cos(radians(hbp - 30)) + 0.24 * cos(radians(2 * hbp))
         + 0.32 * cos(radians(3 * hbp + 6)) - 0.20 * cos(radians(4 * hbp - 63)))
    dtheta = 30 * exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * sqrt(Cbp**7 / (Cbp**7 + 25**7))
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -sin(radians(2 * dtheta)) * Rc
    return sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


@dataclass
class ChipSample:
    rgb: tuple[int, int, int]          # per-channel median
    lab_p10: tuple[float, float, float]  # darkest-ish pixel (by L*) — shading/flake hint
    lab_p90: tuple[float, float, float]  # brightest-ish pixel — highlight hint


def sample_chip(img: Image.Image, box: tuple[int, int, int, int]) -> ChipSample:
    """Median color of a region, plus 10th/90th-percentile-lightness pixels.

    The percentiles matter for metallic/pearl chips, which manufacturers draw as
    gradients: the spread is a rough proxy for how strong the sheen is.
    """
    px = list(img.crop(box).getdata())
    med = tuple(int(statistics.median(ch)) for ch in zip(*px))
    labs = sorted((srgb_to_lab(p) for p in px), key=lambda lab: lab[0])
    return ChipSample(
        rgb=med,  # type: ignore[arg-type]
        lab_p10=labs[len(labs) // 10],
        lab_p90=labs[(len(labs) * 9) // 10],
    )


# ---------------------------------------------------------------- records

FINISHES = {
    "gloss", "semi-gloss", "flat", "metallic", "pearl",
    "clear",        # colorless clear coat
    "clear-color",  # tinted transparent (candy over a metallic base)
    "fluorescent",
}


@dataclass
class Paint:
    brand: str
    line: str
    code: str
    name: str
    hex: str
    finish: str | None
    finish_source: str            # "official" | "inferred" | "unknown"
    source_url: str
    source_method: str            # how the color was obtained
    confidence: str               # "medium" | "low" (no paint here is lab-measured)
    name_ja: str | None = None
    name_sources: dict[str, str] = field(default_factory=dict)  # e.g. {"newtype.us": ..., "bottle label": ...}
    image_url: str | None = None
    is_color: bool = True         # False for clear coats, flat bases, additives
    lab: tuple[float, float, float] | None = None
    sheen_lab_range: tuple[tuple[float, float, float], tuple[float, float, float]] | None = None
    equivalents: list[str] = field(default_factory=list)  # same-maker codes, e.g. "TS-76"
    samples: dict[str, str] = field(default_factory=dict)  # extra swatches, e.g. {"over black": hex}
    description: str | None = None
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.finish is not None and self.finish not in FINISHES:
            raise ValueError(f"{self.brand} {self.code}: unknown finish {self.finish!r}")
        self.hex = self.hex.lower()
        if self.lab is None:
            self.lab = srgb_to_lab(hex_to_rgb(self.hex))

    @property
    def id(self) -> str:
        slug = self.brand.lower().replace(" ", "").replace(".", "")
        return f"{slug}-{self.code.lower()}"

    def to_dict(self) -> dict:
        d = {"id": self.id, **asdict(self)}
        return {k: v for k, v in d.items() if v not in (None, [], "")}
