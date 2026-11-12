// Model-free region detection: background removal + k-means color clustering.
// Used as a fast fallback (and for offline tests) before/without the segmentation model.

import { rgbToLab, type Lab } from "./color";

export interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA
}

/** true = background. Uses alpha if the image has transparency, else flood fill from the border. */
export function backgroundMask(img: Image, tolerance = 3): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const bg = new Uint8Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) transparent++;
  if (transparent > n * 0.05) {
    for (let i = 0; i < n; i++) bg[i] = data[i * 4 + 3] < 128 ? 1 : 0;
    return keepLargeForeground(bg, w, h);
  }
  const lab: Lab[] = new Array(n);
  for (let i = 0; i < n; i++) lab[i] = rgbToLab([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  // Flood fill: step to a neighbor if it's within `tolerance` of the current pixel (handles gradients).
  const stack: number[] = [];
  const push = (i: number) => { if (!bg[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const close = (a: Lab, b: Lab) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < tolerance * tolerance;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    const c = lab[i];
    if (x > 0 && !bg[i - 1] && close(c, lab[i - 1])) push(i - 1);
    if (x < w - 1 && !bg[i + 1] && close(c, lab[i + 1])) push(i + 1);
    if (y > 0 && !bg[i - w] && close(c, lab[i - w])) push(i - w);
    if (y < h - 1 && !bg[i + w] && close(c, lab[i + w])) push(i + w);
  }
  return keepLargeForeground(bg, w, h);
}

/** Drop small foreground islands (text overlays, specks): anything under minFrac of the foreground. */
function keepLargeForeground(bg: Uint8Array, w: number, h: number, minFrac = 0.01): Uint8Array {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  let fgTotal = 0;
  for (let s = 0; s < n; s++) {
    if (bg[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !bg[j] && label[j] < 0) { label[j] = id; stack.push(j); }
      }
    }
    sizes.push(size);
    fgTotal += size;
  }
  const out = new Uint8Array(bg);
  for (let i = 0; i < n; i++) if (label[i] >= 0 && sizes[label[i]] < fgTotal * minFrac) out[i] = 1;
  return out;
}

export interface Clustering {
  regionMap: Int16Array; // -1 = background
  centers: Lab[];
  counts: number[];
}

export interface Parts {
  partMap: Int32Array; // -1 = background
  /** Per part: albedo estimate (bright-percentile L, median a/b) and pixel count. */
  albedo: Lab[];
  size: number[];
}

/**
 * Split the foreground into "parts": areas of smoothly varying color bounded by edges
 * (panel lines, part seams, silhouette). Growing compares each step to the previous pixel,
 * so shading gradients stay inside one part, while a/b drift from the part's mean color
 * stops leaks between differently colored parts.
 */
export function segmentParts(img: Image, bg: Uint8Array, stepTol = 4, chromaTol = 10, minPart = 40): Parts {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lab: Lab[] = new Array(n);
  for (let i = 0; i < n; i++) lab[i] = rgbToLab([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  const part = new Int32Array(n).fill(-1);
  const members: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (bg[s] || part[s] >= 0) continue;
    const id = members.length;
    const list = [s];
    part[s] = id;
    let sa = lab[s][1], sb = lab[s][2];
    for (let q = 0; q < list.length; q++) {
      const i = list[q];
      const x = i % w, y = (i / w) | 0;
      const c = lab[i];
      const ma = sa / list.length, mb = sb / list.length;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || bg[j] || part[j] >= 0) continue;
        const d = lab[j];
        const step = (c[0] - d[0]) ** 2 + (c[1] - d[1]) ** 2 + (c[2] - d[2]) ** 2;
        const drift = (d[1] - ma) ** 2 + (d[2] - mb) ** 2;
        if (step < stepTol * stepTol && drift < chromaTol * chromaTol) {
          part[j] = id;
          list.push(j);
          sa += d[1];
          sb += d[2];
        }
      }
    }
    members.push(list);
  }
  // Tiny parts are edges, seams and anti-aliasing: hand each pixel to a neighboring big part.
  const big = members.map((m) => m.length >= minPart);
  const partMap = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (part[i] >= 0 && big[part[i]]) partMap[i] = part[i];
  let pending: number[] = [];
  for (let i = 0; i < n; i++) if (part[i] >= 0 && !big[part[i]]) pending.push(i);
  for (let pass = 0; pass < 50 && pending.length; pass++) {
    const next: number[] = [];
    const assign: [number, number][] = [];
    for (const i of pending) {
      const x = i % w, y = (i / w) | 0;
      let best = -1, bd = Infinity;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || partMap[j] < 0) continue;
        const d = (lab[i][1] - lab[j][1]) ** 2 + (lab[i][2] - lab[j][2]) ** 2;
        if (d < bd) { bd = d; best = partMap[j]; }
      }
      if (best >= 0) assign.push([i, best]); else next.push(i);
    }
    for (const [i, p] of assign) partMap[i] = p;
    pending = next;
  }
  // Compact ids and compute albedo per part.
  const remap = new Map<number, number>();
  const pix: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = partMap[i];
    if (p < 0) continue;
    let id = remap.get(p);
    if (id === undefined) { id = pix.length; remap.set(p, id); pix.push([]); }
    partMap[i] = id;
    pix[id].push(i);
  }
  const albedo = pix.map((list) => {
    const Ls = list.map((i) => lab[i][0]).sort((a, b) => a - b);
    const as = list.map((i) => lab[i][1]).sort((a, b) => a - b);
    const bs = list.map((i) => lab[i][2]).sort((a, b) => a - b);
    const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
    return [q(Ls, 0.85), q(as, 0.5), q(bs, 0.5)] as Lab;
  });
  return { partMap, albedo, size: pix.map((l) => l.length) };
}

