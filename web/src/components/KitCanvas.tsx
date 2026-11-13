import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRecolored } from "../hooks/useRecolored";
import { getSam } from "../sam/instance";
import { useStore } from "../store";

const ACTIVE_TINT = [0, 220, 255];
const PAD = 16;
const MAX_SCREEN_PX = 24; // max zoom: one image pixel = 24 screen pixels

interface View { zoom: number; x: number; y: number }

/**
 * The kit photo: original or recolored pixels plus the region overlay.
 * Select tool: click a part (Shift = remove, right-click/Alt = exclude a spot from the last pick).
 * Brush/Erase: paint the active region by hand. Zoom: pinch / Ctrl+scroll / + - 0. Pan: scroll,
 * Space+drag or middle-drag.
 */
export function KitCanvas() {
  const image = useStore((s) => s.image);
  const regionMap = useStore((s) => s.regionMap);
  const mapVersion = useStore((s) => s.mapVersion);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const overlay = useStore((s) => s.overlay);
  const samStatus = useStore((s) => s.sam.status);
  const tool = useStore((s) => s.tool);
  const brushSize = useStore((s) => s.brushSize);
  const recolored = useRecolored();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ mode: "pan" | "stroke"; sx: number; sy: number; vx: number; vy: number; lx: number; ly: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // Fit scale: image pixels -> screen pixels at zoom 1.
  const fit = image && size.w ? Math.min((size.w - 2 * PAD) / image.width, (size.h - 2 * PAD) / image.height) : 1;
  const scale = fit * vp.zoom;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [image]);

  // True while the view is "fit to window"; any zoom or pan clears it, so resizes don't undo them.
  const fitted = useRef(true);
  const fitView = useCallback(() => {
    if (!image || !size.w) return;
    const f = Math.min((size.w - 2 * PAD) / image.width, (size.h - 2 * PAD) / image.height);
    fitted.current = true;
    setVp({ zoom: 1, x: (size.w - image.width * f) / 2, y: (size.h - image.height * f) / 2 });
  }, [image, size.w, size.h]);
  useLayoutEffect(() => { fitted.current = true; }, [image]);
  useLayoutEffect(() => { if (fitted.current) fitView(); }, [fitView]);
  // Changing the fit scale (resize) while zoomed: keep the same screen scale by compensating zoom.
  const lastFit = useRef(1);
  useLayoutEffect(() => {
    if (!fitted.current && lastFit.current !== fit) setVp((v) => ({ ...v, zoom: (v.zoom * lastFit.current) / fit }));
    lastFit.current = fit;
  }, [fit]);

  /** Zoom by `factor` keeping the screen point (px, py) fixed (wrap coordinates). */
  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    fitted.current = false;
    setVp((v) => {
      const maxZoom = Math.max(1, MAX_SCREEN_PX / fit);
      const zoom = Math.min(maxZoom, Math.max(0.5, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, [fit]);
  const zoomCenter = useCallback((factor: number) => zoomAt(factor, size.w / 2, size.h / 2), [zoomAt, size.w, size.h]);

  // Wheel: pinch or Ctrl/Cmd+scroll zooms, plain scroll pans. Needs a non-passive listener.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top);
      else { fitted.current = false; setVp((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, image]);

  // Keys: hold Space to pan; + / - / 0 zoom.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement).closest("input, select, textarea");
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.code === "Space") { e.preventDefault(); setSpaceDown(true); }
      else if (e.key === "+" || e.key === "=") zoomCenter(1.25);
      else if (e.key === "-" || e.key === "_") zoomCenter(0.8);
      else if (e.key === "0") fitView();
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [zoomCenter, fitView]);

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
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    canvas.getContext("2d")!.putImageData(new ImageData(out, image.width, image.height), 0, 0);
    // regionMap is painted in place during brush strokes, so mapVersion is the change signal.
  }, [image, recolored, view, overlay, edges, active, regionMap, mapVersion]);

  /** Pointer position in image pixels (floats). */
  function toImage(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * image!.width, y: ((clientY - rect.top) / rect.height) * image!.height };
  }

  function moveCursor(clientX: number, clientY: number, show: boolean) {
    const c = cursorRef.current, wrap = wrapRef.current;
    if (!c || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const d = Math.max(4, brushSize * 2 * scale);
    c.style.display = show ? "block" : "none";
    c.style.width = c.style.height = `${d}px`;
    c.style.transform = `translate(${clientX - r.left - d / 2}px, ${clientY - r.top - d / 2}px)`;
  }

  const painting = tool !== "select";

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!image) return;
    const pan = e.button === 1 || (e.button === 0 && spaceDown);
    if (!pan && !(painting && e.button === 0)) return;
    if (!pan && samStatus === "segmenting") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    drag.current = { mode: pan ? "pan" : "stroke", sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y, lx: p.x, ly: p.y, moved: false };
    if (pan) setPanning(true);
    else useStore.getState().beginStroke(p.x, p.y);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (painting) moveCursor(e.clientX, e.clientY, !spaceDown);
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    if (d.mode === "pan") {
      fitted.current = false;
      setVp((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else {
      const p = toImage(e.clientX, e.clientY);
      useStore.getState().strokeTo(d.lx, d.ly, p.x, p.y);
      d.lx = p.x; d.ly = p.y;
    }
  }

  function onPointerUp() {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.mode === "pan") { setPanning(false); suppressClick.current = d.moved; }
    else useStore.getState().endStroke();
  }

  /**
   * Select tool. Left click: select the part under the cursor (Shift = remove it from the region).
   * Right click or Alt+click: exclude this spot from the last pick and re-run SAM with all points.
   */
  async function onSelect(e: React.MouseEvent<HTMLCanvasElement>, exclude: boolean) {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (!image || painting || spaceDown || busy || samStatus !== "ready") return;
    const p = toImage(e.clientX, e.clientY);
    const x = Math.round(p.x), y = Math.round(p.y);
    const { lastPick, applyMask, refinePick } = useStore.getState();
    if (exclude && !lastPick) return;
    setBusy(true);
    setError(null);
    try {
      if (exclude && lastPick) {
        const points = [...lastPick.points, { x, y, positive: false }];
        const res = await getSam().decode(points);
        refinePick(res.masks, res.scores, points);
      } else {
        const point = { x, y, positive: true };
        const res = await getSam().decode([point]);
        applyMask(res.masks, res.scores, !e.shiftKey, point);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!image) return null;
  const cursor = panning ? "grabbing" : spaceDown ? "grab" : painting ? "none" : busy || samStatus !== "ready" ? "progress" : "crosshair";
  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => moveCursor(0, 0, false)}
      onAuxClick={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: image.width * fit,
          height: image.height * fit,
          transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
          imageRendering: scale >= 2 ? "pixelated" : "auto",
        }}
        onClick={(e) => onSelect(e, e.altKey)}
        onContextMenu={(e) => { e.preventDefault(); if (e.button === 2) onSelect(e, true); }}
        title={painting ? undefined : "Click a part to add it to the selected region. Shift+click removes it. Right-click (or Alt+click) excludes a spot from the last pick."}
      />
      <div ref={cursorRef} className={`brush-cursor ${tool === "erase" ? "erase" : ""}`} />
      <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn small" onClick={() => zoomCenter(0.8)} title="Zoom out (-)">−</button>
        <span className="zoom-level">{Math.round(scale * 100)}%</span>
        <button className="btn small" onClick={() => zoomCenter(1.25)} title="Zoom in (+)">+</button>
        <button className="btn small" onClick={fitView} title="Fit to window (0)">Fit</button>
      </div>
      {samStatus === "error" && <div className="toast error">Part detector unavailable: the brush still works.</div>}
      {error && <div className="toast error">{error}</div>}
    </div>
  );
}
