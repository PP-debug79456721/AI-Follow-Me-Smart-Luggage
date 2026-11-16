import test from "node:test";
import assert from "node:assert/strict";
import { detectLiteMode } from "../js/lite-mode.js";

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
