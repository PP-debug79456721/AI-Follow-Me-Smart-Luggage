
import {
  preprocessImageData
} from "./image-preprocessor.js";

import * as ort from
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/esm/ort.min.js";

// --------------------------------------------------
// ONNX Runtime Configuration
// --------------------------------------------------

ort.env.wasm.numThreads = 1;

ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

// --------------------------------------------------
// Load ONNX Model
// --------------------------------------------------

export async function loadEmbeddingModel(modelPath) {

  if (!modelPath) {
    throw new Error("Model path is required.");
  }

  const session = await ort.InferenceSession.create(
    modelPath,
    {
      executionProviders: ["wasm"]
    }
  );

  if (!session.inputNames.length || !session.outputNames.length) {
    throw new Error("Invalid ONNX model.");
  }

  console.log("Embedding model loaded:", modelPath);

  return session;
}

// --------------------------------------------------
// Image Preprocessing
// --------------------------------------------------

// --------------------------------------------------
// Generate Embedding
// --------------------------------------------------

export async function createEmbedding(
  session,
  image,
  box,
  config
) {

  if (!session) {
    throw new Error("Embedding session is not ready.");
  }

  const tensorData = preprocessImageData(
    image,
    box,
    config
  );

  const inputTensor = new ort.Tensor(
    "float32",
    tensorData,
    [1, 3, config.height, config.width]
  );

  const inputName = config.inputName || session.inputNames[0];

  const outputName = config.outputName || session.outputNames[0];

  if (
    !session.inputNames.includes(inputName) ||
    !session.outputNames.includes(outputName)
  ) {
    throw new Error("Model input/output name mismatch.");
  }

  const results = await session.run({
    [inputName]: inputTensor
  });

  const output = results[outputName];

  if (!output || !output.data || output.data.length === 0) {
    throw new Error("Model returned empty embedding.");
  }

  const vector = Float32Array.from(output.data);

  if (!vector.every(Number.isFinite)) {
    throw new Error("Embedding contains invalid values.");
  }

  return normalizeVector(vector);
}

// --------------------------------------------------
// Normalize Vector
// --------------------------------------------------

export function normalizeVector(vector) {

  if (!vector || vector.length === 0) {
    throw new Error("Embedding vector is empty.");
  }

  let sum = 0;

  for (const value of vector) {

    if (!Number.isFinite(value)) {
      throw new Error("Invalid embedding value.");
    }

    sum += value * value;
  }

  const norm = Math.sqrt(sum);

  if (!norm || !Number.isFinite(norm)) {
    throw new Error("Invalid embedding norm.");
  }

  return Float32Array.from(
    vector,
    value => value / norm
  );
}

// --------------------------------------------------
// Cosine Similarity
// --------------------------------------------------

export function cosineSimilarity(a, b) {

  if (
    !a ||
    !b ||
    a.length === 0 ||
    a.length !== b.length
  ) {
    throw new Error("Embedding dimensions do not match.");
  }

  let dot = 0;

  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {

    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) {
      throw new Error("Invalid embedding values.");
    }

    dot += a[i] * b[i];

    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA * normB);

  if (!denominator) {
    throw new Error("Cannot compare zero vectors.");
  }

  return dot / denominator;
}
