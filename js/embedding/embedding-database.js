
const DB_NAME = "SmartLuggageOwnerDB";
const DB_VERSION = 2;

let databasePromise = null;

// --------------------------------------------------
// Open IndexedDB
// --------------------------------------------------

export function openEmbeddingDatabase() {

  if (databasePromise) {
    return databasePromise;
  }

  let promise;

  promise = new Promise((resolve, reject) => {

    const request = indexedDB.open(
      DB_NAME,
      DB_VERSION
    );

    request.onupgradeneeded = () => {

      const db = request.result;

      // Preserve existing enrollment samples.
      if (!db.objectStoreNames.contains("samples")) {
        db.createObjectStore("samples", {
          keyPath: "id",
          autoIncrement: true
        });
      }

      // Store Face and Re-ID embeddings.
      if (!db.objectStoreNames.contains("embeddings")) {
        db.createObjectStore("embeddings", {
          keyPath: "id",
          autoIncrement: true
        });
      }
    };

    request.onsuccess = () => {

      const db = request.result;

      // Close stale connections when another tab
      // requests a database version upgrade.
      db.onversionchange = () => {

        db.close();

        if (databasePromise === promise) {
          databasePromise = null;
        }
      };

      resolve(db);
    };

    request.onerror = () => {

      if (databasePromise === promise) {
        databasePromise = null;
      }

      reject(request.error);
    };

    request.onblocked = () => {

      console.warn(
        "Database upgrade is blocked. Close other tabs using this database."
      );
    };
  });

  databasePromise = promise;

  return promise;
}

// --------------------------------------------------
// Validate Embedding Record
// --------------------------------------------------

function validateEmbeddingRecord(record) {

  if (!record || typeof record !== "object") {
    throw new Error("Invalid embedding record.");
  }

  if (
    record.mode !== "face" &&
    record.mode !== "reid"
  ) {
    throw new Error(
      "Embedding mode must be face or reid."
    );
  }

  if (
    !record.embedding ||
    record.embedding.length === 0
  ) {
    throw new Error("Embedding vector is empty.");
  }

  for (const value of record.embedding) {

    if (!Number.isFinite(value)) {
      throw new Error(
        "Embedding contains invalid values."
      );
    }
  }
}

// --------------------------------------------------
// Save Embedding
// --------------------------------------------------

export async function saveEmbedding(record) {

  validateEmbeddingRecord(record);

  const db = await openEmbeddingDatabase();

  return new Promise((resolve, reject) => {

    const tx = db.transaction(
      "embeddings",
      "readwrite"
    );

    const store = tx.objectStore("embeddings");

    const request = store.add(record);

    request.onsuccess = () => {
      // Return the generated IndexedDB key.
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.onabort = () => {
      reject(
        tx.error || new Error("Embedding transaction aborted.")
      );
    };
  });
}

// --------------------------------------------------
// Get Embeddings by Mode
// --------------------------------------------------

export async function getEmbeddings(mode) {

  if (mode !== "face" && mode !== "reid") {
    throw new Error(
      "Embedding mode must be face or reid."
    );
  }

  const db = await openEmbeddingDatabase();

  return new Promise((resolve, reject) => {

    const tx = db.transaction(
      "embeddings",
      "readonly"
    );

    const request = tx
      .objectStore("embeddings")
      .getAll();

    request.onsuccess = () => {

      const records = request.result.filter(
        item => item.mode === mode
      );

      resolve(records);
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.onabort = () => {
      reject(
        tx.error || new Error("Read transaction aborted.")
      );
    };
  });
}

// --------------------------------------------------
// Get Enrollment Samples
// --------------------------------------------------

export async function getEnrollmentSamples() {

  const db = await openEmbeddingDatabase();

  return new Promise((resolve, reject) => {

    const tx = db.transaction(
      "samples",
      "readonly"
    );

    const request = tx
      .objectStore("samples")
      .getAll();

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.onabort = () => {
      reject(
        tx.error || new Error("Sample read transaction aborted.")
      );
    };
  });
}
