/*
 * Unit tests for js/motion-decision.js and the tracker's getTarget().
 * No DOM, no packages. Run from the repository root:
 *   node --test tests/motion-decision.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  decideMotion,
  MOTION_COMMAND as C,
  MOTION_REASON as R,
  MOTION_DEFAULTS
} from "../js/motion-decision.js";

import {
  createPersonTracker,
  TRACK_STATE
} from "../js/person-tracker.js";

const W = 640;
const H = 480;

// A centred, mid-size, fresh target: the base case that moves FORWARD.
function input(overrides = {}) {
  return {
    cameraLive: true,
    state: TRACK_STATE.TRACKING,
    matched: true,
    box: { originX: 270, originY: 120, width: 100, height: 240 }, // h = 0.5
    frameWidth: W,
    frameHeight: H,
    lastSeenMs: 1000,
    now: 1100,
    ...overrides
  };
}

function boxAtCenterX(cx, height = 240) {
  return { originX: cx - 50, originY: 100, width: 100, height };
}

function assertStop(result, reason) {
  assert.equal(result.command, C.STOP);
  if (reason) assert.equal(result.reason, reason);
}

// ---------- Movement ----------

test("centred, fresh, mid-size target moves FORWARD", () => {
  const r = decideMotion(input());
  assert.equal(r.command, C.FORWARD);
  assert.equal(r.reason, R.CENTERED_FOLLOW);
  assert.ok(Math.abs(r.offset) < 1e-9);
  assert.equal(r.heightRatio, 0.5);
  assert.equal(r.ageMs, 100);
});

test("target left of the dead band turns LEFT", () => {
  const r = decideMotion(input({ box: boxAtCenterX(100) }));
  assert.equal(r.command, C.LEFT);
  assert.equal(r.reason, R.TURN_LEFT);
  assert.ok(r.offset < -0.2);
});

test("target right of the dead band turns RIGHT", () => {
  const r = decideMotion(input({ box: boxAtCenterX(560) }));
  assert.equal(r.command, C.RIGHT);
  assert.equal(r.reason, R.TURN_RIGHT);
  assert.ok(r.offset > 0.2);
});

test("dead band edge is inclusive: |offset| = 0.20 still goes FORWARD", () => {
  // half = 320, offset 0.20 -> centre x = 320 + 64 = 384
  assert.equal(decideMotion(input({ box: boxAtCenterX(384) })).command, C.FORWARD);
  assert.equal(decideMotion(input({ box: boxAtCenterX(256) })).command, C.FORWARD);
  // just beyond turns
  assert.equal(decideMotion(input({ box: boxAtCenterX(385) })).command, C.RIGHT);
  assert.equal(decideMotion(input({ box: boxAtCenterX(255) })).command, C.LEFT);
});

test("offset is -1 / +1 at the frame edges and clamped", () => {
  const left = decideMotion(input({ box: { originX: -30, originY: 100, width: 60, height: 240 } }));
  assert.equal(left.offset, -1);
  assert.equal(left.command, C.LEFT);
  const right = decideMotion(input({ box: { originX: 610, originY: 100, width: 60, height: 240 } }));
  assert.equal(right.offset, 1);
  assert.equal(right.command, C.RIGHT);
});

// ---------- Distance ----------

test("close enough (height >= 0.80) STOPs, even when off centre", () => {
  // 384 / 480 = 0.8 exactly
  assertStop(decideMotion(input({ box: { originX: 270, originY: 0, width: 100, height: 384 } })), R.TARGET_CLOSE_ENOUGH);
  assertStop(decideMotion(input({ box: { originX: 500, originY: 0, width: 100, height: 440 } })), R.TARGET_CLOSE_ENOUGH);
});

test("just below the stop height still follows", () => {
  const r = decideMotion(input({ box: { originX: 270, originY: 0, width: 100, height: 383 } }));
  assert.equal(r.command, C.FORWARD);
});

test("too small (height < 0.10) STOPs; exactly 0.10 follows", () => {
  assertStop(decideMotion(input({ box: { originX: 300, originY: 200, width: 20, height: 47 } })), R.TARGET_TOO_SMALL);
  assert.equal(decideMotion(input({ box: { originX: 300, originY: 200, width: 20, height: 48 } })).command, C.FORWARD);
});

// ---------- Tracker state: only TRACKING moves ----------

test("every state except TRACKING STOPs", () => {
  for (const state of Object.values(TRACK_STATE)) {
    const r = decideMotion(input({ state }));
    if (state === TRACK_STATE.TRACKING) {
      assert.equal(r.command, C.FORWARD);
    } else {
      assertStop(r, R.NOT_TRACKING);
    }
  }
});

test("SEARCHING, LOST, WAITING, NO_PERSON, NOT_SELECTED, STOPPED stop explicitly", () => {
  for (const state of ["SEARCHING", "LOST", "WAITING", "NO_PERSON", "NOT_SELECTED", "STOPPED"]) {
    assertStop(decideMotion(input({ state })), R.NOT_TRACKING);
  }
});

test("unknown, missing or wrong-case state STOPs", () => {
  for (const state of [undefined, null, "", "tracking", "Tracking", "MOVING", 1, {}]) {
    assertStop(decideMotion(input({ state })), R.NOT_TRACKING);
  }
});

test("TRACKING but not matched STOPs", () => {
  assertStop(decideMotion(input({ matched: false })), R.TARGET_NOT_MATCHED);
  for (const matched of [undefined, null, 1, "true"]) {
    assertStop(decideMotion(input({ matched })), R.TARGET_NOT_MATCHED);
  }
});

// ---------- Camera ----------

test("camera not live STOPs (strict boolean true required)", () => {
  assertStop(decideMotion(input({ cameraLive: false })), R.CAMERA_UNAVAILABLE);
  for (const cameraLive of [undefined, null, 1, "true", {}]) {
    assertStop(decideMotion(input({ cameraLive })), R.CAMERA_UNAVAILABLE);
  }
});

test("camera check wins over everything else", () => {
  assertStop(decideMotion(input({ cameraLive: false, state: "LOST" })), R.CAMERA_UNAVAILABLE);
});

// ---------- Staleness and time ----------

test("data exactly 700 ms old is accepted, 701 ms is STOP", () => {
  assert.equal(decideMotion(input({ lastSeenMs: 1000, now: 1700 })).command, C.FORWARD);
  const r = decideMotion(input({ lastSeenMs: 1000, now: 1701 }));
  assertStop(r, R.STALE_TARGET);
  assert.equal(r.ageMs, 701);
});

test("very old data STOPs", () => {
  assertStop(decideMotion(input({ lastSeenMs: 0, now: 60000 })), R.STALE_TARGET);
});

test("stale threshold can be overridden per call", () => {
  assertStop(decideMotion(input({ lastSeenMs: 1000, now: 1300 }), { staleAfterMs: 200 }), R.STALE_TARGET);
  assert.equal(decideMotion(input({ lastSeenMs: 1000, now: 1300 }), { staleAfterMs: 400 }).command, C.FORWARD);
});

test("target seen in the future STOPs", () => {
  assertStop(decideMotion(input({ lastSeenMs: 2000, now: 1000 })), R.INVALID_TIME);
});

test("invalid timestamps STOP", () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, "1000"]) {
    assertStop(decideMotion(input({ now: bad })), R.INVALID_TIME);
    assertStop(decideMotion(input({ lastSeenMs: bad })), R.INVALID_TIME);
  }
});

// ---------- Frame dimensions ----------

test("invalid frame dimensions STOP", () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null, "640"]) {
    assertStop(decideMotion(input({ frameWidth: bad })), R.INVALID_FRAME);
    assertStop(decideMotion(input({ frameHeight: bad })), R.INVALID_FRAME);
  }
});

// ---------- Box validity ----------

test("invalid box coordinates STOP", () => {
  const good = { originX: 270, originY: 120, width: 100, height: 240 };
  for (const field of ["originX", "originY", "width", "height"]) {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, "5"]) {
      assertStop(decideMotion(input({ box: { ...good, [field]: bad } })), R.INVALID_BOX);
    }
  }
  assertStop(decideMotion(input({ box: null })), R.INVALID_BOX);
  assertStop(decideMotion(input({ box: undefined })), R.INVALID_BOX);
});

test("zero or negative box size STOPs", () => {
  assertStop(decideMotion(input({ box: { originX: 270, originY: 120, width: 0, height: 240 } })), R.INVALID_BOX);
  assertStop(decideMotion(input({ box: { originX: 270, originY: 120, width: 100, height: 0 } })), R.INVALID_BOX);
  assertStop(decideMotion(input({ box: { originX: 270, originY: 120, width: -100, height: 240 } })), R.INVALID_BOX);
});

test("box far outside the frame STOPs; slightly outside is tolerated", () => {
  assertStop(decideMotion(input({ box: { originX: 2000, originY: 100, width: 100, height: 240 } })), R.INVALID_BOX);
  assertStop(decideMotion(input({ box: { originX: -500, originY: 100, width: 100, height: 240 } })), R.INVALID_BOX);
  assertStop(decideMotion(input({ box: { originX: 270, originY: 300, width: 100, height: 240 } })), R.INVALID_BOX);
  // 10 % of 640 = 64 px of tolerance
  assert.notEqual(decideMotion(input({ box: { originX: -40, originY: 100, width: 100, height: 240 } })).reason, R.INVALID_BOX);
});

// ---------- Robustness ----------

test("missing or non-object input STOPs and never throws", () => {
  for (const bad of [undefined, null, 0, "x", [], () => {}]) {
    assert.doesNotThrow(() => decideMotion(bad));
    assert.equal(decideMotion(bad).command, C.STOP);
  }
  assertStop(decideMotion({}), R.CAMERA_UNAVAILABLE);
});

test("the result is always one of the four commands", () => {
  const allowed = new Set(Object.values(C));
  for (const cx of [-100, 0, 100, 320, 560, 640, 900]) {
    for (const h of [0, 10, 47, 100, 300, 384, 500]) {
      for (const state of Object.values(TRACK_STATE)) {
        const r = decideMotion(input({ state, box: boxAtCenterX(cx, h) }));
        assert.ok(allowed.has(r.command));
        if (state !== TRACK_STATE.TRACKING) assert.equal(r.command, C.STOP);
      }
    }
  }
});

test("input is not modified", () => {
  const i = input();
  const copy = JSON.parse(JSON.stringify(i));
  decideMotion(i);
  assert.deepEqual(i, copy);
});

test("documented defaults", () => {
  assert.equal(MOTION_DEFAULTS.staleAfterMs, 700);
  assert.equal(MOTION_DEFAULTS.deadBandRatio, 0.2);
  assert.equal(MOTION_DEFAULTS.minHeightRatio, 0.1);
  assert.equal(MOTION_DEFAULTS.stopHeightRatio, 0.8);
  assert.equal(MOTION_DEFAULTS.boxToleranceRatio, 0.1);
  assert.ok(Object.isFrozen(MOTION_DEFAULTS));
});

// ---------- Integration with the real tracker (getTarget) ----------

function person(cx, height = 240) {
  return { box: { originX: cx - 50, originY: 100, width: 100, height }, score: 0.9 };
}

function decideFromTracker(tracker, now, cameraLive = true) {
  const target = tracker.getTarget();
  if (!target) return decideMotion({ cameraLive, state: tracker.getSnapshot().state, now });
  return decideMotion({ ...target, now, cameraLive });
}

test("tracker.getTarget() is null with no selection", () => {
  const t = createPersonTracker();
  assert.equal(t.getTarget(), null);
  t.reset();
  t.update([person(320)], 0, W, H);
  assert.equal(t.getTarget(), null);
  assert.equal(decideFromTracker(t, 10).command, C.STOP);
});

test("selected person: raw box and frame size are exposed, then FORWARD", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  assert.equal(t.selectAt(320, 200, 0).ok, true);
  t.update([person(330)], 250, W, H);

  const target = t.getTarget();
  assert.deepEqual(target.box, { originX: 280, originY: 100, width: 100, height: 240 });
  assert.equal(target.frameWidth, W);
  assert.equal(target.frameHeight, H);
  assert.equal(target.state, TRACK_STATE.TRACKING);
  assert.equal(target.matched, true);
  assert.equal(target.lastSeenMs, 250);

  assert.equal(decideFromTracker(t, 300).command, C.FORWARD);
});

test("getTarget() returns the RAW box, not the gliding drawn box", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(200)], 0, W, H);
  t.selectAt(200, 200, 0);
  t.update([person(260)], 1000, W, H);

  // Immediately after the update the DRAWN box is still near the old place...
  const drawn = t.getDrawables(1000).find(d => d.selected).box;
  assert.ok(drawn.originX < 210 - 1);

  // ...but the target used for control is already the new detection.
  assert.equal(t.getTarget().box.originX, 210);
});

test("getTarget() returns copies", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  const a = t.getTarget();
  a.box.originX = -9999;
  a.matched = false;
  const b = t.getTarget();
  assert.equal(b.box.originX, 270);
  assert.equal(b.matched, true);
});

test("tracker SEARCHING stops, returning person while SEARCHING resumes", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  t.update([person(320)], 250, W, H);
  assert.equal(decideFromTracker(t, 260).command, C.FORWARD);

  t.update([], 500, W, H);
  assert.equal(t.getTarget().state, TRACK_STATE.SEARCHING);
  assertStop(decideFromTracker(t, 510), R.NOT_TRACKING);

  t.update([person(320)], 750, W, H);
  assert.equal(decideFromTracker(t, 760).command, C.FORWARD);
});

test("tracker LOST stops and exposes no target", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  t.update([], 250, W, H);
  t.tick(3000);
  assert.equal(t.getSnapshot().state, TRACK_STATE.LOST);
  assert.equal(t.getTarget(), null);
  assertStop(decideFromTracker(t, 3000), R.NOT_TRACKING);
});

test("a stalled camera makes the tracker SEARCHING, so it STOPs", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  t.update([person(320)], 250, W, H);
  t.tick(500, { stalled: true });
  assertStop(decideFromTracker(t, 500), R.NOT_TRACKING);
});

test("TRACKING with no new detection becomes STALE before the tracker loses it", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  t.update([person(320)], 250, W, H);
  // No update and no tick for a while: tracker still says TRACKING.
  assert.equal(t.getTarget().state, TRACK_STATE.TRACKING);
  assert.equal(decideFromTracker(t, 950).command, C.FORWARD);   // 700 ms old
  assertStop(decideFromTracker(t, 951), R.STALE_TARGET);        // 701 ms old
});

test("stopped tracker and dead camera STOP", () => {
  const t = createPersonTracker();
  t.reset();
  t.update([person(320)], 0, W, H);
  t.selectAt(320, 200, 0);
  t.update([person(320)], 250, W, H);
  assertStop(decideFromTracker(t, 260, false), R.CAMERA_UNAVAILABLE);
  t.stop();
  assert.equal(t.getTarget(), null);
  assertStop(decideFromTracker(t, 260), R.NOT_TRACKING);
});
