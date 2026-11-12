/*
 * Phase C browser test: tap-to-select person tracking.
 *
 * Runs the real page (index.html + js/) in headless Chromium with:
 *   - MediaPipe replaced by tests/e2e/fake-vision.mjs (person / face boxes
 *     are set by the test), so no CDN, no model files, no network;
 *   - a fake camera that plays a small Y4M video generated at run time in
 *     a temp folder (textured "room", or dark "covered lens");
 *   - every request outside the local test server aborted and recorded.
 *
 * It checks the app's own logic and UI. It does NOT check detection
 * quality (the detector is fake) or real phone browsers.
 *
 * Requirements: Node 18+ and Playwright with Chromium
 *   npm install --no-save playwright && npx playwright install chromium
 * Run from the repository root:
 *   node --test tests/e2e/phase-c.e2e.mjs
 * If Playwright is installed globally instead:
 *   NODE_PATH="$(npm root -g)" node --test tests/e2e/phase-c.e2e.mjs
 * Without Playwright every test is reported as skipped.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_VISION = fs.readFileSync(
  path.join(ROOT, "tests/e2e/fake-vision.mjs"), "utf8"
);

const UNVERIFIED = "ยังไม่ยืนยันตัวตน";
const VIDEO_W = 320;
const VIDEO_H = 240;
const ORANGE = [255, 176, 32];   // selected box colour in ai-owner.js

let playwright = null;
try {
  // createRequire honours NODE_PATH (ESM import does not).
  playwright = createRequire(import.meta.url)("playwright");
} catch {
  playwright = null;
}

const SKIP = playwright ? false : "Playwright is not installed (see file header)";

// --------------------------------------------------
// Test fixtures: static server, Y4M videos, browsers
// --------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json"
};

function startServer() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/*
 * Writes a 320x240, 10 fps, 2 s Y4M (YUV 4:2:0).
 * "room": 8x8 blocks of deterministic pseudo-random grey (has detail).
 * "dark": almost black with slight noise (a covered lens).
 */
function writeY4m(file, kind) {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ySize = VIDEO_W * VIDEO_H;
  const cSize = ySize / 4;
  const chunks = [Buffer.from(`YUV4MPEG2 W${VIDEO_W} H${VIDEO_H} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let frame = 0; frame < 20; frame++) {
    const y = Buffer.alloc(ySize);
    for (let row = 0; row < VIDEO_H; row++) {
      for (let col = 0; col < VIDEO_W; col++) {
        y[row * VIDEO_W + col] = kind === "dark"
          ? 8 + Math.floor(rand() * 6)
          : 0;
      }
    }
    if (kind !== "dark") {
      for (let by = 0; by < VIDEO_H; by += 8) {
        for (let bx = 0; bx < VIDEO_W; bx += 8) {
          const value = 40 + Math.floor(rand() * 170);
          for (let dy = 0; dy < 8; dy++) y.fill(value, (by + dy) * VIDEO_W + bx, (by + dy) * VIDEO_W + bx + 8);
        }
      }
    }
    chunks.push(Buffer.from("FRAME\n"), y, Buffer.alloc(cSize, 128), Buffer.alloc(cSize, 128));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

let server;
let baseUrl;
let tempDir;
const browsers = {};

before(async () => {
  if (SKIP) return;
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-c-e2e-"));
  for (const kind of ["room", "dark"]) {
    const video = path.join(tempDir, `${kind}.y4m`);
    writeY4m(video, kind);
    browsers[kind] = await playwright.chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${video}`
      ]
    });
  }
});

after(async () => {
  for (const browser of Object.values(browsers)) await browser.close();
  server?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// --------------------------------------------------
// Page helpers
// --------------------------------------------------

/* Opens the app on a phone-sized touch screen and starts the camera. */
async function openApp(kind = "room") {
  const context = await browsers[kind].newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true
  });
  const page = await context.newPage();

  const external = [];      // every request that left the test server
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  // Record every label drawn on the overlay canvas.
  await page.addInitScript(() => {
    window.__labels = new Set();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (this.canvas?.id === "aiCanvas") window.__labels.add(String(text));
      return fillText.call(this, text, ...rest);
    };
  });

  await page.route(/.*/, route => {
    const url = route.request().url();
    if (url.startsWith(baseUrl)) return route.continue();
    if (/@mediapipe\/tasks-vision@[\d.]+\/vision_bundle\.mjs$/.test(url)) {
      return route.fulfill({ contentType: "text/javascript", body: FAKE_VISION });
    }
    external.push(url);
    return route.abort();
  });

  await page.goto(`${baseUrl}/index.html`);
  await page.click("#startBtn");
  await page.waitForFunction(
    () => document.getElementById("readyPerson").textContent === "READY" &&
      document.getElementById("trackStatus").textContent !== "STOPPED",
    null, { timeout: 15000 }
  );

  return { context, page, external, errors };
}

