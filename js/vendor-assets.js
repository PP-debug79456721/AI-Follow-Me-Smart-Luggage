/*
 * Local-first loading of the third-party libraries and detector models.
 *
 * Normally the page fetches MediaPipe, ONNX Runtime and the .tflite models from the internet
 * (cdn.jsdelivr.net, storage.googleapis.com), so every page load needs a connection. If a folder
 * `vendor/` sits next to js/ and holds a `vendor-manifest.json` (written by tools/fetch-vendor.ps1),
 * the page uses those files instead. Nothing else changes:
 *
 *   - no manifest, a wrong version, or a missing file  -> that component uses the CDN, as before
 *   - the caller must still fall back to the CDN when the LOCAL file fails to load
 *     (for example a server that sends .mjs with the wrong content type)
 *
 * Pure and DOM-free (fetch is injected), so it is unit-tested in Node (tests/vendor-assets.test.mjs).
 *
 * Manifest (format 1), paths are relative to vendor/:
 *   { "format": 1, "components": {
 *       "mediapipe":   { "version": "0.10.35", "files": [{ "path": "mediapipe/vision_bundle.mjs", ... },
 *                                                         { "path": "mediapipe/wasm/....wasm", ... }] },
 *       "onnxruntime": { "version": "1.31.1",  "files": [{ "path": "onnxruntime/ort.wasm.min.mjs", ... }, ...] },
 *       "models":      { "files": [{ "path": "models/efficientdet_lite0.tflite", ... },
 *                                  { "path": "models/blaze_face_short_range.tflite", ... }] } } }
 */

export const VENDOR_MANIFEST_FILE = "vendor-manifest.json";
export const VENDOR_FORMAT = 1;

export const VENDOR_FILES = Object.freeze({
  mediapipeBundle: "mediapipe/vision_bundle.mjs",
  mediapipeWasmDir: "mediapipe/wasm",
  ortModule: "onnxruntime/ort.wasm.min.mjs",
  ortDir: "onnxruntime/",
  personModel: "models/efficientdet_lite0.tflite",
  faceModel: "models/blaze_face_short_range.tflite"
});

function manifestPaths(entry) {
  if (!entry || !Array.isArray(entry.files)) return [];
  return entry.files
    .map(file => (file && typeof file.path === "string" ? file.path : null))
    .filter(Boolean);
}

function isManifest(value) {
  return Boolean(
    value && typeof value === "object" && value.format === VENDOR_FORMAT &&
    value.components && typeof value.components === "object"
  );
}

/* Reads vendor/vendor-manifest.json. Never throws: any problem means "no local files" (null). */
export async function loadVendorManifest({
  baseUrl,
  fetchFn = globalThis.fetch,
  timeoutMs = 1500
} = {}) {

  if (typeof fetchFn !== "function" || !baseUrl) return null;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(
      new URL(VENDOR_MANIFEST_FILE, baseUrl).href,
      { cache: "no-store", signal: controller ? controller.signal : undefined }
    );
    if (!response || !response.ok) return null;
    const manifest = await response.json();
    return isManifest(manifest) ? manifest : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * Decides, per component, between the local copy and the CDN.
 *   baseUrl: absolute URL of the vendor/ folder, ending with "/"
 *   cdn:     { mediapipeBundle, mediapipeWasm, ortModule, ortBase, personModel, faceModel }
 * Each entry says which source was chosen and why (reason), and carries `fallback` (the CDN URLs)
 * when the local copy was chosen, so the caller can retry on a load error.
 */
export function planVendorAssets(manifest, { baseUrl, mediapipeVersion, ortVersion, cdn }) {

  const base = String(baseUrl);
  const components = isManifest(manifest) ? manifest.components : {};

  /* ---- MediaPipe runtime ---- */
  const mpEntry = components.mediapipe;
  const mpPaths = manifestPaths(mpEntry);
  let mpReason = "OK";
  if (!mpEntry) mpReason = "NOT_INSTALLED";
  else if (mpEntry.version !== mediapipeVersion) mpReason = "VERSION_MISMATCH";
  else if (!mpPaths.includes(VENDOR_FILES.mediapipeBundle)) mpReason = "MISSING_BUNDLE";
  else if (!mpPaths.some(p => p.startsWith(`${VENDOR_FILES.mediapipeWasmDir}/`) && p.endsWith(".wasm"))) {
    mpReason = "MISSING_WASM";
  }
  const mpCdn = { bundleUrl: cdn.mediapipeBundle, wasmUrl: cdn.mediapipeWasm };
  const mediapipe = mpReason === "OK"
    ? {
        source: "local",
        reason: mpReason,
        bundleUrl: new URL(VENDOR_FILES.mediapipeBundle, base).href,
        wasmUrl: new URL(VENDOR_FILES.mediapipeWasmDir, base).href,
        fallback: mpCdn
      }
    : { source: "cdn", reason: mpReason, ...mpCdn, fallback: null };

  /* ---- ONNX Runtime ---- */
  const ortEntry = components.onnxruntime;
  const ortPaths = manifestPaths(ortEntry);
  let ortReason = "OK";
  if (!ortEntry) ortReason = "NOT_INSTALLED";
  else if (ortEntry.version !== ortVersion) ortReason = "VERSION_MISMATCH";
  else if (!ortPaths.includes(VENDOR_FILES.ortModule)) ortReason = "MISSING_MODULE";
  else if (!ortPaths.some(p => p.startsWith(VENDOR_FILES.ortDir) && p.endsWith(".wasm"))) {
    ortReason = "MISSING_WASM";
  }
  const ortCdn = { moduleUrl: cdn.ortModule, wasmBase: cdn.ortBase };
  const onnx = ortReason === "OK"
    ? {
        source: "local",
        reason: ortReason,
        moduleUrl: new URL(VENDOR_FILES.ortModule, base).href,
        wasmBase: new URL(VENDOR_FILES.ortDir, base).href,
        fallback: ortCdn
      }
    : { source: "cdn", reason: ortReason, ...ortCdn, fallback: null };

  /* ---- detector models (each one separately) ---- */
  const modelPaths = manifestPaths(components.models);
  const model = (file, cdnUrl) => modelPaths.includes(file)
    ? { source: "local", url: new URL(file, base).href, fallback: cdnUrl }
    : { source: "cdn", url: cdnUrl, fallback: null };

  return {
    mediapipe,
    onnx,
    models: {
      person: model(VENDOR_FILES.personModel, cdn.personModel),
      face: model(VENDOR_FILES.faceModel, cdn.faceModel)
    }
  };
}

/* "LOCAL" when every component comes from vendor/, "CDN" when none does, otherwise "MIXED". */
export function describeVendorPlan(plan) {
  const sources = [
    plan.mediapipe.source,
    plan.onnx.source,
    plan.models.person.source,
    plan.models.face.source
  ];
  if (sources.every(source => source === "local")) return "LOCAL";
  if (sources.every(source => source === "cdn")) return "CDN";
  return "MIXED";
}
