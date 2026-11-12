// Slim data/paints.json down to what the browser needs: web/public/paints.json.
//   node scripts/build-paints.mjs   (runs automatically before dev/build)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const src = JSON.parse(readFileSync(join(root, "data", "paints.json"), "utf8"));
const keep = ["id", "brand", "line", "code", "name", "name_ja", "hex", "lab", "finish", "confidence", "equivalents", "samples", "notes"];
const paints = src.paints.map((p) => {
  const out = Object.fromEntries(keep.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  out.is_color = p.is_color !== false;
  return out;
});
const out = { generated: src.generated, disclaimer: src.disclaimer, sources: src.sources, paints };
const path = join(import.meta.dirname, "..", "public", "paints.json");
writeFileSync(path, JSON.stringify(out));
console.log(`paints.json: ${paints.length} paints -> ${path}`);
