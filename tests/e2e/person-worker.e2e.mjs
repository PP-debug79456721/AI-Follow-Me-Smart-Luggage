/*
 * Browser test for the person detector in a Web Worker (?worker=1): js/person-worker.js (the REAL worker
 * script), js/person-worker-client.js and the worker path in js/ai-owner.js, in headless Chromium with a
 * fake camera and MediaPipe replaced by tests/e2e/fake-vision.mjs (also inside the worker).
 *
 * It proves the plumbing and the point of the feature: with a heavy detector in a worker the page's main
 * thread keeps ticking. It does NOT prove that the real MediaPipe bundle runs in a worker on a phone.
 *
 *   node --test tests/e2e/person-worker.e2e.mjs
 * Without Playwright every test is skipped.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_VISION = fs.readFileSync(path.join(ROOT, "tests/e2e/fake-vision.mjs"), "utf8");

let playwright = null;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { playwright = null; }
const SKIP = playwright ? false : "Playwright is not installed (see tests/e2e/phase-c.e2e.mjs)";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
let server = null;
let baseUrl = null;
let browser = null;

before(async () => {
  if (!playwright) return;
  server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* workerScript: null = serve the real js/person-worker.js; a string = serve that instead. */
async function openApp({ search = "", workerScript = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const warnings = [];
  page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
  await context.route(/.*/, route => {
    const url = route.request().url();
    if (url === `${baseUrl}/js/person-worker.js` && workerScript !== null) {
      return route.fulfill({ contentType: "text/javascript", body: workerScript });
    }
    if (url.startsWith(baseUrl)) return route.continue();
    if (/@mediapipe\/tasks-vision@[\d.]+\/vision_bundle\.mjs$/.test(url)) {
      return route.fulfill({ contentType: "text/javascript", body: FAKE_VISION });
    }
    return route.abort();
  });
  await page.goto(`${baseUrl}/index.html${search}`);
  await page.click("#startBtn");
  await page.waitForFunction(() => document.getElementById("readyPerson").textContent === "READY", null, { timeout: 30000 });
  return { context, page, errors, warnings };
}

const waitText = (page, id, predicate, timeout = 8000) =>
  page.waitForFunction(([i, src]) => new Function("t", `return ${src}`)(document.getElementById(i).textContent),
    [id, predicate], { timeout, polling: 50 });

async function tapCentre(page) {
  await page.evaluate(() => document.getElementById("aiCanvas").scrollIntoView({ block: "center" }));
  const point = await page.evaluate(([vx, vy]) => {
    const canvas = document.getElementById("aiCanvas");
    const video = document.getElementById("camera");
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
    return { x: r.left + (r.width - video.videoWidth * s) / 2 + vx * s, y: r.top + (r.height - video.videoHeight * s) / 2 + vy * s };
  }, [320, 225]);
  await page.touchscreen.tap(point.x, point.y);
}

/* Longest gap between 20 ms timer ticks over `ms` (a busy main thread shows up as a big gap). */
async function longestTickGap(page, ms) {
  await page.evaluate(() => {
    window.__maxGap = 0;
    let last = performance.now();
    window.__gapTimer = setInterval(() => {
      const now = performance.now();
      window.__maxGap = Math.max(window.__maxGap, now - last);
      last = now;
    }, 20);
  });
  await sleep(ms);
  return page.evaluate(() => { clearInterval(window.__gapTimer); return window.__maxGap; });
}

test("P1 the REAL worker script detects through the worker and the page tracks the person", { skip: SKIP }, async () => {
  const { context, page, errors } = await openApp({ search: "?worker=1" });
  try {
    await waitText(page, "personAIStatus", "t.includes('WORKER') && t.includes('1 PERSON')", 15000);
    const status = await page.locator("#personAIStatus").innerText();
    assert.match(status, /GPU · WORKER/);
    assert.match(status, /LAT \d+ ms/);                                  // capture -> result time is shown
    await waitText(page, "trackStatus", "t === 'NOT SELECTED'", 8000);
    await tapCentre(page);
    await waitText(page, "trackStatus", "t === 'TRACKING'", 6000);      // the worker result reaches the tracker
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("P2 without ?worker=1 nothing runs in a worker (the default stays on the main thread)", { skip: SKIP }, async () => {
  const { context, page } = await openApp({ search: "" });
  try {
    await page.evaluate(() => { window.__persons = [{ originX: 270, originY: 100, width: 100, height: 250 }]; });
    await waitText(page, "personAIStatus", "t.includes('1 PERSON')", 10000);
    const status = await page.locator("#personAIStatus").innerText();
    assert.doesNotMatch(status, /WORKER/);
  } finally { await context.close(); }
});

test("P3 a worker script that cannot start falls back to the main-thread detector", { skip: SKIP }, async () => {
  const { context, page } = await openApp({ search: "?worker=1", workerScript: "throw new Error('worker could not start');" });
  try {
    await page.evaluate(() => { window.__persons = [{ originX: 270, originY: 100, width: 100, height: 250 }]; });
    await waitText(page, "personAIStatus", "t.includes('1 PERSON')", 10000);
    const status = await page.locator("#personAIStatus").innerText();
    assert.doesNotMatch(status, /· WORKER/);
    assert.match(status, /MAIN \(worker unavailable\)/);            // the card says why there is no worker
    assert.equal(await page.locator("#readyPerson").innerText(), "READY");
  } finally { await context.close(); }
});

test("P4 a worker that stops answering is replaced by the main-thread detector while running", { skip: SKIP }, async () => {
  const silentAfterReady = "self.onmessage = e => { if (e.data.type === 'init') self.postMessage({ type: 'ready', delegate: 'FAKE' }); };";
  const { context, page } = await openApp({ search: "?worker=1", workerScript: silentAfterReady });
  try {
    await waitText(page, "personAIStatus", "t.length >= 0", 2000).catch(() => {});
    await page.evaluate(() => { window.__persons = [{ originX: 270, originY: 100, width: 100, height: 250 }]; });
    // detectTimeoutMs is 3 s; then the main-thread detector is created and detects.
    await waitText(page, "personAIStatus", "t.includes('MAIN (worker failed)') && t.includes('1 PERSON')", 20000);
    assert.equal(await page.locator("#readyPerson").innerText(), "READY");
  } finally { await context.close(); }
});

test("P5 a heavy detector blocks the page on the main thread but not in the worker", { skip: SKIP }, async () => {
  const main = await openApp({ search: "" });
  let mainGap;
  try {
    await main.page.evaluate(() => { window.__busyMs = 250; });
    await sleep(1000);
    mainGap = await longestTickGap(main.page, 4000);
  } finally { await main.context.close(); }

  const worker = await openApp({ search: "?worker=1" });
  let workerGap;
  try {
    await waitText(worker.page, "personAIStatus", "t.includes('WORKER')", 15000);
    await sleep(1000);
    workerGap = await longestTickGap(worker.page, 4000);
  } finally { await worker.context.close(); }

  console.log(`longest 20 ms tick gap: main-thread detector ${Math.round(mainGap)} ms, worker detector ${Math.round(workerGap)} ms`);
  assert.ok(mainGap >= 200, `the main-thread detector should block the page (gap ${mainGap})`);
  assert.ok(workerGap < mainGap / 2, `the worker should keep the page responsive (gap ${workerGap} vs ${mainGap})`);
});
