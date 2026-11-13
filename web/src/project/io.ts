// Browser side of project files: canvas PNG encode/decode, the preview image, download, and open.
import {
  buildProjectJson, decodeProjectPng, encodeProjectPng, MAX_SIDE, ProjectError, resolvePaints, sanitizeMap,
  sanitizeProject, type ProjectJson,
} from "../core/projectFile";
import { computeRegionStats, recolor } from "../core/recolor";
import { useStore, type KitImage } from "../store";

const MAX_FILE_BYTES = 64 << 20;

async function canvasPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** Lossless PNG of the working image (alpha is always 255, so no premultiply loss). */
function imagePng(img: KitImage): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvasPng(canvas);
}

/** Decode PNG bytes to RGBA without color management, so pixels come back exactly as saved. */
async function decodePng(bytes: Uint8Array, width: number, height: number): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  if (bitmap.width !== width || bitmap.height !== height) throw new ProjectError("The project's photo doesn't match its saved size.");
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height).data;
}

/** Decode a photo, flatten transparency onto white, and scale to working resolution. */
async function loadPhoto(file: File): Promise<KitImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { name: file.name, width, height, data: ctx.getImageData(0, 0, width, height).data };
}

function fitText(ctx: OffscreenCanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** What image viewers show: the repainted kit with a legend of region → paint underneath. */
async function previewPng(): Promise<Uint8Array> {
  const { image, regionMap, regions, paintsById } = useStore.getState();
  if (!image) throw new Error("No project open");
  const stats = computeRegionStats(image.data, regionMap, regions.length);
  const targets = regions.map((r) => (r.paintId ? paintsById.get(r.paintId)?.hex ?? null : null));
  const pixels = recolor(image.data, regionMap, stats, targets);

  const rows = regions.flatMap((r) => {
    const p = r.paintId ? paintsById.get(r.paintId) : undefined;
    return p ? [{ region: r.name, paint: p }] : [];
  });
  const W = image.width, pad = 12, rowH = 26, cols = W >= 640 ? 2 : 1;
  const legendH = rows.length ? pad * 2 + Math.ceil(rows.length / cols) * rowH + 16 : 0;
  const canvas = new OffscreenCanvas(W, image.height + legendH);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), W, image.height), 0, 0);
  if (rows.length) {
    const top = image.height;
    ctx.fillStyle = "#15171c";
    ctx.fillRect(0, top, W, legendH);
    const colW = (W - pad * 2) / cols;
    rows.forEach(({ region, paint }, i) => {
      const x = pad + (i % cols) * colW, y = top + pad + Math.floor(i / cols) * rowH;
      ctx.fillStyle = paint.hex;
      ctx.fillRect(x, y + 2, 18, 18);
      ctx.strokeStyle = "#2e323c";
      ctx.strokeRect(x + 0.5, y + 2.5, 17, 17);
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#e7e9ee";
      const finish = paint.finish ? ` (${paint.finish === "clear-color" ? "candy/clear" : paint.finish})` : "";
      ctx.fillText(fitText(ctx, `${region}: ${paint.brand} ${paint.code} ${paint.name}${finish}`, colW - 32), x + 26, y + 11);
    });
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#9aa0ad";
    ctx.fillText("Kit Paint Planner · colors are screen approximations of published swatches", pad, top + legendH - 12);
  }
  return canvasPng(canvas);
}

// ------------------------------------------------------------------ unsaved-work tracking

let savedRefs: { regionMap: Int16Array; regions: unknown } | null = null;

/** True if the open project has parts assigned and changed since it was last saved to a file. */
export function hasUnsavedWork(): boolean {
  const { image, regionMap, regions } = useStore.getState();
  if (!image || !regionMap.some((v) => v >= 0)) return false;
  return !savedRefs || savedRefs.regionMap !== regionMap || savedRefs.regions !== regions;
}

function markSaved() {
  const { regionMap, regions } = useStore.getState();
  savedRefs = { regionMap, regions };
}

// ------------------------------------------------------------------ save / open

export function currentProjectJson(): ProjectJson | null {
  const st = useStore.getState();
  return st.image ? buildProjectJson(st as typeof st & { image: KitImage }, st.paintsById, st.paintsGenerated) : null;
}

export function projectFileName(imageName: string): string {
  const base = imageName.replace(/\.kpp\.png$/i, "").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w\- ]+/g, "_").trim() || "kit";
  return `${base}.kpp.png`;
}

export async function saveProjectFile(): Promise<void> {
  const st = useStore.getState();
  const project = currentProjectJson();
  if (!st.image || !project) return;
  const bytes = await encodeProjectPng({
    preview: await previewPng(),
    original: await imagePng(st.image),
    project,
    regionMap: st.regionMap,
  });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = projectFileName(st.image.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  markSaved();
}

/** Load validated project data into the app (shared by file open and autosave resume). */
export function restoreProject(project: ProjectJson, regionMap: Int16Array, data: Uint8ClampedArray, saved: boolean) {
  const { width, height, name } = project.image;
  if (data.length !== width * height * 4) throw new ProjectError("The project's photo doesn't match its saved size.");
  const { paintIds, notices } = resolvePaints(project, useStore.getState().paintsById);
  useStore.getState().loadProject({
    image: { name, width, height, data },
    regionMap,
    regions: project.regions.map((r, i) => ({ name: r.name, paintId: paintIds[i] })),
    active: project.active,
    notices,
  });
  if (saved) markSaved(); else savedRefs = null;
}

/** Restore from the autosave record; validates it like a file, since storage can hold stale formats. */
export function restoreAutosave(raw: { project: unknown; regionMap: unknown; data: unknown }) {
  if (!(raw.regionMap instanceof Int16Array) || !(raw.data instanceof Uint8ClampedArray)) {
    throw new ProjectError("The autosaved project is damaged.");
  }
  const project = sanitizeProject(raw.project);
  restoreProject(project, sanitizeMap(raw.regionMap, project), raw.data, false);
}

/** Open a dropped/chosen file: a saved project resumes, any other image starts a new project. */
export async function openFile(file: File): Promise<"project" | "photo"> {
  if (file.size > MAX_FILE_BYTES) throw new ProjectError(`${file.name} is too large (over 64 MB).`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = await decodeProjectPng(bytes);
  if (decoded) {
    const { project, regionMap, original } = decoded;
    restoreProject(project, regionMap, await decodePng(original, project.image.width, project.image.height), true);
    return "project";
  }
  try {
    useStore.getState().setImage(await loadPhoto(file));
  } catch {
    throw new ProjectError(`Couldn't read ${file.name}. Try a JPEG, PNG or WebP.`);
  }
  savedRefs = null;
  return "photo";
}

