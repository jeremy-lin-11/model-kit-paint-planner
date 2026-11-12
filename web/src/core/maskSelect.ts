// Turning SAM's candidate masks into the part the user meant.

import { rgbToLab } from "./color";

/**
 * SAM returns 3 candidates (roughly sub-part / part / whole). It is often most confident about the
 * biggest one (a whole leg when you clicked a knee plate), so take the smallest candidate whose
 * score is within `slack` of the best.
 */
export function chooseCandidate(masks: Uint8Array, scores: number[], plane: number, slack = 0.06): number {
  const best = Math.max(...scores);
  const areas = scores.map((_, k) => {
    let a = 0;
    for (let i = k * plane, end = i + plane; i < end; i++) a += masks[i];
    return a;
  });
  let pick = scores.indexOf(best);
  scores.forEach((s, k) => {
    if (s >= best - slack && areas[k] > 0 && areas[k] < areas[pick]) pick = k;
  });
  return pick;
}

/**
 * Drop pixels from `mask` whose hue clearly differs from the plastic at (x, y): a differently colored
 * neighbor that SAM merged in gets cut away. Shading changes lightness and chroma a lot (dark red is
 * dull, highlights are pale), so colored plastic is compared by hue angle and near-neutral pixels are
 * kept; neutral plastic (white/gray/black) only loses clearly colored pixels. No connectivity
 * requirement: clicks near edges would otherwise leave slivers.
 * Returns a new 0/1 mask of length w*h.
 */
export function colorGuard(
  mask: Uint8Array, offset: number, rgba: Uint8ClampedArray | Uint8Array,
  w: number, h: number, x: number, y: number, hueTol = 30, neutralChroma = 12,
): Uint8Array {
  const n = w * h;
  const ab = (i: number) => {
    const lab = rgbToLab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
    return [lab[1], lab[2]];
  };
  // Reference chroma: median over a window around the click, inside the mask.
  const as: number[] = [], bs: number[] = [];
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = py * w + px;
    if (!mask[offset + i]) continue;
    const [a, b] = ab(i);
    as.push(a); bs.push(b);
  }
  if (as.length < 10) return mask.slice(offset, offset + n); // too little to judge: leave SAM's mask
  const med = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  const ra = med(as), rb = med(bs);
  const refChroma = Math.hypot(ra, rb);
  const refHue = Math.atan2(rb, ra);
  const kept = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[offset + i]) continue;
    const [a, b] = ab(i);
    const c = Math.hypot(a, b);
    let keep: boolean;
    if (refChroma < neutralChroma) {
      keep = c < neutralChroma * 1.8; // neutral plastic: drop only clearly colored pixels
    } else if (c < neutralChroma * 0.7) {
      keep = true; // highlight or deep shadow on colored plastic
    } else {
      let dh = Math.abs(Math.atan2(b, a) - refHue) * (180 / Math.PI);
      if (dh > 180) dh = 360 - dh;
      keep = dh < hueTol;
    }
    if (keep) kept[i] = 1;
  }
  // Re-admit small enclosed gaps (panel lines, decals, dark seams inside the part).
  return fillEnclosed(kept, mask, offset, w, h);
}

/**
 * Add small mask areas that the kept area surrounds (panel lines, seams, decals). Large enclosed
 * areas are left out: those are usually a separately molded insert of another color.
 */
function fillEnclosed(kept: Uint8Array, mask: Uint8Array, offset: number, w: number, h: number): Uint8Array {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const push = (i: number) => { if (!kept[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const px = i % w, py = (i / w) | 0;
    if (px > 0) push(i - 1);
    if (px < w - 1) push(i + 1);
    if (py > 0) push(i - w);
    if (py < h - 1) push(i + w);
  }
  let keptArea = 0;
  for (let i = 0; i < n; i++) keptArea += kept[i];
  const maxHole = Math.max(60, keptArea * 0.04);
  const out = kept.slice();
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || kept[s] || outside[s] || !mask[offset + s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q], px = i % w, py = (i / w) | 0;
      for (const j of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && !kept[j] && !outside[j] && mask[offset + j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length <= maxHole) for (const i of comp) out[i] = 1;
  }
  return out;
}
