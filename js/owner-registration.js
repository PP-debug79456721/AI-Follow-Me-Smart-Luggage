
const DB_NAME = "SmartLuggageOwnerDB";
const DB_VERSION = 2;

const video = document.getElementById("camera");

const nameInput = document.getElementById("ownerName");
const modeInput = document.getElementById("captureMode");
const consentInput = document.getElementById("consentCheck");

const captureBtn = document.getElementById("captureBtn");
const deleteBtn = document.getElementById("deleteSamplesBtn");

const message = document.getElementById("registrationMessage");

let db = null;

function openDatabase() {
  return new Promise((resolve, reject) => {

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("samples")) {
        database.createObjectStore("samples", {
          keyPath: "id",
          autoIncrement: true
        });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function saveSample(sample) {
  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      "samples",
      "readwrite"
    );

    transaction.objectStore("samples").add(sample);

    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function getSamples() {
  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      "samples",
      "readonly"
    );

    const request = transaction
      .objectStore("samples")
      .getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteAllSamples() {
  return new Promise((resolve, reject) => {

    const transaction = db.transaction(
      "samples",
      "readwrite"
    );

    transaction.objectStore("samples").clear();

    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function updateCounts() {

  const samples = await getSamples();

  const face = samples.filter(
    item => item.mode === "face"
  ).length;

  const reid = samples.filter(
    item => item.mode === "reid"
  ).length;

  document.getElementById("faceCount").textContent =
    `${face} / 8`;

  document.getElementById("reidCount").textContent =
    `${reid} / 15`;
}

function updateCaptureButton() {
  const cameraReady =
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0;

  captureBtn.disabled =
    !cameraReady ||
    !consentInput.checked ||
    !nameInput.value.trim();
}

async function captureSample() {

  if (!db) {
    message.textContent = "Database is not ready.";
    return;
  }

  if (
    !video.srcObject ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !video.videoWidth
  ) {
    message.textContent = "Camera is not ready.";
    return;
  }

  const ownerName = nameInput.value.trim();
  const mode = modeInput.value;

  if (!ownerName || !consentInput.checked) {
    message.textContent =
      "Enter owner name and confirm consent.";
    return;
  }

  const samples = await getSamples();

  const count = samples.filter(
    item => item.mode === mode
  ).length;

  const limit = mode === "face" ? 8 : 15;

  if (count >= limit) {
    message.textContent =
      "Sample limit reached. Delete data to restart enrollment.";
    return;
  }

  const canvas = document.createElement("canvas");

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");

  context.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  const blob = await new Promise(resolve => {
    canvas.toBlob(resolve, "image/jpeg", 0.85);
  });

  if (!blob) {
    message.textContent = "Image capture failed.";
    return;
  }

  try {

    await saveSample({
      ownerName,
      mode,
      blob,
      width: canvas.width,
      height: canvas.height,
      createdAt: new Date().toISOString()
    });

    await updateCounts();

    message.textContent =
      `${mode.toUpperCase()} sample saved successfully.`;

  } catch (error) {

    console.error(error);
    message.textContent = "Failed to save sample.";
  }
}

async function clearOwnerData() {

  const confirmed = window.confirm(
    "Delete all saved owner enrollment images?"
  );

  if (!confirmed) return;

  try {
    await deleteAllSamples();

    await updateCounts();

    message.textContent = "All owner images deleted.";

  } catch (error) {
    console.error(error);
    message.textContent = "Delete operation failed.";
  }
}

export async function initOwnerRegistration() {

  try {

    await openDatabase();
    await updateCounts();

    captureBtn.addEventListener(
      "click",
      captureSample
    );

    deleteBtn.addEventListener(
      "click",
      clearOwnerData
    );

    consentInput.addEventListener(
      "change",
      updateCaptureButton
    );

    nameInput.addEventListener(
      "input",
      updateCaptureButton
    );

    video.addEventListener(
      "loadeddata",
      updateCaptureButton
    );

    video.addEventListener(
      "emptied",
      updateCaptureButton
    );

    updateCaptureButton();

    message.textContent =
      "Owner enrollment database ready.";

  } catch (error) {

    console.error(error);
    message.textContent =
      "Cannot initialize owner database.";
  }
}
