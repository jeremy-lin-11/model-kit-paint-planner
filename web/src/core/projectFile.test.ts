import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { crc32, readChunks, withChunks } from "./pngChunks";
import {
  buildProjectJson, decodeProjectPng, encodeProjectPng, ProjectError, resolvePaints,
  sanitizeProject, type PaintRef, type ProjectState,
} from "./projectFile";

const W = 6, H = 4;

async function png(w: number, h: number, rgb: [number, number, number]) {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
}

const paints = new Map<string, PaintRef>([
  ["mrcolor-c1", { brand: "Mr. Color", code: "C1", name: "White", hex: "#ffffff" }],
  ["gaia-004", { brand: "Gaia", code: "004", name: "Ultrablue", hex: "#1d2089" }],
]);

function state(): ProjectState {
  const regionMap = new Int16Array(W * H).fill(-1);
  regionMap.fill(0, 0, 8);
  regionMap.fill(1, 8, 12);
  return {
    image: { name: "barbatos.jpg", width: W, height: H, data: new Uint8ClampedArray(W * H * 4) },
    regionMap,
    regions: [
      { name: "Main armor", paintId: "mrcolor-c1", sourceHex: "#eeeeee" },
      { name: "Accent", paintId: "gaia-004", sourceHex: "#2233aa" },
      { name: "Frame", paintId: null, sourceHex: null },
    ],
    active: 1,
  };
}

async function projectPng(mutate?: (p: ReturnType<typeof buildProjectJson>) => void) {
  const st = state();
  const project = buildProjectJson(st, paints, "2026-11-12");
  mutate?.(project);
  return encodeProjectPng({ preview: await png(10, 12, [200, 0, 0]), original: await png(W, H, [0, 200, 0]), project, regionMap: st.regionMap });
}

describe("pngChunks", () => {
  it("computes the standard CRC-32", () => {
    expect((crc32(new TextEncoder().encode("IEND")) ^ 0xffffffff) >>> 0).toBe(0xae426082);
  });

  it("inserts chunks before IEND and replaces same-type chunks", async () => {
    const base = await png(2, 2, [1, 2, 3]);
    const once = withChunks(base, [{ type: "kpPj", data: new Uint8Array([1]) }]);
    const twice = withChunks(once, [{ type: "kpPj", data: new Uint8Array([2, 3]) }]);
    const types = readChunks(twice).map((c) => c.type);
    expect(types.at(-1)).toBe("IEND");
    expect(types.filter((t) => t === "kpPj")).toHaveLength(1);
    expect(Array.from(readChunks(twice).find((c) => c.type === "kpPj")!.data)).toEqual([2, 3]);
  });

  it("rejects a corrupted chunk", async () => {
    const bytes = withChunks(await png(2, 2, [1, 2, 3]), [{ type: "kpPj", data: new Uint8Array([7, 7, 7]) }]);
    const i = bytes.length - 12 - 4 - 3; // first data byte of kpPj (IEND is the last 12 bytes)
    bytes[i] ^= 0xff;
    expect(() => readChunks(bytes)).toThrow(/corrupted/);
  });
});

describe("project PNG", () => {
  it("round-trips project, region map and original photo", async () => {
    const bytes = await projectPng();
    const decoded = await decodeProjectPng(bytes);
    expect(decoded).not.toBeNull();
    const { project, regionMap, original } = decoded!;
    expect(Array.from(regionMap)).toEqual(Array.from(state().regionMap));
    expect(project.regions.map((r) => r.name)).toEqual(["Main armor", "Accent", "Frame"]);
    expect(project.schemes[0].paints).toEqual(["mrcolor-c1", "gaia-004", null]);
    expect(project.active).toBe(1);
    expect(project.paintData).toBe("2026-11-12");
    const meta = await sharp(Buffer.from(original)).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it("still opens as an ordinary image showing the preview", async () => {
    const meta = await sharp(Buffer.from(await projectPng())).metadata();
    expect([meta.width, meta.height]).toEqual([10, 12]);
  });

  it("returns null for a plain photo", async () => {
    expect(await decodeProjectPng(await png(4, 4, [9, 9, 9]))).toBeNull();
    expect(await decodeProjectPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // JPEG
  });

  it("rejects a region map that doesn't match the image size", async () => {
    const bytes = await projectPng((p) => { p.image.width = 5; });
    await expect(decodeProjectPng(bytes)).rejects.toThrow(/doesn't match/);
  });

  it("rejects files from a newer version and oversized images", async () => {
    await expect(decodeProjectPng(await projectPng((p) => { p.version = 99; }))).rejects.toThrow(/newer version/);
    await expect(decodeProjectPng(await projectPng((p) => { p.image.width = 5000; }))).rejects.toThrow(ProjectError);
  });

  it("turns out-of-range region ids into unassigned pixels", async () => {
    const bytes = await projectPng((p) => { p.regions = p.regions.slice(0, 1); });
    const { regionMap } = (await decodeProjectPng(bytes))!;
    expect(regionMap.slice(8, 12).every((v) => v === -1)).toBe(true);
    expect(regionMap[0]).toBe(0);
  });
});

describe("sanitizeProject", () => {
  it("drops junk and fills defaults", () => {
    const p = sanitizeProject({
      format: "kit-paint-planner", version: 1, image: { width: 10, height: 10, extra: "<script>" },
      regions: [{ name: 42 }, { name: "x".repeat(500), sourceHex: "red" }], active: 7,
      schemes: [{ paints: ["a", 5] }], paints: { a: { brand: "B", code: "1", name: "N", hex: "#ABCDEF" }, zzz: {} },
    });
    expect(p.regions).toEqual([{ name: "Region 1", sourceHex: null }, { name: "x".repeat(80), sourceHex: null }]);
    expect(p.active).toBe(0);
    expect(p.schemes[0].paints).toEqual(["a", null]);
    expect(p.paints).toEqual({ a: { brand: "B", code: "1", name: "N", hex: "#abcdef" } });
    expect(p.image.name).toBe("kit");
  });

  it("rejects non-projects", () => {
    expect(() => sanitizeProject({ hello: 1 })).toThrow(/isn't a Kit Paint Planner project/);
  });
});

describe("resolvePaints", () => {
  it("flags missing paints and changed colors", () => {
    const project = buildProjectJson(state(), paints);
    const current = new Map(paints);
    current.delete("mrcolor-c1");
    current.set("gaia-004", { ...paints.get("gaia-004")!, hex: "#3050c0" });
    const { paintIds, notices } = resolvePaints(project, current);
    expect(paintIds).toEqual([null, "gaia-004", null]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/C1 White is no longer/);
    expect(notices[1]).toMatch(/004 Ultrablue: its color data was updated/);
  });

  it("is quiet when nothing changed", () => {
    expect(resolvePaints(buildProjectJson(state(), paints), paints).notices).toEqual([]);
  });
});
