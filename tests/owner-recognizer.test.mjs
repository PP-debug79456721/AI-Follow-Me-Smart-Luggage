/*
 * Unit tests for js/owner-recognizer.js (pure logic).
 *   node --test tests/owner-recognizer.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  boxIoU, personForFace, cosine, bestFaceScore,
  colorSignature, signatureSimilarity, blendSignature,
  albumScore, learnIntoAlbum,
  vectorAlbumScore, learnIntoVectorAlbum,
  createAgreement, createFusedAgreement, FUSION_DEFAULTS, RECOGNIZER_DEFAULTS
} from "../js/owner-recognizer.js";

const box = (x, y, w, h) => ({ originX: x, originY: y, width: w, height: h });

/* RGBA image: top half one colour, bottom half another. */
function crop(w, h, top, bottom) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const c = y < h * 0.55 ? top : bottom;
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

const RED = [200, 30, 30], BLUE = [30, 40, 200], BLACK = [15, 15, 15], GREEN = [30, 180, 40];

test("IoU", () => {
  assert.equal(boxIoU(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
  assert.equal(boxIoU(box(0, 0, 10, 10), box(20, 0, 10, 10)), 0);
  assert.ok(Math.abs(boxIoU(box(0, 0, 10, 10), box(5, 0, 10, 10)) - 1 / 3) < 1e-9);
});

test("face goes to the person box that contains its centre; nested boxes -> smallest", () => {
  const persons = [box(0, 0, 100, 300), box(200, 0, 100, 300), box(210, 10, 60, 200)];
  assert.equal(personForFace(box(30, 20, 30, 30), persons), 0);
  assert.equal(personForFace(box(220, 20, 30, 30), persons), 2);
  assert.equal(personForFace(box(500, 20, 30, 30), persons), -1);
});

test("cosine and best score over enrolled samples", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Number.isNaN(cosine([1], [1, 2])));
  assert.equal(bestFaceScore([1, 0], [[0, 1], [1, 0], [1, 1]]), 1);
  assert.ok(Number.isNaN(bestFaceScore([1, 0], [])));
});

test("clothing signature: same outfit ~1, different outfit low", () => {
  const a = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  const b = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  const c = colorSignature(crop(40, 100, GREEN, BLACK), 40, 100);
  assert.ok(signatureSimilarity(a, b) > 0.99);
  assert.ok(signatureSimilarity(a, c) < 0.2);
  assert.equal(colorSignature(crop(4, 4, RED, BLUE), 4, 4), null);
});

test("clothing: same shirt, other trousers scores between", () => {
  const a = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  const d = colorSignature(crop(40, 100, RED, BLACK), 40, 100);
  const s = signatureSimilarity(a, d);
  assert.ok(s > 0.5 && s < 0.7, String(s));
});

test("blendSignature moves slowly", () => {
  const a = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  const c = colorSignature(crop(40, 100, GREEN, BLACK), 40, 100);
  const m = blendSignature(a, c, 0.1);
  assert.ok(signatureSimilarity(m, a) > 0.9);
  assert.equal(blendSignature(null, c), c);
});

const agreement = () => createAgreement({
  threshold: RECOGNIZER_DEFAULTS.faceThreshold,
  margin: RECOGNIZER_DEFAULTS.faceMargin,
  window: 5, need: 3, sameBoxIoU: 0.3
});

test("agreement: a single good round never selects", () => {
  const g = agreement();
  assert.equal(g.push([{ box: box(0, 0, 50, 100), score: 0.7 }]), null);
});

test("agreement: 3 of 5 rounds on the same person selects its latest box", () => {
  const g = agreement();
  g.push([{ box: box(0, 0, 50, 100), score: 0.6 }]);
  g.push([]);
  g.push([{ box: box(2, 0, 50, 100), score: 0.6 }]);
  const r = g.push([{ box: box(4, 0, 50, 100), score: 0.6 }]);
  assert.ok(r);
  assert.equal(r.box.originX, 4);
});

test("agreement: below threshold never selects", () => {
  const g = agreement();
  for (let i = 0; i < 5; i += 1) assert.equal(g.push([{ box: box(0, 0, 50, 100), score: 0.3 }]), null);
});

test("agreement: two people with near-equal scores (ambiguous) -> nobody", () => {
  const g = agreement();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(g.push([
      { box: box(0, 0, 50, 100), score: 0.60 },
      { box: box(200, 0, 50, 100), score: 0.58 }
    ]), null);
  }
});

