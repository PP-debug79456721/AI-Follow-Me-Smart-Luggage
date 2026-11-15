/*
 * Motion smoother (bench, phase 2).
 *
 * Sits between motion-decision.js and the ESP32 session. It removes STOPs that
 * are only noise, and keeps every STOP that matters.
 *
 * 1. Short detector miss: the selected person is not matched in ONE detection
 *    (tracker SEARCHING, reason TARGET_NOT_MATCHED / NOT_TRACKING) right after a
 *    movement. The last movement command is repeated for at most holdMs, with
 *    its ORIGINAL detection time. The link (esp32-link.js) still refuses any
 *    command whose detection is older than ageClaimMaxMs (450 ms) and the device
 *    still ends it by its lease, so this can never extend motion beyond what a
 *    single valid detection already allows.
 * 2. "Close enough" hysteresis: after a STOP because the person is close
 *    (box height >= stopHeightRatio), movement resumes only once the box height
 *    is below resumeHeightRatio. Without it, a person standing right at the
 *    threshold made the luggage jerk: go, stop, go, stop.
 * 3. Turn hysteresis: once turning, the luggage keeps turning until the person
 *    is back within straightBandRatio of the centre (smaller than the decision's
 *    dead band), so it does not flip FORWARD / LEFT at the edge of the band.
 *
 * Never smoothed (always an immediate STOP): camera unavailable, stale or invalid
 * data, target lost, person too small, nothing selected, any unknown reason.
 *
 * Pure: no DOM, timers or network. apply() returns { command, detectionTime,
 * reason }.
 */

import { MOTION_COMMAND, MOTION_REASON } from "./motion-decision.js";
import { TRACK_STATE } from "./person-tracker.js";

export const SMOOTHER_DEFAULTS = Object.freeze({
  holdMs: 400,               // repeat the last movement for at most this long after a miss
  resumeHeightRatio: 0.70,   // resume after "close enough" only below this
  straightBandRatio: 0.10    // while turning, go straight again only within this offset
});

export const SMOOTH_REASON = Object.freeze({
  HELD_THROUGH_MISS: "HELD_THROUGH_MISS",
  CLOSE_HYSTERESIS: "CLOSE_HYSTERESIS",
  TURN_HYSTERESIS: "TURN_HYSTERESIS"
});

const MOVES = new Set([MOTION_COMMAND.FORWARD, MOTION_COMMAND.LEFT, MOTION_COMMAND.RIGHT]);

export function createMotionSmoother(options = {}) {

  const config = { ...SMOOTHER_DEFAULTS, ...options };

  let lastMove = null;        // { command, detectionTime, at }
  let closeLatched = false;

  function stop(reason) {
    lastMove = null;
    return { command: MOTION_COMMAND.STOP, detectionTime: null, reason };
  }

  return {

    /*
     * decision:     result of decideMotion()
     * trackerState: TRACK_STATE value of the tracker right now
     * detectionTime: lastSeenMs of the selected target (null if none)
     * now:          same clock as detectionTime
     */
    apply(decision, trackerState, detectionTime, now) {

      if (!decision || typeof decision !== "object") return stop("NO_DECISION");

      const command = decision.command;

      if (MOVES.has(command)) {

        if (!Number.isFinite(detectionTime)) return stop("NO_DETECTION_TIME");

        // 2. Close-enough hysteresis.
        if (closeLatched) {
          if (Number.isFinite(decision.heightRatio) &&
              decision.heightRatio >= config.resumeHeightRatio) {
            return stop(SMOOTH_REASON.CLOSE_HYSTERESIS);
          }
          closeLatched = false;
        }

        // 3. Turn hysteresis: LEFT/RIGHT -> FORWARD only well inside the centre.
        let out = command;
        let reason = decision.reason;
        if (
          command === MOTION_COMMAND.FORWARD &&
          lastMove &&
          (lastMove.command === MOTION_COMMAND.LEFT || lastMove.command === MOTION_COMMAND.RIGHT) &&
          Number.isFinite(decision.offset) &&
          Math.abs(decision.offset) > config.straightBandRatio &&
          Math.sign(decision.offset) === (lastMove.command === MOTION_COMMAND.LEFT ? -1 : 1)
        ) {
          out = lastMove.command;
          reason = SMOOTH_REASON.TURN_HYSTERESIS;
        }

        lastMove = { command: out, detectionTime, at: now };
        return { command: out, detectionTime, reason };
      }

      // STOP from the decision layer.
      if (decision.reason === MOTION_REASON.TARGET_CLOSE_ENOUGH) {
        closeLatched = true;
        return stop(decision.reason);
      }

      // 1. Short detector miss right after a movement.
      const miss =
        trackerState === TRACK_STATE.SEARCHING &&
        (decision.reason === MOTION_REASON.TARGET_NOT_MATCHED ||
         decision.reason === MOTION_REASON.NOT_TRACKING);

      if (
        miss && lastMove &&
        Number.isFinite(now) && now >= lastMove.at &&
        now - lastMove.at <= config.holdMs
      ) {
        // Same command, ORIGINAL detection time: the link's age limit still applies.
        return {
          command: lastMove.command,
          detectionTime: lastMove.detectionTime,
          reason: SMOOTH_REASON.HELD_THROUGH_MISS
        };
      }

      return stop(decision.reason);
    },

    reset() {
      lastMove = null;
      closeLatched = false;
    }
  };
}
