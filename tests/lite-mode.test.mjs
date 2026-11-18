import test from "node:test";
import assert from "node:assert/strict";
import { detectLiteMode, personIntervalFor, workerModeFor, WORKER_DEFAULT_IN_LITE } from "../js/lite-mode.js";

const phone = { userAgent: "Mozilla/5.0 (Linux; Android 13; Infinix X6711) Chrome/120 Mobile Safari/537.36" };
const desktop = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36" };

test("?lite=1 forces lite on, even on a desktop", () => {
  assert.equal(detectLiteMode("?lite=1", desktop), true);
});

test("?lite=0 forces lite off, even on a phone", () => {
  assert.equal(detectLiteMode("?lite=0", phone), false);
});

test("without the parameter a phone user agent turns lite on", () => {
  assert.equal(detectLiteMode("", phone), true);
});

test("without the parameter a desktop stays off", () => {
  assert.equal(detectLiteMode("", desktop), false);
});

test("userAgentData.mobile wins over the user agent string", () => {
  assert.equal(detectLiteMode("", { ...phone, userAgentData: { mobile: false } }), false);
  assert.equal(detectLiteMode("", { ...desktop, userAgentData: { mobile: true } }), true);
});

test("missing navigator is treated as not mobile", () => {
  assert.equal(detectLiteMode("", {}), false);
});

test("lite mode detects slowly while FOLLOW is off and at the normal rate while it is on", () => {
  const base = { normalMs: 200, idleMs: 500 };
  assert.equal(personIntervalFor({ ...base, lite: true, following: false }), 500);
  assert.equal(personIntervalFor({ ...base, lite: true, following: true }), 200);
});

test("the desktop always uses the normal rate", () => {
  const base = { normalMs: 200, idleMs: 500 };
  assert.equal(personIntervalFor({ ...base, lite: false, following: false }), 200);
  assert.equal(personIntervalFor({ ...base, lite: false, following: true }), 200);
});

test("R1 Re-ID intervals: learning slows while FOLLOW is on (any device), search slows only on phones", async () => {
  const { reidIntervalsFor, REID_LITE_FOLLOW_LEARN_MS, REID_LITE_SEARCH_MS } = await import("../js/lite-mode.js");
  const base = { learnMs: 1000, searchMs: 500 };
  assert.deepEqual(reidIntervalsFor({ ...base, lite: false, following: true }),
    { learnMs: REID_LITE_FOLLOW_LEARN_MS, searchMs: 500 });
  assert.deepEqual(reidIntervalsFor({ ...base, lite: false, following: false }), { learnMs: 1000, searchMs: 500 });
  assert.deepEqual(reidIntervalsFor({ ...base, lite: true, following: false }),
    { learnMs: 1000, searchMs: REID_LITE_SEARCH_MS });
  assert.deepEqual(reidIntervalsFor({ ...base, lite: true, following: true }),
    { learnMs: REID_LITE_FOLLOW_LEARN_MS, searchMs: REID_LITE_SEARCH_MS });
});

test("R2 Re-ID intervals never get faster than the configured ones", async () => {
  const { reidIntervalsFor } = await import("../js/lite-mode.js");
  const slow = reidIntervalsFor({ lite: true, following: true, learnMs: 9000, searchMs: 3000 });
  assert.deepEqual(slow, { learnMs: 9000, searchMs: 3000 });
});

test("L-W1 the person worker is opt-in: only ?worker=1 turns it on while the default is off", () => {
  assert.equal(WORKER_DEFAULT_IN_LITE, false);
  assert.equal(workerModeFor("", true), false);
  assert.equal(workerModeFor("", false), false);
  assert.equal(workerModeFor("?worker=1", false), true);
  assert.equal(workerModeFor("?worker=1&lite=1", true), true);
  assert.equal(workerModeFor("?worker=0", true, true), false);
  assert.equal(workerModeFor("?worker=yes", true), false);          // anything but 1/0 is ignored
});

test("L-W2 when the default is switched on later it applies to lite mode only", () => {
  assert.equal(workerModeFor("", true, true), true);
  assert.equal(workerModeFor("", false, true), false);
});

test("FI1 face detection is skipped only while FOLLOW is on and somebody is followed", async () => {
  const { faceIntervalFor } = await import("../js/lite-mode.js");
  const base = { lite: false, normalMs: 500 };
  assert.equal(faceIntervalFor({ ...base, following: false, tracking: false }), 500);
  assert.equal(faceIntervalFor({ ...base, following: false, tracking: true }), 500);   // FOLLOW off: normal
  assert.equal(faceIntervalFor({ ...base, following: true, tracking: false }), 500);   // owner lost: searching by face
  assert.equal(faceIntervalFor({ ...base, following: true, tracking: true }), Infinity);
});

test("FI2 enrolment and a face crop export always get face detection; lite never runs it", async () => {
  const { faceIntervalFor } = await import("../js/lite-mode.js");
  const base = { normalMs: 500, following: true, tracking: true };
  assert.equal(faceIntervalFor({ ...base, lite: false, enrolling: true }), 500);
  assert.equal(faceIntervalFor({ ...base, lite: false, cropPending: true }), 500);
  assert.equal(faceIntervalFor({ ...base, lite: true, following: false, tracking: false }), Infinity);
  assert.equal(faceIntervalFor({ ...base, lite: true, enrolling: true }), Infinity);
});
