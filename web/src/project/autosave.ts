// Autosave: keep the open project in IndexedDB so a refresh or closed tab doesn't lose work.
// One record ("current"), written about a second after each change. Typed arrays are stored as-is.
import { useStore } from "../store";
import { currentProjectJson } from "./io";

// Storage name kept from before the rename so existing autosaves still resume.
const DB = "kit-paint-planner";
const STORE = "autosave";
const KEY = "current";
const DELAY_MS = 1000;

export interface AutosaveRecord {
  project: unknown; // ProjectJson when written; validated again on restore
  regionMap: unknown; // Int16Array
  data: unknown; // Uint8ClampedArray, RGBA at working resolution
}

export interface AutosaveSummary { name: string; savedAt: string; record: AutosaveRecord }

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The autosaved project, if any (null when storage is empty or unavailable, e.g. some private modes). */
export async function readAutosave(): Promise<AutosaveSummary | null> {
  try {
    const record = (await tx("readonly", (s) => s.get(KEY))) as AutosaveRecord | undefined;
    if (!record || typeof record.project !== "object" || !record.project) return null;
    const p = record.project as { image?: { name?: unknown }; savedAt?: unknown };
    return { name: String(p.image?.name ?? "kit"), savedAt: String(p.savedAt ?? ""), record };
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try { await tx("readwrite", (s) => s.delete(KEY)); } catch { /* storage unavailable */ }
}

async function writeNow() {
  const { image, regionMap } = useStore.getState();
  const project = currentProjectJson();
  if (!image || !project) return;
  const record: AutosaveRecord = { project, regionMap, data: image.data };
  try { await tx("readwrite", (s) => s.put(record, KEY)); } catch { /* quota or private mode: skip quietly */ }
}

let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  void writeNow();
}

/** Start watching the store. Returns a stop function. */
export function startAutosave(): () => void {
  const unsubscribe = useStore.subscribe((st, prev) => {
    if (!st.image) return;
    if (st.image === prev.image && st.mapVersion === prev.mapVersion && st.regions === prev.regions && st.active === prev.active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void writeNow(); }, DELAY_MS);
  });
  const onHide = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flush);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", flush);
  };
}
