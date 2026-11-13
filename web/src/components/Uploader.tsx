import { useState } from "react";
import { hasUnsavedWork, openFile } from "../project/io";
import { useStore } from "../store";

const CONFIRM_REPLACE =
  "Open this file? It replaces the current project, which hasn't been saved to a file. (Use Save project first to keep it.)";

export function Uploader({ compact = false }: { compact?: boolean }) {
  const setNotices = useStore((s) => s.setNotices);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(file: File | undefined) {
    if (!file || busy) return;
    if (hasUnsavedWork() && !window.confirm(CONFIRM_REPLACE)) return;
    setError(null);
    setBusy(true);
    try {
      await openFile(file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (compact) setNotices([msg]); else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const input = (
    <input type="file" accept="image/*,.kpp.png" hidden data-testid="file-input"
      onChange={(e) => { handle(e.target.files?.[0]); e.target.value = ""; }} />
  );
  if (compact) {
    return <label className="btn" title="Open a new kit photo, or a saved .kpp.png project">{busy ? "Opening…" : "Open…"}{input}</label>;
  }
  return (
    <label
      className={`dropzone ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
    >
      {input}
      <strong>{busy ? "Opening…" : "Drop a photo of your kit here"}</strong>
      <span>or click to choose a file. A saved <code>.kpp.png</code> project picks up where you left off.</span>
      <small>Best results: front-facing, plain background, even lighting. Your photo stays on your device.</small>
      {error && <span className="error">{error}</span>}
    </label>
  );
}
