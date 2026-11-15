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
  createAgreement, RECOGNIZER_DEFAULTS
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
