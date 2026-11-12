/*
 * Unit tests for js/person-tracker.js (Phase C).
 *
 * Run from the repository root (Node 18+, no packages needed):
 *
 *     node --test tests/person-tracker.test.mjs
 *
 * The tracker is pure logic (no DOM, no MediaPipe), so every test feeds
 * detection results by hand with explicit timestamps in milliseconds.
 * Frame size is 640x480 like the app's camera request.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPersonTracker,
  clientPointToVideo,
  iou,
  TRACK_STATE,
  LOST_REASON
} from "../js/person-tracker.js";

const W = 640;
const H = 480;
const LOST_AFTER_MS = 2500;   // default lostAfterMs in person-tracker.js
const SMOOTH_MS = 400;        // default smoothMs: drawn boxes glide this long

/* The selected drawable once its glide animation has finished. */
function settledSelected(tracker, lastUpdateMs) {
  return tracker.getDrawables(lastUpdateMs + SMOOTH_MS).find(item => item.selected);
}

function person(x, y, w = 160, h = 300, score = 0.9) {
  return { box: { originX: x, originY: y, width: w, height: h }, score };
}

function centreOf(p) {
  return [p.box.originX + p.box.width / 2, p.box.originY + p.box.height / 2];
}

function startTracker() {
  const tracker = createPersonTracker();
  tracker.reset();
  return tracker;
}

/* Tracker with `p` detected at t and selected by tapping its centre. */
function trackerWithSelection(p, t = 0) {
  const tracker = startTracker();
  tracker.update([p], t, W, H);
  const result = tracker.selectAt(...centreOf(p), t);
  assert.equal(result.ok, true, JSON.stringify(result));
  return tracker;
}

/* Feeds empty detections every 500 ms (the app's PERSON_INTERVAL). */
function feedEmpty(tracker, from, to, hints) {
  for (let t = from; t <= to; t += 500) tracker.update([], t, W, H, hints);
}

const state = tracker => tracker.getSnapshot().state;

// --------------------------------------------------
// States before any selection
// --------------------------------------------------

test("starts STOPPED; reset() waits for the first detection", () => {
  const tracker = createPersonTracker();
  assert.equal(state(tracker), TRACK_STATE.STOPPED);
  tracker.reset();
  assert.equal(state(tracker), TRACK_STATE.WAITING);
});

test("NO_PERSON with no detections, NOT_SELECTED with people", () => {
  const tracker = startTracker();
  tracker.update([], 0, W, H);
  assert.equal(state(tracker), TRACK_STATE.NO_PERSON);
  tracker.update([person(100, 100), person(400, 100)], 500, W, H);
  assert.deepEqual(tracker.getSnapshot(), {
    state: TRACK_STATE.NOT_SELECTED, selectedId: null, personCount: 2, lostReason: null
  });
});

test("while STOPPED, updates are ignored and taps are refused", () => {
  const tracker = createPersonTracker();
  tracker.update([person(100, 100)], 0, W, H);
  assert.equal(state(tracker), TRACK_STATE.STOPPED);
  assert.deepEqual(tracker.selectAt(180, 250, 0), { ok: false, reason: "NOT_RUNNING" });
});

// --------------------------------------------------
// Selecting a box (tap hit-test)
// --------------------------------------------------

test("tap inside a box selects it and starts TRACKING with id 1", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100)], 0, W, H);
  assert.deepEqual(tracker.selectAt(180, 250, 0), { ok: true, id: 1 });
  assert.equal(state(tracker), TRACK_STATE.TRACKING);
  assert.equal(tracker.getSnapshot().selectedId, 1);
});

test("tap on empty space is refused and nothing is selected", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100)], 0, W, H);
  assert.deepEqual(tracker.selectAt(600, 40, 0), { ok: false, reason: "NO_PERSON_AT_POINT" });
  assert.equal(state(tracker), TRACK_STATE.NOT_SELECTED);
});

test("tap just outside a box (finger padding) still selects it", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100)], 0, W, H);
  // Box right edge is x=260; padding is 4 % of 480 = 19.2 px.
  assert.equal(tracker.selectAt(270, 250, 0).ok, true);
  assert.equal(tracker.selectAt(300, 250, 0).ok, false);
});

test("overlapping boxes: the smaller box wins", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100, 300, 380), person(150, 150, 100, 200)], 0, W, H);
  tracker.selectAt(200, 250, 0);
  assert.equal(settledSelected(tracker, 0).box.width, 100);
});

test("tap on the DRAWN box while it glides selects that person", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100)], 0, W, H);
  tracker.update([person(220, 100)], 500, W, H);   // moved 120 px right
  // 50 ms later the drawn box is still around x=100..260; x=120 is outside
  // the new detection (220..380) but inside what the user sees.
  assert.equal(tracker.selectAt(120, 250, 550).ok, true);
  assert.equal(state(tracker), TRACK_STATE.TRACKING);
});

