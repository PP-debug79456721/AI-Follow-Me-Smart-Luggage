/*
 * Motion decision (Phase 1).
 *
 * Turns the selected person's RAW detection box into one motion command:
 * STOP, FORWARD, LEFT or RIGHT. It is pure: no DOM, no timers, no network,
 * no hardware. It only returns a decision; nothing here drives a motor.
 *
 * Fail-safe rule: the answer is STOP unless every check below passes.
 * Only the tracker state TRACKING can ever produce FORWARD / LEFT / RIGHT.
 *
 * Input (all required, anything missing or invalid gives STOP):
 *   cameraLive   boolean  camera delivers frames AND detection is running
 *   state        string   TRACK_STATE value from person-tracker.js
 *   matched      boolean  the selected box was matched in the latest detection
 *   box          { originX, originY, width, height } in VIDEO pixels.
 *                RAW detection box, never the smoothed drawing box.
 *   frameWidth, frameHeight   video size in pixels
 *   lastSeenMs   time the box was last matched (same clock as now)
 *   now          current time in ms (same clock as lastSeenMs)
 *
 * Geometry assumptions (see README "Motion decision"):
 *   - Raw, NOT mirrored, video pixels from a camera facing the same way as
 *     the luggage moves. Image left = turn left, image right = turn right.
 *   - A closer person has a taller box, so box height / frame height is
 *     used as the distance cue. It is a cue, not a measured distance.
 */

import { TRACK_STATE } from "./person-tracker.js";

export const MOTION_COMMAND = Object.freeze({
  STOP: "STOP",
  FORWARD: "FORWARD",
  LEFT: "LEFT",
  RIGHT: "RIGHT"
});

/* Why the command is what it is (shown / logged, never parsed by a device). */
export const MOTION_REASON = Object.freeze({
  // STOP reasons
  CAMERA_UNAVAILABLE: "CAMERA_UNAVAILABLE",
  NOT_TRACKING: "NOT_TRACKING",
  TARGET_NOT_MATCHED: "TARGET_NOT_MATCHED",
  INVALID_TIME: "INVALID_TIME",
  STALE_TARGET: "STALE_TARGET",
  INVALID_FRAME: "INVALID_FRAME",
  INVALID_BOX: "INVALID_BOX",
  TARGET_TOO_SMALL: "TARGET_TOO_SMALL",
  TARGET_CLOSE_ENOUGH: "TARGET_CLOSE_ENOUGH",
  // Movement reasons
  CENTERED_FOLLOW: "CENTERED_FOLLOW",
  TURN_LEFT: "TURN_LEFT",
  TURN_RIGHT: "TURN_RIGHT"
});

/*
 * Thresholds. All values are explicit and can be overridden per call.
 *
 * staleAfterMs      Target data older than this (now - lastSeenMs) = STOP.
 *                   Detection runs about every 250 ms, so a healthy target
 *                   is at most ~250-300 ms old. 700 ms allows one missed
 *                   detection but stops before the tracker's 2500 ms
 *                   "lost" time. The check is "older than", so exactly
 *                   700 ms is still accepted.
 * deadBandRatio     Horizontal dead band, as a fraction of HALF the frame
 *                   width. |offset| <= 0.20 means "centred": go straight.
 * minHeightRatio    Box height / frame height below this = target too small
 *                   or too far to judge reliably = STOP.
 * stopHeightRatio   Box height / frame height at or above this = person is
 *                   close enough = STOP (do not run into the person).
 * boxToleranceRatio How far a box may stick out of the frame (fraction of
 *                   frame size) before it is treated as invalid. Detectors
 *                   can return boxes slightly outside the image.
 */
