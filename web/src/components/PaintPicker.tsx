import { useMemo, useState } from "react";
import { deltaE2000, hexToRgb, rgbToLab } from "../core/color";
import { useStore, type Paint } from "../store";

const BRANDS = ["Mr. Color", "Tamiya", "Gaia"];
const FINISHES = ["gloss", "semi-gloss", "flat", "metallic", "pearl", "clear-color", "fluorescent"];

export function finishLabel(f?: string) {
  return f === "clear-color" ? "candy/clear" : f ?? "finish ?";
}

/** Searchable paint list for one region. */
export function PaintPicker({ region, onClose }: { region: number; onClose: () => void }) {
  const paints = useStore((s) => s.paints);
  const reg = useStore((s) => s.regions[region]);
  const setPaint = useStore((s) => s.setPaint);
  const [q, setQ] = useState("");
  const [brands, setBrands] = useState<Set<string>>(new Set(BRANDS));
  const [finish, setFinish] = useState("");
  const [sort, setSort] = useState<"closest" | "code">(reg?.sourceHex ? "closest" : "code");

  const list = useMemo(() => {
    const ref = reg?.sourceHex ? rgbToLab(hexToRgb(reg.sourceHex)) : null;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = paints.filter((p) =>
      p.is_color && brands.has(p.brand) && (!finish || p.finish === finish) &&
      terms.every((t) => `${p.brand} ${p.code} ${p.name} ${p.name_ja ?? ""} ${p.finish ?? ""}`.toLowerCase().includes(t)));
    if (sort === "closest" && ref) {
      const d = new Map(out.map((p) => [p.id, deltaE2000(ref, p.lab)]));
      out.sort((a, b) => d.get(a.id)! - d.get(b.id)!);
    }
    return out.slice(0, 300);
  }, [paints, brands, finish, q, sort, reg?.sourceHex]);

  const toggleBrand = (b: string) => setBrands((s) => {
    const n = new Set(s);
    if (n.has(b)) n.delete(b); else n.add(b);
    return n;
  });
  const pick = (p: Paint | null) => { setPaint(region, p?.id ?? null); onClose(); };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose paint">
        <header>
          <h3>Paint for “{reg?.name}”</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <input autoFocus placeholder="Search code or name (e.g. C110, XF-1, neutral grey)" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="filters">
          {BRANDS.map((b) => (
            <button key={b} className={`chip ${brands.has(b) ? "on" : ""}`} onClick={() => toggleBrand(b)}>{b}</button>
          ))}
          <select value={finish} onChange={(e) => setFinish(e.target.value)}>
            <option value="">Any finish</option>
            {FINISHES.map((f) => <option key={f} value={f}>{finishLabel(f)}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as "closest" | "code")}>
            <option value="closest" disabled={!reg?.sourceHex}>Closest to current plastic</option>
            <option value="code">By brand / code</option>
          </select>
        </div>
        <ul className="paint-list">
          <li><button className="paint-row" onClick={() => pick(null)}><span className="swatch none" />Keep original plastic</button></li>
          {list.map((p) => (
            <li key={p.id}>
              <button className={`paint-row ${reg?.paintId === p.id ? "selected" : ""}`} onClick={() => pick(p)}>
                <span className="swatch" style={{ background: p.hex }} />
                <span className="paint-code">{p.brand} {p.code}</span>
                <span className="paint-name">{p.name}</span>
                <span className={`finish f-${p.finish ?? "unknown"}`}>{finishLabel(p.finish)}</span>
                {p.confidence === "low" && <span className="warn" title={p.notes?.join("; ")}>color uncertain</span>}
              </button>
            </li>
          ))}
          {!list.length && <li className="empty">No paints match.</li>}
        </ul>
      </div>
    </div>
  );
}
