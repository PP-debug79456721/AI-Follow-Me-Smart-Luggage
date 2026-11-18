
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

// Pure logic: owner face/clothing matching (bench, localhost only).
import {
  personForFace,
  bestFaceScore,
  boxIoU,
  colorSignature,
  signatureSimilarity,
  albumScore,
  learnIntoAlbum,
  vectorAlbumScore,
  learnIntoVectorAlbum,
  REID_ALBUM_DEFAULTS,
  ALBUM_DEFAULTS,
  createAgreement,
  createFusedAgreement,
  FUSION_DEFAULTS,
  RECOGNIZER_DEFAULTS
} from "./owner-recognizer.js";

// Pure logic: turns the raw selected box into STOP / FORWARD / LEFT / RIGHT.
import { decideMotion, MOTION_COMMAND, MOTION_REASON } from "./motion-decision.js";

// No external imports either: tells whether the camera still delivers
// new frames.
import { isCameraLive, getLastVideoFrameTime } from "./camera.js";
import { LITE_MODE, faceIntervalFor, personIntervalFor, reidIntervalsFor, workerModeFor } from "./lite-mode.js";

// Person detector in a Web Worker (opt-in ?worker=1): keeps the main thread free for the ESP32 link.
import { createPersonWorkerClient } from "./person-worker-client.js";

// Pure: chooses between a local vendor/ copy of the libraries/models and the CDN.
import { describeVendorPlan, loadVendorManifest, planVendorAssets } from "./vendor-assets.js";

// Pure, no external imports: where the owner features may run.
import { EDUCATION_HOSTS, ownerFeatureSet } from "./deploy-config.js";
import { resolveModelUseMode } from "./embedding/model-policy.js";

// Pure: user profile keys, names, the "another user" rule and the learning rule.
import {
  PROFILE_STORE, PROFILE_COUNT, profileKey, cleanProfileName,
  parseProfileMeta, bestProfileScore, looksLikeOtherProfile,
  learnEnabledFromSearch, autoLearnAllowed
} from "./owner-profiles.js";

// ?learn=0: no AUTOMATIC learning while following (for repeatable tests).
// ENROL, REMEMBER CLOTHES and ADD VIEW still work.
const LEARN_ENABLED = learnEnabledFromSearch(location.search);
if (!LEARN_ENABLED) console.info("[LEARN OFF] automatic Re-ID / clothing learning is off (?learn=0)");

const MEDIAPIPE_VERSION = "0.10.35";

const MEDIAPIPE_BUNDLE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const FACE_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const PERSON_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

// Only used to describe the ONNX Runtime part of the vendor plan in the log; the real loading is in
// embedding/embedding-engine.js (same version and URLs, keep them in sync).
const ORT_VERSION_FOR_VENDOR = "1.31.1";
const ORT_CDN_MODULE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION_FOR_VENDOR}/dist/ort.wasm.min.mjs`;
const ORT_CDN_BASE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION_FOR_VENDOR}/dist/`;

// Local-first loading (see vendor-assets.js): files in vendor/ are used when vendor/vendor-manifest.json
// lists them, otherwise (or when a local file fails to load) the CDN URLs above, exactly as before.
const VENDOR_BASE_URL = new URL("../vendor/", import.meta.url).href;
const WORKER_MODE = workerModeFor(location.search, LITE_MODE);
let personWorker = null;                   // person-worker-client while the worker detector is in use
let mpTasks = null;                        // MediaPipe tasks/vision kept for the main-thread fallback
let mpVision = null;
let faceModelUrl = FACE_DETECTOR_MODEL_URL;
let personModelUrl = PERSON_DETECTOR_MODEL_URL;
let libLabel = null;                       // "LOCAL" | "CDN" | "MIXED" once the runtime is loading

async function loadMediapipeRuntime() {

  const manifest = await loadVendorManifest({ baseUrl: VENDOR_BASE_URL });
  const plan = planVendorAssets(manifest, {
    baseUrl: VENDOR_BASE_URL,
    mediapipeVersion: MEDIAPIPE_VERSION,
    ortVersion: ORT_VERSION_FOR_VENDOR,
    cdn: {
      mediapipeBundle: MEDIAPIPE_BUNDLE_URL,
      mediapipeWasm: MEDIAPIPE_WASM_URL,
      ortModule: ORT_CDN_MODULE_URL,
      ortBase: ORT_CDN_BASE_URL,
      personModel: PERSON_DETECTOR_MODEL_URL,
      faceModel: FACE_DETECTOR_MODEL_URL
    }
  });

  faceModelUrl = plan.models.face.url;
  personModelUrl = plan.models.person.url;
  libLabel = describeVendorPlan(plan);
  console.info(`[vendor] libraries: ${libLabel} (mediapipe ${plan.mediapipe.source}/${plan.mediapipe.reason}, ` +
    `onnxruntime ${plan.onnx.source}/${plan.onnx.reason}, person model ${plan.models.person.source}, ` +
    `face model ${plan.models.face.source})`);

  if (plan.mediapipe.source === "local") {
    try {
      const tasks = await import(plan.mediapipe.bundleUrl);
      return { tasks, wasmUrl: plan.mediapipe.wasmUrl, bundleUrl: plan.mediapipe.bundleUrl };
    } catch (error) {
      // For example a server that sends .mjs with the wrong content type: use the CDN instead.
      console.warn("[vendor] local MediaPipe failed to load, using the CDN:", error);
      libLabel = "MIXED";
    }
  }

  return { tasks: await import(MEDIAPIPE_BUNDLE_URL), wasmUrl: MEDIAPIPE_WASM_URL, bundleUrl: MEDIAPIPE_BUNDLE_URL };
}

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

// Person detection must be faster than the ESP32 link's evidence limit
// (esp32-link.js ageClaimMaxMs = 450 ms): a movement decision older than that
// is sent as STOP. At 500 ms every decision went stale before the next
// detection, so the wheels only got short pulses. 200 ms keeps the age of a
// healthy target at about 200-350 ms.
const INFERENCE_INTERVAL = 100;
const PERSON_INTERVAL = 200;
// With the detector in a worker the main thread no longer pays for the inference, so detect more often:
// a fresher target means a smaller age at the link gate (450 ms) and smoother wheels. The next request is
// chained to the previous result (see requestWorkerPersons) instead of waiting for the 100 ms frame gate.
const PERSON_INTERVAL_WORKER = 150;

// Phones (lite mode) heat up: on a mid-range phone INF grew from ~180 ms to ~270 ms after 10 minutes.
// While the luggage is NOT following (waiting, choosing the owner) there is no need to detect 5 times
// a second, so lite mode detects every 500 ms until FOLLOW is switched on (setFollowActive).
const PERSON_INTERVAL_IDLE = 500;
let followActive = false;

// Lite mode redraws the overlay at most this often (the boxes glide, 15 fps is enough).
const OVERLAY_INTERVAL_LITE = 66;
let lastOverlayAt = 0;

// looksBlocked() reads pixels back from the GPU; its result only explains a LOST target, so it runs
// at most once per second.
const BLOCKED_CHECK_INTERVAL = 1000;
let blockedCheckAt = -Infinity;
let blockedCheckValue = false;

// Average detector time above this = the phone is slow or hot (shown on the detection card).
const SLOW_INFERENCE_AVG_MS = 250;
// Face detection is not used for motion (only for FACE CROP EXPORT and the
// face boxes), so it runs less often to leave time for person detection.
// ?lite=1 (phones): no face detection at all. On a phone it blocked the main
// thread long enough to push the ESP32 link RTT above its 300 ms gate (laptop
// on the same Wi-Fi: 10-30 ms). FACE CROP EXPORT is unavailable in lite mode.
const FACE_INTERVAL = 500;     // normal period; faceIntervalFor() turns it off in lite mode and while following

function faceIntervalNow() {
  return faceIntervalFor({
    lite: LITE_MODE,
    following: followActive,
    tracking: followingSomeone(),
    enrolling: enrolRemaining > 0,
    cropPending: cropRequest !== null,
    normalMs: FACE_INTERVAL
  });
}

// Minimum detector score for a person box. The bench camera (low angle, backlit)
// often scores the owner 0.50-0.66, so 0.5 dropped boxes and the tracker went SEARCHING.
const PERSON_SCORE_THRESHOLD = 0.35;

