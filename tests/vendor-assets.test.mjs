/*
 * Tests for js/vendor-assets.js: local-first choice between vendor/ files and the CDN.
 * Pure logic with an injected fetch; it proves the choice rules, not that a browser can load the files.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  VENDOR_FILES,
  describeVendorPlan,
  loadVendorManifest,
  planVendorAssets
} from "../js/vendor-assets.js";

const BASE = "http://localhost:8000/vendor/";
const CDN = {
  mediapipeBundle: "https://cdn.example/mp/vision_bundle.mjs",
  mediapipeWasm: "https://cdn.example/mp/wasm",
  ortModule: "https://cdn.example/ort/ort.wasm.min.mjs",
  ortBase: "https://cdn.example/ort/",
  personModel: "https://models.example/efficientdet_lite0.tflite",
  faceModel: "https://models.example/blaze_face_short_range.tflite"
};
const OPTIONS = { baseUrl: BASE, mediapipeVersion: "0.10.35", ortVersion: "1.31.1", cdn: CDN };

const file = path => ({ path, bytes: 1, sha256: "x" });

function fullManifest() {
  return {
    format: 1,
    components: {
      mediapipe: {
        version: "0.10.35",
        files: [file("mediapipe/vision_bundle.mjs"), file("mediapipe/wasm/vision_wasm_internal.wasm"),
          file("mediapipe/wasm/vision_wasm_internal.js")]
      },
      onnxruntime: {
        version: "1.31.1",
        files: [file("onnxruntime/ort.wasm.min.mjs"), file("onnxruntime/ort-wasm-simd-threaded.wasm")]
      },
      models: { files: [file(VENDOR_FILES.personModel), file(VENDOR_FILES.faceModel)] }
    }
  };
}

const respond = (body, ok = true) => async () => ({ ok, json: async () => body });

/* ---------- loadVendorManifest ---------- */

test("V1 a valid manifest is returned and the URL is inside vendor/", async () => {
  let requested = null;
  const manifest = await loadVendorManifest({
    baseUrl: BASE,
    fetchFn: async (url, init) => { requested = { url, init }; return { ok: true, json: async () => fullManifest() }; }
  });
  assert.equal(requested.url, `${BASE}vendor-manifest.json`);
  assert.equal(requested.init.cache, "no-store");
  assert.equal(manifest.format, 1);
});

test("V2 anything wrong gives null and never throws (404, bad JSON, wrong format, network error, no fetch)", async () => {
  assert.equal(await loadVendorManifest({ baseUrl: BASE, fetchFn: respond(null, false) }), null);
  assert.equal(await loadVendorManifest({ baseUrl: BASE, fetchFn: respond({ format: 2, components: {} }) }), null);
  assert.equal(await loadVendorManifest({ baseUrl: BASE, fetchFn: respond("text") }), null);
  assert.equal(await loadVendorManifest({
    baseUrl: BASE,
    fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } })
  }), null);
  assert.equal(await loadVendorManifest({ baseUrl: BASE, fetchFn: async () => { throw new TypeError("offline"); } }), null);
  assert.equal(await loadVendorManifest({ baseUrl: BASE, fetchFn: null }), null);
  assert.equal(await loadVendorManifest({ fetchFn: respond(fullManifest()) }), null);
});

test("V3 a request that never answers is abandoned after the timeout", async () => {
  const start = Date.now();
  const manifest = await loadVendorManifest({
    baseUrl: BASE,
    timeoutMs: 40,
    fetchFn: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });
  assert.equal(manifest, null);
  assert.ok(Date.now() - start < 1000);
});

/* ---------- planVendorAssets ---------- */

test("V4 a complete manifest uses local files everywhere and keeps the CDN as fallback", () => {
  const plan = planVendorAssets(fullManifest(), OPTIONS);
  assert.equal(describeVendorPlan(plan), "LOCAL");
  assert.equal(plan.mediapipe.bundleUrl, `${BASE}mediapipe/vision_bundle.mjs`);
  assert.equal(plan.mediapipe.wasmUrl, `${BASE}mediapipe/wasm`);
  assert.deepEqual(plan.mediapipe.fallback, { bundleUrl: CDN.mediapipeBundle, wasmUrl: CDN.mediapipeWasm });
  assert.equal(plan.onnx.moduleUrl, `${BASE}onnxruntime/ort.wasm.min.mjs`);
  assert.equal(plan.onnx.wasmBase, `${BASE}onnxruntime/`);
  assert.deepEqual(plan.onnx.fallback, { moduleUrl: CDN.ortModule, wasmBase: CDN.ortBase });
  assert.equal(plan.models.person.url, `${BASE}models/efficientdet_lite0.tflite`);
  assert.equal(plan.models.person.fallback, CDN.personModel);
  assert.equal(plan.models.face.url, `${BASE}models/blaze_face_short_range.tflite`);
});

