
import {
  initFaceEmbedding,
  generateFaceEmbedding
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

const FACE_MODEL_PATH =
  "./models/face/face-recognition.onnx";

const REID_MODEL_PATH =
  "./models/person-reid/person-reid.onnx";

// --------------------------------------------------
// Initialize Embedding Models
// --------------------------------------------------

let initializationPromise = null;
let modelsReady = false;

export async function initializeEmbeddingModels() {

  if (modelsReady) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {

    try {

      await Promise.all([
        initFaceEmbedding(FACE_MODEL_PATH),
        initReIDEmbedding(REID_MODEL_PATH)
      ]);

      modelsReady = true;

      console.log(
        "Owner embedding models initialized."
      );

    } catch (error) {

      modelsReady = false;

      throw error;

    } finally {

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

  if (!modelsReady) {
    throw new Error(
      "Embedding models are not initialized."
    );
  }

  if (mode !== "face" && mode !== "reid") {
    throw new Error(
      "Embedding mode must be face or reid."
    );
  }

  if (
    typeof ownerName !== "string" ||
    !ownerName.trim()
  ) {
    throw new Error("Owner name is required.");
  }

  if (!image || !box || !config) {
    throw new Error(
      "Image, bounding box and config are required."
    );
  }

  const vector = mode === "face"
    ? await generateFaceEmbedding(image, box, config)
    : await generateReIDEmbedding(image, box, config);

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
