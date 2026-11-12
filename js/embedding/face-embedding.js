
import {
  loadEmbeddingModel,
  createEmbedding,
  cosineSimilarity
} from "./embedding-engine.js";

// --------------------------------------------------
// Face Model Config
// --------------------------------------------------

// Input/output names, shape and embedding size come from the real
// model file (ONNX metadata): input_1 [N,112,112,3], embedding [N,512].
// Color order and normalization below come from the model card
// (RGB, (x - 127.5) / 128) and are NOT yet verified against real
// faces: run tools/verify_face_model.py before relying on them.
export const FACE_MODEL_CONFIG = Object.freeze({
  width: 112,
  height: 112,
  layout: "NHWC",
  colorOrder: "RGB",
  pixelScale: 1,
  mean: Object.freeze([127.5, 127.5, 127.5]),
  std: Object.freeze([128, 128, 128]),
  alignment: "arcface-112",
  inputName: "input_1",
  outputName: "embedding",
  embeddingDim: 512
});

// --------------------------------------------------
// Face Model Session
// --------------------------------------------------

let faceSession = null;
let initializationPromise = null;

// --------------------------------------------------
// Initialize Face Recognition Model
// --------------------------------------------------

export async function initFaceEmbedding(modelPath, options = {}) {

  if (faceSession) {
    return faceSession;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  if (!modelPath) {
    throw new Error("Face model path is required.");
  }

  initializationPromise = (async () => {

    try {

      faceSession = await loadEmbeddingModel(modelPath, options);

      console.log("Face Embedding initialized.");

      return faceSession;

    } catch (error) {

      faceSession = null;

      throw error;

    } finally {

      initializationPromise = null;

    }

  })();

  return initializationPromise;
}

// --------------------------------------------------
// Generate Face Embedding
// --------------------------------------------------

export async function generateFaceEmbedding(
  image,
  faceBox,
  config = FACE_MODEL_CONFIG
) {

  if (!faceSession) {
    throw new Error("Face model is not initialized.");
  }

  if (!image || !faceBox || !config) {
    throw new Error(
      "Image, face box and config are required."
    );
  }

  return await createEmbedding(
    faceSession,
    image,
    faceBox,
    config
  );
}

// --------------------------------------------------
// Compare Face Embeddings
// --------------------------------------------------

export function compareFaceEmbeddings(
  embeddingA,
  embeddingB
) {

  if (!embeddingA || !embeddingB) {
    throw new Error("Face embeddings are required.");
  }

  return cosineSimilarity(
    embeddingA,
    embeddingB
  );
}

// --------------------------------------------------
// Release Face Model Session
// --------------------------------------------------

export async function disposeFaceEmbedding() {

  if (initializationPromise) {
    await initializationPromise;
  }

  if (faceSession) {

    const session = faceSession;

    faceSession = null;

    await session.release();

  }

  console.log("Face Embedding released.");
}
