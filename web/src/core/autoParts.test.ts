import { describe, expect, it } from "vitest";
import { hexToRgb, rgbToLab, type Lab } from "./color";
import { buildPartMap, colorName, distinctPlastics, groupParts, labImage, partColors, plasticDistance, type PartColor } from "./autoParts";

const lab = (hex: string): Lab => rgbToLab(hexToRgb(hex));
const part = (hex: string, size = 100): PartColor => ({ lab: lab(hex), size });

describe("plastic grouping", () => {
  it("names common plastics", () => {
    expect(colorName(lab("#f2f2f2"))).toBe("White");
    expect(colorName(lab("#1a1a1a"))).toBe("Black");
    expect(colorName(lab("#d62020"))).toBe("Red");
    expect(colorName(lab("#2846c8"))).toBe("Blue"); // Lab hue ~295°: blue, not purple
    expect(colorName(lab("#f0c814"))).toBe("Yellow");
  });

  it("keeps a lit and a shaded red together but white and gray apart", () => {
    expect(plasticDistance(lab("#e0302a"), lab("#8a1a18"))).toBeLessThan(18);
    expect(plasticDistance(lab("#f0f0f0"), lab("#7a7a7a"))).toBeGreaterThan(18);
  });

  it("never folds a vivid accent into a neutral or across hues", () => {
    expect(distinctPlastics(lab("#f0c814"), lab("#f4f4f4"))).toBe(true);
    expect(distinctPlastics(lab("#d62020"), lab("#2846c8"))).toBe(true);
    expect(distinctPlastics(lab("#e0302a"), lab("#8a1a18"))).toBe(false);
  });

  it("groups parts by plastic, biggest group first", () => {
    const colors = [part("#e0302a", 500), part("#9a2220", 300), part("#f4f4f4", 200), part("#f0c814", 10), part("#202020", 50)];
    const { groups, assign } = groupParts(colors);
    expect(groups.map((g) => colorName(g.lab))).toEqual(["Red", "White", "Black", "Yellow"]);
    expect(assign[0]).toBe(assign[1]);
    expect(new Set(assign).size).toBe(4);
  });

  it("merges down to maxGroups even across distinct plastics", () => {
    const colors = [part("#d62020"), part("#2846c8"), part("#20a040"), part("#f0c814")];
    expect(groupParts(colors, 18, 2).groups).toHaveLength(2);
  });
});

describe("part map", () => {
  it("lets smaller parts win overlaps and fills thin gaps", () => {
    const w = 6, h = 1, n = w * h;
    const rgba = new Uint8ClampedArray(n * 4).fill(200);
    const bg = new Uint8Array(n);
    bg[5] = 1;
    const parts = [
      { pixels: new Int32Array([0, 1, 2, 3]), score: 0.9 },
      { pixels: new Int32Array([2, 3]), score: 0.9 },
    ];
    const map = buildPartMap(parts, w, h, bg, labImage(rgba, n));
    expect(Array.from(map)).toEqual([0, 0, 1, 1, 1, -1]); // pixel 4 filled from its neighbor, bg untouched
    expect(partColors(map, 2, labImage(rgba, n)).map((c) => c.size)).toEqual([2, 3]);
  });
});
