// Offline recolor check: node-side run of the same core code the app uses.
//   npx tsx scripts/recolor-spike.ts
// Writes ../.cache/spike/<image>.png strips: original | parts | regions | scheme A | B | C

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";
import { backgroundMask, clusterParts, segmentParts } from "../src/core/autoRegions";
import { labToRgb, rgbToHex } from "../src/core/color";
import { computeRegionStats, recolor } from "../src/core/recolor";

const ROOT = join(import.meta.dirname, "..", "..");
const IMG_DIR = join(ROOT, "data", "Test Product Shots");
const OUT_DIR = join(ROOT, ".cache", "spike");
const SIZE = 480;
const K = 6;

const paints: Record<string, { hex: string; name: string; code: string; brand: string }> = Object.fromEntries(
  JSON.parse(readFileSync(join(ROOT, "data", "paints.json"), "utf8")).paints.map((p: any) => [p.id, p]),
);
// Paints by region rank (largest region first). Regions darker than L*25 are left alone in A/B
// (frames usually stay gunmetal), and painted in C to stress-test dark/light swaps.
const SCHEMES: { name: string; ids: string[]; keepDark: boolean }[] = [
  { name: "A navy/cream", ids: ["mrcolor-c72", "mrcolor-c69", "mrcolor-c79", "gaia-010", "tamiya-xf-63", "tamiya-x-11"], keepDark: true },
  { name: "B desert", ids: ["tamiya-xf-59", "tamiya-xf-62", "mrcolor-c33", "tamiya-x-7", "tamiya-xf-63", "gaia-020"], keepDark: true },
  { name: "C inverted", ids: ["mrcolor-c2", "gaia-003", "mrcolor-c8", "mrcolor-c4", "mrcolor-c69", "mrcolor-c65"], keepDark: false },
];
for (const s of SCHEMES) for (const id of s.ids) if (!paints[id]) throw new Error(`unknown paint ${id}`);

async function run(file: string) {
  const { data, info } = await sharp(join(IMG_DIR, file))
    .resize(SIZE, SIZE, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
  const bg = backgroundMask(img);
  const parts = segmentParts(img, bg);
  const clusters = clusterParts(parts, K);
  const stats = computeRegionStats(img.data, clusters.regionMap, K);

  // Region visualization: each region filled with its cluster center color, background magenta.
  const viz = new Uint8ClampedArray(img.data.length);
  const centerRgb = clusters.centers.map(labToRgb);
  for (let i = 0; i < clusters.regionMap.length; i++) {
    const r = clusters.regionMap[i];
    const c = r < 0 ? [255, 0, 255] : centerRgb[r];
    viz.set([c[0], c[1], c[2], 255], i * 4);
  }
  // Parts visualization: a pseudo-random color per part.
  const partViz = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < parts.partMap.length; i++) {
    const p = parts.partMap[i];
    const c = p < 0 ? [255, 255, 255] : [(p * 97) % 200 + 40, (p * 57) % 200 + 40, (p * 151) % 200 + 40];
    partViz.set([c[0], c[1], c[2], 255], i * 4);
  }
  const panels = [img.data, partViz, viz];
  for (const s of SCHEMES) {
    const targets = clusters.centers.map((lab, r) => (s.keepDark && lab[0] < 25 ? null : paints[s.ids[r]].hex));
    panels.push(recolor(img.data, clusters.regionMap, stats, targets));
  }
  const W = info.width, H = info.height;
  const strip = sharp({ create: { width: W * panels.length, height: H, channels: 4, background: "#fff" } })
    .composite(await Promise.all(panels.map(async (buf, k) => ({
      input: await sharp(Buffer.from(buf.buffer), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(),
      left: k * W, top: 0,
    }))));
  const out = join(OUT_DIR, `${parse(file).name}.png`);
  await strip.png().toFile(out);
  const summary = clusters.centers.map((lab, r) =>
    `${r}:${rgbToHex(labToRgb(lab))} ${((100 * clusters.counts[r]) / clusters.counts.reduce((a, b) => a + b)).toFixed(0)}% yRef=${stats[r].yRef.toFixed(2)}`);
  console.log(`${file}: ${parts.size.length} parts\n  ${summary.join("  ")}\n  -> ${out}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const only = process.argv[2];
for (const f of readdirSync(IMG_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && (!only || f.includes(only)))) {
  await run(f);
}