const setPersons = (page, boxes) =>
  page.evaluate(list => { window.__persons = list; }, boxes);

const box = (x, y = 40, w = 80, h = 160) =>
  ({ originX: x, originY: y, width: w, height: h });

const snapshot = page => page.evaluate(() => ({
  status: document.getElementById("trackStatus").textContent,
  message: document.getElementById("trackMessage").textContent
}));

async function waitStatus(page, status, timeout = 6000) {
  await page.waitForFunction(
    s => document.getElementById("trackStatus").textContent === s,
    status, { timeout, polling: 50 }
  );
}

/* Taps a point given in VIDEO pixels (the video is letterboxed). */
async function tapVideo(page, x, y) {
  await page.evaluate(() => document.getElementById("aiCanvas").scrollIntoView({ block: "center" }));
  const point = await page.evaluate(([vx, vy]) => {
    const canvas = document.getElementById("aiCanvas");
    const video = document.getElementById("camera");
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
    return {
      x: r.left + (r.width - video.videoWidth * s) / 2 + vx * s,
      y: r.top + (r.height - video.videoHeight * s) / 2 + vy * s
    };
  }, [x, y]);
  await page.touchscreen.tap(point.x, point.y);
}

/* Selects the person in `b` and waits for TRACKING. */
async function selectPerson(page, b) {
  await waitStatus(page, "NOT SELECTED");
  await tapVideo(page, b.originX + b.width / 2, b.originY + b.height / 2);
  await waitStatus(page, "TRACKING", 2000);
}

/* Removes all persons; returns ms until SEARCHING and until LOST. */
async function removeAndTime(page) {
  const t0 = Date.now();
  await setPersons(page, []);
  await waitStatus(page, "SEARCHING", 2000);
  const searching = Date.now() - t0;
  await waitStatus(page, "LOST", 6000);
  return { searching, lost: Date.now() - t0 };
}

const personLabels = page => page.evaluate(() =>
  [...window.__labels].filter(t => /^(PERSON|ติดตาม|กำลังค้นหา)/.test(t)));

/*
 * Reads SmartLuggageOwnerDB without creating it. Returns null when the
 * database does not exist, else { stores, <store>: count, faceSamples }.
 */
const readOwnerDb = page => page.evaluate(() => new Promise(resolve => {
  let created = false;
  const request = indexedDB.open("SmartLuggageOwnerDB");
  request.onupgradeneeded = () => { created = true; request.transaction.abort(); };
  request.onerror = event => { event.preventDefault(); resolve(created ? null : "error"); };
  request.onsuccess = () => {
    const db = request.result;
    const names = [...db.objectStoreNames];
    const out = { stores: names };
    if (!names.length) { db.close(); resolve(out); return; }
    const tx = db.transaction(names);
    let left = names.length;
    for (const name of names) {
      tx.objectStore(name).getAll().onsuccess = event => {
        out[name] = event.target.result.length;
        if (name === "samples") out.faceSamples = event.target.result.filter(item => item.mode === "face").length;
        if (--left === 0) { db.close(); resolve(out); }
      };
    }
  };
}));

/* Writes data the way the Phase A+B version did (DB version 2). */
const seedPhaseABData = page => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open("SmartLuggageOwnerDB", 2);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
    request.result.createObjectStore("embeddings", { keyPath: "id", autoIncrement: true });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(["samples", "embeddings"], "readwrite");
    const blob = new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" });
    const sample = mode => ({ ownerName: "old", mode, blob, width: 640, height: 480, createdAt: "2026-11-01T00:00:00Z" });
    tx.objectStore("samples").add(sample("face"));
    tx.objectStore("samples").add(sample("face"));
    tx.objectStore("samples").add(sample("reid"));
    tx.objectStore("embeddings").add({ mode: "face", ownerName: "old", vector: [0.1, 0.2] });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}));

const legacyPanel = page => page.evaluate(() => ({
  face: document.getElementById("legacyFaceCount").textContent,
  reid: document.getElementById("legacyReidCount").textContent,
  embeddings: document.getElementById("legacyEmbeddingCount").textContent,
  message: document.getElementById("legacyDataMessage").textContent.trim(),
  deleteDisabled: document.getElementById("legacyDeleteBtn").disabled
}));

const RECOGNITION_URL = /onnxruntime|\.onnx(\?|$)|manifest\.json|owner-embedding|face-embedding|reid-embedding/i;

// --------------------------------------------------
// Tests
// --------------------------------------------------