test("agreement: winners on different people do not add up", () => {
  const g = agreement();
  g.push([{ box: box(0, 0, 50, 100), score: 0.6 }]);
  g.push([{ box: box(300, 0, 50, 100), score: 0.6 }]);
  assert.equal(g.push([{ box: box(0, 0, 50, 100), score: 0.6 }]), null);
  g.reset();
  assert.equal(g.length, 0);
});

test("agreement: NaN scores are ignored", () => {
  const g = agreement();
  for (let i = 0; i < 5; i += 1) assert.equal(g.push([{ box: box(0, 0, 50, 100), score: NaN }]), null);
});

test("album: blend similar, add a plausible new view, skip a different person", () => {
  const front = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  const nearFront = blendSignature(front, colorSignature(crop(40, 100, RED, BLACK), 40, 100), 0.05);
  const back = blendSignature(front, colorSignature(crop(40, 100, GREEN, BLUE), 40, 100), 0.5);
  const stranger = colorSignature(crop(40, 100, GREEN, BLACK), 40, 100);

  let r = learnIntoAlbum([], front);
  assert.equal(r.action, "add");
  r = learnIntoAlbum(r.album, nearFront);
  assert.equal(r.action, "blend");
  assert.equal(r.album.length, 1);
  r = learnIntoAlbum(r.album, back);
  assert.equal(r.action, "add");
  assert.equal(r.album.length, 2);
  const before = r.album.length;
  r = learnIntoAlbum(r.album, stranger);
  assert.equal(r.action, "skip");
  assert.equal(r.album.length, before);
  assert.ok(albumScore(r.album, back) > 0.99);
  assert.ok(albumScore(r.album, stranger) < 0.55);
  assert.ok(Number.isNaN(albumScore([], front)));
});

test("album keeps view 0 and at most maxViews", () => {
  const base = colorSignature(crop(40, 100, RED, BLUE), 40, 100);
  let album = [base];
  for (let k = 1; k <= 6; k += 1) {
    const v = blendSignature(base, colorSignature(crop(40, 100, GREEN, BLUE), 40, 100), 0.12 * k);
    album = learnIntoAlbum(album, v, { maxViews: 3, sameViewAbove: 0.999, newViewAbove: 0 }).album;
  }
  assert.equal(album.length, 3);
  assert.equal(album[0], base);
});

test("Re-ID vector album: blend, add, skip, unit length", () => {
  const a = [1, 0, 0, 0];
  const nearA = [0.99, 0.1, 0, 0];           // cos ~0.995 -> blend
  const side = [0.7, 0.7, 0, 0];             // cos ~0.71 -> new view
  const other = [0, 0, 1, 0];                // cos 0 -> skip
  let r = learnIntoVectorAlbum([], [2, 0, 0, 0]);
  assert.equal(r.action, "add");
  assert.ok(Math.abs(r.album[0][0] - 1) < 1e-9);
  r = learnIntoVectorAlbum(r.album, nearA);
  assert.equal(r.action, "blend");
  r = learnIntoVectorAlbum(r.album, side);
  assert.equal(r.action, "add");
  r = learnIntoVectorAlbum(r.album, other);
  assert.equal(r.action, "skip");
  assert.equal(r.album.length, 2);
  for (const v of r.album) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  assert.ok(vectorAlbumScore(r.album, side) > 0.99);
  assert.ok(vectorAlbumScore(r.album, other) < 0.1);
  assert.equal(learnIntoVectorAlbum(r.album, [0, 0, 0, 0]).action, "skip");
  void a;
});

// ---------------------------------------------------------------------------
// Re-ID + clothing colours together (createFusedAgreement)
// ---------------------------------------------------------------------------

const fused = () => createFusedAgreement({
  reidThreshold: RECOGNIZER_DEFAULTS.reidThreshold,
  reidFloor: FUSION_DEFAULTS.reidFloor,
  reidMargin: RECOGNIZER_DEFAULTS.reidMargin,
  clothThreshold: RECOGNIZER_DEFAULTS.clothThreshold,
  clothMargin: RECOGNIZER_DEFAULTS.clothMargin,
  window: RECOGNIZER_DEFAULTS.window,
  need: RECOGNIZER_DEFAULTS.need,
  sameBoxIoU: RECOGNIZER_DEFAULTS.sameBoxIoU
});

const A = box(100, 50, 80, 160);
const B = box(300, 50, 80, 160);
const cand = (b, reid, cloth) => ({ box: b, reid, cloth });