test("tap on the latest detected box also selects it while gliding", () => {
  const tracker = startTracker();
  tracker.update([person(100, 100)], 0, W, H);
  tracker.update([person(220, 100)], 500, W, H);
  assert.equal(tracker.selectAt(370, 250, 550).ok, true);
});

test("tapping the selected box again keeps its id; a new box gets a new id", () => {
  const a = person(60, 100);
  const b = person(400, 100);
  const tracker = startTracker();
  tracker.update([a, b], 0, W, H);
  assert.equal(tracker.selectAt(...centreOf(a), 0).id, 1);
  assert.equal(tracker.selectAt(...centreOf(a), 10).id, 1);
  assert.equal(tracker.selectAt(...centreOf(b), 20).id, 2);
  const selected = tracker.getDrawables(20 + SMOOTH_MS).filter(item => item.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].box.originX, 400);
});

test("clearSelection() drops the target", () => {
  const tracker = trackerWithSelection(person(100, 100));
  tracker.clearSelection(10);
  assert.equal(tracker.getSnapshot().selectedId, null);
  assert.equal(state(tracker), TRACK_STATE.NOT_SELECTED);
});

// --------------------------------------------------
// Matching the selected box across detections
// --------------------------------------------------

test("follows the selected person as they move (IoU match)", () => {
  const tracker = trackerWithSelection(person(100, 100));
  for (let i = 1; i <= 10; i++) {
    tracker.update([person(100 + i * 20, 100)], i * 500, W, H);
    assert.equal(state(tracker), TRACK_STATE.TRACKING, `step ${i}`);
  }
  assert.equal(settledSelected(tracker, 5000).box.originX, 300);
});

test("large move with similar size matches by centre distance", () => {
  const tracker = trackerWithSelection(person(100, 100));
  // IoU 0.12 (< minIou 0.15) but the centre moved 125 px, which is
  // 0.57 x sqrt(box area) (< maxCenterDistRatio 0.6).
  assert.equal(iou(person(100, 100).box, person(225, 100).box) < 0.15, true);
  tracker.update([person(225, 100)], 500, W, H);
  assert.equal(state(tracker), TRACK_STATE.TRACKING);
});

test("with two people, stays on the selected one", () => {
  const tracker = startTracker();
  tracker.update([person(60, 100), person(420, 100)], 0, W, H);
  tracker.selectAt(140, 250, 0);
  tracker.update([person(440, 100), person(80, 100)], 500, W, H);   // order swapped
  assert.equal(settledSelected(tracker, 500).box.originX, 80);
});

test("a different-sized box far away is not taken as the target", () => {
  const tracker = trackerWithSelection(person(60, 100));
  tracker.update([person(450, 300, 60, 120)], 500, W, H);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
});

// --------------------------------------------------
// SEARCHING and LOST
// --------------------------------------------------

test("missing target: SEARCHING first, LOST exactly 2.5 s after last seen", () => {
  const tracker = trackerWithSelection(person(240, 100), 0);
  tracker.update([], 500, W, H);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
  tracker.tick(LOST_AFTER_MS - 1);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
  tracker.tick(LOST_AFTER_MS);
  assert.equal(state(tracker), TRACK_STATE.LOST);
  assert.equal(tracker.getSnapshot().selectedId, null);
});

test("SEARCHING keeps drawing the remembered box (dashed) with its id", () => {
  const tracker = trackerWithSelection(person(240, 100));
  tracker.update([], 500, W, H);
  const items = tracker.getDrawables(600);
  assert.equal(items.length, 1);
  assert.equal(items[0].searching, true);
  assert.equal(items[0].id, 1);
});

test("LOST stays visible until the user taps again or clears it", () => {
  const tracker = trackerWithSelection(person(240, 100));
  feedEmpty(tracker, 500, 3500);
  assert.equal(state(tracker), TRACK_STATE.LOST);
  tracker.update([], 4000, W, H);
  assert.equal(state(tracker), TRACK_STATE.LOST);
  tracker.clearSelection(4100);
  assert.equal(state(tracker), TRACK_STATE.NO_PERSON);
});

// --------------------------------------------------
// LOST reason (best guess for the message, see LOST_REASON)
// --------------------------------------------------

const reason = tracker => tracker.getSnapshot().lostReason;

test("vanishing mid-frame while touching the BOTTOM edge -> NOT_FOUND", () => {
  const tracker = trackerWithSelection(person(240, 180));   // bottom = 480
  tracker.update([person(250, 180)], 500, W, H);
  feedEmpty(tracker, 1000, 4000);
  assert.equal(reason(tracker), LOST_REASON.NOT_FOUND);
});

test("moving into the LEFT edge, then gone -> OUT_OF_FRAME", () => {
  const tracker = trackerWithSelection(person(60, 100));
  tracker.update([person(5, 100, 120)], 500, W, H);
  feedEmpty(tracker, 1000, 4000);
  assert.equal(reason(tracker), LOST_REASON.OUT_OF_FRAME);
});

