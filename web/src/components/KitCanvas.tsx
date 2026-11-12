import { useEffect, useMemo, useRef, useState } from "react";
import { useRecolored } from "../hooks/useRecolored";
import { getSam } from "../sam/instance";
import { useStore } from "../store";

const ACTIVE_TINT = [0, 220, 255];

/** The kit photo: shows original or recolored pixels, region overlay, and turns clicks into parts. */
export function KitCanvas() {
  const image = useStore((s) => s.image);
  const regionMap = useStore((s) => s.regionMap);
  const mapVersion = useStore((s) => s.mapVersion);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const overlay = useStore((s) => s.overlay);
  const samStatus = useStore((s) => s.sam.status);
  const applyMask = useStore((s) => s.applyMask);
  const recolored = useRecolored();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Outline pixels: where the region id changes between 4-neighbors.
  const edges = useMemo(() => {
    if (!image) return null;
    const { width: w, height: h } = image;
    const e = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, r = regionMap[i];
      if ((x < w - 1 && regionMap[i + 1] !== r) || (y < h - 1 && regionMap[i + w] !== r)) e[i] = 1;
    }
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, mapVersion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const src = view === "before" || !recolored ? image.data : recolored;
    const out = new Uint8ClampedArray(src);
    if (overlay && edges) {
      for (let i = 0; i < regionMap.length; i++) {
        const p = i * 4;
        if (regionMap[i] === active) {
          for (let c = 0; c < 3; c++) out[p + c] = out[p + c] * 0.65 + ACTIVE_TINT[c] * 0.35;
        }
        if (edges[i] && (regionMap[i] >= 0 || regionMap[i + 1] >= 0)) out.set([255, 255, 255], p);
      }
    }
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")!.putImageData(new ImageData(out, image.width, image.height), 0, 0);
  }, [image, recolored, view, overlay, edges, active, regionMap]);

  async function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!image || busy || samStatus !== "ready") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * image.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * image.height);
    setBusy(true);
    setError(null);
    try {
      const res = await getSam().decode([{ x, y, positive: true }]);
      applyMask(res.masks, res.scores, !e.shiftKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!image) return null;
  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        className={busy || samStatus !== "ready" ? "busy" : ""}
        title="Click a part to add it to the selected region. Shift+click removes it."
      />
      {error && <div className="toast error">{error}</div>}
    </div>
  );
}
