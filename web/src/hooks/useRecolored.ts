import { useMemo } from "react";
import { computeRegionStats, recolor } from "../core/recolor";
import { useStore } from "../store";

/** Recolored RGBA for the current image/regions/paints (recomputed only when those change). */
export function useRecolored(): Uint8ClampedArray | null {
  const image = useStore((s) => s.image);
  const regionMap = useStore((s) => s.regionMap);
  const mapVersion = useStore((s) => s.mapVersion);
  const regions = useStore((s) => s.regions);
  const paintsById = useStore((s) => s.paintsById);

  const stats = useMemo(
    () => (image ? computeRegionStats(image.data, regionMap, regions.length) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [image, mapVersion, regions.length],
  );
  const targetsKey = regions.map((r) => r.paintId ?? "").join("|");
  return useMemo(() => {
    if (!image) return null;
    const targets = regions.map((r) => (r.paintId ? paintsById.get(r.paintId)?.hex ?? null : null));
    return recolor(image.data, regionMap, stats, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, stats, targetsKey, paintsById]);
}
