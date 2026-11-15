/*
 * Unit tests for js/motion-smoother.js.
 *   node --test tests/motion-smoother.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createMotionSmoother, SMOOTH_REASON } from "../js/motion-smoother.js";
import { MOTION_COMMAND as C, MOTION_REASON as R } from "../js/motion-decision.js";
import { TRACK_STATE as T } from "../js/person-tracker.js";

const move = (command, offset = 0, heightRatio = 0.5) => ({ command, reason: "X", offset, heightRatio });
const stopFor = reason => ({ command: C.STOP, reason });

test("movement passes through with its detection time", () => {
  const s = createMotionSmoother();
  assert.deepEqual(s.apply(move(C.FORWARD), T.TRACKING, 100, 120),
    { command: C.FORWARD, detectionTime: 100, reason: "X" });
});

test("movement without a detection time is STOP", () => {
  const s = createMotionSmoother();
  assert.equal(s.apply(move(C.FORWARD), T.TRACKING, null, 120).command, C.STOP);
});

test("one missed detection repeats the last movement with the ORIGINAL detection time", () => {
  const s = createMotionSmoother();
  s.apply(move(C.LEFT, -0.5), T.TRACKING, 100, 110);
  const r = s.apply(stopFor(R.TARGET_NOT_MATCHED), T.SEARCHING, 100, 300);
  assert.equal(r.command, C.LEFT);
  assert.equal(r.detectionTime, 100);
  assert.equal(r.reason, SMOOTH_REASON.HELD_THROUGH_MISS);
});

test("the hold ends after holdMs and never refreshes itself", () => {
  const s = createMotionSmoother({ holdMs: 400 });
  s.apply(move(C.FORWARD), T.TRACKING, 100, 110);
  assert.equal(s.apply(stopFor(R.NOT_TRACKING), T.SEARCHING, 100, 400).command, C.FORWARD);
  assert.equal(s.apply(stopFor(R.NOT_TRACKING), T.SEARCHING, 100, 511).command, C.STOP);
  assert.equal(s.apply(stopFor(R.NOT_TRACKING), T.SEARCHING, 100, 520).command, C.STOP);
});

test("only a SEARCHING miss is held: LOST, stale, camera and other stops are immediate", () => {
  for (const [reason, state] of [
    [R.NOT_TRACKING, T.LOST],
    [R.STALE_TARGET, T.SEARCHING],
    [R.CAMERA_UNAVAILABLE, T.SEARCHING],
    [R.TARGET_TOO_SMALL, T.TRACKING],
    [R.INVALID_BOX, T.SEARCHING],
    ["SOMETHING_NEW", T.SEARCHING]
  ]) {
    const s = createMotionSmoother();
    s.apply(move(C.FORWARD), T.TRACKING, 100, 110);
    assert.equal(s.apply(stopFor(reason), state, 100, 150).command, C.STOP, `${reason}/${state}`);
  }
});

test("no hold without a previous movement", () => {
  const s = createMotionSmoother();
  assert.equal(s.apply(stopFor(R.TARGET_NOT_MATCHED), T.SEARCHING, 100, 150).command, C.STOP);
});

test("close-enough hysteresis: after a close STOP, resume only below resumeHeightRatio", () => {
  const s = createMotionSmoother({ resumeHeightRatio: 0.70 });
  s.apply(move(C.FORWARD, 0, 0.6), T.TRACKING, 100, 110);
  assert.equal(s.apply(stopFor(R.TARGET_CLOSE_ENOUGH), T.TRACKING, 200, 210).command, C.STOP);
  const held = s.apply(move(C.FORWARD, 0, 0.78), T.TRACKING, 300, 310);
  assert.equal(held.command, C.STOP);
  assert.equal(held.reason, SMOOTH_REASON.CLOSE_HYSTERESIS);
  assert.equal(s.apply(move(C.FORWARD, 0, 0.69), T.TRACKING, 400, 410).command, C.FORWARD);
});

test("a close STOP is never held through, even right after a movement", () => {
  const s = createMotionSmoother();
  s.apply(move(C.FORWARD), T.TRACKING, 100, 110);
  assert.equal(s.apply(stopFor(R.TARGET_CLOSE_ENOUGH), T.SEARCHING, 100, 150).command, C.STOP);
});

test("turn hysteresis: keeps turning until the person is back near the centre", () => {
  const s = createMotionSmoother({ straightBandRatio: 0.10 });
  s.apply(move(C.RIGHT, 0.3), T.TRACKING, 100, 110);
  const r = s.apply(move(C.FORWARD, 0.15), T.TRACKING, 200, 210);
  assert.equal(r.command, C.RIGHT);
  assert.equal(r.reason, SMOOTH_REASON.TURN_HYSTERESIS);
  assert.equal(s.apply(move(C.FORWARD, 0.05), T.TRACKING, 300, 310).command, C.FORWARD);
});

test("turn hysteresis never turns toward the wrong side", () => {
  const s = createMotionSmoother();
  s.apply(move(C.RIGHT, 0.3), T.TRACKING, 100, 110);
  assert.equal(s.apply(move(C.FORWARD, -0.15), T.TRACKING, 200, 210).command, C.FORWARD);
});

test("reset() forgets the last movement and the close latch", () => {
  const s = createMotionSmoother();
  s.apply(move(C.FORWARD), T.TRACKING, 100, 110);
  s.apply(stopFor(R.TARGET_CLOSE_ENOUGH), T.TRACKING, 200, 210);
  s.reset();
  assert.equal(s.apply(move(C.FORWARD, 0, 0.75), T.TRACKING, 300, 310).command, C.FORWARD);
  s.reset();
  assert.equal(s.apply(stopFor(R.TARGET_NOT_MATCHED), T.SEARCHING, 300, 320).command, C.STOP);
});
