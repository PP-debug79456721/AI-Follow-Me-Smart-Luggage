/*
 * Person selection and tracking (Phase C).
 *
 * This module only follows ONE box that the user tapped, from one detection
 * result to the next. It does not know who anybody is: it never uses a face,
 * a body embedding or any identity data, and selecting a box is NOT identity
 * verification. A tracked box can jump to another person when people cross,
 * overlap or move fast, so every box stays "ยังไม่ยืนยันตัวตน" in the UI.
 *
 * It has no DOM or MediaPipe imports, so it can be tested on its own.
 * Boxes use MediaPipe's shape: { originX, originY, width, height } in video
 * pixels.
 */

export const TRACK_STATE = Object.freeze({
  STOPPED: "STOPPED",         // camera / detection not running
  WAITING: "WAITING",         // running, no detection result yet
  NO_PERSON: "NO_PERSON",     // nobody detected, nothing selected
  NOT_SELECTED: "NOT_SELECTED", // people detected, none selected
  TRACKING: "TRACKING",       // selected box matched in the latest detection
  SEARCHING: "SEARCHING",     // selected box missed, still within the grace time
  LOST: "LOST"                // grace time ran out; the user must tap again
});

/*
 * Why a selected box was lost. These are best guesses for the message
 * shown to the user, not facts: the tracker cannot see what happened.
 * Checked in this order:
 *   CAMERA_STALLED  video frames stopped arriving
 *   CAMERA_BLOCKED  while missing, the frame looked covered (very dark or
 *                   almost no detail), see the "blocked" hint in update()
 *   OUT_OF_FRAME    last seen at the LEFT or RIGHT edge and moving toward
 *                   it (the bottom edge is ignored: a person close to a
 *                   luggage-height camera nearly always touches it)
 *   NOT_FOUND       anything else: occluded, too far, or just not detected
 */
export const LOST_REASON = Object.freeze({
  OUT_OF_FRAME: "OUT_OF_FRAME",
  CAMERA_BLOCKED: "CAMERA_BLOCKED",
  NOT_FOUND: "NOT_FOUND",
  CAMERA_STALLED: "CAMERA_STALLED"
});

const DEFAULTS = Object.freeze({
  lostAfterMs: 2500,        // grace time before a missing target counts as lost
  edgeMarginRatio: 0.04,    // "touching the edge" = within 4 % of the frame
  minIou: 0.15,             // overlap needed to treat two boxes as the same
  maxCenterDistRatio: 0.6,  // fallback: centre distance / sqrt(box area)
  glideDistRatio: 1.0,      // looser limit used only to animate drawn boxes
  tapPaddingRatio: 0.04,    // forgiveness around a box when tapping
  smoothMs: 400             // boxes glide to a new detection over this time
});

function area(box) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function center(box) {
  return {
    x: box.originX + box.width / 2,
    y: box.originY + box.height / 2
  };
}

function lerpBox(from, to, t) {

  const mix = (a, b) => a + (b - a) * t;

  return {
    originX: mix(from.originX, to.originX),
    originY: mix(from.originY, to.originY),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height)
  };
}

function copyBox(box) {
  return {
    originX: box.originX,
    originY: box.originY,
    width: box.width,
    height: box.height
  };
}

export function iou(a, b) {

  const left = Math.max(a.originX, b.originX);
  const top = Math.max(a.originY, b.originY);
  const right = Math.min(a.originX + a.width, b.originX + b.width);
  const bottom = Math.min(a.originY + a.height, b.originY + b.height);

  const intersection =
    Math.max(0, right - left) * Math.max(0, bottom - top);

  const union = area(a) + area(b) - intersection;

  return union > 0 ? intersection / union : 0;
}

/*
 * Converts a click/tap position to video pixel coordinates.
 *
 * The video and the canvas are drawn with object-fit: contain, so the image
 * can be letterboxed inside the element. rect is the element's
 * getBoundingClientRect(). Returns null when the tap is on the letterbox
 * bars (outside the image) or when sizes are unknown.
 */
export function clientPointToVideo(clientX, clientY, rect, videoWidth, videoHeight) {

  if (
    !rect || !rect.width || !rect.height ||
    !videoWidth || !videoHeight
  ) {
    return null;
  }

  const scale = Math.min(
    rect.width / videoWidth,
    rect.height / videoHeight
  );

  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;

  const offsetX = (rect.width - shownWidth) / 2;
  const offsetY = (rect.height - shownHeight) / 2;

  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;

  if (x < 0 || y < 0 || x > videoWidth || y > videoHeight) {
    return null;
  }

  return { x, y };
}