function inferenceSummary() {
  let sum = 0;
  let max = 0;
  for (const sample of inferenceSamples) {
    sum += sample.ms;
    if (sample.ms > max) max = sample.ms;
  }
  return { avg: sum / inferenceSamples.length, max };
}

function inferenceStats() {
  const summary = inferenceSummary();
  return `${Math.round(summary.avg)}/${Math.round(summary.max)} ms`;
}

function inferenceIsSlow() {
  return inferenceSamples.length >= 10 && inferenceSummary().avg > SLOW_INFERENCE_AVG_MS;
}

function personIntervalMs() {
  return personIntervalFor({
    lite: LITE_MODE,
    following: followActive,
    normalMs: personWorker ? PERSON_INTERVAL_WORKER : PERSON_INTERVAL,
    idleMs: PERSON_INTERVAL_IDLE
  });
}

function looksBlockedThrottled(now) {
  if (now - blockedCheckAt >= BLOCKED_CHECK_INTERVAL) {
    blockedCheckAt = now;
    blockedCheckValue = looksBlocked();
  }
  return blockedCheckValue;
}

// app.js tells the detector whether FOLLOW is on (full rate) or off (lite mode slows down).
export function setFollowActive(active) {
  followActive = Boolean(active);
}

// Detection cycles in the last 60 s where the selected box was not matched (diagnostic only).
const MISS_WINDOW_MS = 60000;
let selectedMissTimes = [];

// Time spent inside personDetector.detectForVideo in the last 60 s (diagnostic only):
// tells how heavy the detector is on this device (a phone vs the laptop).
let inferenceSamples = [];
let lastFaceInference = 0;
let personDelegate = null;
// Measured gap between person detections (ms), shown in the status line.
let personGapMs = null;

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

// Owner recognition: on this computer (localhost / 127.0.0.1) and on the
// education host named in deploy-config.js (EDUCATION_HOSTS, empty by default).
//   OWNER_HOST     clothing album, no model; also in lite mode.
//   FACE_FEATURES  SFace; never in lite mode (it needs face detection).
//   REID_FEATURES  OSNet Re-ID; in lite mode (phones) only when the page was
//                  opened with ?modelMode=development, and off with ?reid=0.
// The models themselves still load only through model-policy.js, i.e. with
// ?modelMode=development (DEVELOPMENT_ONLY licence).
const OWNER_SET = ownerFeatureSet({
  hostname: location.hostname,
  lite: LITE_MODE,
  modelsRequested: resolveModelUseMode(location, EDUCATION_HOSTS) === "development",
  search: location.search
});
const OWNER_HOST = OWNER_SET.clothes;
const FACE_FEATURES = OWNER_SET.face;
const REID_FEATURES = OWNER_SET.reid;
const LOAD_RECOGNITION_MODELS = FACE_FEATURES || REID_FEATURES;
// Lite mode never loads the 38.7 MB face model.
const RECOGNITION_MODEL_KEYS = [FACE_FEATURES && "face", REID_FEATURES && "reid"].filter(Boolean);

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

    // Refused by models/manifest.json policy; nothing was downloaded.
    case "BLOCKED":
      return [`BLOCKED: ${status.reason || "POLICY"}`, "bad"];

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
      // Only reachable with size + SHA-256 checked (fail-closed loader).
      return [
        status.mode === "development"
          ? `SESSION LOADED (DEVELOPMENT ONLY, LICENSE ${status.license || "UNVERIFIED"})`
          : "SESSION LOADED (RECOGNITION NOT VERIFIED)",
        "warn"
      ];

    case "NOT_FOUND":
      return ["MODEL FILE NOT FOUND", "bad"];

    case "SIZE_MISMATCH":
      return ["FILE SIZE MISMATCH", "bad"];

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

  if (FACE_FEATURES) setReady(readyFaceModel, "LOADING", "warn");
  else setReady(readyFaceModel, "OFF (LITE MODE)", "");

  const attempt = (async () => {

    try {

      const { initializeEmbeddingModels } =
        await import("./embedding/owner-embedding.js");

      const result = await initializeEmbeddingModels({
        onStatus: showModelStatus,
        only: RECOGNITION_MODEL_KEYS
      });

      // Show the final state of the models this page uses.
      for (const key of RECOGNITION_MODEL_KEYS) showModelStatus(key, result[key]);

      // Re-ID re-acquire may run as soon as its model is loaded. Before this,
      // the flag was set only while learning during TRACKING, so after a page
      // load the owner was re-acquired from clothing colours alone.
      if (REID_FEATURES) reidReadyCache = result.reid?.state === "SESSION_LOADED";

      // Allow a retry on the next start when a wanted model failed.
      if (RECOGNITION_MODEL_KEYS.some(key => result[key].state !== "SESSION_LOADED")) {
        embeddingPromise = null;
      }

    } catch (error) {

      // The embedding modules themselves could not be loaded
      // (for example the ONNX Runtime download failed).
      console.error("Embedding models not available:", error);

      setReady(FACE_FEATURES ? readyFaceModel : readyReidModel, "LOAD FAILED (RUNTIME)", "bad");

      embeddingPromise = null;
    }
  })();

  embeddingPromise = attempt;

  return attempt;
}

// Person detector on the main thread: GPU first; if the GPU delegate cannot be created on this
// browser/computer, fall back to CPU. Uses the MediaPipe runtime kept by loadDetectors().
function createMainPersonDetector(delegate) {
  return withTimeout(
    mpTasks.ObjectDetector.createFromOptions(
      mpVision,
      {
        baseOptions: {
          modelAssetPath: personModelUrl,
          delegate
        },
        runningMode: "VIDEO",
        scoreThreshold: PERSON_SCORE_THRESHOLD,
        maxResults: 10
      }
    ),
    `Person detector (${delegate})`,
    closeLate
  );
}

async function createMainPersonDetectorWithFallback() {
  try {
    personDetector = await createMainPersonDetector("GPU");
    personDelegate = "GPU";
  } catch (gpuError) {
    console.warn("Person detector: GPU unavailable, using CPU:", gpuError);
    personDetector = await createMainPersonDetector("CPU");
    personDelegate = "CPU";
  }
}

// True when SOME person detector (worker or main thread) can detect.
function hasPersonDetection() {
  return Boolean(personDetector || personWorker);
}

// Starts the person detector in a Web Worker with the same runtime/model sources the main thread uses.
async function startPersonWorker(runtime) {

  const client = createPersonWorkerClient({
    createWorker: () => new Worker(new URL("./person-worker.js", import.meta.url)),
    onFailure: handlePersonWorkerFailure
  });

  await client.start({
    bundleUrl: runtime.bundleUrl,
    wasmUrl: runtime.wasmUrl,
    modelUrl: personModelUrl,
    scoreThreshold: PERSON_SCORE_THRESHOLD,
    maxResults: 10,
    delegates: ["GPU", "CPU"]
  });

  return client;
}

// The worker died or stopped answering: go back to the main-thread detector (same as without ?worker=1).
function handlePersonWorkerFailure(reason) {

  console.warn("[worker] person worker failed, switching to the main thread:", reason);

  personWorker = null;
  personDelegate = null;

  if (!mpTasks || !mpVision) {
    setReady(readyPerson, "ERROR (WORKER)", "bad");
    return;
  }

  setReady(readyPerson, "LOADING (WORKER FAILED)", "warn");

  createMainPersonDetectorWithFallback()
    .then(() => {
      setReady(readyPerson, "READY", "ok");
      personDelegate = `${personDelegate} · MAIN (worker failed)`;
    })
    .catch(error => {
      console.error("Person detector fallback failed:", error);
      personDetector = null;
      setReady(readyPerson, "ERROR", "bad");
    });
}

