// Automatic regions from the kit's existing plastic colors.
//
//   1. The segmentation model is prompted on a grid of foreground points ("segment everything");
//      each accepted mask is one molded part (or a piece of one). [done by the caller]
//   2. buildPartMap: every pixel goes to the smallest accepted mask covering it; thin gaps (seams,
//      panel lines, edges) are filled from neighbors.
//   3. partColors: each part's plastic color = bright-ish lightness + median a/b, so shading and
//      highlights barely move it.
//   4. groupParts: merge parts of the same plastic (agglomerative, area-weighted). Distance weights
//      hue over lightness and chroma, so one red under different lighting stays one group while
//      white / gray / black stay apart.

import { rgbToLab, type Lab } from "./color";

export interface Part { pixels: Int32Array; score: number }

/** Foreground grid points (x, y) spaced `step` px apart, offset half a step from the edges. */
export function gridPoints(w: number, h: number, bg: Uint8Array, step: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
    const px = Math.round(x), py = Math.round(y);
    if (!bg[py * w + px]) pts.push([px, py]);
  }
  return pts;
}

/** Decide whether a candidate mask is a usable part; returns its foreground pixels or null. */
export function acceptMask(
  mask: Uint8Array, bg: Uint8Array, fgArea: number, score: number,
  opts = { minScore: 0.7, minArea: 25, maxFgFrac: 0.35, maxBgFrac: 0.3 },
): Int32Array | null {
  if (score < opts.minScore) return null;
  let area = 0, onBg = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { area++; if (bg[i]) onBg++; }
  if (area < opts.minArea || onBg > area * opts.maxBgFrac || area - onBg > fgArea * opts.maxFgFrac) return null;
  const out = new Int32Array(area - onBg);
  let k = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && !bg[i]) out[k++] = i;
  return out;
}

/** IoU of a new part against existing ones via the current owner map; true if it duplicates one. */
export function isDuplicate(pixels: Int32Array, owner: Int32Array, sizes: number[], iou = 0.85): boolean {
  const counts = new Map<number, number>();
  for (const i of pixels) { const o = owner[i]; if (o >= 0) counts.set(o, (counts.get(o) ?? 0) + 1); }
  for (const [o, inter] of counts) if (inter / (pixels.length + sizes[o] - inter) > iou) return true;
  return false;
}

/**
 * Pixel → part id (-1 = none). Smaller parts win overlaps (they're the finer, more specific pick).
 * Foreground pixels left over within `fillSteps` px of a part are given to the most similar neighbor.
 */
export function buildPartMap(parts: Part[], w: number, h: number, bg: Uint8Array, lab: Float32Array, fillSteps = 6): Int32Array {
  const n = w * h;
  const map = new Int32Array(n).fill(-1);
  const order = parts.map((_, k) => k).sort((a, b) => parts[b].pixels.length - parts[a].pixels.length);
  for (const k of order) for (const i of parts[k].pixels) map[i] = k; // biggest first, smallest overwrite
  let pending: number[] = [];
  for (let i = 0; i < n; i++) if (!bg[i] && map[i] < 0) pending.push(i);
  for (let pass = 0; pass < fillSteps && pending.length; pass++) {
    const next: number[] = [], assign: [number, number][] = [];
    for (const i of pending) {
      const x = i % w, y = (i / w) | 0;
      let best = -1, bd = Infinity;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || map[j] < 0) continue;
        const d = (lab[i * 3] - lab[j * 3]) ** 2 + (lab[i * 3 + 1] - lab[j * 3 + 1]) ** 2 + (lab[i * 3 + 2] - lab[j * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = map[j]; }
      }
      if (best >= 0) assign.push([i, best]); else next.push(i);
    }
    for (const [i, p] of assign) map[i] = p;
    pending = next;
  }
  return map;
}

export function labImage(rgba: Uint8ClampedArray | Uint8Array, n: number): Float32Array {
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) lab.set(rgbToLab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]), i * 3);
  return lab;
}

export interface PartColor { lab: Lab; size: number }

/**
 * Plastic color per part id. Lightness: 85th percentile (the lit side). Hue/chroma: median a and b
 * over mid-tone pixels only (20th-80th lightness percentile), because glossy highlights whiten the
 * color and shift its hue toward pink, and deep shadows lose chroma. Parts with no pixels get size 0.
 */
export function partColors(map: Int32Array, nParts: number, lab: Float32Array): PartColor[] {
  const L: number[][] = Array.from({ length: nParts }, () => []);
  const A: number[][] = Array.from({ length: nParts }, () => []);
  const B: number[][] = Array.from({ length: nParts }, () => []);
  for (let i = 0; i < map.length; i++) {
    const p = map[i];
    if (p < 0) continue;
    L[p].push(lab[i * 3]); A[p].push(lab[i * 3 + 1]); B[p].push(lab[i * 3 + 2]);
  }
  const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.floor(v.length * f))];
  return L.map((l, p) => {
    if (!l.length) return { lab: [0, 0, 0] as Lab, size: 0 };
    const sorted = l.slice().sort((x, y) => x - y);
    const lo = q(sorted, 0.2), hi = q(sorted, 0.8);
    const as: number[] = [], bs: number[] = [];
    l.forEach((v, k) => { if (v >= lo && v <= hi) { as.push(A[p][k]); bs.push(B[p][k]); } });
    if (!as.length) { as.push(...A[p]); bs.push(...B[p]); }
    as.sort((x, y) => x - y); bs.sort((x, y) => x - y);
    return { lab: [q(sorted, 0.85), q(as, 0.5), q(bs, 0.5)] as Lab, size: l.length };
  });
}

