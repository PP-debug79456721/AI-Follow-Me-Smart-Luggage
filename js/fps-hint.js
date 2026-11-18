/*
 * Tells the user when the camera delivers fewer frames than the pipeline needs.
 *
 * The camera frame rate is measured from real video frames (camera.js). A phone lowers it by itself in dim
 * light (longer exposure) and a busy page drops frames too; the page cannot fix either, but it can say so,
 * so a low fps is not mistaken for a software fault. The hint appears only after `samples` low readings in a
 * row (one reading per second) and goes away again at `clearAt` or more, so a start-up blip or a single slow
 * second does not flash it.
 *
 * Pure (no DOM), see tests/fps-hint.test.mjs.
 */

export const FPS_HINT_DEFAULTS = Object.freeze({
  low: 10,        // below this is "low"
  clearAt: 12,    // the hint stays until the rate reaches this
  samples: 5      // consecutive low readings before the hint shows
});

export const FPS_HINT_TEXT = "ต่ำ: แสงน้อย/เครื่องหนัก";

export function createFpsHint(options = {}) {

  const config = { ...FPS_HINT_DEFAULTS, ...options };
  let lowRun = 0;
  let showing = false;

  return {

    /* One reading per second. Returns the hint text or null. */
    push(fps) {

      // No reading, or no frames at all (frozen camera has its own NO FRAMES state): nothing to explain.
      if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
        lowRun = 0;
        showing = false;
        return null;
      }

      if (showing) {
        if (fps >= config.clearAt) {
          showing = false;
          lowRun = 0;
        }
        return showing ? FPS_HINT_TEXT : null;
      }

      lowRun = fps < config.low ? lowRun + 1 : 0;

      if (lowRun >= config.samples) showing = true;

      return showing ? FPS_HINT_TEXT : null;
    },

    reset() {
      lowRun = 0;
      showing = false;
    }
  };
}
