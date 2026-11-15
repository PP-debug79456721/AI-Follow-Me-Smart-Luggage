/*
 * Owner recognition logic (bench, localhost only). PURE: no DOM, no camera,
 * no network, no model. ai-owner.js feeds it detections, face scores and
 * clothing signatures; it only answers "which person box is the owner?".
 *
 * It NEVER moves anything. The result is used to SELECT a box in the person
 * tracker; motion still comes only from motion-decision.js / the link.
 *
 * Two cues:
 *   1. Face (SFace cosine score, computed elsewhere). Needs the owner facing
 *      the camera. Used to lock on and to re-acquire.
 *   2. Clothing colour signature of the person box (upper and lower half,
 *      hue/saturation histogram). Works from the BACK. Captured from the box
 *      that is being followed, refreshed slowly, used only to re-acquire after
 *      the tracker lost the owner.
 *
 * Fail-safe rules:
 *   - Nothing is selected unless the SAME box wins over several rounds
 *     (agreement window).
 *   - Two candidates too close in score (ambiguous) -> nobody.
 *   - No owner data -> nobody.
 */

// --------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------

export function boxCenter(b) {
  return { x: b.originX + b.width / 2, y: b.originY + b.height / 2 };
}

export function boxArea(b) {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

export function boxIoU(a, b) {
  const x1 = Math.max(a.originX, b.originX);
  const y1 = Math.max(a.originY, b.originY);
  const x2 = Math.min(a.originX + a.width, b.originX + b.width);
  const y2 = Math.min(a.originY + a.height, b.originY + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function contains(b, p) {
  return p.x >= b.originX && p.x <= b.originX + b.width &&
         p.y >= b.originY && p.y <= b.originY + b.height;
}

/*
 * Index of the person box that contains the face centre, or -1.
 * Several boxes contain it: the smallest one (the nearest person) wins.
 */
export function personForFace(faceBox, personBoxes) {
  const c = boxCenter(faceBox);
  let best = -1;
  let bestArea = Infinity;
  personBoxes.forEach((p, i) => {
    if (contains(p, c) && boxArea(p) < bestArea) {
      best = i;
      bestArea = boxArea(p);
    }
  });
  return best;
}

// --------------------------------------------------------------------------
// Face scores
// --------------------------------------------------------------------------

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : NaN;
}

/* Best cosine of a probe against all enrolled samples (NaN if none). */
export function bestFaceScore(probe, samples) {
  let best = NaN;
  for (const s of samples || []) {
    const c = cosine(probe, s);
    if (Number.isFinite(c) && !(c <= best)) best = c;
  }
  return best;
}

// --------------------------------------------------------------------------
// Clothing colour signature
// --------------------------------------------------------------------------

export const SIGNATURE = Object.freeze({
  hueBins: 12,
  satBins: 3,
  grayBins: 3,      // low-saturation pixels go to a brightness histogram instead
  minSat: 0.18,
  minValue: 0.12    // very dark pixels: counted as gray "dark"
});

const BINS = SIGNATURE.hueBins * SIGNATURE.satBins + SIGNATURE.grayBins;

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max / 255;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, v];
}

function histogram(rgba, width, y0, y1, x0, x1) {
  const hist = new Float64Array(BINS);
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      let bin;
      if (v < SIGNATURE.minValue || s < SIGNATURE.minSat) {
        const g = Math.min(SIGNATURE.grayBins - 1, Math.floor(v * SIGNATURE.grayBins));
        bin = SIGNATURE.hueBins * SIGNATURE.satBins + g;
      } else {
        const hb = Math.min(SIGNATURE.hueBins - 1, Math.floor(h * SIGNATURE.hueBins));
        const sb = Math.min(SIGNATURE.satBins - 1,
          Math.floor((s - SIGNATURE.minSat) / (1 - SIGNATURE.minSat) * SIGNATURE.satBins));
        bin = hb * SIGNATURE.satBins + sb;
      }
      hist[bin] += 1;
      n += 1;
    }
  }
  if (n > 0) for (let k = 0; k < BINS; k += 1) hist[k] /= n;
  return n > 0 ? hist : null;
}

