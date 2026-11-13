import { useState } from "react";
import { useStore } from "../store";
import { finishLabel, PaintPicker } from "./PaintPicker";

const FINISH_TIPS: Record<string, string> = {
  "clear-color": "Transparent: spray over a silver or gold base for a candy finish.",
  pearl: "Pearl: shows best over a white or matching base color.",
  metallic: "Metallic: a gloss black base makes it brighter.",
  fluorescent: "Fluorescent: spray over pure white; screens can't show its full glow.",
};

export function RegionPanel() {
  const regions = useStore((s) => s.regions);
  const active = useStore((s) => s.active);
  const paintsById = useStore((s) => s.paintsById);
  const setActive = useStore((s) => s.setActive);
  const addRegion = useStore((s) => s.addRegion);
  const removeRegion = useStore((s) => s.removeRegion);
  const renameRegion = useStore((s) => s.renameRegion);
  const notices = useStore((s) => s.notices);
  const setNotices = useStore((s) => s.setNotices);
  const [picking, setPicking] = useState<number | null>(null);

  const chosen = regions.map((r) => (r.paintId ? paintsById.get(r.paintId) : undefined));

  return (
    <aside className="panel">
      {notices.length > 0 && (
        <div className="notices" role="status">
          <ul>{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>
          <button className="btn ghost small" onClick={() => setNotices([])} aria-label="Dismiss">✕</button>
        </div>
      )}
      <h2>Regions</h2>
      <p className="hint">
        Select a region, then click parts on the photo to add them. <kbd>Shift</kbd>+click removes a part.
        Grabbed too much? <strong>Right-click</strong> (or <kbd>Alt</kbd>+click) the extra bit, or use Smaller.
      </p>
      <ul className="regions">
        {regions.map((r, i) => {
          const paint = chosen[i];
          return (
            <li key={i} className={i === active ? "active" : ""} onClick={() => setActive(i)}>
              <span className="swatch" style={{ background: r.sourceHex ?? "transparent" }} title="Current plastic color" />
              <span className="arrow">→</span>
              <button className="swatch paint" style={{ background: paint?.hex ?? "transparent" }}
                onClick={(e) => { e.stopPropagation(); setPicking(i); }} title="Choose paint" aria-label={`Choose paint for ${r.name}`} />
              <div className="region-text">
                <input value={r.name} onChange={(e) => renameRegion(i, e.target.value)} onClick={(e) => e.stopPropagation()} aria-label="Region name" />
                <button className="link" onClick={(e) => { e.stopPropagation(); setPicking(i); }}>
                  {paint ? `${paint.brand} ${paint.code} ${paint.name}` : r.sourceHex ? "Choose paint…" : "No parts yet"}
                </button>
              </div>
              <button className="btn ghost small" onClick={(e) => { e.stopPropagation(); removeRegion(i); }} aria-label={`Delete ${r.name}`}>✕</button>
            </li>
          );
        })}
      </ul>
      <button className="btn" onClick={() => addRegion()}>+ Add region</button>

      {chosen.some(Boolean) && (
        <section className="shopping">
          <h2>Shopping list</h2>
          <ul>
            {[...new Map(chosen.filter(Boolean).map((p) => [p!.id, p!])).values()].map((p) => (
              <li key={p.id}>
                <span className="swatch" style={{ background: p.hex }} />
                <div>
                  <strong>{p.brand} {p.code}</strong> {p.name} <span className="finish">{finishLabel(p.finish)}</span>
                  {p.finish && FINISH_TIPS[p.finish] && <div className="tip">{FINISH_TIPS[p.finish]}</div>}
                  {p.confidence === "low" && <div className="tip warn">Color data uncertain: {p.notes?.[0]}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {picking !== null && <PaintPicker region={picking} onClose={() => setPicking(null)} />}
    </aside>
  );
}
