
// MediaPipe is loaded from the CDN with a dynamic import inside
// loadDetectors(), not a static import: if the CDN cannot be reached, a
// static import would stop app.js from running at all (no camera, no
// messages). See AI_LOAD_MESSAGES below for what the user is told.

// image-preprocessor.js has no external imports, so importing it
// statically cannot make this module fail to load.
import {
  alignFaceToCanvas,
  mediapipeKeypointsToPixels
} from "./embedding/image-preprocessor.js";

// Pure logic with no external imports (same reason as above).
import { createPersonTracker } from "./person-tracker.js";

// No external imports either: tells whether the camera still delivers
// new frames.
import { isCameraLive, getLastVideoFrameTime } from "./camera.js";

const MEDIAPIPE_VERSION = "0.10.35";

const MEDIAPIPE_BUNDLE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const FACE_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const PERSON_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

// Each loading step (runtime, face model, person model) may take this long.
// The runtime is about 10 MB, so a slow phone connection needs time.
// "?aiLoadTimeoutMs=" overrides it (used by the e2e test, minimum 1 s).
const AI_LOAD_TIMEOUT_MS = (() => {
  const value = Number(new URLSearchParams(location.search).get("aiLoadTimeoutMs"));
  return Number.isFinite(value) && value >= 1000 ? value : 60000;
})();

const AI_LOAD_MESSAGES = Object.freeze({
  LOADING:
    "กำลังโหลดระบบตรวจจับบุคคล (MediaPipe) จากอินเทอร์เน็ต ครั้งแรกอาจใช้เวลาสักครู่",
  RUNTIME_FAILED:
    "โหลดระบบตรวจจับบุคคล (MediaPipe) จากอินเทอร์เน็ตไม่ได้ กล้องยังใช้ได้ " +
    "แต่ยังตรวจจับและติดตามบุคคลไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ต แล้วรีโหลดหน้านี้",
  TIMEOUT:
    "โหลดระบบตรวจจับบุคคลนานเกินไป (อินเทอร์เน็ตอาจช้าหรือหลุด) กล้องยังใช้ได้ " +
    "แต่ยังตรวจจับและติดตามบุคคลไม่ได้ ตรวจการเชื่อมต่อ แล้วรีโหลดหน้านี้",
  PERSON_MODEL_FAILED:
    "โหลดโมเดลตรวจจับบุคคลไม่ได้ จึงเลือกและติดตามบุคคลไม่ได้ " +
    "ตรวจการเชื่อมต่อ แล้วรีโหลดหน้านี้",
  FACE_MODEL_FAILED:
    "โหลดโมเดลตรวจจับใบหน้าไม่ได้ การเลือกและติดตามบุคคลยังใช้ได้ " +
    "แต่ส่งออกภาพใบหน้า (FACE CROP EXPORT) ไม่ได้"
});

const aiLoadMessage = document.getElementById("aiLoadMessage");

/* Shows (text) or hides (null) the AI loading notice under the camera. */
function showAiLoadMessage(text, level = "") {

  if (!aiLoadMessage) return;

  aiLoadMessage.hidden = !text;
  aiLoadMessage.textContent = text || "";
  aiLoadMessage.className = `ai-load-message ${level}`.trim();
}

class AiLoadTimeoutError extends Error {
  constructor(step) {
    super(`${step} did not finish within ${AI_LOAD_TIMEOUT_MS} ms`);
    this.name = "AiLoadTimeoutError";
  }
}

/*
 * Rejects with AiLoadTimeoutError when the promise is slower than
 * AI_LOAD_TIMEOUT_MS. A result that arrives after the timeout is passed
 * to onLate (for example to close a detector nobody will use).
 */
function withTimeout(promise, step, onLate = () => {}) {

  let timedOut = false;
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new AiLoadTimeoutError(step));
    }, AI_LOAD_TIMEOUT_MS);
  });

  promise.then(
    value => { if (timedOut) onLate(value); },
    () => {}
  );

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const closeLate = detector => {
  try { detector?.close(); } catch (error) { console.error(error); }
};

