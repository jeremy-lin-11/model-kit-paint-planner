import { useEffect, useState } from "react";
import { clearAutosave, readAutosave, type AutosaveSummary } from "../project/autosave";
import { restoreAutosave } from "../project/io";

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

/** On the start screen: offer to pick up the autosaved project. */
export function ResumeCard() {
  const [saved, setSaved] = useState<AutosaveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { readAutosave().then(setSaved); }, []);
  if (!saved) return null;

  function resume() {
    try {
      restoreAutosave(saved!.record);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="resume">
      <div>
        <strong>Continue where you left off?</strong>
        <span>{saved.name}{saved.savedAt && ` · ${ago(saved.savedAt)}`}</span>
        {error && <span className="error">{error}</span>}
      </div>
      <button className="btn on" onClick={resume}>Resume</button>
      <button className="btn ghost" onClick={() => { if (window.confirm("Discard the autosaved project? This can't be undone.")) { clearAutosave(); setSaved(null); } }} title="Forget the autosaved project">Discard</button>
    </div>
  );
}
