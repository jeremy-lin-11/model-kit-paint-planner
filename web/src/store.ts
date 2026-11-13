import { create } from "zustand";
import { rgbToHex, rgbToLab, labToRgb, type Lab } from "./core/color";
import { groupMap, groupNames, groupParts, GROUP_LEVELS, type PartColor } from "./core/autoParts";
import { chooseCandidate, colorGuard, similarPlastic } from "./core/maskSelect";

export interface Paint {
  id: string;
  brand: string;
  line: string;
  code: string;
  name: string;
  name_ja?: string;
  hex: string;
  lab: Lab;
  finish?: string;
  confidence: "medium" | "low";
  is_color: boolean;
  equivalents?: string[];
  notes?: string[];
}

export interface KitImage {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, working resolution
}

export interface Region {
  name: string;
  paintId: string | null;
  /** Estimated original plastic color (from the brightest-ish pixels), for display and sorting. */
  sourceHex: string | null;
}

export type SamStatus = "loading" | "ready" | "embedding" | "segmenting" | "error";
export type Tool = "select" | "brush" | "erase";

/** Undo step: the region map before a change, plus the region list if the change replaced it. */
export interface HistoryEntry { map: Int16Array; regions?: Region[]; active?: number }

export interface ClickPoint { x: number; y: number; positive: boolean }

/** Last pick, kept so the user can swap candidates or refine it with more points. */
export interface LastPick {
  masks: Uint8Array;
  scores: number[];
  candidate: number;
  region: number;
  /** true = add to region, false = remove from region (Shift+click). */
  add: boolean;
  /** SAM prompt so far: the first click plus any exclude points. */
  points: ClickPoint[];
  before: Int16Array; // region map before this pick
}

/** A project ready to load (from a saved file or the autosave), already validated. */
export interface LoadedProject {
  image: KitImage;
  regionMap: Int16Array;
  regions: { name: string; paintId: string | null }[];
  active: number;
  notices: string[];
}

interface State {
  paints: Paint[];
  /** `generated` date of the paint database, saved into project files. */
  paintsGenerated?: string;
  paintsById: Map<string, Paint>;
  image: KitImage | null;
  regionMap: Int16Array;
  mapVersion: number;
  regions: Region[];
  active: number;
  history: HistoryEntry[];
  lastPick: LastPick | null;
  sam: { status: SamStatus; device?: string; progress?: number; error?: string };
  view: "after" | "before";
  overlay: boolean;
  /** Trim SAM masks to the clicked plastic's hue. */
  guard: boolean;
  /** Messages for the user after loading a project (changed paints) or failing to open a file. */
  notices: string[];
  tool: Tool;
  /** Brush radius in image pixels. */
  brushSize: number;
  /** Every part found in the current photo (segment everything), cached for regrouping. */
  autoParts: { partMap: Int32Array; colors: PartColor[] } | null;
  /** Index into GROUP_LEVELS while the auto grouping can still be adjusted; null after manual edits. */
  autoLevel: number | null;

  setPaints(p: Paint[], generated?: string): void;
  setImage(img: KitImage): void;
  loadProject(p: LoadedProject): void;
  setNotices(n: string[]): void;
  setTool(t: Tool): void;
  setBrushSize(r: number): void;
  setAutoParts(p: State["autoParts"]): void;
  /** Replace the regions with plastic-color groups (keeps paints where a group mostly overlaps an old region). */
  applyAuto(level: number): void;
  beginStroke(x: number, y: number): void;
  /** Paint (or erase) brush dabs along a segment, in image pixels. */
  strokeTo(x0: number, y0: number, x1: number, y1: number): void;
  endStroke(): void;
  setSam(s: Partial<State["sam"]>): void;
  addRegion(name?: string): void;
  removeRegion(i: number): void;
  renameRegion(i: number, name: string): void;
  setActive(i: number): void;
  setPaint(i: number, paintId: string | null): void;
  applyMask(masks: Uint8Array, scores: number[], add: boolean, point: ClickPoint): void;
  refinePick(masks: Uint8Array, scores: number[], points: ClickPoint[]): void;
  cycleCandidate(dir: -1 | 0 | 1): void;
  setGuard(v: boolean): void;
  undo(): void;
  setView(v: State["view"]): void;
  setOverlay(v: boolean): void;
}