const video = document.getElementById("camera");
const canvas = document.getElementById("aiCanvas");
const ctx = canvas.getContext("2d");

const faceStatus = document.getElementById("faceAIStatus");
const personStatus = document.getElementById("personAIStatus");
const ownerStatus = document.getElementById("ownerStatus");
const aiStatus = document.getElementById("aiStatus");

const readyPerson = document.getElementById("readyPerson");
const readyFace = document.getElementById("readyFace");
const readyFaceModel = document.getElementById("readyFaceModel");
const readyReidModel = document.getElementById("readyReidModel");

const UNVERIFIED_TEXT = "ยังไม่ยืนยันตัวตน";

let faceDetector = null;
let personDetector = null;

let initPromise = null;
let embeddingPromise = null;
let rafId = null;

// Follows the box the user tapped. It never identifies anyone.
const tracker = createPersonTracker();
let trackingListener = null;
let lastNotified = "";
let lastFrameTimestamp = 0;

// Face boxes from the latest detection, redrawn on every animation frame
// together with the (smoothly moving) person boxes.
let lastFaces = [];

let running = false;
let lastInference = 0;
let lastPersonInference = 0;

const INFERENCE_INTERVAL = 250;
const PERSON_INTERVAL = 500;

// No new camera frame for this long = the image on screen is frozen.
// Detection is then skipped, so nothing is "tracked" on a stale picture.
const FRAME_STALL_MS = 1000;

/*
 * True when detection must not run because the camera gives no new
 * image: not enough data yet, the camera track ended, or no new video
 * frame for FRAME_STALL_MS (only measurable with requestVideoFrameCallback;
 * without it, an ended track and readyState are still checked).
 */
function cameraStalled() {

  if (video.readyState < 2) return true;

  if (video.srcObject && !isCameraLive()) return true;

  const lastFrame = getLastVideoFrameTime();

  return lastFrame !== null && performance.now() - lastFrame > FRAME_STALL_MS;
}

// Face recognition is not part of Phase C. Keep false until a face model
// with a confirmed license and acceptable size has been approved.
const LOAD_RECOGNITION_MODELS = false;

// --------------------------------------------------
// Camera-covered hint (for the LOST reason text only)
// --------------------------------------------------

// A covered lens gives a very dark frame or one with almost no detail.
// These limits are a heuristic (luma 0-255 on a 32x24 thumbnail) and are
// NOT tuned on real devices yet. The result only changes the wording of
// the LOST message; it never selects, matches or identifies anyone.
const BLOCKED_MAX_MEAN = 35;
const BLOCKED_MAX_STD = 6;

const statsCanvas = document.createElement("canvas");
statsCanvas.width = 32;
statsCanvas.height = 24;
const statsCtx = statsCanvas.getContext("2d", { willReadFrequently: true });

function looksBlocked() {

  if (!statsCtx) return false;

  try {

    statsCtx.drawImage(video, 0, 0, statsCanvas.width, statsCanvas.height);

    const data = statsCtx.getImageData(
      0, 0, statsCanvas.width, statsCanvas.height
    ).data;

    const count = data.length / 4;
    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += luma;
      sumSq += luma * luma;
    }

    const mean = sum / count;
    const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));

    return mean <= BLOCKED_MAX_MEAN || std <= BLOCKED_MAX_STD;

  } catch {
    return false;
  }
}

// --------------------------------------------------
// Aligned Face Crop Export (for offline model testing)
// --------------------------------------------------

const CROP_SIZE = 112;
const CROP_WAIT_MS = 4000;

// A face narrower than this is upscaled to 112 px and looks blurry,
// which gives misleading similarity numbers when testing a model.
const CROP_MIN_FACE_WIDTH_PX = 80;

