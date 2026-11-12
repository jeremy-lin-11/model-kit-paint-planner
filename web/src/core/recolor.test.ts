import { describe, expect, it } from "vitest";
import { hexToRgb } from "./color";
import { computeRegionStats, recolor } from "./recolor";

function solid(hex: string, shades: number[]) {
  // One row of pixels: the same plastic under different shading factors (linear-light).
  const [r, g, b] = hexToRgb(hex);
  const data = new Uint8ClampedArray(shades.length * 4);
  shades.forEach((s, i) => {
    const lin = (c: number) => ((c / 255) ** 2.2) * s;
    data.set([255 * lin(r) ** (1 / 2.2), 255 * lin(g) ** (1 / 2.2), 255 * lin(b) ** (1 / 2.2), 255], i * 4);
  });
  return data;
}

describe("recolor", () => {
  it("leaves unassigned regions and background untouched", () => {
    const src = solid("#cccccc", [1, 0.5]);
    const map = new Int16Array([0, -1]);
    const stats = computeRegionStats(src, map, 1);
    expect(Array.from(recolor(src, map, stats, [null]))).toEqual(Array.from(src));
  });

  it("maps the lit pixel to the target and keeps shading darker", () => {
    const src = solid("#e0e0e0", [1, 1, 1, 0.5, 0.25]);
    const map = new Int16Array(5).fill(0);
    const stats = computeRegionStats(src, map, 1);
    const out = recolor(src, map, stats, ["#1d2089"]);
    const px = (i: number) => Array.from(out.slice(i * 4, i * 4 + 3));
    const [r0, g0, b0] = px(0);
    const [tr, tg, tb] = hexToRgb("#1d2089");
    expect(Math.abs(r0 - tr) + Math.abs(g0 - tg) + Math.abs(b0 - tb)).toBeLessThan(6);
    // Shaded pixels get darker in the same order as the original.
    expect(px(3)[2]).toBeLessThan(px(0)[2]);
    expect(px(4)[2]).toBeLessThan(px(3)[2]);
  });
});