export function createPersonTracker(options = {}) {

  const config = { ...DEFAULTS, ...options };

  let state = TRACK_STATE.STOPPED;
  let selected = null;       // { id, box, prevBox, score, lastSeenMs, matched, blockedWhileMissing }
  let detections = [];       // latest detection result: { box, score, selected }
  let frame = { width: 0, height: 0 };
  let nextId = 1;
  let lostReason = null;
  let hasUpdate = false;

  function matchQuality(targetBox, candidateBox, maxDistRatio = config.maxCenterDistRatio) {

    const overlap = iou(targetBox, candidateBox);

    if (overlap >= config.minIou) {
      return { ok: true, overlap, distance: 0 };
    }

    // Fallback for a person who moved a lot between two detections:
    // similar size and a close centre.
    const targetArea = area(targetBox);
    const candidateArea = area(candidateBox);

    if (targetArea <= 0 || candidateArea <= 0) return { ok: false };

    const ratio = candidateArea / targetArea;

    if (ratio < 0.4 || ratio > 2.5) return { ok: false };

    const a = center(targetBox);
    const b = center(candidateBox);

    const distance =
      Math.hypot(a.x - b.x, a.y - b.y) / Math.sqrt(targetArea);

    if (distance > maxDistRatio) return { ok: false };

    return { ok: true, overlap, distance };
  }

  /* The box as drawn at time now: gliding from its old place to its target. */
  function shownBox(item, now) {

    if (now === undefined || config.smoothMs <= 0) return item.box;

    const t = Math.min(1, Math.max(0, (now - item.startMs) / config.smoothMs));

    // ease-out: fast at first, settles softly
    return lerpBox(item.from, item.box, 1 - (1 - t) * (1 - t));
  }

  /*
   * Gives each new box a starting place: where the best-matching old box is
   * drawn right now. This only affects how boxes are DRAWN (animation); the
   * selected target is matched separately and never from these pairs.
   */
  function glideFromPrevious(previous) {

    const pairs = [];

    previous.forEach((old, i) => {
      detections.forEach((fresh, j) => {

        const quality = matchQuality(old.shown, fresh.box, config.glideDistRatio);

        if (quality.ok) pairs.push({ i, j, ...quality });
      });
    });

    pairs.sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);

    const usedOld = new Set();
    const usedNew = new Set();

    for (const pair of pairs) {

      if (usedOld.has(pair.i) || usedNew.has(pair.j)) continue;

      usedOld.add(pair.i);
      usedNew.add(pair.j);

      detections[pair.j].from = copyBox(previous[pair.i].shown);
    }
  }

  /*
   * True when the target was last seen at the left or right edge and was
   * moving toward that edge (or its motion is unknown). A box that spans
   * both side edges (person very close) gives no direction, so false.
   */
  function likelyLeftFrame(target) {

    if (!frame.width) return false;

    const margin = frame.width * config.edgeMarginRatio;
    const box = target.box;

    const atLeft = box.originX <= margin;
    const atRight = box.originX + box.width >= frame.width - margin;

    if (atLeft === atRight) return false;

    if (!target.prevBox) return true;

    const dx = center(box).x - center(target.prevBox).x;

    return atLeft ? dx <= 0 : dx >= 0;
  }

  function evaluate(now, stalled) {

    if (state === TRACK_STATE.STOPPED) return;

    if (selected) {

      if (!selected.matched && now - selected.lastSeenMs >= config.lostAfterMs) {

        lostReason = stalled
          ? LOST_REASON.CAMERA_STALLED
          : selected.blockedWhileMissing
            ? LOST_REASON.CAMERA_BLOCKED
            : likelyLeftFrame(selected)
              ? LOST_REASON.OUT_OF_FRAME
              : LOST_REASON.NOT_FOUND;

        selected = null;
        state = TRACK_STATE.LOST;
        return;
      }

      state = selected.matched
        ? TRACK_STATE.TRACKING
        : TRACK_STATE.SEARCHING;
      return;
    }

    // LOST stays visible until the user taps again or clears it.
    if (state === TRACK_STATE.LOST) return;

    if (!hasUpdate) {
      state = TRACK_STATE.WAITING;
      return;
    }

    state = detections.length > 0
      ? TRACK_STATE.NOT_SELECTED
      : TRACK_STATE.NO_PERSON;
  }

  return {

    /* Called when detection starts. Forgets any previous selection. */
    reset() {
      selected = null;
      detections = [];
      lostReason = null;
      hasUpdate = false;
      nextId = 1;
      state = TRACK_STATE.WAITING;
    },

    /* Called when the camera or detection stops. */
    stop() {
      selected = null;
      detections = [];
      lostReason = null;
      hasUpdate = false;
      state = TRACK_STATE.STOPPED;
    },

    /*
     * Feeds one person-detection result.
     * list: [{ box, score }], now: ms (same clock for every call).
     * hints.blocked: the frame looked covered (only used for the LOST
     * reason text while the selected box is missing).
     */
    update(list, now, frameWidth, frameHeight, { blocked = false } = {}) {

      if (state === TRACK_STATE.STOPPED) return;

      frame = { width: frameWidth, height: frameHeight };
      hasUpdate = true;

      const previous = detections.map(item => ({
        item,
        shown: shownBox(item, now)
      }));

      detections = list.map(item => ({
        box: copyBox(item.box),
        from: copyBox(item.box),   // where the drawn box starts gliding from
        startMs: now,
        score: item.score ?? 0,
        selected: false
      }));

      glideFromPrevious(previous);

      if (selected) {

        let best = null;

        detections.forEach((candidate, index) => {

          const quality = matchQuality(selected.box, candidate.box);

          if (!quality.ok) return;

          if (
            !best ||
            quality.overlap > best.overlap ||
            (quality.overlap === best.overlap && quality.distance < best.distance)
          ) {
            best = { index, ...quality };
          }
        });

        if (best) {
          const hit = detections[best.index];
          hit.selected = true;
          selected.prevBox = selected.box;
          selected.box = copyBox(hit.box);
          selected.score = hit.score;
          selected.lastSeenMs = now;
          selected.matched = true;
          selected.blockedWhileMissing = false;
        } else {
          selected.matched = false;
          if (blocked) selected.blockedWhileMissing = true;
        }
      }

      evaluate(now, false);
    },

    /*
     * Called on every processed frame so a missing target is dropped on
     * time even when no new detection arrives. stalled = video frames are
     * not arriving (camera frozen or stopped).
     */
    tick(now, { stalled = false } = {}) {

      if (stalled && selected) selected.matched = false;

      evaluate(now, stalled);
    },

    /*
     * Selects the person whose box contains the point (video pixels).
     * now must be the time the overlay was last drawn, so the hit-test
     * uses the same (gliding) box positions the user sees. Only people in
     * the latest detection can be selected, never a remembered box.
     * Smallest drawn box wins when boxes overlap.
     * Returns { ok: true, id } or { ok: false, reason }.
     */
    selectAt(x, y, now) {

      if (state === TRACK_STATE.STOPPED) {
        return { ok: false, reason: "NOT_RUNNING" };
      }

      // Hit-test against what the user SEES: the drawn box (which glides
      // toward the latest detection for smoothMs) and also the latest
      // detected box, so a tap on either one selects that person.
      const contains = (b, pad) =>
        x >= b.originX - pad && x <= b.originX + b.width + pad &&
        y >= b.originY - pad && y <= b.originY + b.height + pad;

      const targets = detections.map(candidate => ({
        candidate,
        shown: shownBox(candidate, now)
      }));

      let pick = null;
      let pickArea = Infinity;

      for (const { candidate, shown } of targets) {

        if (!contains(shown, 0) && !contains(candidate.box, 0)) continue;

        // Smallest drawn box wins when boxes overlap.
        if (area(shown) < pickArea) {
          pick = candidate;
          pickArea = area(shown);
        }
      }

      if (!pick) {

        // Finger tap: allow a small padding, nearest drawn centre wins.
        const pad =
          Math.min(frame.width, frame.height) * config.tapPaddingRatio;

        let bestDistance = Infinity;

        for (const { candidate, shown } of targets) {

          if (!contains(shown, pad) && !contains(candidate.box, pad)) continue;

          const c = center(shown);
          const distance = Math.hypot(c.x - x, c.y - y);

          if (distance < bestDistance) {
            bestDistance = distance;
            pick = candidate;
          }
        }
      }

      if (!pick) {
        return { ok: false, reason: "NO_PERSON_AT_POINT" };
      }

      // Tapping the box that is already selected keeps its number.
      if (!(selected && pick.selected)) {

        for (const candidate of detections) candidate.selected = false;

        selected = {
          id: nextId++,
          box: copyBox(pick.box),
          score: pick.score,
          lastSeenMs: now,
          matched: true,
          prevBox: null,
          blockedWhileMissing: false
        };
      }

      pick.selected = true;
      lostReason = null;

      evaluate(now, false);

      return { ok: true, id: selected.id };
    },

    clearSelection(now = 0) {

      selected = null;
      lostReason = null;

      for (const candidate of detections) candidate.selected = false;

      if (state === TRACK_STATE.LOST) state = TRACK_STATE.WAITING;

      evaluate(now, false);
    },

    /* What to draw: latest detections plus the remembered target if missed. */
    getDrawables(now) {

      const items = detections.map(candidate => ({
        box: shownBox(candidate, now),
        score: candidate.score,
        selected: candidate.selected,
        searching: false,
        id: candidate.selected && selected ? selected.id : null
      }));

      if (selected && !selected.matched) {
        items.push({
          box: selected.box,
          score: selected.score,
          selected: true,
          searching: true,
          id: selected.id
        });
      }

      return items;
    },

    getSnapshot() {
      return {
        state,
        selectedId: selected ? selected.id : null,
        personCount: detections.length,
        lostReason: state === TRACK_STATE.LOST ? lostReason : null
      };
    }
  };
}
