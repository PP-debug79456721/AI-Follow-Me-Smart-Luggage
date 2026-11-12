
import {
  loadEmbeddingModel,
  createEmbedding,
  cosineSimilarity
} from "./embedding-engine.js";

// --------------------------------------------------
// Person Re-ID Model Session
// --------------------------------------------------

let reidSession = null;
let initializationPromise = null;

// --------------------------------------------------
// Initialize Person Re-ID Model
// --------------------------------------------------

export async function initReIDEmbedding(modelPath, options = {}) {

  if (reidSession) {
    return reidSession;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  if (!modelPath) {
    throw new Error("Re-ID model path is required.");
  }

  initializationPromise = (async () => {

    try {

      reidSession = await loadEmbeddingModel(modelPath, options);

      console.log("Person Re-ID initialized.");

      return reidSession;

    } catch (error) {

      reidSession = null;

      throw error;

    } finally {

      initializationPromise = null;

    }

  })();

  return initializationPromise;
}

// --------------------------------------------------
// Generate Person Re-ID Embedding
// --------------------------------------------------

export async function generateReIDEmbedding(
  image,
  personBox,
  config
) {

  if (!reidSession) {
    throw new Error("Re-ID model is not initialized.");
  }

  if (!image || !personBox || !config) {
    throw new Error(
      "Image, person box and config are required."
    );
  }

  return await createEmbedding(
    reidSession,
    image,
    personBox,
    config
  );
}

// --------------------------------------------------
// Compare Person Embeddings
// --------------------------------------------------

export function compareReIDEmbeddings(
  embeddingA,
  embeddingB
) {

  if (!embeddingA || !embeddingB) {
    throw new Error("Re-ID embeddings are required.");
  }

  return cosineSimilarity(
    embeddingA,
    embeddingB
  );
}

// --------------------------------------------------
// Release Person Re-ID Session
// --------------------------------------------------

export async function disposeReIDEmbedding() {

  if (initializationPromise) {
    await initializationPromise;
  }

  if (reidSession) {

    const session = reidSession;

    reidSession = null;

    await session.release();

  }

  console.log("Person Re-ID released.");
}
