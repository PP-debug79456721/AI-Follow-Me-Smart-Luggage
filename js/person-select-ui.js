/*
 * Tap-to-select UI for person tracking (Phase C).
 *
 * Tapping a box only chooses which box to follow. It is not identity
 * verification, and every box stays "ยังไม่ยืนยันตัวตน".
 */

import {
  selectPersonAt,
  clearPersonSelection,
  setPersonTrackingListener
} from "./ai-owner.js";

import {
  clientPointToVideo,
  TRACK_STATE,
  LOST_REASON
} from "./person-tracker.js";

const container = document.querySelector(".video-container");
const canvas = document.getElementById("aiCanvas");
const video = document.getElementById("camera");

const statusEl = document.getElementById("trackStatus");
const messageEl = document.getElementById("trackMessage");
const clearBtn = document.getElementById("trackClearBtn");
const readyPerson = document.getElementById("readyPerson");

// "ok" = following, "warn" = needs the user, "" = neutral
const LEVEL = {
  [TRACK_STATE.TRACKING]: "ok",
  [TRACK_STATE.SEARCHING]: "warn",
  [TRACK_STATE.LOST]: "bad"
};

const TAP_NOTE_MS = 3000;

let current = { state: TRACK_STATE.STOPPED };
let tapNote = "";
let tapNoteTimer = null;

function setTapNote(text) {

  clearTimeout(tapNoteTimer);
  tapNote = text;

  // A hint about a missed tap should not stay on screen while tracking
  // carries on unchanged.
  if (text) {
    tapNoteTimer = setTimeout(() => {
      tapNote = "";
      render(current);
    }, TAP_NOTE_MS);
  }
}

// Shown for every LOST reason that is only a guess (OUT_OF_FRAME,
// CAMERA_BLOCKED, NOT_FOUND in person-tracker.js). Those guesses are not
// tuned on real devices, so the message stays neutral instead of naming
// a cause that may be wrong.
const LOST_NEUTRAL_TEXT = "ไม่พบกรอบที่เลือก หลุดการติดตาม แตะเลือกคนใหม่";

function describeLost(reason) {

  // A stalled camera is observed directly (video frames stopped), not
  // guessed, so it keeps its own message.
  if (reason === LOST_REASON.CAMERA_STALLED) {
    return "ภาพจากกล้องหยุดนิ่ง หลุดการติดตาม ตรวจสอบกล้องแล้วแตะเลือกใหม่";
  }

  return LOST_NEUTRAL_TEXT;
}

function describe(snapshot) {

  switch (snapshot.state) {

    case TRACK_STATE.STOPPED:
      // The camera can be running while the detector failed to load.
      return readyPerson && readyPerson.textContent === "ERROR"
        ? "ระบบตรวจจับบุคคลไม่พร้อม จึงเลือกบุคคลไม่ได้ (ดูข้อความใต้ภาพกล้อง)"
        : "ยังไม่ได้ตรวจจับ เริ่มกล้องก่อน";

    case TRACK_STATE.WAITING:
      return readyPerson && readyPerson.textContent !== "READY"
        ? "Person detector ยังไม่พร้อม จึงยังเลือกบุคคลไม่ได้"
        : "กำลังตรวจจับบุคคล...";

    case TRACK_STATE.NO_PERSON:
      return "ไม่พบบุคคลในภาพ";

    case TRACK_STATE.NOT_SELECTED:
      return `พบ ${snapshot.personCount} คน แตะกรอบเพื่อเลือกคนที่ต้องการติดตาม`;

    case TRACK_STATE.TRACKING:
      return `กำลังติดตามกรอบ #${snapshot.selectedId} (ยังไม่ยืนยันตัวตน)`;

    case TRACK_STATE.SEARCHING:
      return `กรอบ #${snapshot.selectedId} หายชั่วคราว กำลังค้นหา...`;

    case TRACK_STATE.LOST:
      return describeLost(snapshot.lostReason);

    default:
      return "";
  }
}

function render(snapshot) {

  current = snapshot;

  const level = LEVEL[snapshot.state] ?? "";

  statusEl.textContent = snapshot.state.replace("_", " ");
  statusEl.className = level;

  // A tap result (for example "no person there") is shown until the
  // tracking state changes.
  messageEl.textContent = tapNote || describe(snapshot);

  const running = snapshot.state !== TRACK_STATE.STOPPED;

  container.classList.toggle("selectable", running);

  clearBtn.disabled =
    snapshot.selectedId === null && snapshot.state !== TRACK_STATE.LOST;
}

function describeTapFailure(reason) {

  switch (reason) {

    case "NOT_RUNNING":
      return "เริ่มกล้องก่อนจึงจะเลือกบุคคลได้";

    case "NO_PERSON_DETECTOR":
      return "Person detector ไม่พร้อม เลือกบุคคลไม่ได้";

    default:
      return "ตำแหน่งที่แตะไม่มีกรอบบุคคล ลองแตะที่ตัวคนในกรอบ";
  }
}

function onTap(event) {

  if (current.state === TRACK_STATE.STOPPED) {
    setTapNote("");
    render(current);
    return;
  }

  // Use the canvas rectangle: it has the same size and object-fit as the
  // video, so the image area inside it is the same for both.
  const point = clientPointToVideo(
    event.clientX,
    event.clientY,
    canvas.getBoundingClientRect(),
    video.videoWidth,
    video.videoHeight
  );

  const result = point
    ? selectPersonAt(point.x, point.y)
    : { ok: false, reason: "NO_PERSON_AT_POINT" };

  setTapNote(result.ok ? "" : describeTapFailure(result.reason));

  // selectPersonAt notifies on success; on failure show the note now.
  render(current);
}

export function initPersonSelection() {

  if (!container || !canvas || !video || !statusEl || !messageEl || !clearBtn) {
    console.warn("Person selection UI elements are missing.");
    return;
  }

  setPersonTrackingListener(snapshot => {
    setTapNote("");
    render(snapshot);
  });

  container.addEventListener("click", onTap);

  clearBtn.addEventListener("click", () => {
    setTapNote("");
    clearPersonSelection();
  });
}