/*
 * code: NOT_RUNNING | NO_FACE_DETECTOR | BUSY | NO_FACE |
 *       BAD_KEYPOINTS | ENCODE_FAILED | CANCELLED
 */
export class FaceCropError extends Error {

  constructor(code, message) {
    super(message);
    this.name = "FaceCropError";
    this.code = code;
  }
}

let cropRequest = null;

/*
 * Asks for an aligned 112x112 PNG of the largest face in the next frame
 * that contains one. The detection result and the image come from the same
 * frame, and the crop is made by the same alignFaceToCanvas() that the
 * recognition pipeline uses, so exported files match what a model would see.
 *
 * Resolves with { blob, width, height, score, faceCount, faceWidthPx,
 * warnings } where warnings may contain LOW_RESOLUTION and MULTIPLE_FACES.
 * Waits up to CROP_WAIT_MS for a face, then rejects with NO_FACE.
 * The image is never stored here; the caller decides what to do with it.
 */
export function requestAlignedFaceCrop() {

  if (!running) {
    return Promise.reject(new FaceCropError(
      "NOT_RUNNING",
      "The camera and face detection are not running."
    ));
  }

  if (!faceDetector) {
    return Promise.reject(new FaceCropError(
      "NO_FACE_DETECTOR",
      "The face detector is not available."
    ));
  }

  if (cropRequest) {
    return Promise.reject(new FaceCropError(
      "BUSY",
      "A face capture is already in progress."
    ));
  }

  return new Promise((resolve, reject) => {
    cropRequest = { resolve, reject, startTimestamp: null };
  });
}

function settleCropRequest(error, result) {

  const request = cropRequest;

  cropRequest = null;

  if (!request) return;

  if (error) {
    request.reject(error);
  } else {
    request.resolve(result);
  }
}

function cancelCropRequest() {

  settleCropRequest(
    new FaceCropError("CANCELLED", "Capture was cancelled."),
    null
  );
}

/* Called from processFrame with the detections of the current frame. */
function serveCropRequest(faceList, timestamp, width, height) {

  const request = cropRequest;

  if (!request) return;

  if (request.startTimestamp === null) {
    request.startTimestamp = timestamp;
  }

  if (faceList.length === 0) {

    if (timestamp - request.startTimestamp >= CROP_WAIT_MS) {
      settleCropRequest(new FaceCropError(
        "NO_FACE",
        "No face was detected."
      ), null);
    }

    return;
  }

  const area = face =>
    (face.boundingBox?.width ?? 0) * (face.boundingBox?.height ?? 0);

  const face = faceList.reduce(
    (best, current) => area(current) > area(best) ? current : best
  );

  let aligned;

  try {

    if (!Array.isArray(face.keypoints) || face.keypoints.length < 4) {
      throw new Error("The detector returned no facial keypoints.");
    }

    // alignFaceToCanvas rejects inconsistent keypoints
    // (for example a mouth above the eyes).
    aligned = alignFaceToCanvas(
      video,
      mediapipeKeypointsToPixels(face.keypoints, width, height),
      CROP_SIZE
    );

  } catch (error) {

    settleCropRequest(new FaceCropError(
      "BAD_KEYPOINTS",
      error.message
    ), null);

    return;
  }

  const faceWidthPx = face.boundingBox?.width ?? 0;
  const score = face.categories?.[0]?.score ?? 0;

  const warnings = [];

  if (faceWidthPx < CROP_MIN_FACE_WIDTH_PX) warnings.push("LOW_RESOLUTION");
  if (faceList.length > 1) warnings.push("MULTIPLE_FACES");

  // Detach the request before the asynchronous encoding starts so a new
  // request or a STOP cannot interfere with this one.
  cropRequest = null;

  try {

    aligned.toBlob(blob => {

      if (!blob) {
        request.reject(new FaceCropError(
          "ENCODE_FAILED",
          "Could not encode the image."
        ));
        return;
      }

      request.resolve({
        blob,
        width: CROP_SIZE,
        height: CROP_SIZE,
        score,
        faceCount: faceList.length,
        faceWidthPx: Math.round(faceWidthPx),
        warnings
      });

    }, "image/png");

  } catch (error) {

    request.reject(new FaceCropError(
      "ENCODE_FAILED",
      error.message
    ));
  }
}