/*
 * Signature of a person crop given as RGBA pixels (width x height).
 * Upper = torso (15-55 % of the height), lower = legs (55-90 %), each using
 * the central 60 % of the width (less background at the sides). The head is
 * skipped on purpose: from behind there is no face, only hair.
 * Returns { upper, lower } or null when the crop is too small.
 */
export function colorSignature(rgba, width, height) {
  if (!rgba || width < 8 || height < 16) return null;
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.ceil(width * 0.8);
  const upper = histogram(rgba, width, Math.floor(height * 0.15), Math.floor(height * 0.55), x0, x1);
  const lower = histogram(rgba, width, Math.floor(height * 0.55), Math.floor(height * 0.9), x0, x1);
  return upper && lower ? { upper, lower } : null;
}

/* Bhattacharyya coefficient of two normalised histograms: 1 = identical. */
export function histogramSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return NaN;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.sqrt(a[i] * b[i]);
  return s;
}

/* Upper body counts more (shirt colour is the strongest cue from behind). */
export function signatureSimilarity(a, b) {
  if (!a || !b) return NaN;
  const u = histogramSimilarity(a.upper, b.upper);
  const l = histogramSimilarity(a.lower, b.lower);
  return Number.isFinite(u) && Number.isFinite(l) ? 0.6 * u + 0.4 * l : NaN;
}

/* Slow update so one bad frame (overlap, odd light) cannot replace the owner. */
export function blendSignature(old, fresh, rate = 0.1) {
  if (!old) return fresh;
  if (!fresh) return old;
  const mix = (a, b) => {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i += 1) out[i] = (1 - rate) * a[i] + rate * b[i];
    return out;
  };
  return { upper: mix(old.upper, fresh.upper), lower: mix(old.lower, fresh.lower) };
}

// --------------------------------------------------------------------------
// Clothing album: several views of the owner (back, front, side, other light)
// --------------------------------------------------------------------------

export const ALBUM_DEFAULTS = Object.freeze({
  maxViews: 8,          // views kept (view 0 = REMEMBER CLOTHES, never dropped)
  sameViewAbove: 0.88,  // fresh crop this close to a view -> slowly blend into it
  newViewAbove: 0.55,   // below this it is probably NOT the owner -> not learned
  rate: 0.1
});

/* Best similarity of a signature against every view of the album. */
export function albumScore(album, sig) {
  let best = NaN;
  for (const view of album || []) {
    const s = signatureSimilarity(view, sig);
    if (Number.isFinite(s) && !(s <= best)) best = s;
  }
  return best;
}

/*
 * Learn a fresh crop of the person being followed. Returns
 * { album, action: "blend" | "add" | "skip", score }.
 * - close to an existing view: blend into that view (light drift);
 * - different but plausible (turned around, jacket open): add a new view;
 * - very different: skip (likely an identity swap in the tracker).
 * When full, the oldest learned view is replaced (view 0 stays).
 */
export function learnIntoAlbum(album, sig, options = {}) {
  const o = { ...ALBUM_DEFAULTS, ...options };
  const views = Array.isArray(album) ? album.slice() : [];
  if (!sig) return { album: views, action: "skip", score: NaN };
  if (views.length === 0) return { album: [sig], action: "add", score: NaN };

  let best = NaN, bestIdx = -1;
  views.forEach((v, i) => {
    const s = signatureSimilarity(v, sig);
    if (Number.isFinite(s) && !(s <= best)) { best = s; bestIdx = i; }
  });
  if (!Number.isFinite(best) || best < o.newViewAbove) return { album: views, action: "skip", score: best };
  if (best >= o.sameViewAbove) {
    views[bestIdx] = blendSignature(views[bestIdx], sig, o.rate);
    return { album: views, action: "blend", score: best };
  }
  if (views.length >= o.maxViews) views.splice(1, 1);   // drop the oldest learned view
  views.push(sig);
  return { album: views, action: "add", score: best };
}

