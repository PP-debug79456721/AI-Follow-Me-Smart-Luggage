/*
 * Person detector in a Web Worker (MediaPipe ObjectDetector), so the page's main thread stays free to
 * answer the ESP32 link. Started by js/person-worker-client.js; opt-in with ?worker=1 (see lite-mode.js).
 *
 * This is a CLASSIC worker on purpose. MediaPipe loads its WASM loader with importScripts(), which a
 * module worker does not have; a classic worker can still load the ES-module bundle with dynamic import().
 *
 * NOT tested against the real MediaPipe bundle in a worker (that needs a browser with a GPU and the CDN);
 * the message protocol is tested with a fake worker in tests/person-worker-client.test.mjs. If anything
 * here fails, the page falls back to the main-thread detector.
 *
 * Messages in:
 *   { type: "init", bundleUrl, wasmUrl, modelUrl, scoreThreshold, maxResults, delegates: ["GPU", "CPU"] }
 *   { type: "detect", id, bitmap (ImageBitmap, transferred), timestamp }
 *   { type: "close" }
 * Messages out:
 *   { type: "ready", delegate }                       | { type: "error", message }
 *   { type: "result", id, timestamp, detections, inferMs } | { type: "detectError", id, message }
 * detections keep MediaPipe's shape: [{ boundingBox: {originX, originY, width, height}, categories: [{categoryName, score}] }]
 */

/* eslint-env worker */

let detector = null;

function post(message) {
  self.postMessage(message);
}

async function init(options) {

  const tasks = await import(options.bundleUrl);
  const vision = await tasks.FilesetResolver.forVisionTasks(options.wasmUrl);

  let lastError = null;

  for (const delegate of options.delegates) {
    try {
      detector = await tasks.ObjectDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: options.modelUrl, delegate },
        runningMode: "VIDEO",
        scoreThreshold: options.scoreThreshold,
        maxResults: options.maxResults
      });
      return delegate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("no delegate could be created");
}

function plainDetections(result) {
  return (result?.detections ?? []).map(detection => {
    const box = detection.boundingBox;
    return {
      boundingBox: box
        ? { originX: box.originX, originY: box.originY, width: box.width, height: box.height }
        : null,
      categories: (detection.categories ?? []).map(category => ({
        categoryName: category.categoryName,
        score: category.score
      }))
    };
  });
}

self.onmessage = async event => {

  const data = event.data;

  if (data.type === "init") {
    try {
      const delegate = await init(data);
      post({ type: "ready", delegate });
    } catch (error) {
      post({ type: "error", message: String(error?.message ?? error) });
    }
    return;
  }

  if (data.type === "detect") {
    const started = performance.now();
    try {
      if (!detector) throw new Error("detector is not ready");
      const result = detector.detectForVideo(data.bitmap, data.timestamp);
      post({
        type: "result",
        id: data.id,
        timestamp: data.timestamp,
        detections: plainDetections(result),
        inferMs: performance.now() - started
      });
    } catch (error) {
      post({ type: "detectError", id: data.id, message: String(error?.message ?? error) });
    } finally {
      try { data.bitmap?.close?.(); } catch { /* already closed */ }
    }
    return;
  }

  if (data.type === "close") {
    try { detector?.close(); } catch { /* ignore */ }
    detector = null;
    self.close();
  }
};
