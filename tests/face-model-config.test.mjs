/*
 * Unit tests for the SFace input configuration (js/embedding/face-model-config.js)
 * and the preprocessing it drives (js/embedding/image-preprocessor.js).
 *
 * Run from the repository root (Node 18+, no packages needed):
 *
 *     node --test tests/face-model-config.test.mjs
 *
 * No model is loaded and no inference runs. imageToTensorData() is run with a
 * minimal fake canvas whose getImageData() returns known RGBA pixels, so the
 * exact tensor the app would feed the model can be checked.
 *
 * The SFace ONNX graph normalizes internally: its first nodes compute
 * (x - 127.5) * 0.0078125. The app must therefore feed raw 0..255 values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FACE_MODEL_CONFIG } from "../js/embedding/face-model-config.js";
import {
  imageToTensorData,
  getInputShape,
  preprocessImageData
} from "../js/embedding/image-preprocessor.js";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../models/manifest.json", import.meta.url), "utf8")
);

const W = FACE_MODEL_CONFIG.width;
const H = FACE_MODEL_CONFIG.height;
const SIZE = W * H;

// Known test pixels: every channel covers 0..255, channels differ.
const red = i => i % 256;
const green = i => (i * 7) % 256;
const blue = i => 255 - (i % 256);

function testPixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = red(i);
    data[i * 4 + 1] = green(i);
    data[i * 4 + 2] = blue(i);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/* Runs fn with a fake document whose canvas returns testPixels(). */
function withFakeCanvas(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => ({ data: testPixels(w, h) })
        })
      };
    }
  };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const tensorFor = config => withFakeCanvas(() => imageToTensorData({}, config));

/* What the SFace graph's first two nodes (Sub, Mul) do to its input. */
const graphNormalize = x => (x - 127.5) * 0.0078125;

const range = values => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
};

// --------------------------------------------------
// Configuration values
// --------------------------------------------------

test("SFace config: NCHW [1,3,112,112] input, [1,128] output, names from the ONNX file", () => {
  assert.equal(FACE_MODEL_CONFIG.layout, "NCHW");
  assert.deepEqual(FACE_MODEL_CONFIG.inputShape, [1, 3, 112, 112]);
  assert.deepEqual(getInputShape(FACE_MODEL_CONFIG), [...FACE_MODEL_CONFIG.inputShape]);
  assert.deepEqual(FACE_MODEL_CONFIG.outputShape, [1, 128]);
  assert.equal(FACE_MODEL_CONFIG.embeddingDim, 128);
  assert.equal(FACE_MODEL_CONFIG.embeddingDim, FACE_MODEL_CONFIG.outputShape[1]);
  assert.equal(FACE_MODEL_CONFIG.inputName, "data");
  assert.equal(FACE_MODEL_CONFIG.outputName, "fc1");
  assert.equal(FACE_MODEL_CONFIG.colorOrder, "RGB");
  assert.equal(FACE_MODEL_CONFIG.alignment, "arcface-112");
});

test("SFace config: raw pixels (pixelScale 1, mean 0, std 1), set explicitly", () => {
  // image-preprocessor.js defaults pixelScale to 255, so it must be explicit.
  assert.ok(Object.hasOwn(FACE_MODEL_CONFIG, "pixelScale"));
  assert.equal(FACE_MODEL_CONFIG.pixelScale, 1);
  assert.deepEqual([...FACE_MODEL_CONFIG.mean], [0, 0, 0]);
  assert.deepEqual([...FACE_MODEL_CONFIG.std], [1, 1, 1]);
});

test("SFace config is frozen (cannot be changed at run time)", () => {
  assert.ok(Object.isFrozen(FACE_MODEL_CONFIG));
  assert.ok(Object.isFrozen(FACE_MODEL_CONFIG.mean));
  assert.ok(Object.isFrozen(FACE_MODEL_CONFIG.std));
  assert.ok(Object.isFrozen(FACE_MODEL_CONFIG.inputShape));
  assert.ok(Object.isFrozen(FACE_MODEL_CONFIG.outputShape));
});

test("config matches the manifest face entry (names, shapes, layout, color)", () => {
  const face = MANIFEST.models.face;
  assert.equal(face.input.name, FACE_MODEL_CONFIG.inputName);
  assert.equal(face.input.layout, FACE_MODEL_CONFIG.layout);
  assert.deepEqual(face.input.shape, [...FACE_MODEL_CONFIG.inputShape]);
  assert.equal(face.input.colorOrder, FACE_MODEL_CONFIG.colorOrder);
  assert.equal(face.output.name, FACE_MODEL_CONFIG.outputName);
  assert.deepEqual(face.output.shape, [...FACE_MODEL_CONFIG.outputShape]);
});

// --------------------------------------------------
// The tensor the app would feed the model
// --------------------------------------------------

