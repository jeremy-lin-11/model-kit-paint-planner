import { create } from "zustand";
import { rgbToHex, rgbToLab, labToRgb, type Lab } from "./core/color";

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

export type SamStatus = "loading" | "ready" | "embedding" | "error";

/** Last click, kept so the user can swap in a smaller/larger candidate mask. */
export interface LastPick {
  masks: Uint8Array;
  scores: number[];
  candidate: number;
  region: number;
  positive: boolean;
  before: Int16Array; // region map before this pick
}

interface State {
  paints: Paint[];
  paintsById: Map<string, Paint>;
  image: KitImage | null;
  regionMap: Int16Array;
  mapVersion: number;
  regions: Region[];
  active: number;
  history: Int16Array[];
  lastPick: LastPick | null;
  sam: { status: SamStatus; device?: string; progress?: number; error?: string };
  view: "after" | "before";
  overlay: boolean;

  setPaints(p: Paint[]): void;
  setImage(img: KitImage): void;
  setSam(s: Partial<State["sam"]>): void;
  addRegion(name?: string): void;
  removeRegion(i: number): void;
  renameRegion(i: number, name: string): void;
  setActive(i: number): void;
  setPaint(i: number, paintId: string | null): void;
  applyMask(masks: Uint8Array, scores: number[], positive: boolean): void;
  cycleCandidate(dir: 1 | -1): void;
  undo(): void;
  setView(v: State["view"]): void;
  setOverlay(v: boolean): void;
}

const DEFAULT_REGIONS = ["Main armor", "Secondary armor", "Accent", "Frame"];
const MAX_HISTORY = 30;

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

function writeMask(base: Int16Array, mask: Uint8Array, offset: number, region: number, positive: boolean): Int16Array {
  const next = base.slice();
  for (let i = 0; i < next.length; i++) {
    if (!mask[offset + i]) continue;
    if (positive) next[i] = region;
    else if (next[i] === region) next[i] = -1;
  }
  return next;
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

  setPaints: (paints) => set({ paints, paintsById: new Map(paints.map((p) => [p.id, p])) }),
  setImage: (image) => set({
    image,
    regionMap: new Int16Array(image.width * image.height).fill(-1),
    mapVersion: get().mapVersion + 1,
    regions: DEFAULT_REGIONS.map((name) => ({ name, paintId: null, sourceHex: null })),
    active: 0,
    history: [],
    lastPick: null,
    view: "after",
  }),
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
      history: [], // older snapshots use the old region numbering
      lastPick: null,
    };
  }),
  renameRegion: (i, name) => set((st) => ({ regions: st.regions.map((r, k) => (k === i ? { ...r, name } : r)) })),
  setActive: (active) => set({ active, lastPick: null }),
  setPaint: (i, paintId) => set((st) => ({ regions: st.regions.map((r, k) => (k === i ? { ...r, paintId } : r)) })),

  applyMask: (masks, scores, positive) => {
    const st = get();
    if (!st.image || !st.regions.length) return;
    const plane = st.image.width * st.image.height;
    const candidate = scores.indexOf(Math.max(...scores));
    const before = st.regionMap;
    const map = writeMask(before, masks, candidate * plane, st.active, positive);
    const regions = st.regions.map((r, k) => (k === st.active ? { ...r, sourceHex: regionSourceHex(st.image!, map, k) } : r));
    set({
      regionMap: map,
      mapVersion: st.mapVersion + 1,
      regions,
      history: [...st.history, before].slice(-MAX_HISTORY),
      lastPick: { masks, scores, candidate, region: st.active, positive, before },
    });
  },
  cycleCandidate: (dir) => {
    const st = get();
    const lp = st.lastPick;
    if (!lp || !st.image) return;
    const plane = st.image.width * st.image.height;
    const candidate = (lp.candidate + dir + 3) % 3;
    const map = writeMask(lp.before, lp.masks, candidate * plane, lp.region, lp.positive);
    const regions = st.regions.map((r, k) => (k === lp.region ? { ...r, sourceHex: regionSourceHex(st.image!, map, k) } : r));
    set({ regionMap: map, mapVersion: st.mapVersion + 1, regions, lastPick: { ...lp, candidate } });
  },
  undo: () => {
    const st = get();
    const prev = st.history[st.history.length - 1];
    if (!prev || !st.image) return;
    const regions = st.regions.map((r, k) => ({ ...r, sourceHex: regionSourceHex(st.image!, prev, k) }));
    set({ regionMap: prev, mapVersion: st.mapVersion + 1, regions, history: st.history.slice(0, -1), lastPick: null });
  },
  setView: (view) => set({ view }),
  setOverlay: (overlay) => set({ overlay }),
}));