const DEFAULT_REGIONS = ["Main armor", "Secondary armor", "Accent", "Frame"];
const MAX_HISTORY = 30;

/** Brush state for the stroke in progress (not part of the store: changes every pointer move). */
let stroke: { ref: Lab | null; erase: boolean } | null = null;

function labAt(img: KitImage, x: number, y: number): Lab {
  // Median over a 5x5 window so one noisy pixel doesn't set the brush color.
  const L: number[] = [], A: number[] = [], B: number[] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.min(img.width - 1, Math.max(0, Math.round(x) + dx)), py = Math.min(img.height - 1, Math.max(0, Math.round(y) + dy));
    const i = (py * img.width + px) * 4;
    const [l, a, b] = rgbToLab([img.data[i], img.data[i + 1], img.data[i + 2]]);
    L.push(l); A.push(a); B.push(b);
  }
  const med = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  return [med(L), med(A), med(B)];
}

/** Region "plastic color": 85th-percentile lightness, median a and b over its pixels. */
function regionSourceHex(img: KitImage, map: Int16Array, region: number): string | null {
  const Ls: number[] = [], as: number[] = [], bs: number[] = [];
  const step = Math.max(1, Math.floor(map.length / 200_000)); // subsample big regions
  for (let i = 0; i < map.length; i += step) {
    if (map[i] !== region) continue;
    const [L, a, b] = rgbToLab([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
    Ls.push(L); as.push(a); bs.push(b);
  }
  if (!Ls.length) return null;
  const q = (arr: number[], f: number) => arr.sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  return rgbToHex(labToRgb([q(Ls, 0.85), q(as, 0.5), q(bs, 0.5)]));
}

function writeMask(base: Int16Array, mask: Uint8Array, region: number, add: boolean): Int16Array {
  const next = base.slice();
  for (let i = 0; i < next.length; i++) {
    if (!mask[i]) continue;
    if (add) next[i] = region;
    else if (next[i] === region) next[i] = -1;
  }
  return next;
}

/** One candidate as a full-image 0/1 mask, trimmed to the clicked plastic if the guard is on. */
function candidateMask(img: KitImage, masks: Uint8Array, k: number, anchor: ClickPoint, guard: boolean): Uint8Array {
  const plane = img.width * img.height;
  return guard
    ? colorGuard(masks, k * plane, img.data, img.width, img.height, anchor.x, anchor.y)
    : masks.slice(k * plane, (k + 1) * plane);
}

export const useStore = create<State>((set, get) => ({
  paints: [],
  paintsById: new Map(),
  image: null,
  regionMap: new Int16Array(0),
  mapVersion: 0,
  regions: [],
  active: 0,
  history: [],
  lastPick: null,
  sam: { status: "loading" },
  view: "after",
  overlay: true,
  guard: true,
  notices: [],
  tool: "select",
  brushSize: 12,
  autoParts: null,
  autoLevel: null,

  setPaints: (paints, paintsGenerated) => set({ paints, paintsGenerated, paintsById: new Map(paints.map((p) => [p.id, p])) }),
  setImage: (image) => set({
    image,
    regionMap: new Int16Array(image.width * image.height).fill(-1),
    mapVersion: get().mapVersion + 1,
    regions: DEFAULT_REGIONS.map((name) => ({ name, paintId: null, sourceHex: null })),
    active: 0,
    history: [],
    lastPick: null,
    view: "after",
    notices: [],
    autoParts: null,
    autoLevel: null,
  }),
  loadProject: (p) => set({
    image: p.image,
    regionMap: p.regionMap,
    mapVersion: get().mapVersion + 1,
    // Recompute plastic colors from the pixels rather than trusting the file.
    regions: p.regions.map((r, k) => ({ ...r, sourceHex: regionSourceHex(p.image, p.regionMap, k) })),
    active: Math.min(p.active, Math.max(0, p.regions.length - 1)),
    history: [],
    lastPick: null,
    view: "after",
    notices: p.notices,
    autoParts: null,
    autoLevel: null,
  }),
  setNotices: (notices) => set({ notices }),
  setTool: (tool) => set({ tool, lastPick: null }),
  setBrushSize: (r) => set({ brushSize: Math.max(1, Math.min(80, Math.round(r))) }),
  setAutoParts: (autoParts) => set({ autoParts }),

  applyAuto: (level) => {
    const st = get();
    const ap = st.autoParts, img = st.image;
    if (!ap || !img) return;
    const lv = Math.max(0, Math.min(GROUP_LEVELS.length - 1, level));
    const { groups, assign } = groupParts(ap.colors, GROUP_LEVELS[lv]);
    const map = groupMap(ap.partMap, assign);
    const names = groupNames(groups);
    // Carry paint choices over from whichever old region covers most of each new group.
    const counts = groups.map(() => new Int32Array(st.regions.length));
    for (let i = 0; i < map.length; i++) {
      const g = map[i], o = st.regionMap[i];
      if (g >= 0 && o >= 0) counts[g][o]++;
    }
    const regions = groups.map((g, gi) => {
      let best = -1, bc = 0;
      counts[gi].forEach((c, o) => { if (c > bc) { bc = c; best = o; } });
      const paintId = best >= 0 && bc > g.size * 0.5 ? st.regions[best].paintId : null;
      return { name: names[gi], paintId, sourceHex: regionSourceHex(img, map, gi) };
    });
    // Adjusting Fewer/More replaces the previous auto result; the undo step stays the pre-auto state.
    const history = st.autoLevel === null
      ? [...st.history, { map: st.regionMap, regions: st.regions, active: st.active }].slice(-MAX_HISTORY)
      : st.history;
    set({ regionMap: map, regions, active: 0, mapVersion: st.mapVersion + 1, history, lastPick: null, autoLevel: lv, overlay: true });
  },

  beginStroke: (x, y) => {
    const st = get();
    if (!st.image || !st.regions.length) return;
    const erase = st.tool === "erase";
    stroke = { ref: st.guard ? labAt(st.image, x, y) : null, erase };
    set({
      history: [...st.history, { map: st.regionMap }].slice(-MAX_HISTORY),
      regionMap: st.regionMap.slice(), // painted in place until the stroke ends
      lastPick: null,
      autoLevel: null,
      overlay: true,
    });
    get().strokeTo(x, y, x, y);
  },
  strokeTo: (x0, y0, x1, y1) => {
    const st = get();
    const img = st.image;
    if (!stroke || !img) return;
    const { width: w, height: h, data } = img;
    const r = st.brushSize, map = st.regionMap, region = st.active;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 3)));
    for (let s = 0; s <= steps; s++) {
      const cx = x0 + ((x1 - x0) * s) / steps, cy = y0 + ((y1 - y0) * s) / steps;
      const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(w - 1, Math.ceil(cx + r));
      const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = y * w + x;
        if (stroke.erase ? map[i] !== region : map[i] === region) continue;
        if (stroke.ref && !similarPlastic(stroke.ref, rgbToLab([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]))) continue;
        map[i] = stroke.erase ? -1 : region;
      }
    }
    set({ mapVersion: st.mapVersion + 1 });
  },
  endStroke: () => {
    const st = get();
    if (!stroke || !st.image) return;
    stroke = null;
    const regions = st.regions.map((r, k) => ({ ...r, sourceHex: regionSourceHex(st.image!, st.regionMap, k) }));
    set({ regions, mapVersion: st.mapVersion + 1 });
  },
  setSam: (s) => set({ sam: { ...get().sam, ...s } }),

  addRegion: (name) => set((st) => ({
    regions: [...st.regions, { name: name ?? `Region ${st.regions.length + 1}`, paintId: null, sourceHex: null }],
    active: st.regions.length,
  })),
  removeRegion: (i) => set((st) => {
    const map = st.regionMap.slice();
    for (let p = 0; p < map.length; p++) {
      if (map[p] === i) map[p] = -1;
      else if (map[p] > i) map[p]--;
    }
    return {
      regions: st.regions.filter((_, k) => k !== i),
      regionMap: map,
      mapVersion: st.mapVersion + 1,
      active: Math.max(0, Math.min(st.active, st.regions.length - 2)),
      // Older map snapshots use the old region numbering, so this step restores the list too.
      history: [...st.history, { map: st.regionMap, regions: st.regions, active: st.active }].slice(-MAX_HISTORY),
      lastPick: null,
      autoLevel: null,
    };
  }),
  renameRegion: (i, name) => set((st) => ({ regions: st.regions.map((r, k) => (k === i ? { ...r, name } : r)) })),
  setActive: (active) => set({ active, lastPick: null }),
  setPaint: (i, paintId) => set((st) => ({ regions: st.regions.map((r, k) => (k === i ? { ...r, paintId } : r)) })),

  applyMask: (masks, scores, add, point) => {
    const st = get();
    if (!st.image || !st.regions.length) return;
    const plane = st.image.width * st.image.height;
    const candidate = chooseCandidate(masks, scores, plane);
    const before = st.regionMap;
    const map = writeMask(before, candidateMask(st.image, masks, candidate, point, st.guard), st.active, add);
    const regions = st.regions.map((r, k) => (k === st.active ? { ...r, sourceHex: regionSourceHex(st.image!, map, k) } : r));
    set({
      regionMap: map,
      mapVersion: st.mapVersion + 1,
      regions,
      history: [...st.history, { map: before }].slice(-MAX_HISTORY),
      lastPick: { masks, scores, candidate, region: st.active, add, points: [point], before },
      autoLevel: null,
      overlay: true, // editing a selection: show what's selected
    });
  },
  refinePick: (masks, scores, points) => {
    const st = get();
    const lp = st.lastPick;
    if (!lp || !st.image) return;
    // With several prompt points SAM's top-scoring mask is the reliable one.
    const candidate = scores.indexOf(Math.max(...scores));
    const map = writeMask(lp.before, candidateMask(st.image, masks, candidate, points[0], st.guard), lp.region, lp.add);
    const regions = st.regions.map((r, k) => (k === lp.region ? { ...r, sourceHex: regionSourceHex(st.image!, map, k) } : r));
    set({ regionMap: map, mapVersion: st.mapVersion + 1, regions, lastPick: { ...lp, masks, scores, candidate, points }, overlay: true });
  },
  cycleCandidate: (dir) => {
    const st = get();
    const lp = st.lastPick;
    if (!lp || !st.image) return;
    const candidate = (lp.candidate + dir + 3) % 3;
    const map = writeMask(lp.before, candidateMask(st.image, lp.masks, candidate, lp.points[0], st.guard), lp.region, lp.add);
    const regions = st.regions.map((r, k) => (k === lp.region ? { ...r, sourceHex: regionSourceHex(st.image!, map, k) } : r));
    set({ regionMap: map, mapVersion: st.mapVersion + 1, regions, lastPick: { ...lp, candidate }, overlay: true });
  },
  setGuard: (guard) => {
    set({ guard });
    const lp = get().lastPick;
    if (lp) get().cycleCandidate(0); // re-apply the last pick with the new setting
  },
  undo: () => {
    const st = get();
    const prev = st.history[st.history.length - 1];
    if (!prev || !st.image) return;
    const base = prev.regions ?? st.regions;
    const regions = base.map((r, k) => ({ ...r, sourceHex: regionSourceHex(st.image!, prev.map, k) }));
    set({
      regionMap: prev.map, mapVersion: st.mapVersion + 1, regions, history: st.history.slice(0, -1), lastPick: null, autoLevel: null,
      active: Math.min(prev.active ?? st.active, Math.max(0, regions.length - 1)),
    });
  },
  setView: (view) => set({ view }),
  setOverlay: (overlay) => set({ overlay }),
}));
