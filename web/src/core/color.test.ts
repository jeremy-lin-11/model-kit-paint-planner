import { describe, expect, it } from "vitest";
import { deltaE2000, hexToRgb, labToRgb, linearToSrgb, rgbToHex, rgbToLab, srgbToLinear } from "./color";

describe("color", () => {
  it("converts white and black to Lab", () => {
    const w = rgbToLab([255, 255, 255]);
    expect(w[0]).toBeCloseTo(100, 1);
    expect(Math.abs(w[1])).toBeLessThan(0.01);
    expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 5);
  });

  it("round-trips sRGB through Lab", () => {
    for (const hex of ["#e70014", "#004ea1", "#7b7a7c", "#fee100", "#1d2089"]) {
      expect(rgbToHex(labToRgb(rgbToLab(hexToRgb(hex))))).toBe(hex);
    }
  });

  it("round-trips sRGB through linear via the lookup tables", () => {
    for (let c = 0; c < 256; c++) expect(linearToSrgb(srgbToLinear(c))).toBe(c);
  });

  // Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula".
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  ] as const)("deltaE2000(%j, %j) = %d", (a, b, expected) => {
    expect(deltaE2000([...a], [...b])).toBeCloseTo(expected, 3);
  });
});
