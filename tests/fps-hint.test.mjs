import test from "node:test";
import assert from "node:assert/strict";

import { createFpsHint, FPS_HINT_TEXT } from "../js/fps-hint.js";

const feed = (hint, values) => values.map(value => hint.push(value));

test("H1 the hint shows only after 5 low readings in a row", () => {
  const hint = createFpsHint();
  assert.deepEqual(feed(hint, [8, 8, 8, 8]), [null, null, null, null]);
  assert.equal(hint.push(8), FPS_HINT_TEXT);
});

test("H2 a reading of 10 or more restarts the count (below 10 is low, 10 is not)", () => {
  const hint = createFpsHint();
  feed(hint, [8, 8, 8, 8]);
  assert.equal(hint.push(10), null);
  assert.deepEqual(feed(hint, [8, 8, 8, 8]), [null, null, null, null]);
  assert.equal(hint.push(9.9), FPS_HINT_TEXT);
});

test("H3 once shown the hint stays through 10-11.9 and clears at 12", () => {
  const hint = createFpsHint();
  feed(hint, [5, 5, 5, 5, 5]);
  assert.equal(hint.push(11), FPS_HINT_TEXT);
  assert.equal(hint.push(11.9), FPS_HINT_TEXT);
  assert.equal(hint.push(12), null);
  assert.equal(hint.push(8), null, "needs 5 low readings again");
});

test("H4 no frames (0), no reading (null) or garbage clear the hint and the count", () => {
  const hint = createFpsHint();
  feed(hint, [5, 5, 5, 5, 5]);
  assert.equal(hint.push(0), null);
  assert.equal(hint.push(5), null);
  feed(hint, [5, 5, 5]);
  assert.equal(hint.push(null), null);
  assert.deepEqual(feed(hint, [5, 5, 5, 5]), [null, null, null, null]);
  assert.equal(hint.push(Number.NaN), null);
  assert.equal(hint.push("7"), null);
});

test("H5 reset() forgets everything; thresholds can be changed", () => {
  const hint = createFpsHint();
  feed(hint, [5, 5, 5, 5, 5]);
  hint.reset();
  assert.equal(hint.push(5), null);

  const custom = createFpsHint({ low: 20, clearAt: 25, samples: 2 });
  assert.deepEqual(feed(custom, [15, 15]), [null, FPS_HINT_TEXT]);
  assert.equal(custom.push(24), FPS_HINT_TEXT);
  assert.equal(custom.push(25), null);
});
