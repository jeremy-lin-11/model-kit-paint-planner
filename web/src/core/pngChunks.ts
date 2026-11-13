// Minimal PNG chunk reader/writer: enough to carry project data inside a normal PNG.
// Viewers ignore unknown ancillary chunks, so the file still opens as an image everywhere.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export interface Chunk { type: string; data: Uint8Array }

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** All chunks in file order. Throws on a malformed file or a bad checksum. */
export function readChunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let p = 8;
  while (p < bytes.length) {
    if (p + 12 > bytes.length) throw new Error("PNG is truncated");
    const len = view.getUint32(p);
    if (p + 12 + len > bytes.length) throw new Error("PNG is truncated");
    const typeBytes = bytes.subarray(p + 4, p + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(p + 8, p + 8 + len);
    const expected = view.getUint32(p + 8 + len);
    if (((crc32(data, crc32(typeBytes)) ^ 0xffffffff) >>> 0) !== expected) throw new Error(`PNG chunk ${type} is corrupted`);
    chunks.push({ type, data });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

function encodeChunk(c: Chunk): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(c.type)) throw new Error(`Bad chunk type ${c.type}`);
  const out = new Uint8Array(12 + c.data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, c.data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = c.type.charCodeAt(i);
  out.set(c.data, 8);
  view.setUint32(8 + c.data.length, (crc32(out.subarray(4, 8 + c.data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Copy of `png` with `extra` chunks inserted just before IEND (existing chunks of those types are dropped). */
export function withChunks(png: Uint8Array, extra: Chunk[]): Uint8Array {
  const replace = new Set(extra.map((c) => c.type));
  const chunks = readChunks(png).filter((c) => !replace.has(c.type));
  const iend = chunks.findIndex((c) => c.type === "IEND");
  if (iend < 0) throw new Error("PNG has no IEND chunk");
  chunks.splice(iend, 0, ...extra);
  const parts = chunks.map(encodeChunk);
  const out = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0));
  out.set(SIGNATURE, 0);
  let p = 8;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
