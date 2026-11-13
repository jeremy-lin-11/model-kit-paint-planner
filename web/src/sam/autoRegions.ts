import { DEFAULT_LEVEL } from "../core/autoParts";
import { useStore } from "../store";
import { getSam } from "./instance";

/** Find every part once per photo (cached), then group them by plastic color. */
export async function runAutoRegions(): Promise<void> {
  const st = useStore.getState();
  if (!st.image || st.sam.status !== "ready") return;
  if (!st.autoParts) {
    const image = st.image;
    st.setSam({ status: "segmenting", progress: 0 });
    try {
      const res = await getSam().parts((done, total) => useStore.getState().setSam({ progress: total ? done / total : 0 }));
      if (useStore.getState().image !== image) return; // another photo was opened meanwhile
      useStore.getState().setAutoParts({ partMap: res.partMap, colors: res.colors });
    } catch (e) {
      useStore.getState().setNotices([`Auto regions failed: ${e instanceof Error ? e.message : String(e)}`]);
      return;
    } finally {
      useStore.getState().setSam({ status: "ready" });
    }
  }
  useStore.getState().applyAuto(DEFAULT_LEVEL);
}
