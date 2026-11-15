/*
 * Browser regression test for the ESP32 LINK panel's "device motor" display.
 *
 * Bug: after ESTOP, or after the link dropped, the panel kept showing the
 * last acknowledged motor (for example FORWARD). The display must show "—"
 * while ESTOP is latched or the link is not established, and after a
 * reconnect only a value from the NEW session's first valid ACK.
 *
 * Runs the real page (index.html + js/) in headless Chromium with:
 *   - Chromium's built-in FAKE camera (not a real camera);
 *   - MediaPipe replaced by tests/e2e/fake-vision.mjs (the test places the
 *     person box; this is NOT real person detection);
 *   - the in-page MOCK ESP32 (mock://device). No hardware, no network.
 *
 * Requirements and run command are the same as tests/e2e/phase-c.e2e.mjs:
 *   node --test tests/e2e/esp32-panel.e2e.mjs
 * Without Playwright every test is reported as skipped.
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
const DASH = "—";

let playwright = null;
try {
  playwright = createRequire(import.meta.url)("playwright");
} catch {
  playwright = null;
}
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
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/* ---------- helpers ---------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openApp() {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(/.*/, route => {
    const url = route.request().url();
    if (url.startsWith(baseUrl)) return route.continue();
    if (/@mediapipe\/tasks-vision@[\d.]+\/vision_bundle\.mjs$/.test(url)) {
      return route.fulfill({ contentType: "text/javascript", body: FAKE_VISION });
    }
    return route.abort();
  });
  await page.goto(`${baseUrl}/index.html`);
  await page.click("#startBtn");
  await page.waitForFunction(() => document.getElementById("readyPerson").textContent === "READY", null, { timeout: 20000 });
  return { context, page, errors };
}

const waitText = (page, id, predicate, timeout = 8000) =>
  page.waitForFunction(([i, src]) => new Function("t", `return ${src}`)(document.getElementById(i).textContent),
    [id, predicate], { timeout, polling: 50 });

/* One reading of the panel. */
async function read(page) {
  const detail = await page.locator("#espDetail").innerText();
  return {
    label: await page.locator("#espStatus").innerText(),
    motor: (/device motor: (\S+)/.exec(detail) ?? [])[1] ?? null,
    sending: (/sending: (\S+)/.exec(detail) ?? [])[1] ?? null
  };
}

/* Readings every 50 ms for `ms`. */
async function sample(page, ms) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) { out.push(await read(page)); await sleep(50); }
  return out;
}

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

/* Camera, a tracked centred person, mock connected: ready to ARM. */
async function readyToArm(page) {
  await page.evaluate(() => { window.__persons = [{ originX: 270, originY: 100, width: 100, height: 250 }]; });
  await waitText(page, "trackStatus", "t === 'NOT SELECTED'", 8000);
  await tapCentre(page);
  await waitText(page, "trackStatus", "t === 'TRACKING'", 4000);
  await page.fill("#espUrl", "mock://device");
  await page.click("#espConnectBtn");
  await waitText(page, "espStatus", "t.startsWith('CONNECTED')", 8000);
}

/* ARM / FOLLOW until the panel itself shows FORWARD (a positive control). */
async function armAndWaitForForward(page) {
  await page.click("#espFollowBtn");
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if ((await read(page)).motor === "FORWARD") return;
    await sleep(60);
  }
  assert.fail("the panel never showed FORWARD after ARM / FOLLOW (positive control failed)");
}

/* ---------- tests ---------- */

test("positive control: in normal operation the panel does show the device motor", { skip: SKIP, timeout: 90000 }, async () => {
  const { context, page, errors } = await openApp();
  await readyToArm(page);
  const before = await read(page);
  assert.equal(before.motor, "STOP", "a fresh session shows the value from its first ACK");
  await armAndWaitForForward(page);
  assert.deepEqual(errors, []);
  await context.close();
});

test("ESTOP: the panel shows — immediately and never the last FORWARD; clearing it shows no old value", { skip: SKIP, timeout: 90000 }, async () => {
  const { context, page } = await openApp();
  await readyToArm(page);
  await armAndWaitForForward(page);

  await page.click("#espEstopBtn");
  await waitText(page, "espStatus", "t === 'ESTOP LATCHED'", 3000);
  const latched = await sample(page, 2500);
  assert.ok(latched.length > 20);
  for (const reading of latched) assert.equal(reading.motor, DASH, `ESTOP latched but the panel showed ${reading.motor}`);

  await page.click("#espClearEstopBtn");
  const after = await sample(page, 3000);
  for (const reading of after) {
    assert.notEqual(reading.motor, "FORWARD", "no value from the previous session after CLEAR ESTOP");
  }
  assert.equal(after.at(-1).motor, "STOP", "the new session's own ACK is shown");
  await context.close();
});

test("disconnect and reconnect: — while not connected, no previous-session value, then the new session's ACK", { skip: SKIP, timeout: 90000 }, async () => {
  const { context, page } = await openApp();
  await readyToArm(page);
  await armAndWaitForForward(page);

  await page.click("#espDisconnectBtn");
  await waitText(page, "espStatus", "t === 'DISCONNECTED'", 3000);
  for (const reading of await sample(page, 1500)) assert.equal(reading.motor, DASH, "disconnected");

  await page.click("#espConnectBtn");
  const during = await sample(page, 3000);
  for (const reading of during) {
    assert.notEqual(reading.motor, "FORWARD", "the previous session's FORWARD must never reappear");
    if (!reading.label.startsWith("CONNECTED")) assert.equal(reading.motor, DASH, `not connected (${reading.label}) but showed ${reading.motor}`);
  }
  assert.equal(during.at(-1).motor, "STOP");
  await context.close();
});

test("socket closed by a hidden page: — while paused, no previous value after the page returns", { skip: SKIP, timeout: 90000 }, async () => {
  const { context, page } = await openApp();
  await readyToArm(page);
  await armAndWaitForForward(page);

  await page.evaluate(() => Object.defineProperty(document, "hidden", { value: true, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitText(page, "espStatus", "t.startsWith('PAUSED')", 3000);
  for (const reading of await sample(page, 1500)) assert.equal(reading.motor, DASH, "socket closed");

  await page.evaluate(() => Object.defineProperty(document, "hidden", { value: false, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const back = await sample(page, 3000);
  for (const reading of back) assert.notEqual(reading.motor, "FORWARD", "no value from the previous session");
  assert.equal(back.at(-1).motor, "STOP");
  await context.close();
});
