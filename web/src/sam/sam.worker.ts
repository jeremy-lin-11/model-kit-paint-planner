/// <reference lib="webworker" />
// Segment-anything in a worker: embed the image once, then decode masks per click.

import { AutoProcessor, env, RawImage, SamModel, Tensor } from "@huggingface/transformers";

export const SAM_MODEL = "Xenova/slimsam-77-uniform";

export type SamRequest =
  | { type: "load" }
  | { type: "embed"; id: number; width: number; height: number; rgba: ArrayBuffer }
  | { type: "decode"; id: number; points: { x: number; y: number; positive: boolean }[] };

export type SamResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready"; device: string }
  | { type: "embedded"; id: number; ms: number }
  | { type: "mask"; id: number; width: number; height: number; masks: Uint8Array; scores: number[] }
  | { type: "error"; id?: number; message: string };

env.allowLocalModels = false;

let model: SamModel | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let device = "wasm";
let embedding: { emb: Record<string, Tensor>; inputs: any; width: number; height: number } | null = null;

const post = (msg: SamResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function load() {
  if (model) return post({ type: "ready", device });
  const progress_callback = (p: any) => {
    if (p.status === "progress") post({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
  };
  device = "gpu" in navigator ? "webgpu" : "wasm";
  try {
    model = await SamModel.from_pretrained(SAM_MODEL, { device, dtype: "fp32", progress_callback } as any) as SamModel;
  } catch {
    device = "wasm"; // WebGPU present but unusable (e.g. no adapter): fall back
    model = await SamModel.from_pretrained(SAM_MODEL, { device, dtype: "fp32", progress_callback } as any) as SamModel;
  }
  processor = await AutoProcessor.from_pretrained(SAM_MODEL, {});
  post({ type: "ready", device });
}

self.onmessage = async (e: MessageEvent<SamRequest>) => {
  const req = e.data;
  try {
    if (req.type === "load") return await load();
    if (!model || !processor) throw new Error("model not loaded");
    if (req.type === "embed") {
      const t = performance.now();
      const image = new RawImage(new Uint8ClampedArray(req.rgba), req.width, req.height, 4).rgb();
      const inputs = await (processor as any)(image);
      const emb = await model.get_image_embeddings(inputs);
      embedding = { emb, inputs, width: req.width, height: req.height };
      return post({ type: "embedded", id: req.id, ms: Math.round(performance.now() - t) });
    }
    if (req.type === "decode") {
      if (!embedding) throw new Error("no image embedded");
      const { emb, inputs, width, height } = embedding;
      const [rh, rw] = inputs.reshaped_input_sizes[0];
      const sx = rw / width, sy = rh / height;
      const n = req.points.length;
      const input_points = new Tensor("float32", req.points.flatMap((p) => [p.x * sx, p.y * sy]), [1, 1, n, 2]);
      const input_labels = new Tensor("int64", req.points.map((p) => (p.positive ? 1n : 0n)), [1, 1, n]);
      const out = await model({ ...emb, input_points, input_labels });
      const masks = await (processor as any).post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
      const data = masks[0].data as Uint8Array | boolean[];
      const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as boolean[], (v) => (v ? 1 : 0));
      const scores = Array.from(out.iou_scores.data as Float32Array);
      return post({ type: "mask", id: req.id, width, height, masks: bytes, scores }, [bytes.buffer]);
    }
  } catch (err) {
    post({ type: "error", id: "id" in req ? req.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
