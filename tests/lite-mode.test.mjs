import test from "node:test";
import assert from "node:assert/strict";
import { detectLiteMode, personIntervalFor } from "../js/lite-mode.js";

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

test("R1 Re-ID intervals: desktop unchanged, phone slower, learning slower only while FOLLOW is on", async () => {
  const { reidIntervalsFor, REID_LITE_FOLLOW_LEARN_MS, REID_LITE_SEARCH_MS } = await import("../js/lite-mode.js");
  const base = { learnMs: 1000, searchMs: 500 };
  assert.deepEqual(reidIntervalsFor({ ...base, lite: false, following: true }), { learnMs: 1000, searchMs: 500 });
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
