/*
 * Owner data saved by the Phase A+B version (read and delete only).
 *
 * Phase A+B had an OWNER REGISTRATION panel that saved full camera frames
 * ("face" and "reid" mode, both may show a face) to IndexedDB
 * "SmartLuggageOwnerDB", store "samples". Its embedding code could also
 * write to the "embeddings" store.
 *
 * Phase C does not save any image or face data. This module only:
 *   - counts what an earlier version left on this device, and
 *   - deletes it when the user presses the button and confirms.
 * Nothing is deleted automatically, and the database is never created
 * here: if it does not exist, opening it is cancelled.
 */

const DB_NAME = "SmartLuggageOwnerDB";
const STORES = ["samples", "embeddings"];

const faceCountEl = document.getElementById("legacyFaceCount");
const reidCountEl = document.getElementById("legacyReidCount");
const embeddingCountEl = document.getElementById("legacyEmbeddingCount");
const messageEl = document.getElementById("legacyDataMessage");
const deleteBtn = document.getElementById("legacyDeleteBtn");

let busy = false;

/*
 * Opens the existing database at its current version, or resolves null
 * when it does not exist (the creation is aborted, so nothing is made).
 */
function openExistingDatabase() {

  return new Promise((resolve, reject) => {

    let created = false;

    const request = indexedDB.open(DB_NAME);

    request.onupgradeneeded = () => {
      // Only happens when the database did not exist yet.
      created = true;
      request.transaction.abort();
    };

    request.onsuccess = () => {
      const db = request.result;
      // Let a later version of the app upgrade the database.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = event => {
      if (created) {
        event.preventDefault();
        resolve(null);
      } else {
        reject(request.error);
      }
    };
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* { face, reid, otherSamples, embeddings } — 0 when nothing is stored. */
async function countSavedData() {

  const counts = { face: 0, reid: 0, otherSamples: 0, embeddings: 0 };

  const db = await openExistingDatabase();

  if (!db) return counts;

  try {

    const stores = STORES.filter(name => db.objectStoreNames.contains(name));

    if (stores.length === 0) return counts;

    const tx = db.transaction(stores, "readonly");

    if (stores.includes("samples")) {

      const samples = await requestResult(tx.objectStore("samples").getAll());

      for (const sample of samples) {
        if (sample?.mode === "face") counts.face++;
        else if (sample?.mode === "reid") counts.reid++;
        else counts.otherSamples++;
      }
    }

    if (stores.includes("embeddings")) {
      counts.embeddings = await requestResult(tx.objectStore("embeddings").count());
    }

    return counts;

  } finally {
    db.close();
  }
}

async function deleteSavedData() {

  const db = await openExistingDatabase();

  if (!db) return;

  try {

    const stores = STORES.filter(name => db.objectStoreNames.contains(name));

    if (stores.length === 0) return;

    await new Promise((resolve, reject) => {

      const tx = db.transaction(stores, "readwrite");

      for (const name of stores) tx.objectStore(name).clear();

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  } finally {
    db.close();
  }
}

const total = counts =>
  counts.face + counts.reid + counts.otherSamples + counts.embeddings;

function show(counts) {

  faceCountEl.textContent = String(counts.face);
  reidCountEl.textContent = String(counts.reid + counts.otherSamples);
  embeddingCountEl.textContent = String(counts.embeddings);

  deleteBtn.disabled = busy || total(counts) === 0;
}

async function refresh(note) {

  try {

    const counts = await countSavedData();

    show(counts);

    messageEl.textContent = note ?? (
      total(counts) === 0
        ? "ไม่มีข้อมูลเจ้าของจากเวอร์ชันก่อนในเครื่องนี้"
        : "มีข้อมูลจากเวอร์ชันก่อนค้างอยู่ ระบบไม่ลบให้อัตโนมัติ กดปุ่มด้านล่างถ้าต้องการลบ"
    );

  } catch (error) {

    console.error("Saved owner data check failed:", error);

    deleteBtn.disabled = true;
    messageEl.textContent =
      "ตรวจข้อมูลเดิมไม่ได้ ลบเองได้จากการตั้งค่าเบราว์เซอร์ (ดูข้อความด้านล่าง)";
  }
}

async function onDelete() {

  if (busy) return;

  const confirmed = window.confirm(
    "ลบภาพเจ้าของและข้อมูล embedding ที่เวอร์ชันก่อนบันทึกไว้ในเครื่องนี้ทั้งหมด?\n" +
    "ลบแล้วกู้คืนไม่ได้"
  );

  if (!confirmed) return;

  busy = true;
  deleteBtn.disabled = true;
  messageEl.textContent = "กำลังลบ...";

  try {

    await deleteSavedData();

    busy = false;
    await refresh("ลบข้อมูลเดิมแล้ว");

  } catch (error) {

    console.error("Saved owner data delete failed:", error);

    busy = false;
    await refresh("ลบไม่สำเร็จ ปิดแท็บอื่นของหน้านี้แล้วลองใหม่ หรือลบจากการตั้งค่าเบราว์เซอร์");
  }
}

export function initLegacyOwnerData() {

  if (!faceCountEl || !reidCountEl || !embeddingCountEl || !messageEl || !deleteBtn) {
    console.warn("Saved owner data panel elements are missing.");
    return;
  }

  deleteBtn.addEventListener("click", onDelete);

  refresh();
}
