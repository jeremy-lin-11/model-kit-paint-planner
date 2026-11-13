// Project save format: a normal PNG (the repainted kit + paint legend) carrying the project in
// private chunks, so dropping the file back into the app resumes where you left off.
//
//   kpPj  project JSON (UTF-8)            regions, paint choices, paint snapshot
//   kpMp  region map, deflated            Int16 little-endian per pixel, -1 = unassigned
//   kpIm  original photo, PNG bytes       the exact working-resolution pixels the map refers to
//
// Everything read from a file is untrusted: sizes are capped and every field is validated.

import { deltaE2000, hexToRgb, rgbToLab } from "./color";
import { isPng, readChunks, withChunks } from "./pngChunks";

export const FORMAT = "kit-paint-planner";
export const VERSION = 1;
/** Working resolution cap; must match the uploader. */
export const MAX_SIDE = 1024;
export const MAX_REGIONS = 64;
const MAX_NAME = 80;
const MAX_JSON_BYTES = 1 << 20;
const MAX_IMAGE_BYTES = 32 << 20;
const CHUNK = { project: "kpPj", map: "kpMp", image: "kpIm" } as const;

export class ProjectError extends Error {}
const MAP_MISMATCH = "The project's region map doesn't match its image size.";

export interface PaintRef { brand: string; code: string; name: string; hex: string }
export interface Scheme { name: string; paints: (string | null)[] }

export interface ProjectJson {
  format: typeof FORMAT;
  version: number;
  savedAt: string;
  /** `generated` date of the paint database used when saving. */
  paintData?: string;
  image: { name: string; width: number; height: number };
  regions: { name: string; sourceHex: string | null }[];
  active: number;
  /** One paint choice per region per scheme. Only one scheme is used today. */
  schemes: Scheme[];
  activeScheme: number;
  /** What each chosen paint looked like when saved, to detect later database changes. */
  paints: Record<string, PaintRef>;
}

/** The parts of app state a project file captures (structural, so core/ doesn't import the store). */
export interface ProjectState {
  image: { name: string; width: number; height: number; data: Uint8ClampedArray };
  regionMap: Int16Array;
  regions: { name: string; paintId: string | null; sourceHex: string | null }[];
  active: number;
}

export function buildProjectJson(
  st: ProjectState,
  paintsById: Map<string, PaintRef>,
  paintData?: string,
  now = new Date(),
): ProjectJson {
  const paints: Record<string, PaintRef> = {};
  for (const r of st.regions) {
    const p = r.paintId ? paintsById.get(r.paintId) : undefined;
    if (r.paintId && p) paints[r.paintId] = { brand: p.brand, code: p.code, name: p.name, hex: p.hex };
  }
  return {
    format: FORMAT,
    version: VERSION,
    savedAt: now.toISOString(),
    ...(paintData ? { paintData } : {}),
    image: { name: st.image.name, width: st.image.width, height: st.image.height },
    regions: st.regions.map((r) => ({ name: r.name, sourceHex: r.sourceHex })),
    active: st.active,
    schemes: [{ name: "Scheme 1", paints: st.regions.map((r) => r.paintId) }],
    activeScheme: 0,
    paints,
  };
}

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_NAME): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const hex = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
const int = (v: unknown, lo: number, hi: number): number | null =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null;

/** Validate untrusted project JSON. Throws ProjectError with a readable message; drops unknown fields. */
export function sanitizeProject(raw: unknown): ProjectJson {
  if (!isObj(raw) || raw.format !== FORMAT) throw new ProjectError("This file isn't a Kit Paint Planner project.");
  if (typeof raw.version !== "number" || raw.version > VERSION) {
    throw new ProjectError("This project was saved by a newer version of the app. Reload the page to update.");
  }
  const img = isObj(raw.image) ? raw.image : {};
  const width = int(img.width, 1, MAX_SIDE), height = int(img.height, 1, MAX_SIDE);
  if (width === null || height === null) throw new ProjectError("The project's image size is invalid.");

  if (!Array.isArray(raw.regions) || raw.regions.length > MAX_REGIONS) throw new ProjectError("The project's region list is invalid.");
  const regions = raw.regions.map((r, i) => ({
    name: (isObj(r) && str(r.name)) || `Region ${i + 1}`,
    sourceHex: isObj(r) ? hex(r.sourceHex) : null,
  }));
  const n = regions.length;

  const schemesIn = Array.isArray(raw.schemes) ? raw.schemes.slice(0, 32) : [];
  const schemes: Scheme[] = schemesIn.filter(isObj).map((s, i) => ({
    name: str(s.name) || `Scheme ${i + 1}`,
    paints: Array.from({ length: n }, (_, k) => (Array.isArray(s.paints) ? str(s.paints[k], 64) : null)),
  }));
  if (!schemes.length) schemes.push({ name: "Scheme 1", paints: Array(n).fill(null) });

  const paints: Record<string, PaintRef> = {};
  if (isObj(raw.paints)) {
    for (const id of new Set(schemes.flatMap((s) => s.paints))) {
      const p = id ? raw.paints[id] : undefined;
      if (!id || !isObj(p)) continue;
      const h = hex(p.hex), brand = str(p.brand), code = str(p.code, 32), name = str(p.name);
      if (h && brand && code && name !== null) paints[id] = { brand, code, name, hex: h };
    }
  }

  return {
    format: FORMAT,
    version: VERSION,
    savedAt: str(raw.savedAt, 40) ?? "",
    ...(str(raw.paintData, 40) ? { paintData: str(raw.paintData, 40)! } : {}),
    image: { name: str(img.name, 200) || "kit", width, height },
    regions,
    active: int(raw.active, 0, Math.max(0, n - 1)) ?? 0,
    schemes,
    activeScheme: int(raw.activeScheme, 0, schemes.length - 1) ?? 0,
    paints,
  };
}

