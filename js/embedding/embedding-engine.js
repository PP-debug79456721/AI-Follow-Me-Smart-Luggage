
import {
  preprocessImageData,
  getInputShape
} from "./image-preprocessor.js";

// onnxruntime-web ES module (WASM only). The wasm loader and binary are
// fetched from wasmPaths below, so both URLs must use the same version.
import * as ort from
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs";

// --------------------------------------------------
// ONNX Runtime Configuration
// --------------------------------------------------

ort.env.wasm.numThreads = 1;

ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

// --------------------------------------------------
// Model Load Errors
// --------------------------------------------------

/*
 * code: NETWORK | NOT_FOUND | HTTP_ERROR | EMPTY_FILE |
 *       SIZE_MISMATCH | CHECKSUM_MISMATCH | SESSION_ERROR
 */
export class ModelLoadError extends Error {

  constructor(code, message) {
    super(message);
    this.name = "ModelLoadError";
    this.code = code;
  }
}

const MODEL_CACHE_NAME = "smart-luggage-models-v1";

// --------------------------------------------------
// Model File Download, Integrity Check And Cache
// --------------------------------------------------

async function sha256Hex(bytes) {

  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyModelBytes(
  bytes,
  modelPath,
  { expectedSize, expectedSha256 }
) {

  if (bytes.length === 0) {
    throw new ModelLoadError(
      "EMPTY_FILE",
      `Model file is empty (0 bytes): ${modelPath}`
    );
  }

  if (expectedSize && bytes.length !== expectedSize) {
    throw new ModelLoadError(
      "SIZE_MISMATCH",
      `Model size is ${bytes.length} bytes, expected ${expectedSize}: ${modelPath}`
    );
  }

  if (expectedSha256) {

    const actual = await sha256Hex(bytes);

    if (actual !== expectedSha256.toLowerCase()) {
      throw new ModelLoadError(
        "CHECKSUM_MISMATCH",
        `SHA-256 mismatch for ${modelPath}`
      );
    }
  }
}

async function readResponseBytes(
  response,
  expectedSize,
  onStatus
) {

  if (!response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const total =
    Number(response.headers.get("content-length")) ||
    expectedSize ||
    0;

  const reader = response.body.getReader();

  // Fill one pre-allocated buffer when the size is known so a large
  // model is not held in memory twice.
  let buffer = total > 0 ? new Uint8Array(total) : null;
  let overflow = buffer ? null : [];

  let received = 0;
  let lastPercent = -1;

  for (;;) {

    const { done, value } = await reader.read();

    if (done) break;

    if (buffer && received + value.length <= buffer.length) {

      buffer.set(value, received);

    } else {

      if (buffer) {
        overflow = [buffer.subarray(0, received)];
        buffer = null;
      }

      overflow.push(value);
    }

    received += value.length;

    if (total > 0) {

      const percent = Math.min(
        100,
        Math.floor(received * 100 / total)
      );

      if (percent !== lastPercent) {
        lastPercent = percent;
        onStatus("DOWNLOADING", { percent });
      }
    }
  }

  if (buffer) {
    return buffer.subarray(0, received);
  }

  const joined = new Uint8Array(received);

  let offset = 0;

  for (const chunk of overflow) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
}

async function fetchModelBytes(modelPath, options) {

  const { expectedSha256, onStatus } = options;

  const cache = typeof caches !== "undefined"
    ? await caches.open(MODEL_CACHE_NAME).catch(() => null)
    : null;

  // Only files verified against a checksum are cached/reused.
  if (cache && expectedSha256) {

    const hit = await cache.match(modelPath);

    if (hit) {

      onStatus("VERIFYING", { source: "cache" });

      try {

        const cached = new Uint8Array(await hit.arrayBuffer());

        await verifyModelBytes(cached, modelPath, options);

        return cached;

      } catch (error) {

        console.warn("Cached model rejected:", error.message);

        await cache.delete(modelPath);
      }
    }
  }

  onStatus("DOWNLOADING", { percent: 0 });

  let response;

  try {
    response = await fetch(modelPath);
  } catch (error) {
    throw new ModelLoadError(
      "NETWORK",
      `Cannot fetch ${modelPath}: ${error.message}`
    );
  }

  if (response.status === 404) {
    throw new ModelLoadError(
      "NOT_FOUND",
      `Model file not found (404): ${modelPath}`
    );
  }

  if (!response.ok) {
    throw new ModelLoadError(
      "HTTP_ERROR",
      `HTTP ${response.status} while fetching ${modelPath}`
    );
  }

  const bytes = await readResponseBytes(
    response,
    options.expectedSize,
    onStatus
  );

  onStatus("VERIFYING", { source: "network" });

  await verifyModelBytes(bytes, modelPath, options);

  if (cache && expectedSha256) {

    try {
      await cache.put(modelPath, new Response(bytes));
    } catch (error) {
      // Caching is an optimization only (e.g. storage quota).
      console.warn("Model cache write failed:", error.message);
    }
  }

  return bytes;
}

// --------------------------------------------------
// Load ONNX Model
// --------------------------------------------------

/*
 * options (all optional):
 *   expectedSize    bytes; rejects a truncated or wrong file
 *   expectedSha256  hex; rejects a different file and enables the cache
 *   onStatus(state, extra)  DOWNLOADING | VERIFYING | LOADING
 */
export async function loadEmbeddingModel(
  modelPath,
  options = {}
) {

  if (!modelPath) {
    throw new Error("Model path is required.");
  }

  const {
    expectedSize = null,
    expectedSha256 = null,
    onStatus = () => {}
  } = options;

  const bytes = await fetchModelBytes(
    modelPath,
    { expectedSize, expectedSha256, onStatus }
  );

  onStatus("LOADING", {});

  let session;

  try {

    session = await ort.InferenceSession.create(
      bytes,
      {
        executionProviders: ["wasm"]
      }
    );

  } catch (error) {

    throw new ModelLoadError(
      "SESSION_ERROR",
      `ONNX Runtime could not load ${modelPath}: ${error?.message || error}`
    );
  }

  if (!session.inputNames.length || !session.outputNames.length) {
    throw new ModelLoadError("SESSION_ERROR", "Invalid ONNX model.");
  }

  console.log("Embedding model loaded:", modelPath);

  return session;
}

// --------------------------------------------------
// Input Shape Check Against Model Metadata
// --------------------------------------------------

function assertInputShape(session, inputName, shape) {

  const metadata = Array.isArray(session.inputMetadata)
    ? session.inputMetadata.find(item => item.name === inputName)
    : null;

  if (!metadata || !Array.isArray(metadata.shape)) return;

  const expected = metadata.shape;

  const matches =
    expected.length === shape.length &&
    expected.every(
      (dim, i) =>
        typeof dim !== "number" || dim <= 0 || dim === shape[i]
    );

  if (!matches) {
    throw new Error(
      `Model input "${inputName}" expects ${JSON.stringify(expected)} ` +
      `but preprocessing produced ${JSON.stringify(shape)}. ` +
      "Check the model config (layout, width, height)."
    );
  }
}

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

  const shape = getInputShape(config);

  const inputName = config.inputName || session.inputNames[0];

  const outputName = config.outputName || session.outputNames[0];

  if (
    !session.inputNames.includes(inputName) ||
    !session.outputNames.includes(outputName)
  ) {
    throw new Error("Model input/output name mismatch.");
  }

  assertInputShape(session, inputName, shape);

  const inputTensor = new ort.Tensor(
    "float32",
    tensorData,
    shape
  );

  const results = await session.run({
    [inputName]: inputTensor
  });

  const output = results[outputName];

  if (!output || !output.data || output.data.length === 0) {
    throw new Error("Model returned empty embedding.");
  }

  const vector = Float32Array.from(output.data);

  if (
    config.embeddingDim &&
    vector.length !== config.embeddingDim
  ) {
    throw new Error(
      `Expected a ${config.embeddingDim}-dimensional embedding but the ` +
      `model returned ${vector.length} values. This may not be an ` +
      "embedding model."
    );
  }

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
