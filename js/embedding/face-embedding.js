
import {
  loadEmbeddingModel,
  createEmbedding,
  cosineSimilarity
} from "./embedding-engine.js";

// --------------------------------------------------
// Face Model Session
// --------------------------------------------------

let faceSession = null;
let initializationPromise = null;

// --------------------------------------------------
// Initialize Face Recognition Model
// --------------------------------------------------

export async function initFaceEmbedding(modelPath) {

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

      faceSession = await loadEmbeddingModel(modelPath);

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
  config
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
