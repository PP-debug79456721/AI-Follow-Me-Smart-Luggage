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

export const LITE_MODE = detectLiteMode(
  typeof location !== "undefined" ? location.search : "",
  typeof navigator !== "undefined" ? navigator : {}
);
