import { useEffect, useRef, useState } from "react";
import { KitCanvas } from "./components/KitCanvas";
import { RegionPanel } from "./components/RegionPanel";
import { ResumeCard } from "./components/ResumeCard";
import { Uploader } from "./components/Uploader";
import { startAutosave } from "./project/autosave";
import { saveProjectFile } from "./project/io";
import { getSam } from "./sam/instance";
import { useStore, type Paint } from "./store";
import "./index.css";

export default function App() {
  const image = useStore((s) => s.image);
  const sam = useStore((s) => s.sam);
  const view = useStore((s) => s.view);
  const overlay = useStore((s) => s.overlay);
  const lastPick = useStore((s) => s.lastPick);
  const historyLen = useStore((s) => s.history.length);
  const guard = useStore((s) => s.guard);
  const paintsLoaded = useStore((s) => s.paints.length > 0);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const { setNotices, setPaints, setSam, setView, setOverlay, setGuard, undo, cycleCandidate } = useStore.getState();

  // Paint data + model load (once).
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}paints.json`).then((r) => r.json()).then((d) => setPaints(d.paints as Paint[], d.generated));
    const client = getSam();
    client.onProgress = (l, t) => setSam({ progress: t ? l / t : 0 });
    client.ready().then((device) => setSam({ status: "ready", device }), (e) => setSam({ status: "error", error: String(e) }));
  }, [setPaints, setSam]);

  useEffect(() => startAutosave(), []);

  async function save() {
    if (saving === "saving") return;
    setSaving("saving");
    try {
      await saveProjectFile();
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 2000);
    } catch (e) {
      setSaving("idle");
      setNotices([`Couldn't save the project: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });

  // Embed each new photo.
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    setSam({ status: "embedding" });
    getSam().embed(image.data, image.width, image.height)
      .then(() => !cancelled && setSam({ status: "ready" }))
      .catch((e) => !cancelled && setSam({ status: "error", error: String(e) }));
    return () => { cancelled = true; };
  }, [image, setSam]);

  // Shortcuts: hold Space = before, Ctrl/Cmd+Z = undo, [ / ] = smaller/larger part.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Ctrl/Cmd+S works everywhere (also while editing a region name).
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (useStore.getState().image) saveRef.current(); return; }
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.code === "Space") { e.preventDefault(); setView("before"); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
      else if (e.key === "[") cycleCandidate(-1);
      else if (e.key === "]") cycleCandidate(1);
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setView("after"); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [setView, undo, cycleCandidate]);

  const status =
    sam.status === "loading" ? `Loading part detector… ${sam.progress ? Math.round(sam.progress * 100) + "%" : ""}`
    : sam.status === "embedding" ? "Analyzing photo…"
    : sam.status === "error" ? `Part detector failed: ${sam.error}`
    : `Ready (${sam.device})`;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Kit Paint Planner</h1>
        {image && (
          <div className="tools">
            <button className={`btn ${view === "before" ? "on" : ""}`} onClick={() => setView(view === "before" ? "after" : "before")} title="Hold Space to peek">
              {view === "before" ? "Showing original" : "Showing repaint"}
            </button>
            <button className={`btn ${overlay ? "on" : ""}`} onClick={() => setOverlay(!overlay)}>Outlines</button>
            <button className={`btn ${guard ? "on" : ""}`} onClick={() => setGuard(!guard)}
              title="Trim each selection to the color you clicked, so neighboring parts of another color aren't grabbed">
              Color-aware
            </button>
            <button className="btn" onClick={undo} disabled={!historyLen} title="Ctrl/Cmd+Z">Undo</button>
            {lastPick && (
              <span className="part-size">
                Part size:
                <button className="btn small" onClick={() => cycleCandidate(-1)} title="[">Smaller</button>
                <button className="btn small" onClick={() => cycleCandidate(1)} title="]">Larger</button>
                <span className="hint-inline">Right-click to exclude a spot</span>
              </span>
            )}
            <button className="btn" onClick={save} disabled={saving === "saving"}
              title="Download a .kpp.png: the repainted kit with a paint legend. Drop it back in to keep working. (Ctrl/Cmd+S)">
              {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved ✓" : "Save project"}
            </button>
            <Uploader compact />
          </div>
        )}
        <span className={`status s-${sam.status}`} data-testid="sam-status">{status}</span>
      </header>
      {image ? (
        <main className="workspace">
          <KitCanvas />
          <RegionPanel />
        </main>
      ) : (
        <main className="empty-state">
          {paintsLoaded ? (
            <div className="start">
              <ResumeCard />
              <Uploader />
            </div>
          ) : (
            <span className="hint">Loading paints…</span>
          )}
        </main>
      )}
      <footer className="foot">Paint colors are manufacturers' published swatches, not measurements. Test-spray before committing.</footer>
    </div>
  );
}
