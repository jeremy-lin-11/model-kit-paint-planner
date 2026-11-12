// Compare part-selection strategies on many clicks per test image.
//   NODE_USE_ENV_PROXY=1 node --import tsx scripts/select-eval.ts
// Writes ../.cache/spike/select_<image>.png: for each click where strategies differ,
// [old: highest score (red)] [new: smallest confident + color guard (green)].

import { mkdirSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";
import { AutoProcessor, env, RawImage, SamModel, Tensor } from "@huggingface/transformers";
import { backgroundMask } from "../src/core/autoRegions";
import { chooseCandidate, colorGuard } from "../src/core/maskSelect";

const ROOT = join(import.meta.dirname, "..", "..");
env.cacheDir = join(ROOT, ".cache", "hf");
const MODEL = "Xenova/slimsam-77-uniform";
const IMG_DIR = join(ROOT, "data", "Test Product Shots");
const OUT_DIR = join(ROOT, ".cache", "spike");
const GRID = 7; // GRID x GRID candidate click points, foreground only
const TILE = 200;

const model = await SamModel.from_pretrained(MODEL, { dtype: "fp32" });
const processor = await AutoProcessor.from_pretrained(MODEL);
mkdirSync(OUT_DIR, { recursive: true });

function tint(rgb: Buffer, w: number, mask: Uint8Array, color: number[], box: number[], x: number, y: number) {
  const [x0, y0, x1, y1] = box;
  const cw = x1 - x0, ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 3);
  for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
    const i = (y0 + yy) * w + (x0 + xx), o = (yy * cw + xx) * 3;
    for (let c = 0; c < 3; c++) out[o + c] = mask[i] ? rgb[i * 3 + c] * 0.4 + color[c] * 0.6 : rgb[i * 3 + c];
    if (Math.abs(x0 + xx - x) + Math.abs(y0 + yy - y) < 4) out.set([0, 0, 0], o);
  }
  return sharp(out, { raw: { width: cw, height: ch, channels: 3 } }).resize(TILE, TILE, { fit: "contain", background: "#fff" }).png().toBuffer();
}

let totalClicks = 0, changed = 0;
for (const file of readdirSync(IMG_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
  const { data: rgbaBuf, info } = await sharp(join(IMG_DIR, file)).flatten({ background: "#fff" })
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, plane = w * h;
  const rgba = new Uint8ClampedArray(rgbaBuf);
  const rgb = Buffer.alloc(plane * 3);
  for (let i = 0; i < plane; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  const image = new RawImage(rgba, w, h, 4).rgb();
  const inputs = await (processor as any)(image);
  const emb = await model.get_image_embeddings(inputs);
  const [rh, rw] = inputs.reshaped_input_sizes[0];
  const bg = backgroundMask({ width: w, height: h, data: rgba });

  const tiles: Buffer[] = [];
  const lines: string[] = [];
  for (let gy = 1; gy <= GRID; gy++) for (let gx = 1; gx <= GRID; gx++) {
    const x = Math.round((gx / (GRID + 1)) * w), y = Math.round((gy / (GRID + 1)) * h);
    if (bg[y * w + x]) continue;
    totalClicks++;
    const out = await model({
      ...emb,
      input_points: new Tensor("float32", [x * (rw / w), y * (rh / h)], [1, 1, 1, 2]),
      input_labels: new Tensor("int64", [1n], [1, 1, 1]),
    });
    const masks = (await (processor as any).post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes))[0].data as Uint8Array;
    const scores = Array.from(out.iou_scores.data as Float32Array);
    const oldK = scores.indexOf(Math.max(...scores));
    const oldMask = masks.subarray(oldK * plane, (oldK + 1) * plane);
    const newK = chooseCandidate(masks, scores, plane);
    const newMask = colorGuard(masks, newK * plane, rgba, w, h, x, y);
    let aOld = 0, aNew = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let i = 0; i < plane; i++) {
      aOld += oldMask[i]; aNew += newMask[i];
      if (oldMask[i] || newMask[i]) {
        const px = i % w, py = (i / w) | 0;
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    if (aOld === 0 || aNew / aOld > 0.85) continue; // essentially the same pick
    changed++;
    const pad = 20;
    const box = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + pad), Math.min(h, y1 + pad)];
    tiles.push(await tint(rgb, w, oldMask, [255, 40, 40], box, x, y), await tint(rgb, w, newMask, [40, 220, 40], box, x, y));
    lines.push(`(${x},${y}) old#${oldK} ${(100 * aOld / plane).toFixed(1)}% -> new#${newK} ${(100 * aNew / plane).toFixed(1)}%  scores ${scores.map((s) => s.toFixed(2)).join("/")}`);
  }
  console.log(`${file}: ${lines.length} changed`);
  for (const l of lines) console.log("  " + l);
  if (!tiles.length) continue;
  const cols = 6, rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: cols * TILE, height: rows * TILE, channels: 3, background: "#fff" } })
    .composite(tiles.map((input, k) => ({ input, left: (k % cols) * TILE, top: Math.floor(k / cols) * TILE })))
    .png().toFile(join(OUT_DIR, `select_${parse(file).name}.png`));
}
console.log(`\n${changed}/${totalClicks} clicks changed by the new selection`);
