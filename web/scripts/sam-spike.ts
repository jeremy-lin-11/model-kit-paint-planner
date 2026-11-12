// Offline check of click-to-select parts with SlimSAM (same library the app will use).
//   node --import tsx scripts/sam-spike.ts [model-id]
// Writes ../.cache/spike/sam_<image>.png: each click's best mask tinted, click marked.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { AutoProcessor, env, RawImage, SamModel, Tensor } from "@huggingface/transformers";

const ROOT = join(import.meta.dirname, "..", "..");
env.cacheDir = join(ROOT, ".cache", "hf");
const MODEL = process.argv[2] ?? "Xenova/slimsam-77-uniform";
const OUT_DIR = join(ROOT, ".cache", "spike");

// Clicks in original-image pixels: one per part we'd expect a user to tap.
const TESTS: { file: string; clicks: [number, number][] }[] = [
  { file: "rg_hi_nu.jpg", clicks: [[420, 600], [640, 420], [330, 820], [300, 330], [760, 560]] },
  { file: "mg_barbatos_lupus.webp", clicks: [[640, 190], [500, 240], [600, 580], [250, 560], [470, 400]] },
];
const TINTS = [[255, 0, 0], [0, 200, 0], [0, 80, 255], [255, 160, 0], [200, 0, 200]];

const t0 = Date.now();
const model = await SamModel.from_pretrained(MODEL, { dtype: "fp32" });
const processor = await AutoProcessor.from_pretrained(MODEL);
console.log(`loaded ${MODEL} in ${Date.now() - t0} ms`);
mkdirSync(OUT_DIR, { recursive: true });

for (const { file, clicks } of TESTS) {
  const path = join(ROOT, "data", "Test Product Shots", file);
  const png = await sharp(path).removeAlpha().png().toBuffer();
  const image = await RawImage.fromBlob(new Blob([png]));
  const t1 = Date.now();
  const inputs = await processor(image);
  const emb = await model.get_image_embeddings(inputs);
  console.log(`${file}: ${image.width}x${image.height}, embedding ${Date.now() - t1} ms`);

  const overlay = Buffer.from((await sharp(png).raw().toBuffer()));
  for (let k = 0; k < clicks.length; k++) {
    const t2 = Date.now();
    // Points must be in the processor's resized coordinate frame.
    const [rh, rw] = inputs.reshaped_input_sizes[0];
    const sx = rw / image.width, sy = rh / image.height;
    const input_points = new Tensor("float32", [clicks[k][0] * sx, clicks[k][1] * sy], [1, 1, 1, 2]);
    const input_labels = new Tensor("int64", [1n], [1, 1, 1]);
    const out = await model({ ...emb, input_points, input_labels });
    const masks = await processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
    const scores = out.iou_scores.data as Float32Array;
    // SAM returns 3 candidate masks (sub-part / part / whole); report all, draw the best.
    const best = scores.indexOf(Math.max(...scores));
    const m = masks[0]; // [1, 3, H, W] bool
    const plane = image.width * image.height;
    let area = 0;
    for (let i = 0; i < plane; i++) {
      if (!m.data[best * plane + i]) continue;
      area++;
      for (let c = 0; c < 3; c++) overlay[i * 3 + c] = Math.round(overlay[i * 3 + c] * 0.45 + TINTS[k][c] * 0.55);
    }
    const [cx, cy] = clicks[k];
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      if (Math.abs(dx) > 1 && Math.abs(dy) > 1) continue;
      const i = (cy + dy) * image.width + (cx + dx);
      overlay.set([0, 0, 0], i * 3);
    }
    console.log(`  click ${k} (${cx},${cy}) scores=${[...scores].map((s) => s.toFixed(2)).join("/")} best=${best} area=${(100 * area / plane).toFixed(1)}% ${Date.now() - t2} ms`);
  }
  const out = join(OUT_DIR, `sam_${file.replace(/\.\w+$/, "")}.png`);
  await sharp(overlay, { raw: { width: image.width, height: image.height, channels: 3 } }).resize(640).png().toFile(out);
  console.log(`  -> ${out}`);
}
