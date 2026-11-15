import test from "node:test";
import assert from "node:assert/strict";
import { REID_MODEL_CONFIG as C } from "../js/embedding/reid-model-config.js";

test("Re-ID config matches Torchreid OSNet test-time preprocessing", () => {
  assert.equal(C.width, 128);
  assert.equal(C.height, 256);
  assert.deepEqual([...C.inputShape], [1, 3, C.height, C.width]);
  assert.equal(C.layout, "NCHW");
  assert.equal(C.colorOrder, "RGB");
  assert.equal(C.pixelScale, 255);
  assert.deepEqual([...C.mean], [0.485, 0.456, 0.406]);
  assert.deepEqual([...C.std], [0.229, 0.224, 0.225]);
  assert.equal(C.embeddingDim, 512);
  assert.equal(C.alignment, undefined);
  assert.ok(Object.isFrozen(C));
});