function setReady(element, text, level) {

  if (!element) return;

  element.textContent = text;
  element.className = level || "";
}

/*
 * Loads the MediaPipe detectors once. Calling it again while loading
 * or after success reuses the same result instead of loading twice.
 * Each detector is loaded independently so the dashboard can report
 * exactly which one is available.
 */
export function initOwnerAI() {

  if (!initPromise) {

    initPromise = loadDetectors().catch(error => {
      // Allow a retry after a failed initialization.
      initPromise = null;
      // Let the tracking panel explain why nothing can be selected.
      notifyTracking(true);
      throw error;
    });
  }

  // Phase C does not use face recognition: the face / Re-ID embedding
  // models are NOT loaded (no ONNX Runtime, no model download, no
  // manifest request). loadEmbeddingModels() is kept for a later phase
  // and runs only when LOAD_RECOGNITION_MODELS is set to true.
  if (LOAD_RECOGNITION_MODELS) {
    const startEmbeddings = () => { loadEmbeddingModels(); };
    initPromise.then(startEmbeddings, startEmbeddings);
  } else {
    setReady(readyFaceModel, "OFF (NOT USED IN PHASE C)", "");
  }

  return initPromise;
}

/*
 * Maps a per-model status from the embedding modules to the text shown
 * in the AI READINESS panel. "SESSION LOADED" means only that the ONNX
 * session was created. Recognition itself is not verified.
 */
function describeModelStatus(status) {

  switch (status.state) {

    case "NO_MODEL":
      return ["NO MODEL", "warn"];

    case "NOT_LOADED":
      return ["NOT LOADED", ""];

    case "DOWNLOADING":
      return [
        Number.isFinite(status.percent)
          ? `DOWNLOADING ${status.percent}%`
          : "DOWNLOADING",
        "warn"
      ];

    case "VERIFYING":
      return ["VERIFYING FILE", "warn"];

    case "LOADING":
      return ["LOADING SESSION", "warn"];

    case "SESSION_LOADED":
      return [
        status.checksum
          ? "SESSION LOADED (UNVERIFIED)"
          : "SESSION LOADED (UNVERIFIED, NO CHECKSUM)",
        "warn"
      ];

    case "NOT_FOUND":
      return ["MODEL FILE NOT FOUND", "bad"];

    case "CHECKSUM_MISMATCH":
      return ["CHECKSUM MISMATCH", "bad"];

    default:
      return ["LOAD FAILED", "bad"];
  }
}

function showModelStatus(key, status) {

  const element =
    key === "face" ? readyFaceModel : readyReidModel;

  const [text, level] = describeModelStatus(status);

  setReady(element, text, level);
}

/*
 * Loads the ArcFace / Re-ID ONNX sessions through the embedding modules.
 * The modules are imported dynamically so that a failing ONNX Runtime
 * download only marks the face model row as failed instead of stopping
 * the whole app from loading. Each model reports its own status.
 *
 * A loaded session is NOT a working recognizer: preprocessing and
 * inference have not been verified yet, so the status says UNVERIFIED.
 */