test("moving into the RIGHT edge, then gone -> OUT_OF_FRAME", () => {
  const tracker = trackerWithSelection(person(420, 100));
  tracker.update([person(500, 100, 140)], 500, W, H);   // right = 640
  feedEmpty(tracker, 1000, 4000);
  assert.equal(reason(tracker), LOST_REASON.OUT_OF_FRAME);
});

test("at the right edge but moving away from it -> NOT_FOUND", () => {
  const tracker = trackerWithSelection(person(480, 100));
  tracker.update([person(470, 100, 165)], 500, W, H);
  feedEmpty(tracker, 1000, 4000);
  assert.equal(reason(tracker), LOST_REASON.NOT_FOUND);
});

test("box spanning both side edges (person very close) -> NOT_FOUND", () => {
  const tracker = trackerWithSelection(person(0, 0, 640, 480));
  feedEmpty(tracker, 500, 3500);
  assert.equal(reason(tracker), LOST_REASON.NOT_FOUND);
});

test("frame looked covered while missing -> CAMERA_BLOCKED (beats edge)", () => {
  const tracker = trackerWithSelection(person(60, 100));
  tracker.update([person(5, 100, 120)], 500, W, H);
  feedEmpty(tracker, 1000, 4000, { blocked: true });
  assert.equal(reason(tracker), LOST_REASON.CAMERA_BLOCKED);
});

test("blocked hint is forgotten once the target is found again", () => {
  const tracker = trackerWithSelection(person(240, 100));
  tracker.update([], 500, W, H, { blocked: true });
  tracker.update([person(245, 100)], 1000, W, H);
  feedEmpty(tracker, 1500, 4500);
  assert.equal(reason(tracker), LOST_REASON.NOT_FOUND);
});

test("camera frames stop arriving -> CAMERA_STALLED", () => {
  const tracker = trackerWithSelection(person(240, 100));
  tracker.tick(1000, { stalled: true });
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
  tracker.tick(LOST_AFTER_MS, { stalled: true });
  assert.equal(reason(tracker), LOST_REASON.CAMERA_STALLED);
});

// --------------------------------------------------
// Person coming back into the picture
// --------------------------------------------------

test("returns near the last place while SEARCHING -> TRACKING again, same id", () => {
  const tracker = trackerWithSelection(person(240, 100));
  tracker.update([], 500, W, H);
  tracker.update([], 1000, W, H);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
  tracker.update([person(260, 110)], 1500, W, H);
  assert.equal(state(tracker), TRACK_STATE.TRACKING);
  assert.equal(tracker.getSnapshot().selectedId, 1);
  // The grace time restarts from the new sighting.
  tracker.update([], 2000, W, H);
  tracker.tick(1500 + LOST_AFTER_MS - 1);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
});

test("someone appearing far from the last place while SEARCHING is not taken", () => {
  const tracker = trackerWithSelection(person(40, 100));
  tracker.update([], 500, W, H);
  tracker.update([person(460, 100)], 1000, W, H);
  assert.equal(state(tracker), TRACK_STATE.SEARCHING);
  feedEmpty(tracker, 1500, 3000);
  assert.equal(state(tracker), TRACK_STATE.LOST);
});

test("after LOST, a returning person is NOT re-selected automatically", () => {
  const tracker = trackerWithSelection(person(240, 100));
  feedEmpty(tracker, 500, 3500);
  assert.equal(state(tracker), TRACK_STATE.LOST);
  tracker.update([person(240, 100)], 4000, W, H);   // same place
  assert.equal(state(tracker), TRACK_STATE.LOST);
  assert.equal(tracker.getDrawables(4000).some(item => item.selected), false);
});

test("after LOST, tapping the returning person starts tracking with a new id", () => {
  const p = person(240, 100);
  const tracker = trackerWithSelection(p);
  feedEmpty(tracker, 500, 3500);
  tracker.update([p], 4000, W, H);
  assert.deepEqual(tracker.selectAt(...centreOf(p), 4000), { ok: true, id: 2 });
  assert.equal(state(tracker), TRACK_STATE.TRACKING);
  assert.equal(tracker.getSnapshot().lostReason, null);
});

// --------------------------------------------------
// Tap position -> video pixels (object-fit: contain)
// --------------------------------------------------

test("clientPointToVideo maps through letterbox bars", () => {
  // 640x480 video shown in a 400x400 element at (10, 20): scale 0.625,
  // shown 400x300, 50 px bars at top and bottom.
  const rect = { left: 10, top: 20, width: 400, height: 400 };
  assert.deepEqual(clientPointToVideo(210, 220, rect, 640, 480), { x: 320, y: 240 });
  assert.deepEqual(clientPointToVideo(10, 70, rect, 640, 480), { x: 0, y: 0 });
  assert.equal(clientPointToVideo(210, 40, rect, 640, 480), null);   // on the bar
  assert.equal(clientPointToVideo(210, 220, rect, 0, 0), null);      // size unknown
});
