
import {
  initFaceEmbedding,
  generateFaceEmbedding,
  FACE_MODEL_CONFIG
} from "./face-embedding.js";

import {
  initReIDEmbedding,
  generateReIDEmbedding
} from "./reid-embedding.js";

import {
  saveEmbedding
} from "./embedding-database.js";

// --------------------------------------------------
// Model Configuration
// --------------------------------------------------

// models/manifest.json describes each model file (size, SHA-256,
// availability). It is optional: without it the face model still loads
// from its default path but without an integrity check, and the
// Re-ID model is treated as unavailable.
const MANIFEST_PATH = "./models/manifest.json";

const DEFAULT_FACE_PATH =
  "./models/face/face-recognition.onnx";

// --------------------------------------------------
// Per-Model Status
// --------------------------------------------------

/*
 * state: NOT_LOADED | NO_MODEL | DOWNLOADING | VERIFYING | LOADING |
 *        SESSION_LOADED | NOT_FOUND | CHECKSUM_MISMATCH | ERROR
 * SESSION_LOADED means the ONNX session was created. It does NOT mean
 * recognition has been verified.
 */
const modelStatus = {
  face: { state: "NOT_LOADED" },
  reid: { state: "NO_MODEL" }
};

export function getEmbeddingModelStatus() {

  return {
    face: { ...modelStatus.face },
    reid: { ...modelStatus.reid }
  };
}

function setModelStatus(key, state, extra, listener) {

  modelStatus[key] = { state, ...(extra || {}) };

  if (listener) {
    listener(key, { ...modelStatus[key] });
  }
}

function failureState(error) {

  if (error?.code === "NOT_FOUND") return "NOT_FOUND";
  if (error?.code === "CHECKSUM_MISMATCH") return "CHECKSUM_MISMATCH";

  return "ERROR";
}

async function loadManifest() {

  try {

    const response = await fetch(MANIFEST_PATH, { cache: "no-store" });

    if (!response.ok) return null;

    return await response.json();

  } catch (error) {

    console.warn("Model manifest unavailable:", error.message);

    return null;
  }
}

// --------------------------------------------------
// Initialize Embedding Models
// --------------------------------------------------

let initializationPromise = null;

/*
 * Loads each model independently, one after another (to limit peak
 * memory on phones), so one broken or missing model never prevents the
 * other from loading. Never rejects for a single model failure: read
 * the per-model result from the returned status object or from
 * onStatus(modelKey, status).
 */
export function initializeEmbeddingModels({ onStatus } = {}) {

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {

    try {

      const manifest = await loadManifest();

      const faceEntry = manifest?.models?.face;
      const reidEntry = manifest?.models?.reid;

      // ---- Face
      if (faceEntry?.status === "NO_MODEL") {

        setModelStatus("face", "NO_MODEL", {}, onStatus);

      } else if (modelStatus.face.state !== "SESSION_LOADED") {

        const path = faceEntry?.file
          ? `./${faceEntry.file}`
          : DEFAULT_FACE_PATH;

        const checksum = faceEntry?.sha256 || null;

        try {

          await initFaceEmbedding(path, {
            expectedSize: faceEntry?.sizeBytes || null,
            expectedSha256: checksum,
            onStatus: (state, extra) =>
              setModelStatus("face", state, extra, onStatus)
          });

          setModelStatus(
            "face",
            "SESSION_LOADED",
            { checksum: Boolean(checksum) },
            onStatus
          );

        } catch (error) {

          console.error("Face model not available:", error);

          setModelStatus(
            "face",
            failureState(error),
            { message: error.message },
            onStatus
          );
        }
      }

      // ---- Re-ID: only when the manifest explicitly marks a
      // verified model as AVAILABLE.
      if (reidEntry?.status !== "AVAILABLE" || !reidEntry.file) {

        setModelStatus("reid", "NO_MODEL", {}, onStatus);

      } else if (modelStatus.reid.state !== "SESSION_LOADED") {

        const checksum = reidEntry.sha256 || null;

        try {

          await initReIDEmbedding(`./${reidEntry.file}`, {
            expectedSize: reidEntry.sizeBytes || null,
            expectedSha256: checksum,
            onStatus: (state, extra) =>
              setModelStatus("reid", state, extra, onStatus)
          });

          setModelStatus(
            "reid",
            "SESSION_LOADED",
            { checksum: Boolean(checksum) },
            onStatus
          );

        } catch (error) {

          console.error("Re-ID model not available:", error);

          setModelStatus(
            "reid",
            failureState(error),
            { message: error.message },
            onStatus
          );
        }
      }

      return getEmbeddingModelStatus();

    } finally {

      // Allows a later call to retry models that failed.
      initializationPromise = null;
    }

  })();

  return initializationPromise;
}

// --------------------------------------------------
// Generate Owner Embedding
// --------------------------------------------------

export async function generateOwnerEmbedding({

  image,
  box,
  ownerName,
  mode,
  config

}) {

  if (mode !== "face" && mode !== "reid") {
    throw new Error(
      "Embedding mode must be face or reid."
    );
  }

  if (modelStatus[mode].state !== "SESSION_LOADED") {
    throw new Error(
      mode === "reid" && modelStatus.reid.state === "NO_MODEL"
        ? "No Re-ID model is available (NO MODEL)."
        : `The ${mode} model is not initialized.`
    );
  }

  if (
    typeof ownerName !== "string" ||
    !ownerName.trim()
  ) {
    throw new Error("Owner name is required.");
  }

  const modelConfig =
    config || (mode === "face" ? FACE_MODEL_CONFIG : null);

  if (!image || !box || !modelConfig) {
    throw new Error(
      "Image, bounding box and config are required."
    );
  }

  const vector = mode === "face"
    ? await generateFaceEmbedding(image, box, modelConfig)
    : await generateReIDEmbedding(image, box, modelConfig);

  await saveEmbedding({

    ownerName: ownerName.trim(),

    mode,

    embedding: Array.from(vector),

    createdAt: new Date().toISOString()

  });

  console.log(
    `${mode} embedding saved for owner:`,
    ownerName
  );

  return vector;
}
