
import {
  FilesetResolver,
  FaceDetector,
  ObjectDetector
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

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
let lastPersons = [];

let running = false;
let lastInference = 0;
let lastPersonInference = 0;

const INFERENCE_INTERVAL = 250;
const PERSON_INTERVAL = 500;

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
      throw error;
    });
  }

  // Embedding models are large, so they load after the detectors have
  // settled and in the background. They never block or break the
  // camera, the detectors or owner registration.
  const startEmbeddings = () => { loadEmbeddingModels(); };
  initPromise.then(startEmbeddings, startEmbeddings);

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

  let vision;

  try {
    vision = await FilesetResolver.forVisionTasks(
      MEDIAPIPE_WASM_URL
    );
  } catch (error) {
    console.error("MediaPipe runtime load error:", error);
    aiStatus.textContent = "AI ERROR";
    setReady(readyPerson, "ERROR", "bad");
    setReady(readyFace, "ERROR", "bad");
    throw error;
  }

  const errors = [];

  try {
    faceDetector = await FaceDetector.createFromOptions(
      vision,
      {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
          delegate: "CPU"
        },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.6
      }
    );
    setReady(readyFace, "READY", "ok");
  } catch (error) {
    console.error("Face detector load error:", error);
    faceDetector = null;
    errors.push(error);
    setReady(readyFace, "ERROR", "bad");
  }

  try {
    personDetector = await ObjectDetector.createFromOptions(
      vision,
      {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
          delegate: "CPU"
        },
        runningMode: "VIDEO",
        scoreThreshold: 0.5,
        maxResults: 10
      }
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
    throw errors[0];
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
  lastPersons = [];

  rafId = requestAnimationFrame(processFrame);
}

export function stopOwnerAI() {

  running = false;

  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  lastPersons = [];

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

function drawBox(box, label, color) {

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;

  ctx.strokeRect(
    box.originX,
    box.originY,
    box.width,
    box.height
  );

  ctx.fillStyle = color;
  ctx.font = "13px Arial";

  ctx.fillText(
    label,
    box.originX,
    Math.max(14, box.originY - 6)
  );
}

function scheduleNextFrame() {

  if (running) {
    rafId = requestAnimationFrame(processFrame);
  }
}

function drawPersons() {

  for (const person of lastPersons) {

    const score =
      person.categories.find(
        category => category.categoryName === "person"
      )?.score ?? 0;

    drawBox(
      person.boundingBox,
      `PERSON ${Math.round(score * 100)}%`,
      "#b18cff"
    );
  }
}

function processFrame(timestamp) {

  if (!running) return;

  if (video.readyState < 2) {
    scheduleNextFrame();
    return;
  }

  if (timestamp - lastInference < INFERENCE_INTERVAL) {
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

    if (faceDetector) {

      const faces = faceDetector.detectForVideo(
        video,
        timestamp
      );

      const faceList = faces.detections || [];

      faceStatus.textContent =
        `${faceList.length} FACE(S)`;

      for (const face of faceList) {

        const score =
          face.categories?.[0]?.score ?? 0;

        drawBox(
          face.boundingBox,
          `FACE ${Math.round(score * 100)}%`,
          "#00ffcc"
        );
      }
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

      lastPersons = (people.detections || []).filter(
        detection =>
          detection.categories?.some(
            category => category.categoryName === "person"
          )
      );

      personStatus.textContent =
        `${lastPersons.length} PERSON(S)`;
    }

    // Person boxes are detected every PERSON_INTERVAL but the canvas is
    // cleared every frame, so redraw the latest result each time.
    drawPersons();

    // Detection is not identity verification.
    ownerStatus.textContent = UNVERIFIED_TEXT;

  } catch (error) {

    console.error("Inference error:", error);
    aiStatus.textContent = "INFERENCE ERROR";
  }

  scheduleNextFrame();
}