async function loadDetectors() {

  aiStatus.textContent = "LOADING";
  setReady(readyPerson, "LOADING", "warn");
  setReady(readyFace, "LOADING", "warn");
  showAiLoadMessage(AI_LOAD_MESSAGES.LOADING, "info");

  let vision;
  let tasks;
  let runtime;

  try {

    runtime = await withTimeout(loadMediapipeRuntime(), "MediaPipe runtime");
    tasks = runtime.tasks;

    vision = await withTimeout(
      tasks.FilesetResolver.forVisionTasks(runtime.wasmUrl),
      "MediaPipe runtime"
    );

    mpTasks = tasks;
    mpVision = vision;

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
            modelAssetPath: faceModelUrl,
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

  // Person detection feeds the motion decision, so it must be fast (see
  // PERSON_INTERVAL). Opt-in (?worker=1): run it in a Web Worker so the main thread
  // stays free for the ESP32 link; any failure falls back to the main-thread detector.
  let workerStartFailed = false;
  if (WORKER_MODE) {
    try {
      personWorker = await startPersonWorker(runtime);
      personDelegate = `${personWorker.getDelegate() ?? "?"} · WORKER`;
      setReady(readyPerson, "READY", "ok");
    } catch (workerError) {
      console.warn("[worker] person worker could not start, using the main thread:", workerError);
      personWorker = null;
      workerStartFailed = true;
    }
  }

  if (!personWorker) {
    try {
      await createMainPersonDetectorWithFallback();
      if (workerStartFailed) personDelegate = `${personDelegate} · MAIN (worker unavailable)`;
      setReady(readyPerson, "READY", "ok");
    } catch (error) {
      console.error("Person detector load error:", error);
      personDetector = null;
      personDelegate = null;
      errors.push(error);
      setReady(readyPerson, "ERROR", "bad");
    }
  }

  if (!faceDetector && !hasPersonDetection()) {
    aiStatus.textContent = "AI ERROR";
    showAiLoadMessage(
      errors.every(error => error instanceof AiLoadTimeoutError)
        ? AI_LOAD_MESSAGES.TIMEOUT
        : AI_LOAD_MESSAGES.PERSON_MODEL_FAILED,
      "bad"
    );
    throw errors[0];
  }

  if (!hasPersonDetection()) {
    showAiLoadMessage(AI_LOAD_MESSAGES.PERSON_MODEL_FAILED, "bad");
  } else if (!faceDetector) {
    showAiLoadMessage(AI_LOAD_MESSAGES.FACE_MODEL_FAILED, "warn");
  } else {
    showAiLoadMessage(null);
  }

  // Detectors only. No identity recognition is available yet.
  aiStatus.textContent =
    faceDetector && hasPersonDetection() ? "DETECTION ONLY" : "PARTIAL";

  return {
    face: Boolean(faceDetector),
    person: hasPersonDetection()
  };
}

export function startOwnerAI() {

  if (!faceDetector && !hasPersonDetection()) {
    throw new Error("AI detectors are not initialized.");
  }

  // Never run two processing loops at once.
  if (running) return;

  running = true;
  lastInference = 0;
  lastPersonInference = 0;
  lastFaceInference = 0;
  personGapMs = null;

  tracker.reset();
  lockedSelectionId = null;
  otherProfileLabels = [];
  lastFaces = [];
  notifyTracking(true);

  rafId = requestAnimationFrame(processFrame);
}

// --------------------------------------------------
// Owner recognition (bench, localhost only)
// --------------------------------------------------
//
// Face (SFace, needs ?modelMode=development) locks on to the enrolled owner
// and re-acquires them when they face the camera. The clothing colour
// signature of the followed box re-acquires them from BEHIND. Both only
// SELECT a box in the tracker; they never send motion commands. Automatic
// selection happens only while nobody is being followed (NOT_SELECTED / LOST),
// never while TRACKING or SEARCHING, and never after CLEAR SELECTION until the
// user taps someone or presses FIND OWNER.

const OWNER_STORE = "owner.face.v1";      // 128-D vectors only, never images
const CLOTH_STORE = "owner.cloth.v2";     // album of colour histograms only, never images
const CLOTH_ADD_GAP_MS = 2000;            // at most one new automatic view per 2 s
const REID_STORE = "owner.reid.v1";       // 512-D OSNet vectors only, never images
const REID_LEARN_MS = 1000;               // learn the followed person at most once per second
const REID_SEARCH_MS = 500;               // re-acquire round at most every 0.5 s (lite: 1 s, see lite-mode.js)

// Effective Re-ID intervals: slower on phones so the main thread stays free for the ESP32 link.
function reidIntervals() {
  return reidIntervalsFor({
    lite: LITE_MODE,
    following: followActive,
    learnMs: REID_LEARN_MS,
    searchMs: REID_SEARCH_MS
  });
}
const REID_MAX_CANDIDATES = 3;
const ENROL_SAMPLES = 5;
const FACE_ROUND_MS = 700;                // at most one SFace round per 0.7 s
const MIN_FACE_PX = 40;                   // smaller faces are skipped
const SIGNATURE_REFRESH_MS = 500;
const SIGNATURE_W = 24;
const SIGNATURE_H = 48;

// Up to 3 user profiles; ONE is active. Only the active profile is searched
// for, auto-selected and learned. Profile 1 keeps the original keys (no
// migration); profiles 2-3 use "owner.p2." / "owner.p3." keys.
// Keys, names and the "another user" rule: js/owner-profiles.js.
const OTHER_LABEL_MS = 2000;
function loadProfileMeta() {
  let text = null;
  try { text = localStorage.getItem(PROFILE_STORE); } catch { /* blocked: defaults */ }
  return parseProfileMeta(text);
}
function saveProfileMeta() {
  try { localStorage.setItem(PROFILE_STORE, JSON.stringify(profileMeta)); } catch { /* storage full/blocked */ }
}
let profileMeta = loadProfileMeta();
let otherProfiles = [];          // [{ index, name, faces, reid, cloth }] of the NON-active profiles (cloth = album)
let otherProfileLabels = [];     // [{ box, name, at }] faces/bodies recognised as a non-active profile
let lockedSelectionId = null;    // tracker id chosen by owner recognition for the active profile
let lockedProfile = -1;
let lockedHow = "";             // "Re-ID" | "ใบหน้า" | "เสื้อผ้า": what recognised the locked box
// A clothing-only lock is upgraded to "Re-ID" after LABEL_UPGRADE_HITS
// consecutive Re-ID checks of the locked box pass. The Re-ID album is
// snapshotted at lock time so views learned from this box cannot confirm it.
const LABEL_UPGRADE_HITS = 3;
let lockedReidBaseline = [];
let lockedUpgradeHits = 0;

let ownerFaces = loadOwnerFaces();
let ownerAlbum = loadClothAlbum();       // [view0 (REMEMBER CLOTHES), learned views...]
let lastClothAddAt = 0;
let reidAlbum = loadReidAlbum();
let reidScore = NaN;                      // followed person vs the Re-ID album
let reidBusy = false;
let lastReidLearnAt = 0;
let lastReidAddAt = 0;
let lastReidSearchAt = 0;
let clothScore = NaN;                     // fresh crop of the followed box vs the remembered clothes
let lastClothSaveAt = 0;
let ownerAutoPaused = false;
let ownerLastScore = NaN;
let ownerLastEvent = "";
let enrolRemaining = 0;
let faceRoundBusy = false;
let lastFaceRoundAt = 0;
let lastIdentityCheckAt = 0;
let lastPersonBoxes = [];
let lastPersonAt = 0;
let faceModule = null;

const faceAgreement = createAgreement({
  threshold: RECOGNIZER_DEFAULTS.faceThreshold,
  margin: RECOGNIZER_DEFAULTS.faceMargin,
  window: RECOGNIZER_DEFAULTS.window,
  need: RECOGNIZER_DEFAULTS.need,
  sameBoxIoU: RECOGNIZER_DEFAULTS.sameBoxIoU
});
const clothAgreement = createAgreement({
  threshold: RECOGNIZER_DEFAULTS.clothThreshold,
  margin: RECOGNIZER_DEFAULTS.clothMargin,
  window: RECOGNIZER_DEFAULTS.window,
  need: RECOGNIZER_DEFAULTS.need,
  sameBoxIoU: RECOGNIZER_DEFAULTS.sameBoxIoU
});

// Re-ID and clothing colours decide TOGETHER when the owner is lost and found again (see
// createFusedAgreement): ?fuse=0 gives the old Re-ID-only rule, ?reidfloor=0.55 changes the weakest
// Re-ID that clothes may confirm (default 0.50, never above the Re-ID threshold).
const FUSE_SEARCH = new URLSearchParams(location.search).get("fuse") !== "0";
const REID_FLOOR = (() => {
  const value = Number(new URLSearchParams(location.search).get("reidfloor"));
  const wanted = Number.isFinite(value) && value > 0 ? value : FUSION_DEFAULTS.reidFloor;
  return Math.min(RECOGNIZER_DEFAULTS.reidThreshold, Math.max(0.3, wanted));
})();

const reidAgreement = createFusedAgreement({
  reidThreshold: RECOGNIZER_DEFAULTS.reidThreshold,
  reidFloor: FUSE_SEARCH ? REID_FLOOR : RECOGNIZER_DEFAULTS.reidThreshold,
  reidMargin: RECOGNIZER_DEFAULTS.reidMargin,
  clothThreshold: RECOGNIZER_DEFAULTS.clothThreshold,
  clothMargin: RECOGNIZER_DEFAULTS.clothMargin,
  window: RECOGNIZER_DEFAULTS.window,
  need: RECOGNIZER_DEFAULTS.need,
  sameBoxIoU: RECOGNIZER_DEFAULTS.sameBoxIoU
});

function resetOwnerAgreements() {
  faceAgreement.reset();
  clothAgreement.reset();
  reidAgreement.reset();
}

function loadOwnerFaces(i = profileMeta.active) {
  try {
    const raw = JSON.parse(localStorage.getItem(profileKey(OWNER_STORE, i)) || "[]");
    return Array.isArray(raw)
      ? raw.filter(v => Array.isArray(v) && v.length === 128 && v.every(Number.isFinite))
      : [];
  } catch {
    return [];
  }
}

function loadReidAlbum(i = profileMeta.active) {
  try {
    const raw = JSON.parse(localStorage.getItem(profileKey(REID_STORE, i)) || "[]");
    return Array.isArray(raw)
      ? raw.filter(v => Array.isArray(v) && v.length === 512 && v.every(Number.isFinite))
          .slice(0, REID_ALBUM_DEFAULTS.maxViews)
      : [];
  } catch {
    return [];
  }
}

function saveReidAlbum() {
  try {
    const key = profileKey(REID_STORE, profileMeta.active);
    if (reidAlbum.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(reidAlbum));
  } catch { /* storage full/blocked */ }
}

function loadClothAlbum(i = profileMeta.active) {
  try {
    localStorage.removeItem("owner.cloth.v1");   // v1 was saved unreadably (typed arrays); drop it
    const raw = JSON.parse(localStorage.getItem(profileKey(CLOTH_STORE, i)) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(v => v && Array.isArray(v.upper) && Array.isArray(v.lower) &&
                   v.upper.length === v.lower.length && v.upper.every(Number.isFinite))
      .slice(0, ALBUM_DEFAULTS.maxViews);
  } catch {
    return [];
  }
}

function saveClothAlbum() {
  try {
    const key = profileKey(CLOTH_STORE, profileMeta.active);
    if (ownerAlbum.length === 0) { localStorage.removeItem(key); return; }
    const plain = ownerAlbum.map(v => ({ upper: Array.from(v.upper), lower: Array.from(v.lower) }));
    localStorage.setItem(key, JSON.stringify(plain));
  } catch { /* storage full/blocked */ }
}

function saveOwnerFaces() {
  try { localStorage.setItem(profileKey(OWNER_STORE, profileMeta.active), JSON.stringify(ownerFaces)); } catch { /* storage full/blocked */ }
}

/* The non-active profiles, read-only: used only to REFUSE a match that looks
   more like another registered user, and to label that person's box. */
function refreshOtherProfiles() {
  otherProfiles = [];
  for (let i = 0; i < PROFILE_COUNT; i++) {
    if (i === profileMeta.active) continue;
    otherProfiles.push({
      index: i, name: profileMeta.names[i],
      faces: loadOwnerFaces(i), reid: loadReidAlbum(i), cloth: loadClothAlbum(i)
    });
  }
}
refreshOtherProfiles();

/* Best { name, score } of a non-active profile, or null. */
function bestOtherProfile(scoreOf) {
  return bestProfileScore(otherProfiles, scoreOf);
}

function noteOtherProfile(box, name, at) {
  otherProfileLabels = otherProfileLabels
    .filter(l => at - l.at < OTHER_LABEL_MS && boxIoU(l.box, box) < 0.3);
  otherProfileLabels.push({ box, name, at });
}

function otherProfileLabelFor(box, now) {
  const hit = otherProfileLabels.find(l => now - l.at < OTHER_LABEL_MS && boxIoU(l.box, box) >= 0.3);
  return hit ? hit.name : null;
}

function lockedOwnerName(id) {
  return id !== null && id === lockedSelectionId && lockedProfile === profileMeta.active
    ? profileMeta.names[lockedProfile] : null;
}

async function getFaceModule() {
  if (!faceModule) {
    faceModule = Promise.all([
      import("./embedding/face-embedding.js"),
      import("./embedding/owner-embedding.js"),
      import("./embedding/reid-embedding.js"),
      import("./embedding/reid-model-config.js")
    ]).then(([face, owner, reid, reidConfig]) => ({ face, owner, reid, reidConfig }));
  }
  return faceModule;
}

async function faceModelReady() {
  if (!FACE_FEATURES) return false;
  try {
    const { owner } = await getFaceModule();
    return owner.getEmbeddingModelStatus().face?.state === "SESSION_LOADED";
  } catch {
    return false;
  }
}

/* True when the OSNet Re-ID session is loaded (development mode, file present). */
let reidReadyCache = false;
async function reidModelReady() {
  if (!REID_FEATURES) return false;
  try {
    const { owner } = await getFaceModule();
    reidReadyCache = owner.getEmbeddingModelStatus().reid?.state === "SESSION_LOADED";
  } catch {
    reidReadyCache = false;
  }
  return reidReadyCache;
}

async function reidVector(box) {
  const { reid, reidConfig } = await getFaceModule();
  // The crop is taken synchronously from the current video frame before
  // the first await inside createEmbedding.
  const v = await reid.generateReIDEmbedding(video, box, reidConfig.REID_MODEL_CONFIG);
  return Array.from(v);
}

/* Automatic learning allowed for the person followed right now? (owner-profiles.js) */
function followedLearnAllowed() {
  const target = tracker.getTarget();
  return autoLearnAllowed({
    learnEnabled: LEARN_ENABLED,
    targetId: target ? target.id : null,
    lockedId: lockedSelectionId,
    lockedProfile,
    activeProfile: profileMeta.active,
    lockedHow
  });
}

/* Learn the followed person (TRACKING, alone) into the Re-ID album. */
function reidLearn(timestamp, box, force = false, reset = false) {
  if (!REID_FEATURES || reidBusy) return;
  reidBusy = true;
  (async () => {
    try {
      if (!(await reidModelReady())) return;
      const v = await reidVector(box);
      if (reset) reidAlbum = [];
      if (force) {
        const r = learnIntoVectorAlbum(reidAlbum, v, { newViewAbove: -1, sameViewAbove: 1.01 });
        reidAlbum = r.album;
        reidScore = 1;
        saveReidAlbum();
        return;
      }
      reidScore = vectorAlbumScore(reidAlbum, v);
      checkLabelUpgrade(v);
      // Scoring and the label check above always run; learning only when allowed.
      if (!followedLearnAllowed()) return;
      const canAdd = timestamp - lastReidAddAt >= CLOTH_ADD_GAP_MS;
      const r = learnIntoVectorAlbum(reidAlbum, v,
        canAdd ? {} : { newViewAbove: REID_ALBUM_DEFAULTS.sameViewAbove });
      reidAlbum = r.album;
      if (r.action === "add") { lastReidAddAt = timestamp; saveReidAlbum(); }
      else if (r.action === "blend" && timestamp - lastClothSaveAt >= 5000) saveReidAlbum();
    } catch (error) {
      console.warn("Re-ID learn failed:", error);
    } finally {
      reidBusy = false;
    }
  })();
}

/*
 * Label only: a box locked by clothing colours becomes "จำได้จาก Re-ID" after
 * LABEL_UPGRADE_HITS consecutive checks where the box matches the Re-ID album
 * as it was at lock time and does not look more like another registered user.
 * One failed check restarts the count. Selection and motor commands are not
 * affected.
 */
function checkLabelUpgrade(v) {
  if (lockedHow !== "เสื้อผ้า" || lockedProfile !== profileMeta.active) return;
  const target = tracker.getTarget();
  if (!target || target.id !== lockedSelectionId || !target.matched) return;
  if (lockedReidBaseline.length === 0) return;

  const own = vectorAlbumScore(lockedReidBaseline, v);
  const other = bestOtherProfile(p => p.reid.length ? vectorAlbumScore(p.reid, v) : NaN);
  const pass = own >= RECOGNIZER_DEFAULTS.reidThreshold &&
    !looksLikeOtherProfile(own, other, RECOGNIZER_DEFAULTS.reidThreshold);

  lockedUpgradeHits = pass ? lockedUpgradeHits + 1 : 0;
  if (lockedUpgradeHits >= LABEL_UPGRADE_HITS) {
    lockedHow = "Re-ID";
    ownerLastEvent = "ยืนยันตัวตนด้วย Re-ID แล้ว";
  }
}

/* Re-acquire with Re-ID: score up to 3 person boxes of THIS detection round. */
function reidSearch(timestamp) {
  if (reidBusy) return;
  lastReidSearchAt = timestamp;
  reidBusy = true;
  const boxes = lastPersonBoxes.slice(0, REID_MAX_CANDIDATES);
  // Clothing colours of the same boxes, read NOW (synchronously), before the first await: same frame.
  const clothScores = boxes.map(b => {
    if (ownerAlbum.length === 0) return NaN;
    const sig = signatureOf(b);
    if (!sig) return NaN;
    const own = albumScore(ownerAlbum, sig);
    const other = bestOtherProfile(p => p.cloth.length ? albumScore(p.cloth, sig) : NaN);
    // Looks more like another registered user: no clothes evidence for this person.
    return looksLikeOtherProfile(own, other, RECOGNIZER_DEFAULTS.clothThreshold) ? NaN : own;
  });
  (async () => {
    try {
      const candidates = [];
      for (let i = 0; i < boxes.length; i += 1) {
        const b = boxes[i];
        const v = await reidVector(b);
        const own = vectorAlbumScore(reidAlbum, v);
        const other = bestOtherProfile(p => p.reid.length ? vectorAlbumScore(p.reid, v) : NaN);
        if (looksLikeOtherProfile(own, other, RECOGNIZER_DEFAULTS.reidThreshold)) {
          noteOtherProfile(b, other.name, timestamp);
          candidates.push({ box: b, reid: NaN, cloth: NaN });   // looks more like another user: never chosen
        } else {
          candidates.push({ box: b, reid: own, cloth: clothScores[i] });
        }
      }
      const best = Math.max(...candidates.map(c => c.reid).filter(Number.isFinite));
      if (Number.isFinite(best)) ownerLastScore = best;
      const bestCloth = Math.max(...candidates.map(c => c.cloth).filter(Number.isFinite));
      ownerLastClothScore = Number.isFinite(bestCloth) ? bestCloth : NaN;
      const agreed = reidAgreement.push(candidates);
      if (agreed && !followingSomeone() && !ownerAutoPaused) {
        ownerLastScore = agreed.score;
        if (agreed.how === "reid+cloth") {
          // Weaker than Re-ID alone: labelled like a clothes match (no auto-learning until Re-ID confirms).
          autoSelect(agreed.box, "พบเจ้าของจาก Re-ID + เสื้อผ้า", "เสื้อผ้า");
        } else {
          autoSelect(agreed.box, "พบเจ้าของจาก Re-ID");
        }
      }
    } catch (error) {
      console.warn("Re-ID search failed:", error);
    } finally {
      reidBusy = false;
    }
  })();
}

let ownerLastClothScore = NaN;   // best clothes score of the last Re-ID search round (display only)

function ownerStatusText() {
  if (!OWNER_HOST) return UNVERIFIED_TEXT;
  if (enrolRemaining > 0) return `กำลังลงทะเบียนหน้า… เหลือ ${enrolRemaining}`;
  const score = Number.isFinite(ownerLastScore) ? ` ${ownerLastScore.toFixed(2)}` : "";
  const parts = [];
  if (FACE_FEATURES) {
    parts.push(ownerFaces.length ? `หน้าเจ้าของ ${ownerFaces.length} ภาพ` : "ยังไม่ลงทะเบียนหน้า");
  }
  if (ownerAlbum.length === 0) parts.push("ยังไม่จำเสื้อผ้า");
  else {
    parts.push(`จำเสื้อผ้า ${ownerAlbum.length}/${ALBUM_DEFAULTS.maxViews} มุม`);
    if (followingSomeone() && Number.isFinite(clothScore)) parts.push(`ตรง ${clothScore.toFixed(2)}`);
  }
  if (reidReadyCache) {
    let t = reidAlbum.length ? `Re-ID ${reidAlbum.length}/${REID_ALBUM_DEFAULTS.maxViews}` : "Re-ID ยังไม่มีข้อมูล";
    if (followingSomeone() && Number.isFinite(reidScore)) t += ` ตรง ${reidScore.toFixed(2)}`;
    parts.push(t);
  }
  if (ownerAutoPaused) parts.push("หยุดหาอัตโนมัติ");
  if (!LEARN_ENABLED) parts.push("ไม่เรียนรู้อัตโนมัติ (learn=0)");
  else if (followingSomeone() && !followedLearnAllowed()) parts.push("รอยืนยันตัวตนก่อนเรียนรู้");
  const clothNote = !followingSomeone() && Number.isFinite(ownerLastClothScore) && Number.isFinite(ownerLastScore)
    ? ` (เสื้อ ${ownerLastClothScore.toFixed(2)})` : "";
  if (ownerLastEvent) parts.push(ownerLastEvent + score + clothNote);
  else if (clothNote && reidReadyCache) parts.push(`ค้นหา Re-ID${score}${clothNote}`);   // the scores while searching
  return parts.join(" · ");
}

function videoCropRGBA(b) {
  // Small crop of the person box: enough for colour histograms, cheap to read.
  if (!statsCtx) return null;
  try {
    ownerCropCanvas.width = SIGNATURE_W;
    ownerCropCanvas.height = SIGNATURE_H;
    ownerCropCtx.drawImage(video, b.originX, b.originY, b.width, b.height, 0, 0, SIGNATURE_W, SIGNATURE_H);
    return ownerCropCtx.getImageData(0, 0, SIGNATURE_W, SIGNATURE_H).data;
  } catch {
    return null;
  }
}
const ownerCropCanvas = document.createElement("canvas");
const ownerCropCtx = ownerCropCanvas.getContext("2d", { willReadFrequently: true });

function signatureOf(b) {
  const px = videoCropRGBA(b);
  return px ? colorSignature(px, SIGNATURE_W, SIGNATURE_H) : null;
}

function autoSelect(b, how, label = null) {
  const c = { x: b.originX + b.width / 2, y: b.originY + b.height / 2 };
  const result = tracker.selectAt(c.x, c.y, lastFrameTimestamp);
  if (result.ok) {
    lockedSelectionId = result.id;
    lockedProfile = profileMeta.active;
    lockedHow = label ?? (how.includes("Re-ID") ? "Re-ID" : how.includes("ใบหน้า") ? "ใบหน้า" : "เสื้อผ้า");
    lockedReidBaseline = reidAlbum.slice();
    lockedUpgradeHits = 0;
    ownerLastEvent = how;
    resetOwnerAgreements();
    notifyTracking(true);
  }
}

function followingSomeone() {
  const state = tracker.getSnapshot().state;
  return state === "TRACKING" || state === "SEARCHING";
}

/* Called after every person detection round. */
function ownerAfterPersons(timestamp) {

  if (!OWNER_HOST || lastPersonAt !== timestamp) return;

  const target = tracker.getTarget();

  // Verify the currently matched target against the remembered clothing
  // before learning anything from it. This gate protects BOTH albums.
  if (target && target.state === "TRACKING" && target.matched &&
      timestamp - lastIdentityCheckAt >= SIGNATURE_REFRESH_MS) {
    lastIdentityCheckAt = timestamp;

    const alone = lastPersonBoxes.every(b =>
      boxIoU(b, target.box) > 0.9 || boxIoU(b, target.box) < 0.05
    );
    const sig = signatureOf(target.box);

    // With no album yet, the user's manual selection is the session
    // baseline. Once an album exists, require a measurable clothing match.
    let appearanceVerified = ownerAlbum.length === 0;

    if (ownerAlbum.length > 0) {
      const score = sig ? albumScore(ownerAlbum, sig) : NaN;
      clothScore = score;

      if (Number.isFinite(score)) {
        appearanceVerified = score >= RECOGNIZER_DEFAULTS.clothThreshold;
        if (!appearanceVerified) {
          tracker.rejectCurrentMatch(timestamp);
          resetOwnerAgreements();
          return;
        }
      } else {
        // Missing pixels / unusable crop is unknown, not a pass.
        appearanceVerified = false;
      }
    }

    // Never teach Re-ID or clothing from an unverified or crowded frame.
    if (alone && appearanceVerified) {
      tracker.confirmCurrentMatch();

      if (timestamp - lastReidLearnAt >= reidIntervals().learnMs &&
          (reidReadyCache || REID_FEATURES)) {
        lastReidLearnAt = timestamp;
        reidLearn(timestamp, target.box);
      }

      // Clothing is learned only when allowed: never with ?learn=0, never
      // while the lock rests on clothing colours alone.
      if (sig && followedLearnAllowed()) {
        // New views (owner turned around, jacket opened) are added at most
        // every 2 s; very different crops are not learned.
        const canAdd = timestamp - lastClothAddAt >= CLOTH_ADD_GAP_MS;
        const r = learnIntoAlbum(
          ownerAlbum,
          sig,
          canAdd ? {} : { newViewAbove: ALBUM_DEFAULTS.sameViewAbove }
        );
        ownerAlbum = r.album;
        if (r.action === "add") {
          lastClothAddAt = timestamp;
          saveClothAlbum();
        } else if (r.action === "blend" && timestamp - lastClothSaveAt >= 5000) {
          lastClothSaveAt = timestamp;
          saveClothAlbum();
        }
      }
    }
  }

  if (followingSomeone()) {
    resetOwnerAgreements();
    return;
  }
  clothScore = NaN;
  reidScore = NaN;

  // Re-acquire with Re-ID when its model is loaded and it has learned the
  // owner: it is more reliable than colours, so it decides alone.
  if (reidReadyCache && reidAlbum.length > 0) {
    if (!ownerAutoPaused && lastPersonBoxes.length > 0 && timestamp - lastReidSearchAt >= reidIntervals().searchMs) {
      reidSearch(timestamp);
    }
    return;
  }

  // Re-acquire from behind (clothing), only after this session followed the owner.
  if (ownerAutoPaused || ownerAlbum.length === 0 || lastPersonBoxes.length === 0) return;

  // Same rule as face and Re-ID: a person whose clothes look at least as much
  // like another registered user's is never chosen.
  const candidates = lastPersonBoxes.slice(0, 4).map(b => {
    const sig = signatureOf(b);
    const own = albumScore(ownerAlbum, sig);
    const other = sig ? bestOtherProfile(p => p.cloth.length ? albumScore(p.cloth, sig) : NaN) : null;
    if (looksLikeOtherProfile(own, other, RECOGNIZER_DEFAULTS.clothThreshold)) {
      noteOtherProfile(b, other.name, timestamp);
      return { box: b, score: NaN };
    }
    return { box: b, score: own };
  });
  const best = Math.max(...candidates.map(c => c.score).filter(Number.isFinite));
  if (Number.isFinite(best)) ownerLastScore = best;
  const agreed = clothAgreement.push(candidates);
  if (agreed) {
    ownerLastScore = agreed.score;
    autoSelect(agreed.box, "พบเจ้าของจากเสื้อผ้า");
  }
}

/* Called right after face detection, with the faces of THIS frame. */
function ownerAfterFaces(faceList, timestamp, width, height) {

  if (!FACE_FEATURES || faceRoundBusy) return;

  const enrolling = enrolRemaining > 0;
  const lookingForOwner = !enrolling && !ownerAutoPaused && ownerFaces.length > 0 && !followingSomeone();
  if (!enrolling && !lookingForOwner) return;
  if (timestamp - lastFaceRoundAt < FACE_ROUND_MS) return;
  if (timestamp - lastPersonAt > 400) return;   // person boxes too old for this frame

  const faces = faceList
    .filter(f => f.boundingBox && f.boundingBox.height >= MIN_FACE_PX &&
                 Array.isArray(f.keypoints) && f.keypoints.length >= 4)
    .map(f => ({ face: f, person: personForFace(f.boundingBox, lastPersonBoxes) }))
    .filter(x => x.person >= 0);

  let work;
  if (enrolling) {
    // Only the face inside the box being followed.
    const target = tracker.getTarget();
    if (!target || !target.matched) return;
    work = faces.filter(x => boxIoU(lastPersonBoxes[x.person], target.box) > 0.5).slice(0, 1);
  } else {
    work = faces
      .sort((a, b) => b.face.boundingBox.height - a.face.boundingBox.height)
      .slice(0, 2);
  }
  if (work.length === 0) return;

  lastFaceRoundAt = timestamp;
  faceRoundBusy = true;

  // Keypoints and pixels come from the same frame: the aligned crop is made
  // synchronously inside generateFaceEmbedding before any await.
  (async () => {
    try {
      if (!(await faceModelReady())) {
        if (enrolling) { enrolRemaining = 0; ownerLastEvent = "โมเดลจดจำหน้ายังไม่พร้อม"; }
        return;
      }
      const { face } = await getFaceModule();
      const results = [];
      for (const x of work) {
        const box = {
          ...x.face.boundingBox,
          keypoints: mediapipeKeypointsToPixels(x.face.keypoints, width, height)
        };
        const vector = await face.generateFaceEmbedding(video, box);
        results.push({ person: lastPersonBoxes[x.person], vector: Array.from(vector) });
      }

      if (enrolling) {
        ownerFaces.push(results[0].vector);
        if (ownerFaces.length > 20) ownerFaces = ownerFaces.slice(-20);
        saveOwnerFaces();
        enrolRemaining -= 1;
        ownerLastEvent = enrolRemaining > 0 ? "" : "ลงทะเบียนหน้าแล้ว";
        return;
      }

      const candidates = results.map(r => {
        const own = bestFaceScore(r.vector, ownerFaces);
        const other = bestOtherProfile(p => p.faces.length ? bestFaceScore(r.vector, p.faces) : NaN);
        if (looksLikeOtherProfile(own, other, RECOGNIZER_DEFAULTS.faceThreshold)) {
          noteOtherProfile(r.person, other.name, timestamp);
          return { box: r.person, score: NaN };       // looks more like another user: never chosen
        }
        return { box: r.person, score: own };
      });
      ownerLastScore = Math.max(...candidates.map(c => c.score).filter(Number.isFinite));
      const agreed = faceAgreement.push(candidates);
      if (agreed && !followingSomeone() && !ownerAutoPaused) {
        ownerLastScore = agreed.score;
        autoSelect(agreed.box, "พบเจ้าของจากใบหน้า");
      }
    } catch (error) {
      console.warn("Owner face round failed:", error);
      if (enrolling) { enrolRemaining = 0; ownerLastEvent = "ลงทะเบียนไม่สำเร็จ"; }
    } finally {
      faceRoundBusy = false;
    }
  })();
}

/* UI: capture ENROL_SAMPLES faces of the person currently followed. */
export function startOwnerEnrolment() {
  if (!FACE_FEATURES) return { ok: false, reason: "NOT_LOCALHOST" };
  const target = tracker.getTarget();
  if (!target || target.state !== "TRACKING") {
    ownerLastEvent = "แตะเลือกตัวเองก่อน (ต้องขึ้น TRACKING)";
    return { ok: false, reason: "SELECT_OWNER_FIRST" };
  }
  enrolRemaining = ENROL_SAMPLES;
  ownerLastEvent = "";
  return { ok: true };
}

/* UI: forget the enrolled face and the clothing signature. */
export function forgetOwner() {
  lockedSelectionId = null;
  ownerFaces = [];
  saveOwnerFaces();
  ownerAlbum = [];
  clothScore = NaN;
  saveClothAlbum();
  reidAlbum = [];
  reidScore = NaN;
  saveReidAlbum();
  enrolRemaining = 0;
  ownerLastScore = NaN;
  ownerLastEvent = "ลบข้อมูลเจ้าของแล้ว";
  resetOwnerAgreements();
}

function currentOwnerCrop() {
  const target = tracker.getTarget();
  if (!target || target.state !== "TRACKING" || !target.matched) {
    ownerLastEvent = "แตะเลือกตัวเองก่อน (ต้องขึ้น TRACKING)";
    return null;
  }
  return signatureOf(target.box);
}

/* UI: add the CURRENT view of the followed person (e.g. turn around and press
   it again for the back / sides). Manual, so no similarity check. */
export function addOwnerClothesView() {
  if (!OWNER_HOST) return { ok: false, reason: "NOT_LOCALHOST" };
  const sig = currentOwnerCrop();
  if (!sig) return { ok: false, reason: "SELECT_OWNER_FIRST" };
  if (ownerAlbum.length >= ALBUM_DEFAULTS.maxViews) ownerAlbum.splice(1, 1);
  ownerAlbum.push(sig);
  saveClothAlbum();
  const t = tracker.getTarget();
  if (t) reidLearn(lastFrameTimestamp, t.box, true);
  ownerLastEvent = `เพิ่มมุมเสื้อผ้าแล้ว (${ownerAlbum.length})`;
  resetOwnerAgreements();
  return { ok: true };
}

/* UI (method A): start a NEW clothing album from the person followed RIGHT NOW
   (new outfit). Stand alone in the picture (nobody overlapping). */
export function rememberOwnerClothes() {
  if (!OWNER_HOST) return { ok: false, reason: "NOT_LOCALHOST" };
  const target = tracker.getTarget();
  if (!target || target.state !== "TRACKING" || !target.matched) {
    ownerLastEvent = "แตะเลือกตัวเองก่อน (ต้องขึ้น TRACKING)";
    return { ok: false, reason: "SELECT_OWNER_FIRST" };
  }
  const sig = signatureOf(target.box);
  if (!sig) return { ok: false, reason: "NO_PIXELS" };
  ownerAlbum = [sig];
  clothScore = 1;
  saveClothAlbum();
  reidAlbum = [];                 // new outfit / new owner: start the Re-ID album again
  reidScore = NaN;
  saveReidAlbum();
  reidLearn(lastFrameTimestamp, target.box, true);
  ownerLastEvent = "จำเสื้อผ้าใหม่แล้ว";
  ownerLastScore = NaN;
  resetOwnerAgreements();
  return { ok: true };
}

/* UI: the 3 profiles with their counts (names are plain text). */
export function getOwnerProfiles() {
  return profileMeta.names.map((name, i) => {
    if (i === profileMeta.active) {
      return { index: i, name, active: true, faces: ownerFaces.length, reid: reidAlbum.length, cloth: ownerAlbum.length };
    }
    const p = otherProfiles.find(o => o.index === i);
    return { index: i, name, active: false, faces: p?.faces.length ?? 0, reid: p?.reid.length ?? 0, cloth: p?.cloth.length ?? 0 };
  });
}

/* UI: make profile i the one that is searched for and followed. Clears the
   current selection and pauses automatic search until FIND OWNER. */
export function setActiveOwnerProfile(i) {
  if (!OWNER_HOST) return { ok: false, reason: "NOT_LOCALHOST" };
  if (!Number.isInteger(i) || i < 0 || i >= PROFILE_COUNT) return { ok: false, reason: "BAD_PROFILE" };
  if (i === profileMeta.active) return { ok: true };
  profileMeta.active = i;
  saveProfileMeta();
  ownerFaces = loadOwnerFaces();
  ownerAlbum = loadClothAlbum();
  reidAlbum = loadReidAlbum();
  refreshOtherProfiles();
  enrolRemaining = 0;
  clothScore = NaN;
  reidScore = NaN;
  ownerLastScore = NaN;
  lockedSelectionId = null;
  otherProfileLabels = [];
  resetOwnerAgreements();
  if (running) tracker.clearSelection(lastFrameTimestamp);
  ownerAutoPaused = true;
  ownerLastEvent = `ผู้ใช้ปัจจุบัน: ${profileMeta.names[i]} · กด FIND OWNER เพื่อหา`;
  notifyTracking(true);
  return { ok: true };
}

/* UI: rename profile i (plain text, at most 20 characters). */
export function renameOwnerProfile(i, name) {
  if (!OWNER_HOST) return { ok: false, reason: "NOT_LOCALHOST" };
  if (!Number.isInteger(i) || i < 0 || i >= PROFILE_COUNT) return { ok: false, reason: "BAD_PROFILE" };
  profileMeta.names[i] = cleanProfileName(name, i);
  saveProfileMeta();
  refreshOtherProfiles();
  return { ok: true, name: profileMeta.names[i] };
}

/* UI: allow automatic re-acquire again after CLEAR SELECTION. */
export function findOwner() {
  ownerAutoPaused = false;
  ownerLastEvent = "กำลังหาเจ้าของ";
  resetOwnerAgreements();
}

export function ownerFeaturesEnabled() {
  return FACE_FEATURES;
}

export function ownerClothesEnabled() {
  return OWNER_HOST;
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

/*
 * The selected target for motion decisions: the RAW detected box in video
 * pixels (never the smoothed drawing box), the frame size, the tracker
 * state and the timestamps (same clock as requestAnimationFrame).
 * Returns null when nothing is selected. Read-only copies.
 */
export function getSelectedTarget() {

  const target = tracker.getTarget();

  if (!target) return null;

  return {
    ...target,
    now: lastFrameTimestamp,
    cameraLive: isMotionInputLive()
  };
}

/* Detection is running AND the camera is delivering fresh frames. */
function isMotionInputLive() {
  return running && isCameraLive() && !cameraStalled();
}

// Receives the motion decision on every processed frame, and whenever the
// selection or the camera changes. It only reports; nothing drives a motor.
let motionListener = null;
let lastMotion = {
  command: MOTION_COMMAND.STOP,
  reason: MOTION_REASON.CAMERA_UNAVAILABLE
};

// Stop when the person's box is this tall (fraction of the frame height).
// motion-decision's own default is 0.80; the bench owner chose 0.95 (follow
// closer). ?stop=0.80 etc. overrides it. Clamped to 0.50-0.95;
// motion-smoother resumes 0.10 below it (see app.js).
const BENCH_STOP_HEIGHT = 0.95;
export const STOP_HEIGHT_OVERRIDE = (() => {
  const value = Number(new URLSearchParams(location.search).get("stop"));
  const chosen = Number.isFinite(value) && value > 0 ? value : BENCH_STOP_HEIGHT;
  return Math.min(0.95, Math.max(0.5, chosen));
})();
const MOTION_OVERRIDES = STOP_HEIGHT_OVERRIDE ? { stopHeightRatio: STOP_HEIGHT_OVERRIDE } : {};

export function setMotionDecisionListener(listener) {

  motionListener = listener;
  publishMotion();
}

export function getMotionDecision() {
  return lastMotion;
}

// The decision uses the owner's box moved ahead by the measured speed (person-tracker getPredictedTarget):
// the last detection is 100-350 ms old, so the raw box makes turns late. ?predict=0 switches it off.
const PREDICT_MOTION = new URLSearchParams(location.search).get("predict") !== "0";

function publishMotion() {

  const target = PREDICT_MOTION ? tracker.getPredictedTarget(lastFrameTimestamp) : tracker.getTarget();

  // No selection (or stopped) means STOP, with the camera state as input.
  lastMotion = decideMotion(
    target
      ? { ...target, now: lastFrameTimestamp, cameraLive: isMotionInputLive() }
      : { cameraLive: isMotionInputLive(), state: tracker.getSnapshot().state },
    MOTION_OVERRIDES
  );

  if (!motionListener) return;

  try {
    motionListener(lastMotion);
  } catch (error) {
    // A failing display must never leave a stale movement command behind.
    console.error("Motion listener failed:", error);
  }
}

function notifyTracking(force = false) {

  publishMotion();

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

  if (!hasPersonDetection()) return { ok: false, reason: "NO_PERSON_DETECTOR" };

  const result = tracker.selectAt(x, y, lastFrameTimestamp);

  // A manual pick re-enables automatic owner re-acquire, and the clothing
  // signature is taken again from this person.
  if (result.ok) {
    ownerAutoPaused = false;
    resetOwnerAgreements();
  }

  // The highlight appears on the next processed frame (<= 250 ms).
  notifyTracking();

  return result;
}

export function clearPersonSelection() {

  tracker.clearSelection(lastFrameTimestamp);
  lockedSelectionId = null;

  // CLEAR SELECTION means "follow nobody": no automatic re-acquire until the
  // user taps someone again or presses FIND OWNER.
  ownerAutoPaused = true;
  resetOwnerAgreements();

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
  enrolRemaining = 0;
  resetOwnerAgreements();
  ownerStatus.textContent = UNVERIFIED_TEXT;
}

/* Releases the MediaPipe detectors (used when the page is closed). */
export function disposeOwnerAI() {

  stopOwnerAI();

  try { faceDetector?.close(); } catch (e) { console.error(e); }
  try { personDetector?.close(); } catch (e) { console.error(e); }
  try { personWorker?.stop(); } catch (e) { console.error(e); }

  faceDetector = null;
  personDetector = null;
  personWorker = null;
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

      // A box chosen by owner recognition shows the active user's name
      // instead of its selection number (#n counts selections, not people).
      const name = lockedOwnerName(person.id);
      const who = name ?? `#${person.id}`;
      // Recognised by Re-ID or face: say what recognised it instead of
      // "not verified". Clothing colour alone is too weak, it keeps the warning.
      const tail = name && lockedHow !== "เสื้อผ้า" ? `จำได้จาก ${lockedHow}` : UNVERIFIED_TEXT;

      drawBox(
        person.box,
        person.searching
          ? `กำลังค้นหา ${who} · ${tail}`
          : `ติดตาม ${who} ${percent} · ${tail}`,
        "#ffb020",
        { dashed: person.searching, thick: true }
      );

    } else {

      const other = otherProfileLabelFor(person.box, now);

      drawBox(
        person.box,
        other
          ? `${other} (ไม่ใช่ผู้ใช้ที่เลือก) ${percent} · ${UNVERIFIED_TEXT}`
          : `PERSON ${percent} · ${UNVERIFIED_TEXT}`,
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

/*
 * Everything that follows a person detection, for BOTH detectors (main thread and worker).
 * `timestamp` is the time of the FRAME the detections were computed from (never the time the result
 * arrived): the tracker and the motion decision use it as the detection time, so a result that took
 * 250 ms in a worker is correctly 250 ms old.
 */
function applyPersonDetections(detections, timestamp, width, height, inferMs, latencyMs = null) {

  inferenceSamples.push({ at: timestamp, ms: inferMs });
  while (inferenceSamples.length && timestamp - inferenceSamples[0].at > MISS_WINDOW_MS) {
    inferenceSamples.shift();
  }

  const persons = [];

  for (const detection of detections) {

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
      ? looksBlockedThrottled(timestamp)
      : false;

  tracker.update(persons, timestamp, width, height, { blocked });

  const missTarget = tracker.getTarget();
  if (missTarget && !missTarget.matched) selectedMissTimes.push(timestamp);
  while (selectedMissTimes.length && timestamp - selectedMissTimes[0] > MISS_WINDOW_MS) {
    selectedMissTimes.shift();
  }

  lastPersonBoxes = persons.map(p => p.box);
  lastPersonAt = timestamp;

  personStatus.textContent =
    `${persons.length} PERSON(S)` +
    (personGapMs !== null ? ` · ${Math.round(personGapMs)} ms` : "") +
    (personDelegate ? ` · ${personDelegate}` : "") +
    (libLabel ? ` · LIB ${libLabel}` : "") +
    (inferenceSamples.length ? ` · INF ${inferenceStats()}` : "") +
    (latencyMs !== null ? ` · LAT ${Math.round(latencyMs)} ms` : "") +
    (inferenceIsSlow() ? " · เครื่องช้า/ร้อน" : "") +
    (tracker.getSnapshot().selectedId !== null ? ` · MISS ${selectedMissTimes.length}/60s` : "");
}

/* Sends the current frame to the person worker; the answer is applied when it arrives. */
/*
 * Asks for the next frame as soon as the detection period allows, right after a result, instead of
 * waiting for the next processFrame() pass (which only runs every >= 100 ms and later on a busy page).
 * Never runs two detections at once (busy() check) and stays quiet while the camera is not delivering.
 */
function scheduleNextWorkerRequest(worker) {
  const wait = Math.max(0, personIntervalMs() - (performance.now() - lastPersonInference));
  setTimeout(() => {
    if (!running || personWorker !== worker || worker.busy() || cameraStalled()) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    if (performance.now() - lastPersonInference < personIntervalMs()) return;   // processFrame was first
    requestWorkerPersons(performance.now(), width, height);
  }, wait);
}

function requestWorkerPersons(timestamp, width, height) {

  const worker = personWorker;
  const request = worker.detect(video, timestamp);

  if (request === null) return;               // busy or not ready: the next frame tries again

  if (lastPersonInference > 0) personGapMs = timestamp - lastPersonInference;
  lastPersonInference = timestamp;

  request
    .then(result => {

      // Stopped, or switched back to the main thread while waiting: this answer is no longer wanted.
      if (!running || personWorker !== worker) return;

      applyPersonDetections(
        result.detections,
        result.timestamp,                      // the frame's time = the detection time
        width,
        height,
        result.inferMs,
        performance.now() - result.timestamp   // capture -> result applied
      );

      // What processFrame() does after a main-thread detection.
      ownerAfterPersons(lastFrameTimestamp, width, height);
      ownerStatus.textContent = ownerStatusText();
      notifyTracking();

      scheduleNextWorkerRequest(worker);
    })
    .catch(error => {
      // One frame lost (bitmap or detection error). Repeated failures make the client fail, which
      // switches to the main-thread detector (handlePersonWorkerFailure).
      console.warn("[worker] frame skipped:", error?.message ?? error);
    });
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
      if (!LITE_MODE || timestamp - lastOverlayAt >= OVERLAY_INTERVAL_LITE) {
        lastOverlayAt = timestamp;
        renderOverlay(timestamp);
      }
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

    const faceInterval = faceIntervalNow();
    if (faceInterval === Infinity && lastFaces.length > 0) lastFaces = [];   // no stale face boxes

    if (faceDetector && timestamp - lastFaceInference >= faceInterval) {

      lastFaceInference = timestamp;

      const faces = faceDetector.detectForVideo(
        video,
        timestamp
      );

      faceList = faces.detections || [];

      faceStatus.textContent =
        `${faceList.length} FACE(S)`;

      ownerAfterFaces(faceList, timestamp, width, height);

      lastFaces = faceList
        .filter(face => face.boundingBox)
        .map(face => ({
          box: face.boundingBox,
          score: face.categories?.[0]?.score ?? 0
        }));

      // Uses the same frame and detections that were just computed.
      serveCropRequest(faceList, timestamp, width, height);
    }

    if (personWorker) {

      // Worker detector: the frame is copied and sent without blocking; the result comes back
      // later through requestWorkerPersons(). One detection in flight at a time.
      if (!personWorker.busy() && timestamp - lastPersonInference >= personIntervalMs()) {
        requestWorkerPersons(timestamp, width, height);
      }

    } else if (
      personDetector &&
      timestamp - lastPersonInference >= personIntervalMs()
    ) {

      if (lastPersonInference > 0) personGapMs = timestamp - lastPersonInference;
      lastPersonInference = timestamp;

      const inferenceStart = performance.now();

      const people = personDetector.detectForVideo(
        video,
        timestamp
      );

      applyPersonDetections(
        people.detections || [],
        timestamp,
        width,
        height,
        performance.now() - inferenceStart
      );
    }

    tracker.tick(timestamp);
    ownerAfterPersons(timestamp, width, height);
    renderOverlay(timestamp);
    notifyTracking();

    ownerStatus.textContent = ownerStatusText();

  } catch (error) {

    console.error("Inference error:", error);
    aiStatus.textContent = "INFERENCE ERROR";
  }

  scheduleNextFrame();
}