/** Group parts into k color regions with area-weighted k-means on their albedo. */
export function clusterParts(parts: Parts, k: number, seed = 1): Clustering {
  const P = parts.albedo.length;
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const d2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const pick = (weights: number[]) => {
    let r = rand() * weights.reduce((a, b) => a + b, 0), j = 0;
    while (j < weights.length - 1 && (r -= weights[j]) > 0) j++;
    return j;
  };
  const centers: Lab[] = [parts.albedo[pick(parts.size)].slice() as Lab];
  while (centers.length < Math.min(k, P)) {
    const wts = parts.albedo.map((a, i) => parts.size[i] * Math.min(...centers.map((c) => d2(a, c))));
    centers.push(parts.albedo[pick(wts)].slice() as Lab);
  }
  const assign = new Int32Array(P);
  for (let iter = 0; iter < 30; iter++) {
    for (let p = 0; p < P; p++) {
      let best = 0, bd = Infinity;
      centers.forEach((c, ci) => { const d = d2(parts.albedo[p], c); if (d < bd) { bd = d; best = ci; } });
      assign[p] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < P; p++) {
      const s = sums[assign[p]], wgt = parts.size[p], a = parts.albedo[p];
      s[0] += a[0] * wgt; s[1] += a[1] * wgt; s[2] += a[2] * wgt; s[3] += wgt;
    }
    sums.forEach((s, ci) => { if (s[3]) centers[ci] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centers.map(() => 0);
  for (let p = 0; p < P; p++) counts[assign[p]] += parts.size[p];
  const order = counts.map((_, c) => c).sort((a, b) => counts[b] - counts[a]);
  const rank = new Int32Array(centers.length);
  order.forEach((c, r) => (rank[c] = r));
  const regionMap = new Int16Array(parts.partMap.length).fill(-1);
  for (let i = 0; i < regionMap.length; i++) {
    const p = parts.partMap[i];
    if (p >= 0) regionMap[i] = rank[assign[p]];
  }
  return { regionMap, centers: order.map((c) => centers[c]), counts: order.map((c) => counts[c]) };
}

/**
 * k-means in Lab over foreground pixels. Lightness is down-weighted so that one plastic color
 * under different lighting stays one cluster.
 */
export function kmeansRegions(img: Image, bg: Uint8Array, k: number, lWeight = 0.5, seed = 1): Clustering {
  const n = img.width * img.height;
  const feats: number[][] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (bg[i]) continue;
    const [L, a, b] = rgbToLab([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
    feats.push([L * lWeight, a, b]);
    idx.push(i);
  }
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const sample = feats.length > 30000 ? Array.from({ length: 30000 }, () => feats[(rand() * feats.length) | 0]) : feats;
  const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

  // k-means++ init
  const centers: number[][] = [sample[(rand() * sample.length) | 0].slice()];
  while (centers.length < k) {
    const dist = sample.map((p) => Math.min(...centers.map((c) => d2(p, c))));
    const total = dist.reduce((s, v) => s + v, 0);
    let r = rand() * total, j = 0;
    while (j < dist.length - 1 && (r -= dist[j]) > 0) j++;
    centers.push(sample[j].slice());
  }
  const nearest = (p: number[]) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < centers.length; c++) { const d = d2(p, centers[c]); if (d < bd) { bd = d; best = c; } }
    return best;
  };
  for (let iter = 0; iter < 20; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of sample) { const c = nearest(p); sums[c][0] += p[0]; sums[c][1] += p[1]; sums[c][2] += p[2]; sums[c][3]++; }
    sums.forEach((s, c) => { if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const regionMap = new Int16Array(n).fill(-1);
  const counts = new Array(k).fill(0);
  feats.forEach((p, j) => { const c = nearest(p); regionMap[idx[j]] = c; counts[c]++; });
  // Sort regions by size, largest first, so region 0 is the "main" color.
  const order = counts.map((_, c) => c).sort((a, b) => counts[b] - counts[a]);
  const remap = new Int16Array(k);
  order.forEach((c, newIdx) => (remap[c] = newIdx));
  for (let i = 0; i < n; i++) if (regionMap[i] >= 0) regionMap[i] = remap[regionMap[i]];
  return {
    regionMap,
    centers: order.map((c) => [centers[c][0] / lWeight, centers[c][1], centers[c][2]] as Lab),
    counts: order.map((c) => counts[c]),
  };
}
