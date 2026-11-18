/*
 * ONNX Runtime loading in js/embedding/embedding-engine.js: lazy, local copy first, CDN as fallback.
 * Uses temporary files and an injected fetch; Node cannot import https:// URLs, so the CDN attempt
 * always fails here, which makes the fallback order observable without a network.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEmbeddingModel, loadOnnxRuntime } from "../js/embedding/embedding-engine.js";

const root = mkdtempSync(path.join(tmpdir(), "ort-vendor-"));
after(() => rmSync(root, { recursive: true, force: true }));

const baseUrl = `${pathToFileURL(path.join(root, "vendor")).href}/`;
mkdirSync(path.join(root, "vendor", "onnxruntime"), { recursive: true });
const modulePath = path.join(root, "vendor", "onnxruntime", "ort.wasm.min.mjs");

const manifest = {
  format: 1,
  components: {
    onnxruntime: {
      version: "1.31.1",
      files: [{ path: "onnxruntime/ort.wasm.min.mjs" }, { path: "onnxruntime/ort-wasm-simd-threaded.wasm" }]
    }
  }
};
const fetchFn = async () => ({ ok: true, json: async () => manifest });

async function captureWarnings(action) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { result: await action().then(value => ({ value }), error => ({ error })), warnings };
  } finally {
    console.warn = original;
  }
}

test("O1 without integrity values nothing is fetched and ONNX Runtime is never loaded", async () => {
  let fetched = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error("no network in this test"); };
  try {
    await assert.rejects(
      () => loadEmbeddingModel("./models/x.onnx", {}),
      error => error.code === "NO_INTEGRITY"
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetched, 0);
});

test("O2 a broken local copy is tried first, then the CDN (which fails here): both attempts are reported", async () => {
  writeFileSync(modulePath, "export const env = {;;; this is not valid javascript");
  const { result, warnings } = await captureWarnings(() => loadOnnxRuntime({ baseUrl, fetchFn }));
  assert.ok(result.error, "no source could be loaded");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /from local failed/);
  assert.match(warnings[1], /from cdn failed/);
});

test("O3 a working local copy is used and wasmPaths points at vendor/onnxruntime/", async () => {
  writeFileSync(modulePath, "export const env = { wasm: {} };\nexport const source = 'local';\n");
  const ort = await loadOnnxRuntime({ baseUrl, fetchFn });
  assert.equal(ort.source, "local");
  assert.equal(ort.env.wasm.numThreads, 1);
  assert.equal(ort.env.wasm.wasmPaths, `${baseUrl}onnxruntime/`);
});

test("O4 without a manifest only the CDN is tried", async () => {
  const { result, warnings } = await captureWarnings(
    () => loadOnnxRuntime({ baseUrl, fetchFn: async () => ({ ok: false }) })
  );
  assert.ok(result.error);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /from cdn failed/);
});