test("tap selects a moving person: orange box, '#1', always unverified", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page, errors } = await openApp();
  // Walk right 4 px every 100 ms.
  await page.evaluate(() => {
    window.__persons = [{ originX: 60, originY: 40, width: 80, height: 160 }];
    window.__walk = setInterval(() => { window.__persons[0].originX += 4; }, 100);
  });
  await waitStatus(page, "NOT SELECTED");
  const now = await page.evaluate(() => window.__persons[0]);
  await tapVideo(page, now.originX + now.width / 2, now.originY + now.height / 2);
  await waitStatus(page, "TRACKING", 2000);

  const { message } = await snapshot(page);
  assert.match(message, /#1/);
  assert.match(message, new RegExp(UNVERIFIED));

  await page.waitForTimeout(600);
  const hasOrange = await page.evaluate(([r, g, b]) => {
    const canvas = document.getElementById("aiCanvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) < 6 && Math.abs(data[i + 1] - g) < 6 && Math.abs(data[i + 2] - b) < 6) return true;
    }
    return false;
  }, ORANGE);
  assert.equal(hasOrange, true, "selected box should be drawn in orange");

  const labels = await personLabels(page);
  assert.ok(labels.some(t => t.startsWith("ติดตาม #1")), JSON.stringify(labels));
  for (const label of labels) assert.ok(label.includes(UNVERIFIED), `label without "${UNVERIFIED}": ${label}`);
  assert.equal(await page.textContent("#ownerStatus"), UNVERIFIED);
  assert.deepEqual(errors, []);
  await context.close();
});

test("person vanishes mid-frame: SEARCHING, then LOST about 2.5 s later, NOT_FOUND text", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page } = await openApp();
  // Touches the bottom edge like a person close to a luggage-height camera;
  // that must not be reported as "left the frame".
  const b = box(120, 60, 80, VIDEO_H - 60);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  const timing = await removeAndTime(page);
  // The last sighting can be up to one detection interval (500 ms) before
  // the removal, and polling adds a little, so allow 1.8 - 3.5 s.
  assert.ok(timing.searching < timing.lost);
  assert.ok(timing.lost >= 1800 && timing.lost <= 3500, JSON.stringify(timing));
  assert.match((await snapshot(page)).message, /^ไม่พบกรอบที่เลือก/);
  await context.close();
});

test("person walks out the left edge: OUT_OF_FRAME text", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page } = await openApp();
  const b = box(60);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  for (const x of [40, 20, 4]) {           // moving left into the edge
    await setPersons(page, [box(x)]);
    await page.waitForTimeout(600);
  }
  assert.equal((await snapshot(page)).status, "TRACKING");
  await removeAndTime(page);
  assert.match((await snapshot(page)).message, /ขอบซ้ายหรือขวา/);
  await context.close();
});

test("covered (dark) camera: CAMERA_BLOCKED text", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page } = await openApp("dark");
  const b = box(120);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  await removeAndTime(page);
  assert.match((await snapshot(page)).message, /กล้องอาจถูกบัง/);
  await context.close();
});

test("person returns: back to TRACKING while SEARCHING; after LOST only a new tap selects (#2)", { skip: SKIP, timeout: 40000 }, async () => {
  const { context, page } = await openApp();
  const b = box(120);
  await setPersons(page, [b]);
  await selectPerson(page, b);

  // Short disappearance: comes back near the same place.
  await setPersons(page, []);
  await waitStatus(page, "SEARCHING", 2000);
  await setPersons(page, [box(126)]);
  await waitStatus(page, "TRACKING", 2000);
  assert.match((await snapshot(page)).message, /#1/);

  // Long disappearance: LOST, then the person comes back.
  await removeAndTime(page);
  await setPersons(page, [b]);
  await page.waitForTimeout(1200);
  assert.equal((await snapshot(page)).status, "LOST", "must not re-select automatically");

  await tapVideo(page, b.originX + b.width / 2, b.originY + b.height / 2);
  await waitStatus(page, "TRACKING", 2000);
  assert.match((await snapshot(page)).message, /#2/);
  await context.close();
});

test("no face recognition: no ONNX / manifest / embedding module requested", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page, external } = await openApp();
  const b = box(120);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  await page.waitForTimeout(1500);

  const local = await page.evaluate(() =>
    performance.getEntriesByType("resource").map(entry => entry.name));
  const all = [...local, ...external];
  assert.deepEqual(all.filter(url => RECOGNITION_URL.test(url)), []);
  assert.equal(await page.textContent("#readyFaceModel"), "OFF (NOT USED IN PHASE C)");
  assert.equal(await page.textContent("#ownerStatus"), UNVERIFIED);
  await context.close();
});

