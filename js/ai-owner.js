
import {
  FilesetResolver,
  FaceDetector,
  ObjectDetector
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";

const video = document.getElementById("camera");
const canvas = document.getElementById("aiCanvas");
const ctx = canvas.getContext("2d");

const faceStatus = document.getElementById("faceAIStatus");
const personStatus = document.getElementById("personAIStatus");
const ownerStatus = document.getElementById("ownerStatus");
const aiStatus = document.getElementById("aiStatus");

let faceDetector = null;
let personDetector = null;

let running = false;
let lastInference = 0;
let lastPersonInference = 0;

const INFERENCE_INTERVAL = 250;
const PERSON_INTERVAL = 500;

export async function initOwnerAI() {

  aiStatus.textContent = "LOADING";

  try {

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
    );

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

    aiStatus.textContent = "DETECTORS READY";

    return true;

  } catch (error) {

    console.error("AI initialization error:", error);

    aiStatus.textContent = "AI ERROR";

    throw error;
  }
}

export function startOwnerAI() {

  if (!faceDetector || !personDetector) {
    throw new Error("AI models are not initialized.");
  }

  running = true;
  lastInference = 0;
  lastPersonInference = 0;

  requestAnimationFrame(processFrame);
}

export function stopOwnerAI() {

  running = false;

  ctx.clearRect(
    0, 0, canvas.width, canvas.height
  );

  faceStatus.textContent = "NOT RUNNING";
  personStatus.textContent = "NOT RUNNING";
  ownerStatus.textContent = "NOT VERIFIED";
}

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

function processFrame(timestamp) {

  if (!running || video.readyState < 2) {
    if (running) requestAnimationFrame(processFrame);
    return;
  }

  if (timestamp - lastInference < INFERENCE_INTERVAL) {
    requestAnimationFrame(processFrame);
    return;
  }

  lastInference = timestamp;

  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    requestAnimationFrame(processFrame);
    return;
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);

  try {

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

    if (timestamp - lastPersonInference >= PERSON_INTERVAL) {

      lastPersonInference = timestamp;

      const people = personDetector.detectForVideo(
        video,
        timestamp
      );

      const persons = (people.detections || []).filter(
        detection =>
          detection.categories?.some(
            category => category.categoryName === "person"
          )
      );

      personStatus.textContent =
        `${persons.length} PERSON(S)`;

      for (const person of persons) {

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

    // Detection is not identity verification.
    ownerStatus.textContent = "NOT VERIFIED";

  } catch (error) {

    console.error("Inference error:", error);
    aiStatus.textContent = "INFERENCE ERROR";
  }

  requestAnimationFrame(processFrame);
}