/* Feeds the same round `n` times; returns the last answer. */
function rounds(agreement, n, list) {
  let out = null;
  for (let i = 0; i < n; i += 1) out = agreement.push(list);
  return out;
}

test("FU1 defaults: floor 0.50 is below the Re-ID threshold 0.65", () => {
  assert.equal(FUSION_DEFAULTS.reidFloor, 0.5);
  assert.ok(FUSION_DEFAULTS.reidFloor < RECOGNIZER_DEFAULTS.reidThreshold);
});

test("FU2 strong Re-ID (>= 0.65) alone decides after 3 rounds, as before", () => {
  const a = fused();
  assert.equal(rounds(a, 2, [cand(A, 0.72, NaN)]), null);
  const win = a.push([cand(A, 0.72, NaN)]);
  assert.equal(win.how, "reid");
  assert.equal(win.score, 0.72);
});

test("FU3 weaker Re-ID (0.50-0.64) WITH matching clothes decides, and says so", () => {
  const win = rounds(fused(), 3, [cand(A, 0.56, 0.86)]);
  assert.equal(win.how, "reid+cloth");
  assert.deepEqual(win.box, A);
});

test("FU4 weaker Re-ID without matching clothes never decides", () => {
  assert.equal(rounds(fused(), 6, [cand(A, 0.60, 0.70)]), null);     // clothes below 0.80
  assert.equal(rounds(fused(), 6, [cand(A, 0.60, NaN)]), null);      // clothes unknown
});

test("FU5 Re-ID below the floor never decides, however good the clothes", () => {
  assert.equal(rounds(fused(), 6, [cand(A, 0.45, 0.98)]), null);
});

test("FU6 a second person with a close Re-ID score blocks the win (margin 0.05), eligible or not", () => {
  assert.equal(rounds(fused(), 6, [cand(A, 0.58, 0.86), cand(B, 0.56, 0.40)]), null);
  assert.equal(rounds(fused(), 6, [cand(A, 0.70, NaN), cand(B, 0.68, NaN)]), null);
});

test("FU7 fused rule also needs the clothes to lead every other person by 0.06", () => {
  const similarClothes = [cand(A, 0.60, 0.86), cand(B, 0.50, 0.84)];   // Re-ID leads by 0.10, clothes by 0.02
  assert.equal(rounds(fused(), 6, similarClothes), null);
  const clearClothes = [cand(A, 0.60, 0.86), cand(B, 0.50, 0.70)];     // clothes lead by 0.16
  assert.equal(rounds(fused(), 3, clearClothes).how, "reid+cloth");
});

test("FU8 the strong rule does not look at the clothes (same as the old Re-ID-only rule)", () => {
  const win = rounds(fused(), 3, [cand(A, 0.72, 0.30), cand(B, 0.60, 0.95)]);
  assert.equal(win.how, "reid");
  assert.deepEqual(win.box, A);
});

test("FU9 only the best Re-ID person can win, even when someone else has better clothes", () => {
  assert.equal(rounds(fused(), 6, [cand(A, 0.55, 0.60), cand(B, 0.52, 0.95)]), null);
});

test("FU10 3 of the last 5 rounds must pick the same box; NaN Re-ID candidates are ignored", () => {
  const a = fused();
  assert.equal(a.push([cand(A, 0.56, 0.86)]), null);
  assert.equal(a.push([cand(A, NaN, NaN)]), null);                   // no winner this round
  assert.equal(a.push([cand(A, 0.56, 0.86)]), null);                 // 2 of 3
  assert.equal(a.push([cand(B, 0.56, 0.86)]), null);                 // another box does not count
  const win = a.push([cand(A, 0.56, 0.86)]);                         // A has 3 of the last 5
  assert.deepEqual(win.box, A);
});

test("FU11 reset() forgets the rounds", () => {
  const a = fused();
  rounds(a, 2, [cand(A, 0.56, 0.86)]);
  a.reset();
  assert.equal(a.length, 0);
  assert.equal(a.push([cand(A, 0.56, 0.86)]), null);
});

test("FU12 with reidFloor = reidThreshold (?fuse=0) the fused rule cannot fire", () => {
  const a = createFusedAgreement({
    reidThreshold: 0.65, reidFloor: 0.65, reidMargin: 0.05, clothThreshold: 0.8, clothMargin: 0.06,
    window: 5, need: 3, sameBoxIoU: 0.3
  });
  assert.equal(rounds(a, 6, [cand(A, 0.60, 0.95)]), null);
  assert.equal(rounds(a, 3, [cand(A, 0.70, 0.10)]).how, "reid");
});
