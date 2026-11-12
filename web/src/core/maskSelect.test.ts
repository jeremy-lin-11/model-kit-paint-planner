import { describe, expect, it } from "vitest";
import { chooseCandidate, colorGuard } from "./maskSelect";

describe("chooseCandidate", () => {
  const plane = 10;
  // Candidate areas 2, 5, 9 pixels.
  const masks = new Uint8Array(30);
  masks.fill(1, 0, 2);
  masks.fill(1, 10, 15);
  masks.fill(1, 20, 29);

  it("prefers the smallest candidate that is nearly as confident as the best", () => {
    expect(chooseCandidate(masks, [0.5, 0.86, 0.9], plane)).toBe(1);
  });
  it("keeps the most confident one when smaller ones are clearly worse", () => {
    expect(chooseCandidate(masks, [0.5, 0.7, 0.95], plane)).toBe(2);
  });
});

describe("colorGuard", () => {
  // 20x10 image: left half red, right half blue, SAM mask covers both.
  const w = 20, h = 10, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const red = i % w < 10;
    rgba.set(red ? [200, 30, 30, 255] : [30, 50, 200, 255], i * 4);
  }
  const mask = new Uint8Array(n).fill(1);

  it("cuts away the differently colored half", () => {
    const out = colorGuard(mask, 0, rgba, w, h, 4, 5);
    let left = 0, right = 0;
    for (let i = 0; i < n; i++) if (out[i]) (i % w < 10 ? left++ : right++);
    expect(left).toBe(100); // 10x10 left half
    expect(right).toBe(0);
  });

  it("keeps shaded pixels of the clicked color", () => {
    const shaded = rgba.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < 5; x++) shaded.set([90, 12, 12, 255], (y * w + x) * 4);
    const out = colorGuard(mask, 0, shaded, w, h, 7, 5);
    let left = 0;
    for (let i = 0; i < n; i++) if (out[i] && i % w < 10) left++;
    expect(left).toBe(100); // 10x10 left half
  });
});
