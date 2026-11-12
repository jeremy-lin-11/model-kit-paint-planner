// Shading-preserving recolor. Treats each pixel as (region albedo) x (shading): the shading
// ratio S = Y / Yref is measured on the original plastic and re-applied to the target paint,
// so panel lines, shadows and highlights survive while the base color changes.

import { hexToRgb, luminance, linearToSrgb, srgbToLinear } from "./color";

export interface RegionStats {
  /** Luminance taken as the region's unshaded "albedo" (a high percentile of its pixels). */
  yRef: number;
  count: number;
}

export interface RecolorOptions {
  /** Percentile of region luminance used as the albedo reference (0–1). */
  refPercentile: number;
  /** S above this is treated as specular highlight and pushed toward white. */
  highlightStart: number;
  /** S at which the highlight blend is at full strength. */
  highlightEnd: number;
  /** Max fraction of the way to white a highlight can go. */
  highlightStrength: number;
  /** Shading contrast: S' = S^gamma. <1 flattens, >1 deepens. */
  shadingGamma: number;
  /** Ignore shading below this source luminance (dark plastic is mostly noise). */
  darkSourceFloor: number;
}

export const DEFAULT_OPTIONS: RecolorOptions = {
  refPercentile: 0.75,
  highlightStart: 1.05,
  highlightEnd: 1.6,
  highlightStrength: 0.6,
  shadingGamma: 1.0,
  darkSourceFloor: 0.02,
};

/** Per-region albedo reference. regionMap holds a region index per pixel, -1 = not recolorable. */
export function computeRegionStats(
  rgba: Uint8ClampedArray | Uint8Array,
  regionMap: Int16Array,
  regionCount: number,
  opts: RecolorOptions = DEFAULT_OPTIONS,
): RegionStats[] {
  const hists = Array.from({ length: regionCount }, () => new Uint32Array(1024));
  const counts = new Uint32Array(regionCount);
  for (let i = 0, p = 0; i < regionMap.length; i++, p += 4) {
    const r = regionMap[i];
    if (r < 0) continue;
    const y = luminance(srgbToLinear(rgba[p]), srgbToLinear(rgba[p + 1]), srgbToLinear(rgba[p + 2]));
    hists[r][Math.min(1023, Math.floor(y * 1024))]++;
    counts[r]++;
  }
  return hists.map((h, r) => {
    const target = counts[r] * opts.refPercentile;
    let acc = 0, bin = 0;
    for (; bin < 1024; bin++) {
      acc += h[bin];
      if (acc >= target) break;
    }
    return { yRef: Math.max((bin + 0.5) / 1024, 1e-4), count: counts[r] };
  });
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Recolor pixels. targets[r] is a hex color for region r, or null to leave it untouched.
 * Returns a new RGBA buffer.
 */
export function recolor(
  rgba: Uint8ClampedArray | Uint8Array,
  regionMap: Int16Array,
  stats: RegionStats[],
  targets: (string | null)[],
  opts: RecolorOptions = DEFAULT_OPTIONS,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const lin = targets.map((hex) => (hex ? hexToRgb(hex).map(srgbToLinear) : null));
  for (let i = 0, p = 0; i < regionMap.length; i++, p += 4) {
    const r = regionMap[i];
    if (r < 0) continue;
    const t = lin[r];
    if (!t) continue;
    const sr = srgbToLinear(rgba[p]), sg = srgbToLinear(rgba[p + 1]), sb = srgbToLinear(rgba[p + 2]);
    const y = luminance(sr, sg, sb);
    const { yRef } = stats[r];
    // Dark plastic: shading ratios are dominated by noise, so blend toward flat (S=1).
    const trust = smoothstep(opts.darkSourceFloor * 0.5, opts.darkSourceFloor * 2, yRef);
    let s = y / yRef;
    s = 1 + (s - 1) * trust;
    const sShade = Math.min(s, 1) ** opts.shadingGamma;
    const hi = smoothstep(opts.highlightStart, opts.highlightEnd, s) * opts.highlightStrength;
    for (let c = 0; c < 3; c++) {
      const shaded = t[c] * sShade;
      out[p + c] = linearToSrgb(shaded + (1 - shaded) * hi);
    }
  }
  return out;
}
