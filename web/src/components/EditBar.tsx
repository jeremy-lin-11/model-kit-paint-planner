import { useState } from "react";
import { GROUP_LEVELS } from "../core/autoParts";
import { runAutoRegions } from "../sam/autoRegions";
import { useStore, type Tool } from "../store";

const TOOLS: { id: Tool; label: string; key: string; tip: string }[] = [
  { id: "select", label: "Select", key: "V", tip: "Click a part to add it to the region (Shift+click removes, right-click excludes a spot)" },
  { id: "brush", label: "Brush", key: "B", tip: "Paint the selected region by hand" },
  { id: "erase", label: "Erase", key: "E", tip: "Remove pixels from the selected region" },
];

export function EditBar() {
  const tool = useStore((s) => s.tool);
  const brushSize = useStore((s) => s.brushSize);
  const guard = useStore((s) => s.guard);
  const lastPick = useStore((s) => s.lastPick);
  const samStatus = useStore((s) => s.sam.status);
  const autoLevel = useStore((s) => s.autoLevel);
  const regionCount = useStore((s) => s.regions.length);
  const { setTool, setBrushSize, setGuard, cycleCandidate, applyAuto } = useStore.getState();
  const [running, setRunning] = useState(false);

  async function auto() {
    setRunning(true);
    try { await runAutoRegions(); } finally { setRunning(false); }
  }

  return (
    <div className="editbar">
      <div className="seg" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <button key={t.id} className={`btn small ${tool === t.id ? "on" : ""}`} onClick={() => setTool(t.id)} title={`${t.tip} (${t.key})`}
            role="radio" aria-checked={tool === t.id}>
            {t.label}
          </button>
        ))}
      </div>

      {tool === "select" ? (
        lastPick && (
          <span className="group">
            Part size
            <button className="btn small" onClick={() => cycleCandidate(-1)} title="[">Smaller</button>
            <button className="btn small" onClick={() => cycleCandidate(1)} title="]">Larger</button>
          </span>
        )
      ) : (
        <label className="group" title="Brush size ([ and ])">
          Size
          <input type="range" min={1} max={80} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          <span className="num">{brushSize}</span>
        </label>
      )}

      <button className={`btn small ${guard ? "on" : ""}`} onClick={() => setGuard(!guard)}
        title="Selections and brush strokes stay on the plastic color you started on, so neighboring parts of another color aren't grabbed">
        Color-aware
      </button>

      <span className="spacer" />

      {autoLevel !== null && (
        <span className="group" title="Undo restores the regions you had before">
          {regionCount} colors
          <button className="btn small" onClick={() => applyAuto(autoLevel - 1)} disabled={autoLevel <= 0}>Fewer</button>
          <button className="btn small" onClick={() => applyAuto(autoLevel + 1)} disabled={autoLevel >= GROUP_LEVELS.length - 1}>More</button>
        </span>
      )}
      <button className="btn small" onClick={auto} disabled={running || samStatus !== "ready"}
        title="Replace the regions with groups of parts that share a plastic color. Undo goes back.">
        {running ? "Finding parts…" : "Auto regions"}
      </button>
    </div>
  );
}