export const MOTION_DEFAULTS = Object.freeze({
  staleAfterMs: 700,
  deadBandRatio: 0.20,
  minHeightRatio: 0.10,
  stopHeightRatio: 0.80,
  boxToleranceRatio: 0.10
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stop(reason, extra = {}) {
  return {
    command: MOTION_COMMAND.STOP,
    reason,
    offset: null,
    heightRatio: null,
    ageMs: null,
    ...extra
  };
}

/*
 * Returns { command, reason, offset, heightRatio, ageMs }.
 * offset: -1 (target at the left edge) .. 0 (centre) .. +1 (right edge).
 * Never throws; any unexpected input gives STOP.
 */
export function decideMotion(input, options = {}) {

  const config = { ...MOTION_DEFAULTS, ...options };

  if (!input || typeof input !== "object") {
    return stop(MOTION_REASON.CAMERA_UNAVAILABLE);
  }

  const {
    cameraLive,
    state,
    matched,
    box,
    frameWidth,
    frameHeight,
    lastSeenMs,
    now
  } = input;

  // Strict "=== true": a truthy string or number must not enable movement.
  if (cameraLive !== true) {
    return stop(MOTION_REASON.CAMERA_UNAVAILABLE);
  }

  // Only TRACKING may move. SEARCHING, LOST, WAITING, NO_PERSON,
  // NOT_SELECTED, STOPPED and any unknown value stop.
  if (state !== TRACK_STATE.TRACKING) {
    return stop(MOTION_REASON.NOT_TRACKING);
  }

  if (matched !== true) {
    return stop(MOTION_REASON.TARGET_NOT_MATCHED);
  }

  if (!isFiniteNumber(now) || !isFiniteNumber(lastSeenMs)) {
    return stop(MOTION_REASON.INVALID_TIME);
  }

  const ageMs = now - lastSeenMs;

  // The target cannot have been seen in the future.
  if (ageMs < 0) {
    return stop(MOTION_REASON.INVALID_TIME);
  }

  if (ageMs > config.staleAfterMs) {
    return stop(MOTION_REASON.STALE_TARGET, { ageMs });
  }

  if (
    !isFiniteNumber(frameWidth) || !isFiniteNumber(frameHeight) ||
    frameWidth <= 0 || frameHeight <= 0
  ) {
    return stop(MOTION_REASON.INVALID_FRAME, { ageMs });
  }

  if (
    !box ||
    !isFiniteNumber(box.originX) || !isFiniteNumber(box.originY) ||
    !isFiniteNumber(box.width) || !isFiniteNumber(box.height) ||
    box.width <= 0 || box.height <= 0
  ) {
    return stop(MOTION_REASON.INVALID_BOX, { ageMs });
  }

  const tolX = frameWidth * config.boxToleranceRatio;
  const tolY = frameHeight * config.boxToleranceRatio;

  if (
    box.originX < -tolX ||
    box.originY < -tolY ||
    box.originX + box.width > frameWidth + tolX ||
    box.originY + box.height > frameHeight + tolY
  ) {
    return stop(MOTION_REASON.INVALID_BOX, { ageMs });
  }

  const centerX = box.originX + box.width / 2;
  const half = frameWidth / 2;

  // Clamped to -1..1 (a box slightly outside the frame is tolerated above).
  const offset = Math.max(-1, Math.min(1, (centerX - half) / half));
  const heightRatio = box.height / frameHeight;

  const info = { offset, heightRatio, ageMs };

  if (heightRatio < config.minHeightRatio) {
    return stop(MOTION_REASON.TARGET_TOO_SMALL, info);
  }

  if (heightRatio >= config.stopHeightRatio) {
    return stop(MOTION_REASON.TARGET_CLOSE_ENOUGH, info);
  }

  if (offset < -config.deadBandRatio) {
    return {
      command: MOTION_COMMAND.LEFT,
      reason: MOTION_REASON.TURN_LEFT,
      ...info
    };
  }

  if (offset > config.deadBandRatio) {
    return {
      command: MOTION_COMMAND.RIGHT,
      reason: MOTION_REASON.TURN_RIGHT,
      ...info
    };
  }

  return {
    command: MOTION_COMMAND.FORWARD,
    reason: MOTION_REASON.CENTERED_FOLLOW,
    ...info
  };
}