function loadEmbeddingModels() {

  if (embeddingPromise) return embeddingPromise;

  setReady(readyFaceModel, "LOADING", "warn");

  const attempt = (async () => {

    try {

      const { initializeEmbeddingModels } =
        await import("./embedding/owner-embedding.js");

      const result = await initializeEmbeddingModels({
        onStatus: showModelStatus
      });

      // Show the final state of both models.
      showModelStatus("face", result.face);
      showModelStatus("reid", result.reid);

      // Allow a retry on the next start when the face model failed.
      if (result.face.state !== "SESSION_LOADED") {
        embeddingPromise = null;
      }

    } catch (error) {

      // The embedding modules themselves could not be loaded
      // (for example the ONNX Runtime download failed).
      console.error("Embedding models not available:", error);

      setReady(readyFaceModel, "LOAD FAILED (RUNTIME)", "bad");

      embeddingPromise = null;
    }
  })();

  embeddingPromise = attempt;

  return attempt;
}

async function loadDetectors() {

  aiStatus.textContent = "LOADING";
  setReady(readyPerson, "LOADING", "warn");
  setReady(readyFace, "LOADING", "warn");
  showAiLoadMessage(AI_LOAD_MESSAGES.LOADING, "info");

  let vision;
  let tasks;

  try {

    tasks = await withTimeout(import(MEDIAPIPE_BUNDLE_URL), "MediaPipe runtime");

    vision = await withTimeout(
      tasks.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL),
      "MediaPipe runtime"
    );

  } catch (error) {

    console.error("MediaPipe runtime load error:", error);

    aiStatus.textContent = "AI ERROR";
    setReady(readyPerson, "ERROR", "bad");
    setReady(readyFace, "ERROR", "bad");

    showAiLoadMessage(
      error instanceof AiLoadTimeoutError
        ? AI_LOAD_MESSAGES.TIMEOUT
        : AI_LOAD_MESSAGES.RUNTIME_FAILED,
      "bad"
    );

    throw error;
  }

  const errors = [];

  try {
    faceDetector = await withTimeout(
      tasks.FaceDetector.createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath: FACE_DETECTOR_MODEL_URL,
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.6
        }
      ),
      "Face detector",
      closeLate
    );
    setReady(readyFace, "READY", "ok");
  } catch (error) {
    console.error("Face detector load error:", error);
    faceDetector = null;
    errors.push(error);
    setReady(readyFace, "ERROR", "bad");
  }

  try {
    personDetector = await withTimeout(
      tasks.ObjectDetector.createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath: PERSON_DETECTOR_MODEL_URL,
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          scoreThreshold: 0.5,
          maxResults: 10
        }
      ),
      "Person detector",
      closeLate
    );
    setReady(readyPerson, "READY", "ok");
  } catch (error) {
    console.error("Person detector load error:", error);
    personDetector = null;
    errors.push(error);
    setReady(readyPerson, "ERROR", "bad");
  }

  if (!faceDetector && !personDetector) {
    aiStatus.textContent = "AI ERROR";
    showAiLoadMessage(
      errors.every(error => error instanceof AiLoadTimeoutError)
        ? AI_LOAD_MESSAGES.TIMEOUT
        : AI_LOAD_MESSAGES.PERSON_MODEL_FAILED,
      "bad"
    );
    throw errors[0];
  }

  if (!personDetector) {
    showAiLoadMessage(AI_LOAD_MESSAGES.PERSON_MODEL_FAILED, "bad");
  } else if (!faceDetector) {
    showAiLoadMessage(AI_LOAD_MESSAGES.FACE_MODEL_FAILED, "warn");
  } else {
    showAiLoadMessage(null);
  }

  // Detectors only. No identity recognition is available yet.
  aiStatus.textContent =
    faceDetector && personDetector ? "DETECTION ONLY" : "PARTIAL";

  return {
    face: Boolean(faceDetector),
    person: Boolean(personDetector)
  };
}

export function startOwnerAI() {

  if (!faceDetector && !personDetector) {
    throw new Error("AI detectors are not initialized.");
  }

  // Never run two processing loops at once.
  if (running) return;

  running = true;
  lastInference = 0;
  lastPersonInference = 0;

  tracker.reset();
  lastFaces = [];
  notifyTracking(true);

  rafId = requestAnimationFrame(processFrame);
}

