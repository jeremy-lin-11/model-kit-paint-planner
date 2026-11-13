import { beforeEach, describe, expect, it } from "vitest";
import { hexToRgb, rgbToLab } from "./core/color";
import { useStore } from "./store";

const W = 20, H = 10;

/** Left half white plastic, right half red plastic. */
function photo() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    data.set([...hexToRgb(x < 10 ? "#f0f0f0" : "#d02020"), 255], (y * W + x) * 4);
  }
  return { name: "t.png", width: W, height: H, data };
}
const count = (v: number) => useStore.getState().regionMap.filter((r) => r === v).length;

beforeEach(() => {
  useStore.getState().setImage(photo());
  useStore.setState({ guard: false, tool: "brush", brushSize: 2, overlay: false });
});

describe("brush and eraser", () => {
  it("paints the active region along a stroke, erases it, and undoes", () => {
    const st = useStore.getState();
    st.beginStroke(2, 5);
    st.strokeTo(2, 5, 16, 5);
    st.endStroke();
    expect(count(0)).toBeGreaterThan(30);
    expect(useStore.getState().overlay).toBe(true); // editing turns outlines back on
    expect(useStore.getState().regions[0].sourceHex).not.toBeNull();

    useStore.setState({ tool: "erase" });
    st.beginStroke(16, 5);
    st.strokeTo(16, 5, 12, 5);
    st.endStroke();
    const afterErase = count(0);
    expect(afterErase).toBeLessThan(useStore.getState().history.at(-1)!.map.filter((r) => r === 0).length);

    st.undo(); // eraser stroke
    st.undo(); // brush stroke
    expect(count(0)).toBe(0);
  });

  it("color-aware brush stays on the plastic the stroke started on", () => {
    useStore.setState({ guard: true, brushSize: 30 });
    const st = useStore.getState();
    st.beginStroke(3, 5); // on white
    st.strokeTo(3, 5, 17, 5);
    st.endStroke();
    const map = useStore.getState().regionMap;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) expect(map[y * W + x]).toBe(x < 10 ? 0 : -1);
  });
});

describe("auto regions", () => {
  it("replaces regions with named color groups, keeps paints by overlap, and undoes in one step", () => {
    const st = useStore.getState();
    // Pretend the user already painted the red half with a paint in region 1.
    useStore.setState({ active: 1 });
    st.beginStroke(15, 5);
    useStore.setState({ brushSize: 30 });
    st.strokeTo(15, 5, 15, 5);
    st.endStroke();
    st.setPaint(1, "mrcolor-c3");
    useStore.setState({ overlay: false });

    const partMap = new Int32Array(W * H);
    for (let i = 0; i < partMap.length; i++) partMap[i] = i % W < 10 ? 0 : 1;
    st.setAutoParts({
      partMap,
      colors: [{ lab: rgbToLab(hexToRgb("#f0f0f0")), size: 100 }, { lab: rgbToLab(hexToRgb("#d02020")), size: 100 }],
    });
    st.applyAuto(2);
    const s1 = useStore.getState();
    expect(s1.regions.map((r) => r.name).sort()).toEqual(["Red", "White"]);
    expect(s1.regions.find((r) => r.name === "Red")!.paintId).toBe("mrcolor-c3");
    expect(s1.autoLevel).toBe(2);
    expect(s1.overlay).toBe(true);

    st.applyAuto(0); // Fewer: regroup without adding another undo step
    expect(useStore.getState().history.length).toBe(s1.history.length);

    st.undo();
    const s2 = useStore.getState();
    expect(s2.regions.map((r) => r.name)).toEqual(["Main armor", "Secondary armor", "Accent", "Frame"]);
    expect(s2.autoLevel).toBeNull();
  });
});