/** Check a region map against the project: exact size, ids in range (others become unassigned). */
export function sanitizeMap(map: Int16Array, project: ProjectJson): Int16Array {
  const { width, height } = project.image;
  if (map.length !== width * height) throw new ProjectError(MAP_MISMATCH);
  const n = project.regions.length;
  const out = map.slice();
  for (let i = 0; i < out.length; i++) if (out[i] < -1 || out[i] >= n) out[i] = -1;
  return out;
}

export interface ResolvedPaints {
  /** Paint id per region for the active scheme; null where the paint is no longer known. */
  paintIds: (string | null)[];
  /** Things the user should know, e.g. a paint whose color data changed since saving. */
  notices: string[];
}

/** Map the active scheme onto the current paint database and report anything that changed. */
export function resolvePaints(project: ProjectJson, current: Map<string, PaintRef>, tolerance = 2): ResolvedPaints {
  const scheme = project.schemes[project.activeScheme];
  const notices: string[] = [];
  const reported = new Set<string>();
  const paintIds = project.regions.map((region, i) => {
    const id = scheme.paints[i];
    if (!id) return null;
    const saved = project.paints[id];
    const now = current.get(id);
    const label = saved ? `${saved.brand} ${saved.code} ${saved.name}`.trim() : id;
    if (!now) {
      notices.push(`${label} is no longer in the paint list, so "${region.name}" has no paint.`);
      return null;
    }
    if (saved && !reported.has(id)) {
      const dE = deltaE2000(rgbToLab(hexToRgb(saved.hex)), rgbToLab(hexToRgb(now.hex)));
      if (dE > tolerance) notices.push(`${label}: its color data was updated since this project was saved (${saved.hex} → ${now.hex}).`);
      reported.add(id);
    }
    return id;
  });
  return { paintIds, notices };
}

// ---------------------------------------------------------------- binary helpers

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxBytes = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new ProjectError(MAP_MISMATCH); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

export function mapToBytes(map: Int16Array): Uint8Array {
  const out = new Uint8Array(map.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < map.length; i++) view.setInt16(i * 2, map[i], true);
  return out;
}

export function bytesToMap(bytes: Uint8Array): Int16Array {
  if (bytes.length % 2) throw new ProjectError("The project's region map is corrupted.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// ---------------------------------------------------------------- PNG container

export async function encodeProjectPng(args: {
  preview: Uint8Array; // PNG shown by image viewers
  original: Uint8Array; // PNG of the working-resolution photo
  project: ProjectJson;
  regionMap: Int16Array;
}): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(args.project));
  const map = await pipeBytes(mapToBytes(args.regionMap), new CompressionStream("deflate"));
  return withChunks(args.preview, [
    { type: CHUNK.project, data: json },
    { type: CHUNK.map, data: map },
    { type: CHUNK.image, data: args.original },
  ]);
}

export interface DecodedProject { project: ProjectJson; regionMap: Int16Array; original: Uint8Array }

/** Read a project PNG. Returns null for a plain image (not a project); throws ProjectError for a damaged project. */
export async function decodeProjectPng(bytes: Uint8Array): Promise<DecodedProject | null> {
  if (!isPng(bytes)) return null;
  let chunks;
  try {
    chunks = readChunks(bytes);
  } catch (e) {
    throw new ProjectError(`The file is damaged: ${(e as Error).message}.`);
  }
  const get = (type: string) => chunks.find((c) => c.type === type)?.data;
  const jsonBytes = get(CHUNK.project);
  if (!jsonBytes) return null;
  if (jsonBytes.length > MAX_JSON_BYTES) throw new ProjectError("The project data is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new ProjectError("The project data is corrupted.");
  }
  const project = sanitizeProject(raw);
  const mapBytes = get(CHUNK.map), original = get(CHUNK.image);
  if (!mapBytes || !original) throw new ProjectError("The project is missing its photo or regions.");
  if (original.length > MAX_IMAGE_BYTES || !isPng(original)) throw new ProjectError("The project's photo is invalid.");
  const expected = project.image.width * project.image.height * 2;
  let inflated;
  try {
    inflated = await pipeBytes(mapBytes, new DecompressionStream("deflate"), expected);
  } catch (e) {
    throw e instanceof ProjectError ? e : new ProjectError("The project's region map is corrupted.");
  }
  const regionMap = sanitizeMap(bytesToMap(inflated), project);
  return { project, regionMap, original: original.slice() };
}
