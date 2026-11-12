import { useState } from "react";
import { useStore } from "../store";

const MAX_SIDE = 1024;

/** Decode a file, flatten transparency onto white, and scale to working resolution. */
async function loadImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { name: file.name, width, height, data: ctx.getImageData(0, 0, width, height).data };
}

export function Uploader({ compact = false }: { compact?: boolean }) {
  const setImage = useStore((s) => s.setImage);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      setImage(await loadImage(file));
    } catch {
      setError(`Couldn't read ${file.name}. Try a JPEG, PNG or WebP.`);
    }
  }

  const input = (
    <input type="file" accept="image/*" hidden onChange={(e) => handle(e.target.files?.[0])} data-testid="file-input" />
  );
  if (compact) return <label className="btn">New photo{input}</label>;
  return (
    <label
      className={`dropzone ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
    >
      {input}
      <strong>Drop a photo of your kit here</strong>
      <span>or click to choose a file</span>
      <small>Best results: front-facing, plain background, even lighting. Your photo stays on your device.</small>
      {error && <span className="error">{error}</span>}
    </label>
  );
}