const NEUTRAL_C = 12; // below this chroma a plastic reads as white/gray/black
const VIVID_C = 20; // above this it's a definite color

/**
 * Plastic-to-plastic distance. Hue difference is measured in chroma units (like CIEDE2000's ΔH);
 * between two colored plastics, lightness and chroma are down-weighted because shading changes both
 * and hue carries the identity. Near-neutrals (white, gray, black, navy) only differ in lightness and
 * a little chroma, so those count for more.
 */
export function plasticDistance(p: Lab, q: Lab): number {
  const c1 = Math.hypot(p[1], p[2]), c2 = Math.hypot(q[1], q[2]);
  const da = p[1] - q[1], db = p[2] - q[2];
  const dC = c1 - c2;
  const dH2 = Math.max(0, da * da + db * db - dC * dC); // ΔH² = Δa² + Δb² − ΔC²
  const colored = c1 >= NEUTRAL_C && c2 >= NEUTRAL_C;
  const wL = colored ? 0.35 : 0.8, wC = colored ? 0.4 : 0.8;
  return Math.sqrt((wL * (p[0] - q[0])) ** 2 + (wC * dC) ** 2 + dH2);
}

/**
 * Pairs that are different plastics whatever the distance says: a vivid color vs a neutral
 * (a yellow accent must not fold into white), or two colors far apart in hue.
 */
export function distinctPlastics(p: Lab, q: Lab, maxHueDeg = 35): boolean {
  const c1 = Math.hypot(p[1], p[2]), c2 = Math.hypot(q[1], q[2]);
  if ((c1 >= VIVID_C && c2 < NEUTRAL_C) || (c2 >= VIVID_C && c1 < NEUTRAL_C)) return true;
  if (c1 < NEUTRAL_C || c2 < NEUTRAL_C) return false;
  let dh = Math.abs(Math.atan2(p[2], p[1]) - Math.atan2(q[2], q[1])) * (180 / Math.PI);
  if (dh > 180) dh = 360 - dh;
  return dh > maxHueDeg;
}

export interface Group { lab: Lab; size: number; parts: number[] }

/**
 * Merge parts into plastic-color groups until the closest pair is farther than `threshold`.
 * Distinct pairs (see distinctPlastics) only merge when needed to get down to `maxGroups`.
 */
export function groupParts(colors: PartColor[], threshold = 18, maxGroups = 10): { groups: Group[]; assign: Int32Array } {
  let groups: Group[] = colors.flatMap((c, p) => (c.size ? [{ lab: c.lab.slice() as Lab, size: c.size, parts: [p] }] : []));
  const merge = (a: number, b: number) => {
    const A = groups[a], B = groups[b], s = A.size + B.size;
    A.lab = [0, 1, 2].map((k) => (A.lab[k] * A.size + B.lab[k] * B.size) / s) as Lab;
    A.size = s;
    A.parts.push(...B.parts);
    groups.splice(b, 1);
  };
  for (;;) {
    const forced = groups.length > maxGroups;
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      if (!forced && distinctPlastics(groups[i].lab, groups[j].lab)) continue;
      const d = plasticDistance(groups[i].lab, groups[j].lab);
      if (d < best) { best = d; bi = i; bj = j; }
    }
    if (bi < 0 || (best > threshold && !forced)) break;
    merge(bi, bj);
  }
  groups = groups.sort((a, b) => b.size - a.size);
  const assign = new Int32Array(colors.length).fill(-1);
  groups.forEach((g, gi) => g.parts.forEach((p) => (assign[p] = gi)));
  return { groups, assign };
}

/** Human name for a plastic color ("White", "Dark gray", "Red", "Light blue"). */
export function colorName([L, a, b]: Lab): string {
  const C = Math.hypot(a, b);
  if (C < 10 || (C < 16 && L < 30)) {
    return L > 82 ? "White" : L > 64 ? "Light gray" : L > 42 ? "Gray" : L > 25 ? "Dark gray" : "Black";
  }
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  let hue =
    h < 15 || h >= 345 ? "Pink" : h < 50 ? "Red" : h < 70 ? "Orange" : h < 100 ? "Yellow"
    : h < 165 ? "Green" : h < 225 ? "Teal" : h < 320 ? "Blue" : "Purple";
  if (hue === "Pink" && L < 55) hue = "Red";
  if ((hue === "Orange" || hue === "Yellow") && C < 35 && L < 75) hue = "Tan";
  const tone = L < 35 ? "Dark " : L > 75 && hue !== "Yellow" ? "Light " : "";
  return tone + (tone ? hue.toLowerCase() : hue);
}

/** Region map from groups (pixel → group index, -1 = none). */
export function groupMap(partMap: Int32Array, assign: Int32Array): Int16Array {
  const out = new Int16Array(partMap.length).fill(-1);
  for (let i = 0; i < out.length; i++) if (partMap[i] >= 0) out[i] = assign[partMap[i]];
  return out;
}
