
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

import {
  decideModelLoad,
  resolveModelUseMode
} from "./model-policy.js";

// --------------------------------------------------
// Model Configuration
// --------------------------------------------------

// models/manifest.json describes each model file (schema 2, see
// model-policy.js and models/MODEL_METADATA.md). It is REQUIRED: without
// a valid manifest entry with size and SHA-256 no model is loaded
// (fail-closed). There is no default model path.
const MANIFEST_PATH = "./models/manifest.json";

// --------------------------------------------------
// Per-Model Status
// --------------------------------------------------

/*
 * state: NOT_LOADED | NO_MODEL | BLOCKED | DOWNLOADING | VERIFYING |
 *        LOADING | SESSION_LOADED | NOT_FOUND | SIZE_MISMATCH |
 *        CHECKSUM_MISMATCH | ERROR
 * BLOCKED carries a reason from model-policy.js (nothing was requested).
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

  switch (error?.code) {
    case "NOT_FOUND":
    case "SIZE_MISMATCH":
    case "CHECKSUM_MISMATCH":
      return error.code;
    case "EMPTY_FILE":
      return "SIZE_MISMATCH";
    default:
      return "ERROR";
  }
}

/* The parsed manifest, or null when it is missing or not valid JSON. */
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
 *
 * Fail-closed: model-policy.js decides from the manifest BEFORE any model
 * file is requested. The mode (production / development) comes from the
 * page address, never from the caller, so code cannot switch it.
 */
export function initializeEmbeddingModels({ onStatus } = {}) {

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {

    try {

      const mode = resolveModelUseMode(globalThis.location);
      const manifest = await loadManifest();

      const loaders = {
        face: initFaceEmbedding,
        reid: initReIDEmbedding
      };

      for (const key of ["face", "reid"]) {

        if (modelStatus[key].state === "SESSION_LOADED") continue;

        const decision = decideModelLoad(manifest, key, mode);

        if (!decision.allowed) {
          setModelStatus(key, decision.state, { reason: decision.reason, mode }, onStatus);
          continue;
        }

        try {

          await loaders[key](`./${decision.file}`, {
            expectedSize: decision.sizeBytes,
            expectedSha256: decision.sha256,
            onStatus: (state, extra) =>
              setModelStatus(key, state, extra, onStatus)
          });

          setModelStatus(
            key,
            "SESSION_LOADED",
            { checksum: true, mode, license: decision.license },
            onStatus
          );

        } catch (error) {

          console.error(`${key} model not available:`, error);

          setModelStatus(
            key,
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
