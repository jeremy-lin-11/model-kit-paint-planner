// Evaluate automatic regions (segment-everything + plastic-color grouping) on the test photos.
//   NODE_USE_ENV_PROXY=1 node --import tsx scripts/auto-eval.ts [step=20] [batch=16] [threshold=10]
// Writes ../.cache/spike/auto_<image>.png: [photo | parts | color groups | legend].

import { mkdirSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";
import { AutoProcessor, env, RawImage, SamModel, Tensor } from "@huggingface/transformers";
import { backgroundMask } from "../src/core/autoRegions";
import {
  acceptMask, buildPartMap, plasticDistance, colorName, gridPoints, groupMap, groupParts, isDuplicate, labImage, partColors, type Part,
} from "../src/core/autoParts";
import { labToRgb, rgbToHex } from "../src/core/color";
import { chooseCandidate, colorGuard } from "../src/core/maskSelect";

const ROOT = join(import.meta.dirname, "..", "..");
env.cacheDir = join(ROOT, ".cache", "hf");
const MODEL = "Xenova/slimsam-77-uniform";
const IMG_DIR = join(ROOT, "data", "Test Product Shots");
const OUT_DIR = join(ROOT, ".cache", "spike");
const STEP = Number(process.argv[2] ?? 20);
const BATCH = Number(process.argv[3] ?? 16);
const THRESHOLD = Number(process.argv[4] ?? 18);
const ONLY = process.argv[5];
const TILE = 480;

const model = await SamModel.from_pretrained(MODEL, { dtype: "fp32" });
const processor = await AutoProcessor.from_pretrained(MODEL);
mkdirSync(OUT_DIR, { recursive: true });

const tile = (rgb: Buffer, w: number, h: number) =>
  sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(TILE, TILE, { fit: "contain", background: "#fff" }).png().toBuffer();

for (const file of readdirSync(IMG_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && (!ONLY || f.includes(ONLY)))) {
  const t0 = performance.now();
  const { data: buf, info } = await sharp(join(IMG_DIR, file)).flatten({ background: "#fff" })
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h;
  const rgba = new Uint8ClampedArray(buf);
  const inputs = await (processor as any)(new RawImage(rgba, w, h, 4).rgb());
  const emb = await model.get_image_embeddings(inputs);
  const [rh, rw] = inputs.reshaped_input_sizes[0];
  const tEmbed = performance.now();

  const bg = backgroundMask({ width: w, height: h, data: rgba });
  let fgArea = 0;
  for (let i = 0; i < n; i++) if (!bg[i]) fgArea++;
  const points = gridPoints(w, h, bg, STEP);
  const owner = new Int32Array(n).fill(-1);
  const parts: Part[] = [];
  let decoded = 0, tDecode = 0;
  for (let start = 0; start < points.length;) {
    const batch: [number, number][] = [];
    while (start < points.length && batch.length < BATCH) {
      const [x, y] = points[start++];
      if (owner[y * w + x] < 0) batch.push([x, y]);
    }
    if (!batch.length) break;
    const td = performance.now();
    const out = await model({
      ...emb,
      input_points: new Tensor("float32", batch.flatMap(([x, y]) => [x * (rw / w), y * (rh / h)]), [1, batch.length, 1, 2]),
      input_labels: new Tensor("int64", batch.map(() => 1n), [1, batch.length, 1]),
    });
    const masks = (await (processor as any).post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes))[0].data as Uint8Array;
    const scores = Array.from(out.iou_scores.data as Float32Array);
    tDecode += performance.now() - td;
    decoded += batch.length;
    batch.forEach(([x, y], b) => {
      const three = masks.subarray(b * 3 * n, (b + 1) * 3 * n);
      const sc = scores.slice(b * 3, b * 3 + 3);
      const k = chooseCandidate(three, sc, n);
      const mask = colorGuard(three, k * n, rgba, w, h, x, y);
      const pixels = acceptMask(mask, bg, fgArea, sc[k]);
      if (!pixels || isDuplicate(pixels, owner, parts.map((p) => p.pixels.length))) return;
      const id = parts.length;
      parts.push({ pixels, score: sc[k] });
      for (const i of pixels) if (owner[i] < 0 || parts[owner[i]].pixels.length > pixels.length) owner[i] = id;
    });
  }

  const lab = labImage(rgba, n);
  const partMap = buildPartMap(parts, w, h, bg, lab);
  const colors = partColors(partMap, parts.length, lab);
  const { groups, assign } = groupParts(colors, THRESHOLD);
  const regions = groupMap(partMap, assign);
  let covered = 0;
  for (let i = 0; i < n; i++) if (!bg[i] && partMap[i] >= 0) covered++;
  const counts = [12, 15, 18, 22, 26].map((t) => `${t}:${groupParts(colors, t).groups.length}`).join(" ");

  // --- sheet
  const photo = Buffer.alloc(n * 3), partsImg = Buffer.alloc(n * 3), groupImg = Buffer.alloc(n * 3);
  const rnd = (k: number) => [(k * 97) % 200 + 40, (k * 57) % 200 + 40, (k * 131) % 200 + 40];
  const gRgb = groups.map((g) => labToRgb(g.lab));
  for (let i = 0; i < n; i++) {
    photo.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const p = partMap[i], g = regions[i];
    partsImg.set(p >= 0 ? rnd(p) : bg[i] ? [255, 255, 255] : [255, 0, 255], i * 3);
    const x = i % w;
    const edge = g >= 0 && ((x < w - 1 && regions[i + 1] !== g) || (i + w < n && regions[i + w] !== g));
    groupImg.set(g >= 0 ? (edge ? [0, 0, 0] : gRgb[g]) : bg[i] ? [255, 255, 255] : [255, 0, 255], i * 3);
  }
  const legend = groups.map((g, k) => {
    const hex = rgbToHex(gRgb[k]);
    return `<rect x="10" y="${14 + k * 34}" width="26" height="26" fill="${hex}" stroke="#333"/>` +
      `<text x="46" y="${33 + k * 34}" font-family="Helvetica" font-size="18">${colorName(g.lab)}  ${(100 * g.size / fgArea).toFixed(1)}%  (${g.parts.length} parts)</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}"><rect width="100%" height="100%" fill="#fff"/>${legend}` +
    `<text x="10" y="${TILE - 12}" font-family="Helvetica" font-size="14" fill="#666">magenta = not covered · threshold ${THRESHOLD}</text></svg>`);
  const tiles = [await tile(photo, w, h), await tile(partsImg, w, h), await tile(groupImg, w, h), await sharp(svg).png().toBuffer()];
  await sharp({ create: { width: TILE * 4, height: TILE, channels: 3, background: "#fff" } })
    .composite(tiles.map((input, k) => ({ input, left: k * TILE, top: 0 })))
    .png().toFile(join(OUT_DIR, `auto_${parse(file).name}.png`));

  console.log(`${file} ${w}x${h}: embed ${((tEmbed - t0) / 1000).toFixed(1)}s, ${decoded}/${points.length} points decoded in ${(tDecode / 1000).toFixed(1)}s, ` +
    `${parts.length} parts, coverage ${(100 * covered / fgArea).toFixed(1)}%, groups by threshold ${counts}`);
  console.log("  " + groups.map((g) => `${colorName(g.lab)} ${(100 * g.size / fgArea).toFixed(1)}%`).join(", "));
  if (process.env.DEBUG) {
    const lch = (l: number[]) => `L${l[0].toFixed(0)} C${Math.hypot(l[1], l[2]).toFixed(0)} h${((Math.atan2(l[2], l[1]) * 180 / Math.PI + 360) % 360).toFixed(0)}`;
    groups.forEach((g, i) => console.log(`   ${i} ${colorName(g.lab).padEnd(11)} ${lch(g.lab)}  d: ` +
      groups.slice(0, i).map((o, j) => `${j}=${plasticDistance(g.lab, o.lab).toFixed(0)}`).join(" ")));
  }
}
