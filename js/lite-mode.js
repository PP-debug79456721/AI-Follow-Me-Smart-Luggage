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
 * Re-ID (ONNX Runtime in WASM) runs on the page's main thread, the same thread that must answer the
 * ESP32 link. On a phone, with the link gate at 300 ms, every long task shows up as RTT. So in lite mode:
 *   - the search for the owner (only while nobody is followed) runs at most once per second,
 *   - learning the followed person runs at most once per 4 s while FOLLOW is on (the album is already
 *     built by then); before FOLLOW (enrolment, choosing) it keeps the normal rate.
 * Desktop values are untouched.
 */
export const REID_LITE_FOLLOW_LEARN_MS = 4000;
export const REID_LITE_SEARCH_MS = 1000;

export function reidIntervalsFor({ lite, following, learnMs, searchMs }) {
  if (!lite) return { learnMs, searchMs };
  return {
    learnMs: following ? Math.max(learnMs, REID_LITE_FOLLOW_LEARN_MS) : learnMs,
    searchMs: Math.max(searchMs, REID_LITE_SEARCH_MS)
  };
}

export const LITE_MODE = detectLiteMode(
  typeof location !== "undefined" ? location.search : "",
  typeof navigator !== "undefined" ? navigator : {}
);