test("FACE CROP EXPORT: 112x112 PNG in page memory only (no network, no IndexedDB)", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page, external } = await openApp();
  await page.evaluate(() => {
    // One face, 90 px wide, keypoints (normalised): eyes, nose, mouth.
    window.__faces = [{
      boundingBox: { originX: 115, originY: 60, width: 90, height: 90 },
      categories: [{ score: 0.95 }],
      keypoints: [
        { x: 0.45, y: 0.40 }, { x: 0.55, y: 0.40 },
        { x: 0.50, y: 0.47 }, { x: 0.50, y: 0.54 }
      ]
    }];
  });

  const idbCounts = () => readOwnerDb(page);

  const idbBefore = await idbCounts();
  const externalBefore = external.length;
  const resourcesBefore = await page.evaluate(() => performance.getEntriesByType("resource").length);

  await page.fill("#cropLabel", "test");
  await page.click("#cropBtn");
  await page.waitForSelector("#cropList a", { timeout: 6000 });

  const href = await page.getAttribute("#cropList a", "href");
  assert.match(href, /^blob:/, "crop must be a page-local object URL");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    page.click("#cropList a")
  ]);
  assert.equal(download.suggestedFilename(), "test_1.png");
  const png = fs.readFileSync(await download.path());
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 112);
  assert.equal(png.readUInt32BE(20), 112);

  const newResources = await page.evaluate(n =>
    performance.getEntriesByType("resource").slice(n).map(entry => entry.name), resourcesBefore);
  assert.deepEqual(newResources.filter(url => !url.startsWith("blob:")), []);
  assert.equal(external.length, externalBefore, "no request may leave the page");
  assert.deepEqual(await idbCounts(), idbBefore);

  await page.click("#cropClearBtn");
  assert.equal(await page.locator("#cropList a").count(), 0);
  await context.close();
});

test("no enrollment UI; a full session saves nothing to IndexedDB", { skip: SKIP, timeout: 30000 }, async () => {
  const { context, page, errors } = await openApp();
  for (const id of ["captureBtn", "captureMode", "consentCheck", "ownerName", "deleteSamplesBtn"]) {
    assert.equal(await page.locator(`#${id}`).count(), 0, `#${id} must be gone`);
  }
  assert.equal(await page.getByText("Face Enrollment").count(), 0);

  // Track a person and export a face crop, then look for stored data.
  const b = box(120);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  await page.evaluate(() => {
    window.__faces = [{
      boundingBox: { originX: 115, originY: 60, width: 90, height: 90 },
      categories: [{ score: 0.95 }],
      keypoints: [{ x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 }, { x: 0.5, y: 0.47 }, { x: 0.5, y: 0.54 }]
    }];
  });
  await page.fill("#cropLabel", "me");
  await page.click("#cropBtn");
  await page.waitForSelector("#cropList a", { timeout: 6000 });

  const panel = await legacyPanel(page);
  assert.deepEqual([panel.face, panel.reid, panel.embeddings], ["0", "0", "0"]);
  assert.equal(panel.deleteDisabled, true);
  assert.match(panel.message, /ไม่มีข้อมูลเจ้าของ/);

  const names = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
  assert.deepEqual(names, [], "no IndexedDB database may be created");
  assert.equal(await readOwnerDb(page), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Phase A+B data: shown, never deleted automatically, deleted only after confirm", { skip: SKIP, timeout: 40000 }, async () => {
  const { context, page } = await openApp();
  await seedPhaseABData(page);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("legacyFaceCount").textContent !== "--");

  let panel = await legacyPanel(page);
  assert.deepEqual([panel.face, panel.reid, panel.embeddings], ["2", "1", "1"]);
  assert.equal(panel.deleteDisabled, false);
  assert.match(panel.message, /ไม่ลบให้อัตโนมัติ/);

  // Using the app (camera + tracking) must not touch the old data.
  await page.click("#startBtn");
  await page.waitForFunction(() => document.getElementById("trackStatus").textContent !== "STOPPED");
  const b = box(120);
  await setPersons(page, [b]);
  await selectPerson(page, b);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("legacyFaceCount").textContent !== "--");
  assert.deepEqual(await readOwnerDb(page), {
    stores: ["embeddings", "samples"], embeddings: 1, samples: 3, faceSamples: 2
  });

  // Cancel in the confirm dialog: nothing is deleted.
  page.once("dialog", dialog => dialog.dismiss());
  await page.click("#legacyDeleteBtn");
  await page.waitForTimeout(300);
  assert.equal((await readOwnerDb(page)).samples, 3);

  // Confirm: samples and embeddings are cleared.
  page.once("dialog", dialog => dialog.accept());
  await page.click("#legacyDeleteBtn");
  await page.waitForFunction(() => document.getElementById("legacyDataMessage").textContent.includes("ลบข้อมูลเดิมแล้ว"));
  panel = await legacyPanel(page);
  assert.deepEqual([panel.face, panel.reid, panel.embeddings], ["0", "0", "0"]);
  assert.equal(panel.deleteDisabled, true);
  const after = await readOwnerDb(page);
  assert.equal(after.samples, 0);
  assert.equal(after.embeddings, 0);
  await context.close();
});
