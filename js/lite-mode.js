/*
 * Lite mode: a lighter pipeline for phones (smaller frames, no face detection).
 *
 *   ?lite=1  force on
 *   ?lite=0  force off (even on a phone)
 *   neither  on when the browser reports a mobile device
 *
 * Pure and DOM-free so it can be tested: pass the search string and a
 * navigator-like object.
 */
export function detectLiteMode(search = "", nav = {}) {
  const value = new URLSearchParams(search).get("lite");
  if (value === "1") return true;
  if (value === "0") return false;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") {
    return nav.userAgentData.mobile;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || "");
}

/*
 * Person detection period. Lite mode (phones) detects less often while FOLLOW is off: nothing
 * moves, so the phone does less work and stays cooler. With FOLLOW on, the normal period is
 * always used (the ESP32 link needs fresh detections).
 */
export function personIntervalFor({ lite, following, normalMs, idleMs }) {
  return lite && !following ? idleMs : normalMs;
}

/*
 * Person detection period while FOLLOW is off in lite mode (waiting, choosing the owner, finding the owner).
 * 500 ms keeps the phone cool but makes the owner search slow (3 rounds of 5 are needed). ?idle=250 (ms)
 * changes it; clamped to 150-1000 ms, anything else gives the default.
 */
export const IDLE_INTERVAL_DEFAULT_MS = 500;

export function idleIntervalFor(search = "", defaultMs = IDLE_INTERVAL_DEFAULT_MS) {
  const raw = new URLSearchParams(search).get("idle");
  if (raw === null || raw.trim() === "") return defaultMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return defaultMs;
  return Math.min(1000, Math.max(150, Math.round(value)));
}

/*
 * Re-ID (ONNX Runtime in WASM) runs on the page's main thread, the same thread that must answer the
 * ESP32 link. Every long task shows up as RTT / page stall, i.e. jerky wheels. So:
 *   - while FOLLOW is on, learning the followed person runs at most once per 4 s on every device (the
 *     album is already built by then); before FOLLOW (enrolment, choosing) it keeps the normal rate,
 *   - in lite mode (phones) the search for the owner (only while nobody is followed) runs at most once
 *     per second. Desktop search values are untouched.
 */
export const REID_FOLLOW_LEARN_MS = 4000;
export const REID_LITE_FOLLOW_LEARN_MS = REID_FOLLOW_LEARN_MS;     // old name, same value
export const REID_LITE_SEARCH_MS = 1000;

export function reidIntervalsFor({ lite, following, learnMs, searchMs }) {
  return {
    learnMs: following ? Math.max(learnMs, REID_FOLLOW_LEARN_MS) : learnMs,
    searchMs: lite ? Math.max(searchMs, REID_LITE_SEARCH_MS) : searchMs
  };
}

/*
 * Face detection period (ms; Infinity = do not run). Faces feed only: enrolment, the FACE CROP EXPORT,
 * finding the owner while nobody is followed, and the cyan face boxes. No motion decision uses them, so
 * while FOLLOW is on and a person is being followed (TRACKING / SEARCHING) the detector is skipped, which
 * removes a main-thread task every 500 ms. It runs again the moment the follow ends, the owner is lost
 * (LOST: the wheels are already stopped), or an enrolment / crop export is waiting for a face.
 * Lite mode never runs it.
 */
export function faceIntervalFor({ lite, following, tracking, enrolling = false, cropPending = false, normalMs }) {
  if (lite) return Infinity;
  if (enrolling || cropPending) return normalMs;
  if (following && tracking) return Infinity;
  return normalMs;
}

/*
 * Run the person detector in a Web Worker (js/person-worker.js) so the main thread stays free for the
 * ESP32 link.  ?worker=1 on, ?worker=0 off.  With neither, WORKER_DEFAULT_IN_LITE decides for phones
 * (lite mode); it stays false until the worker path has been tried on a real phone.
 */
export const WORKER_DEFAULT_IN_LITE = false;

export function workerModeFor(search = "", lite = false, defaultInLite = WORKER_DEFAULT_IN_LITE) {
  const value = new URLSearchParams(search).get("worker");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(lite && defaultInLite);
}

export const LITE_MODE = detectLiteMode(
  typeof location !== "undefined" ? location.search : "",
  typeof navigator !== "undefined" ? navigator : {}
);