// --------------------------------------------------------------------------
// Re-ID album: several 512-D appearance vectors of the owner (back/front/side)
// --------------------------------------------------------------------------

export const REID_ALBUM_DEFAULTS = Object.freeze({
  maxViews: 12,
  sameViewAbove: 0.90,  // cosine: blend into that view
  newViewAbove: 0.50,   // below: probably someone else -> not learned
  rate: 0.1
});

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? Array.from(v, x => x / n) : null;
}

/* Best cosine of a vector against every view. */
export function vectorAlbumScore(album, v) {
  return bestFaceScore(v, album);
}

/* Same rules as learnIntoAlbum, for embedding vectors (stored unit length). */
export function learnIntoVectorAlbum(album, v, options = {}) {
  const o = { ...REID_ALBUM_DEFAULTS, ...options };
  const views = Array.isArray(album) ? album.slice() : [];
  const u = v ? unit(v) : null;
  if (!u) return { album: views, action: "skip", score: NaN };
  if (views.length === 0) return { album: [u], action: "add", score: NaN };

  let best = NaN, bestIdx = -1;
  views.forEach((w, i) => {
    const c = cosine(w, u);
    if (Number.isFinite(c) && !(c <= best)) { best = c; bestIdx = i; }
  });
  if (!Number.isFinite(best) || best < o.newViewAbove) return { album: views, action: "skip", score: best };
  if (best >= o.sameViewAbove) {
    views[bestIdx] = unit(views[bestIdx].map((x, i) => (1 - o.rate) * x + o.rate * u[i]));
    return { album: views, action: "blend", score: best };
  }
  if (views.length >= o.maxViews) views.splice(1, 1);
  views.push(u);
  return { album: views, action: "add", score: best };
}

// --------------------------------------------------------------------------
// Decision over several rounds
// --------------------------------------------------------------------------

export const RECOGNIZER_DEFAULTS = Object.freeze({
  faceThreshold: 0.363,     // SFace cosine (OpenCV reference value; tune on the real camera)
  faceMargin: 0.05,         // best face must beat the second by this
  clothThreshold: 0.80,     // signature similarity (Bhattacharyya); tune on the real camera
  reidThreshold: 0.65,      // OSNet cosine; starting value, tune on the real camera
  reidMargin: 0.05,
  clothMargin: 0.06,        // best person must beat the second by this
  window: 5,                // last N rounds ...
  need: 3,                  // ... of which this many must agree
  sameBoxIoU: 0.3           // "same person" between rounds
});

/*
 * One recognition round gives, for each candidate person box, a score.
 * The winner of the round is the best box if it passes the threshold and
 * beats the second best by the margin; otherwise the round has no winner.
 * After `need` of the last `window` rounds picked overlapping boxes, the
 * decision is that box (latest position). Anything else: null.
 */
export function createAgreement({ threshold, margin, window, need, sameBoxIoU }) {

  let rounds = [];   // null (no winner) or { box, score }

  return {
    /*
     * candidates: [{ box, score }] (score NaN = unknown, ignored).
     * Returns { box, score } when agreed, else null.
     */
    push(candidates) {
      const valid = (candidates || []).filter(c => Number.isFinite(c.score));
      valid.sort((a, b) => b.score - a.score);
      let winner = null;
      if (valid.length > 0 && valid[0].score >= threshold) {
        const second = valid.length > 1 ? valid[1].score : -Infinity;
        if (valid[0].score - second >= margin) winner = valid[0];
      }
      rounds.push(winner);
      if (rounds.length > window) rounds = rounds.slice(-window);

      const last = rounds[rounds.length - 1];
      if (!last) return null;
      const agreeing = rounds.filter(r => r && boxIoU(r.box, last.box) >= sameBoxIoU).length;
      return agreeing >= need ? { box: last.box, score: last.score } : null;
    },

    reset() { rounds = []; },

    get length() { return rounds.length; }
  };
}
