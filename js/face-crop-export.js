/*
 * Face crop export panel.
 *
 * Saves aligned 112x112 face crops (made by the same alignment code the
 * recognition pipeline uses) as PNG files, so they can be used with
 * tools/verify_face_model.py (--same / --diff).
 *
 * Privacy: crops live only in this page's memory as object URLs. They are
 * not uploaded, not stored in IndexedDB and not linked to owner enrollment
 * data. A crop leaves the page only when the person taps its download link.
 * Use only your own face or the face of someone who agreed.
 */

import {
  requestAlignedFaceCrop
} from "./ai-owner.js";

const MAX_ITEMS = 30;
const LABEL_MAX_LENGTH = 20;
const DOWNLOAD_ALL_DELAY_MS = 400;

const labelInput = document.getElementById("cropLabel");
const captureBtn = document.getElementById("cropBtn");
const downloadAllBtn = document.getElementById("cropDownloadAllBtn");
const clearBtn = document.getElementById("cropClearBtn");
const message = document.getElementById("cropMessage");
const list = document.getElementById("cropList");

// { name, url, element }
const items = [];

// Next file number for each label (kept after "clear" so a new file never
// reuses a name that may already be in the Downloads folder).
const counters = new Map();

let enabled = false;
let capturing = false;

export function sanitizeCropLabel(value) {

  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, LABEL_MAX_LENGTH);
}

function showMessage(text) {

  if (message) message.textContent = text;
}

function refreshButtons() {

  if (captureBtn) {
    captureBtn.disabled = !enabled || capturing;
  }

  if (downloadAllBtn) {
    downloadAllBtn.disabled = items.length === 0;
  }

  if (clearBtn) {
    clearBtn.disabled = items.length === 0;
  }
}

/* Called by app.js when the face detector is running (or stopped). */
export function setFaceCropEnabled(value) {

  enabled = Boolean(value);

  if (!enabled && !capturing) {
    showMessage("เริ่มกล้องและรอให้ Face detector พร้อมก่อน");
  } else if (enabled && !capturing) {
    showMessage("หันหน้าเข้ากล้อง แล้วกดส่งออกภาพใบหน้า");
  }

  refreshButtons();
}

function describeError(error) {

  switch (error?.code) {

    case "NO_FACE":
      return "ไม่พบใบหน้าใน 4 วินาที ลองเข้าใกล้กล้องและหันหน้าตรงมากขึ้น";

    case "BAD_KEYPOINTS":
      return `จัดแนวใบหน้าไม่ได้ (${error.message}) ลองหันหน้าตรงแล้วถ่ายใหม่`;

    case "BUSY":
      return "กำลังจับภาพอยู่";

    case "NOT_RUNNING":
    case "NO_FACE_DETECTOR":
      return "Face detector ยังไม่พร้อม เริ่มกล้องและรอสถานะ READY";

    case "CANCELLED":
      return "ยกเลิกการจับภาพ";

    default:
      return `ส่งออกไม่สำเร็จ: ${error?.message || error}`;
  }
}

function describeWarnings(result) {

  const notes = [];

  if (result.warnings.includes("LOW_RESOLUTION")) {
    notes.push(
      `หน้าเล็กไป (${result.faceWidthPx}px) ภาพจะเบลอ ควรเข้าใกล้กล้อง`
    );
  }

  if (result.warnings.includes("MULTIPLE_FACES")) {
    notes.push(
      `พบ ${result.faceCount} ใบหน้า ใช้ใบหน้าที่ใหญ่ที่สุด ตรวจว่าเป็นคนที่ตั้งใจ`
    );
  }

  return notes;
}

function addItem(blob, name, result) {

  const url = URL.createObjectURL(blob);

  const element = document.createElement("div");
  element.className = "crop-item";

  const image = document.createElement("img");
  image.src = url;
  image.width = 56;
  image.height = 56;
  image.alt = name;

  const text = document.createElement("div");

  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = name;

  const detail = document.createElement("small");
  detail.textContent =
    `face ${result.faceWidthPx}px · score ${Math.round(result.score * 100)}%`;

  text.append(link, detail);

  for (const note of describeWarnings(result)) {

    const warning = document.createElement("small");
    warning.className = "crop-warning";
    warning.textContent = note;

    text.append(warning);
  }

  element.append(image, text);

  list.append(element);

  items.push({ name, url, element });
}

async function capture() {

  if (capturing || !enabled) return;

  const label = sanitizeCropLabel(labelInput?.value);

  if (!label) {
    showMessage("ใส่ป้ายชื่อเป็นตัวอักษรอังกฤษ ตัวเลข _ หรือ - (เช่น me, friend1)");
    return;
  }

  if (items.length >= MAX_ITEMS) {
    showMessage(
      `ครบ ${MAX_ITEMS} ภาพ ดาวน์โหลดแล้วกดล้างรายการก่อนถ่ายเพิ่ม`
    );
    return;
  }

  if (labelInput) labelInput.value = label;

  capturing = true;
  refreshButtons();
  showMessage("กำลังจับภาพ... มองกล้องตรง ๆ");

  try {

    const result = await requestAlignedFaceCrop();

    const number = (counters.get(label) ?? 0) + 1;

    counters.set(label, number);

    const name = `${label}_${number}.png`;

    addItem(result.blob, name, result);

    const notes = describeWarnings(result);

    showMessage(
      notes.length
        ? `บันทึก ${name} แล้ว แต่ ${notes.join(" / ")}`
        : `บันทึก ${name} แล้ว กดชื่อไฟล์เพื่อดาวน์โหลด`
    );

  } catch (error) {

    console.warn("Face crop export failed:", error);

    showMessage(describeError(error));

  } finally {

    capturing = false;
    refreshButtons();
  }
}

function downloadItem(item) {

  const anchor = document.createElement("a");

  anchor.href = item.url;
  anchor.download = item.name;

  anchor.click();
}

async function downloadAll() {

  if (items.length === 0) return;

  showMessage(
    "ถ้าเบราว์เซอร์ถามว่าอนุญาตดาวน์โหลดหลายไฟล์ ให้กดอนุญาต"
  );

  // Copy so tapping "clear" mid-way cannot break the loop.
  for (const item of [...items]) {

    downloadItem(item);

    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_ALL_DELAY_MS));
  }
}

function clearItems() {

  for (const item of items) {

    URL.revokeObjectURL(item.url);
    item.element.remove();
  }

  items.length = 0;

  showMessage("ล้างรายการแล้ว");
  refreshButtons();
}

export function initFaceCropExport() {

  if (!captureBtn) return;

  captureBtn.addEventListener("click", capture);
  downloadAllBtn?.addEventListener("click", downloadAll);
  clearBtn?.addEventListener("click", clearItems);

  window.addEventListener("pagehide", () => {

    for (const item of items) {
      URL.revokeObjectURL(item.url);
    }
  });

  refreshButtons();
}