test("tensor is NCHW, RGB planes, raw 0..255 pixel values", () => {
  const t = tensorFor(FACE_MODEL_CONFIG);
  assert.ok(t instanceof Float32Array);
  assert.equal(t.length, 3 * SIZE);
  for (let i = 0; i < SIZE; i++) {
    assert.equal(t[i], red(i));                 // plane 0 = R
    assert.equal(t[SIZE + i], green(i));        // plane 1 = G
    assert.equal(t[2 * SIZE + i], blue(i));     // plane 2 = B
  }
  assert.deepEqual(range(t), { min: 0, max: 255 });
});

test("no duplicate normalization: the graph's own (x-127.5)/128 spreads inputs over about -1..1", () => {
  const fed = tensorFor(FACE_MODEL_CONFIG);
  const inGraph = range(Array.from(fed, graphNormalize));
  assert.ok(Math.abs(inGraph.min - (-127.5 / 128)) < 1e-6, String(inGraph.min));
  assert.ok(Math.abs(inGraph.max - (127.5 / 128)) < 1e-6, String(inGraph.max));
});

test("guard: the old ArcFace settings would normalize twice and collapse the input", () => {
  // Shows why mean 127.5 / std 128 must NOT be used with SFace.
  const doubled = tensorFor({ ...FACE_MODEL_CONFIG, mean: [127.5, 127.5, 127.5], std: [128, 128, 128] });
  const inGraph = range(Array.from(doubled, graphNormalize));
  assert.ok(inGraph.max - inGraph.min < 0.02, JSON.stringify(inGraph));
  assert.notDeepEqual(range(doubled), range(tensorFor(FACE_MODEL_CONFIG)));
});

test("guard: leaving pixelScale at the preprocessor default (255) would feed 0..1, not 0..255", () => {
  const { pixelScale, ...withoutScale } = FACE_MODEL_CONFIG;
  assert.equal(pixelScale, 1);
  const scaled = range(tensorFor(withoutScale));
  assert.ok(scaled.max <= 1, JSON.stringify(scaled));
  assert.equal(range(tensorFor(FACE_MODEL_CONFIG)).max, 255);
});

// --------------------------------------------------
// Validation stays active
// --------------------------------------------------

test("preprocessing still rejects non-finite or zero normalization settings", () => {
  for (const changes of [
    { mean: [NaN, 0, 0] },
    { mean: [0, Infinity, 0] },
    { std: [0, 1, 1] },
    { std: [1, NaN, 1] },
    { std: [1, 1, -Infinity] },
    { mean: [0, 0] },
    { pixelScale: 0 },
    { pixelScale: NaN },
    { pixelScale: -1 },
    { layout: "NWHC" },
    { colorOrder: "GRB" }
  ]) {
    assert.throws(() => tensorFor({ ...FACE_MODEL_CONFIG, ...changes }), Error, JSON.stringify(changes));
  }
});

test("aligned input stays mandatory: no keypoints means no tensor (no unaligned fallback)", () => {
  assert.throws(
    () => withFakeCanvas(() => preprocessImageData({}, { originX: 0, originY: 0, width: 50, height: 50 }, FACE_MODEL_CONFIG)),
    /keypoints are required/
  );
});

test("fixtures and tools use the SFace tensor names, not the old ArcFace ones (source guard)", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  // The e2e fake ONNX Runtime session must look like the real SFace file.
  const e2e = read("./e2e/phase-c.e2e.mjs");
  assert.match(e2e, /inputNames: \["data"\]/);
  assert.match(e2e, /outputNames: \["fc1"\]/);
  assert.match(e2e, /name: "data", isTensor: true, type: "float32", shape: \[1, 3, 112, 112\]/);
  assert.match(e2e, /name: "fc1", isTensor: true, type: "float32", shape: \[1, 128\]/);
  assert.doesNotMatch(e2e, /input_1|outputNames: \["embedding"\]/);
  // The verification tool's default profile is SFace with raw input.
  const tool = read("../tools/verify_face_model.py");
  assert.match(tool, /DEFAULT_PROFILE = "sface"/);
  assert.match(tool, /"sface": \{[\s\S]*?"input_name": "data",[\s\S]*?"output_name": "fc1",[\s\S]*?"layout": "NCHW",[\s\S]*?"embedding_dim": 128,[\s\S]*?"mean": 0\.0,[\s\S]*?"std": 1\.0,[\s\S]*?"graph_normalization": \(127\.5, 128\.0\)/);
});

test("engine still checks embedding length and finite values (source guard)", () => {
  // embedding-engine.js imports ONNX Runtime from a URL, so it cannot be
  // imported in Node; these checks keep its guards from being removed.
  const source = readFileSync(new URL("../js/embedding/embedding-engine.js", import.meta.url), "utf8");
  assert.match(source, /config\.embeddingDim &&\s*vector\.length !== config\.embeddingDim/);
  assert.match(source, /vector\.every\(Number\.isFinite\)/);
  assert.match(source, /function normalizeVector[\s\S]*Number\.isFinite\(value\)/);
});
