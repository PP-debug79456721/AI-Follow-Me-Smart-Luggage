/*
 * Main-thread side of the person-detector worker (js/person-worker.js).
 *
 *   const client = createPersonWorkerClient({ createWorker, onFailure });
 *   const { delegate } = await client.start({ bundleUrl, wasmUrl, modelUrl, ... });   // rejects on error / timeout
 *   const result = await client.detect(videoElement, timestamp);                        // null while busy
 *
 * Rules that keep it safe:
 *   - at most ONE detection in flight: a new frame is simply not sent while the worker is busy (null),
 *     so frames never queue up and the result is never older than one inference;
 *   - the frame is copied with createImageBitmap(video) when detect() is called and TRANSFERRED to the
 *     worker (no copy on the main thread, no blocking);
 *   - a result carries the timestamp of the frame it was computed from, which the caller must use as the
 *     detection time (NOT the time the result arrived);
 *   - a worker error, an unanswered detection (detectTimeoutMs) or too many failed frames in a row makes
 *     the client FAIL once: pending work is rejected, the worker is terminated, onFailure(reason) is
 *     called and the caller falls back to the main-thread detector.
 *
 * Everything the browser provides is injected (createWorker, createBitmap, timers, now), so it is
 * unit-tested in Node with a fake worker (tests/person-worker-client.test.mjs).
 */

export const WORKER_DEFAULTS = Object.freeze({
  initTimeoutMs: 25000,          // runtime + wasm + model download and GPU delegate creation
  detectTimeoutMs: 3000,         // one inference; far above the normal ~200 ms
  maxConsecutiveFailures: 5      // frames that could not be turned into a bitmap / sent in a row
});

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id)
  };
}

export function createPersonWorkerClient({
  createWorker,
  createBitmap = source => globalThis.createImageBitmap(source),
  onFailure = () => {},
  timers = defaultTimers(),
  now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()),
  ...overrides
} = {}) {

  if (typeof createWorker !== "function") {
    throw new TypeError("createWorker() is required");
  }

  const config = { ...WORKER_DEFAULTS, ...overrides };

  let worker = null;
  let ready = false;
  let failed = false;
  let delegate = null;
  let nextId = 1;
  let pending = null;            // { id, timer, resolve, reject, sentAt, timestamp }
  let starting = null;           // { resolve, reject, timer }
  let consecutiveFailures = 0;

  const stats = { sent: 0, results: 0, detectErrors: 0, bitmapErrors: 0, busySkips: 0 };

  function clear(handle) {
    if (handle && handle.timer !== null && handle.timer !== undefined) timers.clearTimeout(handle.timer);
  }

  function terminate() {
    const old = worker;
    worker = null;
    ready = false;
    if (old) {
      try { old.onmessage = null; old.onerror = null; } catch { /* ignore */ }
      try { old.terminate(); } catch { /* ignore */ }
    }
  }

  /* One-way: after fail() nothing is sent any more and the caller is told once. */
  function fail(reason) {
    if (failed) return;
    failed = true;

    clear(pending);
    const wasPending = pending;
    pending = null;
    if (wasPending) wasPending.reject(new Error(`person worker failed: ${reason}`));

    clear(starting);
    const wasStarting = starting;
    starting = null;
    if (wasStarting) wasStarting.reject(new Error(`person worker failed: ${reason}`));

    terminate();

    try { onFailure(reason); } catch (error) { console.error("person worker onFailure failed:", error); }
  }

  function onMessage(event) {
    const data = event?.data;
    if (!data || failed) return;

    if (data.type === "ready" && starting) {
      clear(starting);
      const waiting = starting;
      starting = null;
      ready = true;
      delegate = data.delegate ?? null;
      waiting.resolve({ delegate });
      return;
    }

    if (data.type === "error") {
      fail(`init: ${data.message ?? "unknown"}`);
      return;
    }

    if (data.type === "result" && pending && data.id === pending.id) {
      clear(pending);
      const done = pending;
      pending = null;
      consecutiveFailures = 0;
      stats.results += 1;
      done.resolve({
        detections: Array.isArray(data.detections) ? data.detections : [],
        inferMs: Number(data.inferMs) || 0,
        timestamp: done.timestamp,
        roundTripMs: now() - done.sentAt
      });
      return;
    }

    if (data.type === "detectError" && pending && data.id === pending.id) {
      clear(pending);
      const done = pending;
      pending = null;
      stats.detectErrors += 1;
      consecutiveFailures += 1;
      done.reject(new Error(`detection failed: ${data.message ?? "unknown"}`));
      if (consecutiveFailures >= config.maxConsecutiveFailures) fail("too many failed detections");
    }
    // Anything else (a late result for an old id) is dropped.
  }

  return {

    /* Creates the worker and waits until it can detect. Rejects on error or timeout. */
    start(options) {
      if (failed) return Promise.reject(new Error("person worker already failed"));
      if (worker) return Promise.reject(new Error("person worker already started"));

      return new Promise((resolve, reject) => {
        try {
          worker = createWorker();
        } catch (error) {
          failed = true;
          reject(error);
          return;
        }

        starting = {
          resolve,
          reject,
          timer: timers.setTimeout(() => fail(`init timed out after ${config.initTimeoutMs} ms`), config.initTimeoutMs)
        };

        worker.onmessage = onMessage;
        worker.onerror = event => fail(`worker error: ${event?.message ?? "unknown"}`);
        worker.postMessage({ type: "init", ...options });
      });
    },

    /*
     * Sends the current frame of `source` (a <video>) for detection. Returns null when the worker is not
     * ready or still busy (the caller just tries again on its next frame); otherwise a promise for
     * { detections, inferMs, timestamp, roundTripMs }, which rejects on a failed frame.
     */
    detect(source, timestamp) {
      if (!ready || failed || !worker) return null;
      if (pending) {
        stats.busySkips += 1;
        return null;
      }

      const id = nextId;
      nextId += 1;

      const promise = new Promise((resolve, reject) => {
        pending = { id, timer: null, resolve, reject, sentAt: now(), timestamp };
      });
      const mine = pending;

      Promise.resolve()
        .then(() => createBitmap(source))
        .then(bitmap => {
          if (pending !== mine || failed || !worker) {
            try { bitmap?.close?.(); } catch { /* ignore */ }
            return;
          }
          mine.timer = timers.setTimeout(
            () => fail(`detection ${id} not answered within ${config.detectTimeoutMs} ms`),
            config.detectTimeoutMs
          );
          stats.sent += 1;
          worker.postMessage({ type: "detect", id, bitmap, timestamp }, [bitmap]);
        })
        .catch(error => {
          if (pending !== mine) return;
          pending = null;
          stats.bitmapErrors += 1;
          consecutiveFailures += 1;
          mine.reject(error);
          if (consecutiveFailures >= config.maxConsecutiveFailures) fail("too many frames could not be sent");
        });

      return promise;
    },

    busy: () => pending !== null,
    isReady: () => ready && !failed,
    hasFailed: () => failed,
    getDelegate: () => delegate,
    getStats: () => ({ ...stats }),

    stop() {
      clear(pending);
      clear(starting);
      const wasPending = pending;
      pending = null;
      starting = null;
      if (wasPending) wasPending.reject(new Error("person worker stopped"));
      if (worker) {
        try { worker.postMessage({ type: "close" }); } catch { /* ignore */ }
      }
      terminate();
      failed = true;                // a stopped client is never used again
    }
  };
}