// --------------------------------------------------
// Person selection (tap to follow a box)
// --------------------------------------------------

/* Receives a tracking snapshot whenever it changes. */
export function setPersonTrackingListener(listener) {

  trackingListener = listener;
  notifyTracking(true);
}

export function getPersonTrackingSnapshot() {
  return tracker.getSnapshot();
}

function notifyTracking(force = false) {

  if (!trackingListener) return;

  const snapshot = tracker.getSnapshot();
  const key = JSON.stringify(snapshot);

  if (!force && key === lastNotified) return;

  lastNotified = key;

  try {
    trackingListener(snapshot);
  } catch (error) {
    console.error("Tracking listener failed:", error);
  }
}

/*
 * Selects the person box at a point given in VIDEO pixels.
 * Returns { ok: true, id } or { ok: false, reason } with reason
 * NOT_RUNNING | NO_PERSON_DETECTOR | NO_PERSON_AT_POINT.
 * This only chooses a box to follow; it does not verify who the person is.
 */
export function selectPersonAt(x, y) {

  if (!running) return { ok: false, reason: "NOT_RUNNING" };

  if (!personDetector) return { ok: false, reason: "NO_PERSON_DETECTOR" };

  const result = tracker.selectAt(x, y, lastFrameTimestamp);

  // The highlight appears on the next processed frame (<= 250 ms).
  notifyTracking();

  return result;
}

export function clearPersonSelection() {

  tracker.clearSelection(lastFrameTimestamp);

  notifyTracking();
}
export function stopOwnerAI() {

  running = false;

  cancelCropRequest();

  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  tracker.stop();
  lastFaces = [];
  notifyTracking();

  ctx.clearRect(
    0, 0, canvas.width, canvas.height
  );

  faceStatus.textContent = "NOT RUNNING";
  personStatus.textContent = "NOT RUNNING";
  ownerStatus.textContent = UNVERIFIED_TEXT;
}

/* Releases the MediaPipe detectors (used when the page is closed). */
export function disposeOwnerAI() {

  stopOwnerAI();

  try { faceDetector?.close(); } catch (e) { console.error(e); }
  try { personDetector?.close(); } catch (e) { console.error(e); }

  faceDetector = null;
  personDetector = null;
  initPromise = null;

  setReady(readyPerson, "NOT LOADED", "");
  setReady(readyFace, "NOT LOADED", "");
  aiStatus.textContent = "NOT LOADED";
}

window.addEventListener("pagehide", disposeOwnerAI);

function drawBox(box, label, color, { dashed = false, thick = false } = {}) {

  // The canvas is drawn at video resolution (e.g. 640 px) but shown much
  // smaller on a phone, so the text size follows the canvas width.
  const fontSize = Math.max(13, Math.round(canvas.width / 32));

  ctx.strokeStyle = color;
  ctx.lineWidth = thick ? 4 : 2;
  ctx.setLineDash(dashed ? [10, 6] : []);

  ctx.strokeRect(
    box.originX,
    box.originY,
    box.width,
    box.height
  );

  ctx.setLineDash([]);

  ctx.font = `${fontSize}px Arial`;

  const textWidth = ctx.measureText(label).width;
  const padding = 3;

  // Keep the label inside the image.
  const x = Math.max(
    0,
    Math.min(box.originX, canvas.width - textWidth - padding * 2)
  );

  const above = box.originY - fontSize - padding * 2;
  const y = above >= 0 ? above : box.originY;

  ctx.fillStyle = color;
  ctx.fillRect(x, y, textWidth + padding * 2, fontSize + padding * 2);

  ctx.fillStyle = "#05090d";
  ctx.textBaseline = "top";
  ctx.fillText(label, x + padding, y + padding);
  ctx.textBaseline = "alphabetic";
}

function scheduleNextFrame() {

  if (running) {
    rafId = requestAnimationFrame(processFrame);
  }
}