test("V5 no manifest: everything stays on the CDN exactly as before", () => {
  const plan = planVendorAssets(null, OPTIONS);
  assert.equal(describeVendorPlan(plan), "CDN");
  assert.equal(plan.mediapipe.bundleUrl, CDN.mediapipeBundle);
  assert.equal(plan.mediapipe.wasmUrl, CDN.mediapipeWasm);
  assert.equal(plan.mediapipe.reason, "NOT_INSTALLED");
  assert.equal(plan.mediapipe.fallback, null);
  assert.equal(plan.onnx.moduleUrl, CDN.ortModule);
  assert.equal(plan.onnx.wasmBase, CDN.ortBase);
  assert.equal(plan.models.person.url, CDN.personModel);
  assert.equal(plan.models.face.url, CDN.faceModel);
});

test("V6 a library version that differs from the code's version is never used", () => {
  const manifest = fullManifest();
  manifest.components.mediapipe.version = "0.10.14";
  manifest.components.onnxruntime.version = "1.0.0";
  const plan = planVendorAssets(manifest, OPTIONS);
  assert.equal(plan.mediapipe.source, "cdn");
  assert.equal(plan.mediapipe.reason, "VERSION_MISMATCH");
  assert.equal(plan.onnx.source, "cdn");
  assert.equal(plan.onnx.reason, "VERSION_MISMATCH");
  assert.equal(describeVendorPlan(plan), "MIXED");           // the models are still local
});

test("V7 a component missing its main file or its wasm falls back to the CDN", () => {
  const noBundle = fullManifest();
  noBundle.components.mediapipe.files = noBundle.components.mediapipe.files.filter(f => !f.path.endsWith(".mjs"));
  assert.equal(planVendorAssets(noBundle, OPTIONS).mediapipe.reason, "MISSING_BUNDLE");

  const noWasm = fullManifest();
  noWasm.components.mediapipe.files = noWasm.components.mediapipe.files.filter(f => !f.path.endsWith(".wasm"));
  assert.equal(planVendorAssets(noWasm, OPTIONS).mediapipe.reason, "MISSING_WASM");

  const noOrtModule = fullManifest();
  noOrtModule.components.onnxruntime.files = noOrtModule.components.onnxruntime.files.filter(f => !f.path.endsWith(".mjs"));
  assert.equal(planVendorAssets(noOrtModule, OPTIONS).onnx.reason, "MISSING_MODULE");

  const noOrtWasm = fullManifest();
  noOrtWasm.components.onnxruntime.files = noOrtWasm.components.onnxruntime.files.filter(f => !f.path.endsWith(".wasm"));
  assert.equal(planVendorAssets(noOrtWasm, OPTIONS).onnx.reason, "MISSING_WASM");
});

test("V8 models are chosen one by one", () => {
  const manifest = fullManifest();
  manifest.components.models.files = [file(VENDOR_FILES.personModel)];
  const plan = planVendorAssets(manifest, OPTIONS);
  assert.equal(plan.models.person.source, "local");
  assert.equal(plan.models.face.source, "cdn");
  assert.equal(plan.models.face.url, CDN.faceModel);
});

test("V9 a malformed manifest entry never throws and means CDN", () => {
  for (const manifest of [
    { format: 1, components: { mediapipe: { version: "0.10.35", files: "nope" } } },
    { format: 1, components: { mediapipe: null, onnxruntime: 5, models: { files: [null, 3, {}] } } },
    { format: 1 },
    "text",
    undefined
  ]) {
    const plan = planVendorAssets(manifest, OPTIONS);
    assert.equal(describeVendorPlan(plan), "CDN");
  }
});
