// End-to-end check against the production build, without a dev server (the sandbox blocks listening):
// Playwright serves dist/ by intercepting requests to http://app.test/.
//   npm run build && node scripts/e2e-check.mjs
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const WEB = join(import.meta.dirname, "..");
const ROOT = join(WEB, "..");
const DIST = join(WEB, "dist");
const OUT = join(ROOT, ".cache", "e2e");
mkdirSync(OUT, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };

const IMAGE = join(ROOT, "data", "Test Product Shots", "mg_barbatos_lupus.webp");
// Clicks in image pixels (image is 1000x1000, under the 1024 working size), and paint per region.
const PLAN = [
  { region: 0, clicks: [[600, 580], [470, 400], [380, 560]], paint: "XF-59" },
  { region: 1, clicks: [[500, 240]], paint: "XF-62" },
  { region: 2, clicks: [[640, 190], [420, 170]], paint: "C79" },
  { region: 3, clicks: [[250, 560]], paint: "C8" },
];

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ channel: "chrome", headless: true, proxy });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.context().route("http://app.test/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  const file = join(DIST, path === "/" ? "index.html" : decodeURIComponent(path));
  if (!existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
  route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
});

try {
  const t0 = Date.now();
  await page.goto("http://app.test/");
  await page.locator('[data-testid="file-input"]').setInputFiles(IMAGE);
  await page.waitForFunction(() => document.querySelector('[data-testid="sam-status"]')?.textContent?.startsWith("Ready"),
    null, { timeout: 180_000 });
  console.log(`model + embedding ready in ${Date.now() - t0} ms: ${await page.textContent('[data-testid="sam-status"]')}`);

  const canvas = page.locator("canvas");
  for (const step of PLAN) {
    await page.locator(".regions li").nth(step.region).click({ position: { x: 4, y: 4 } });
    for (const [x, y] of step.clicks) {
      const box = await canvas.boundingBox();
      const size = await canvas.evaluate((c) => [c.width, c.height]);
      await page.mouse.click(box.x + (x / size[0]) * box.width, box.y + (y / size[1]) * box.height);
      await page.waitForFunction(() => !document.querySelector("canvas.busy"), null, { timeout: 30_000 });
    }
    await page.locator(".swatch.paint").nth(step.region).click();
    await page.locator(".modal input").fill(step.paint);
    await page.locator(".paint-row", { hasText: step.paint }).first().click();
  }
  const regionText = await page.locator(".regions li").allInnerTexts();
  console.log("regions:\n  " + regionText.map((t) => t.replace(/\s+/g, " ")).join("\n  "));
  await page.screenshot({ path: join(OUT, "after.png") });
  await page.keyboard.down("o");
  await page.screenshot({ path: join(OUT, "before.png") });
  await page.keyboard.up("o");
  await page.locator("button", { hasText: "Outlines" }).click();
  await canvas.screenshot({ path: join(OUT, "canvas_clean.png") });
  console.log(`screenshots in ${OUT}`);

  // --- Save project, then resume it two ways: autosave after reload, and re-opening the saved file.
  const pixels = () => page.locator("canvas").evaluate((c) => c.toDataURL());
  const regionsNow = async () => (await page.locator(".regions li").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  const wantPixels = await pixels(), wantRegions = await regionsNow();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("button", { hasText: "Save project" }).click()]);
  const saved = join(OUT, download.suggestedFilename());
  await download.saveAs(saved);
  const savedBytes = readFileSync(saved);
  const chunks = [];
  for (let p = 8; p < savedBytes.length;) {
    const len = savedBytes.readUInt32BE(p);
    chunks.push(savedBytes.toString("latin1", p + 4, p + 8));
    p += 12 + len;
  }
  console.log(`saved ${download.suggestedFilename()} (${(savedBytes.length / 1e6).toFixed(2)} MB), chunks: ${chunks.filter((c) => c.startsWith("kp")).join(" ")}`);
  const check = async (label) => {
    await page.locator("button", { hasText: "Outlines" }).click(); // a reload turns outlines back on; turn them off to compare clean pixels
    const same = (await regionsNow()).join("|") === wantRegions.join("|");
    const samePx = (await pixels()) === wantPixels;
    console.log(`${label}: regions ${same ? "match" : "DIFFER"}, pixels ${samePx ? "match" : "DIFFER"}`);
  };

  await page.waitForTimeout(1500); // let the autosave land
  await page.reload();
  await page.locator(".resume button", { hasText: "Resume" }).click();
  await check("autosave resume");

  await page.evaluate(() => indexedDB.deleteDatabase("kit-paint-planner"));
  await page.reload();
  if (await page.locator(".resume").count()) throw new Error("resume card shown after clearing storage");
  await page.locator('[data-testid="file-input"]').setInputFiles(saved);
  await page.waitForSelector(".regions li");
  await check("open saved file");

  // --- Auto regions, brush stroke, zoom.
  await page.waitForFunction(() => document.querySelector('[data-testid="sam-status"]')?.textContent?.startsWith("Ready"), null, { timeout: 120_000 });
  const tAuto = Date.now();
  await page.locator("button", { hasText: "Auto regions" }).click();
  await page.waitForFunction(() => /colors/.test(document.querySelector(".editbar")?.textContent ?? ""), null, { timeout: 300_000 });
  console.log(`auto regions in ${Date.now() - tAuto} ms: ${(await regionsNow()).join(" | ")}`);
  await page.screenshot({ path: join(OUT, "auto.png") });
  await page.locator("button", { hasText: "Fewer" }).click();
  console.log(`fewer: ${(await regionsNow()).length} regions`);
  await page.keyboard.press("b");
  const cb = await page.locator("canvas").boundingBox();
  await page.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.35, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  console.log(`zoom after ctrl+wheel: ${await page.textContent(".zoom-level")}`);
  await page.screenshot({ path: join(OUT, "brush_zoom.png") });
} finally {
  const errs = logs.filter((l) => /error/i.test(l));
  if (errs.length) console.log("browser errors:\n  " + errs.slice(0, 10).join("\n  "));
  await browser.close();
}