// Every person box says it is not identity-verified, selected or not.
function drawPersons(now) {

  for (const person of tracker.getDrawables(now)) {

    const percent = `${Math.round(person.score * 100)}%`;

    if (person.selected) {

      drawBox(
        person.box,
        person.searching
          ? `กำลังค้นหา #${person.id} · ${UNVERIFIED_TEXT}`
          : `ติดตาม #${person.id} ${percent} · ${UNVERIFIED_TEXT}`,
        "#ffb020",
        { dashed: person.searching, thick: true }
      );

    } else {

      drawBox(
        person.box,
        `PERSON ${percent} · ${UNVERIFIED_TEXT}`,
        "#b18cff"
      );
    }
  }
}

/*
 * Redraws everything on the overlay. Person boxes move smoothly toward their
 * latest detection, so this runs on every animation frame, not only when
 * the detectors run.
 */
function renderOverlay(now) {

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const face of lastFaces) {

    drawBox(
      face.box,
      `FACE ${Math.round(face.score * 100)}%`,
      "#00ffcc"
    );
  }

  drawPersons(now);
}

function processFrame(timestamp) {

  if (!running) return;

  lastFrameTimestamp = timestamp;

  if (cameraStalled()) {

    // Frames are not arriving: run no detection on the frozen image,
    // clear its boxes, and let a selected target time out as lost.
    tracker.tick(timestamp, { stalled: true });
    notifyTracking();

    if (canvas.width && canvas.height) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    lastFaces = [];
    faceStatus.textContent = "NO CAMERA FRAMES";
    personStatus.textContent = "NO CAMERA FRAMES";

    scheduleNextFrame();
    return;
  }

  if (timestamp - lastInference < INFERENCE_INTERVAL) {

    // No detection this frame: only move the boxes a little.
    if (canvas.width && canvas.height) {
      tracker.tick(timestamp);
      renderOverlay(timestamp);
      notifyTracking();
    }

    scheduleNextFrame();
    return;
  }

  lastInference = timestamp;

  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    scheduleNextFrame();
    return;
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);

  try {

    let faceList = [];

    if (faceDetector) {

      const faces = faceDetector.detectForVideo(
        video,
        timestamp
      );

      faceList = faces.detections || [];

      faceStatus.textContent =
        `${faceList.length} FACE(S)`;

      lastFaces = faceList
        .filter(face => face.boundingBox)
        .map(face => ({
          box: face.boundingBox,
          score: face.categories?.[0]?.score ?? 0
        }));

      // Uses the same frame and detections that were just computed.
      serveCropRequest(faceList, timestamp, width, height);
    }

    if (
      personDetector &&
      timestamp - lastPersonInference >= PERSON_INTERVAL
    ) {

      lastPersonInference = timestamp;

      const people = personDetector.detectForVideo(
        video,
        timestamp
      );

      const persons = [];

      for (const detection of people.detections || []) {

        const category = detection.categories?.find(
          item => item.categoryName === "person"
        );

        if (category && detection.boundingBox) {
          persons.push({
            box: detection.boundingBox,
            score: category.score ?? 0
          });
        }
      }

      // Only needed while a box is selected (the tracker uses it only when
      // that box is missing), so the thumbnail is not read otherwise.
      const blocked =
        tracker.getSnapshot().selectedId !== null
          ? looksBlocked()
          : false;

      tracker.update(persons, timestamp, width, height, { blocked });

      personStatus.textContent =
        `${persons.length} PERSON(S)`;
    }

    tracker.tick(timestamp);
    renderOverlay(timestamp);
    notifyTracking();

    // Detection is not identity verification.
    ownerStatus.textContent = UNVERIFIED_TEXT;

  } catch (error) {

    console.error("Inference error:", error);
    aiStatus.textContent = "INFERENCE ERROR";
  }

  scheduleNextFrame();
}
