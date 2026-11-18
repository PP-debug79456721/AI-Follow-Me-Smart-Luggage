import {
  initOwnerAI,
  startOwnerAI,
  stopOwnerAI,
  setFollowActive,
  setMotionDecisionListener,
  getSelectedTarget,
  STOP_HEIGHT_OVERRIDE,
  ownerFeaturesEnabled,
  ownerClothesEnabled,
  rememberOwnerClothes,
  addOwnerClothesView,
  startOwnerEnrolment,
  findOwner,
  forgetOwner,
  getOwnerProfiles,
  setActiveOwnerProfile,
  renameOwnerProfile
} from "./ai-owner.js";
import { createEsp32Session } from "./esp32-session.js";
import { LITE_MODE } from "./lite-mode.js";
import { createFpsHint } from "./fps-hint.js";
import { createMotionSmoother } from "./motion-smoother.js";
import { createMockDeviceNetwork } from "./mock-socket.js";
import { createBleSocketFactory } from "./ble-socket.js";
import { initLegacyOwnerData }
  from "./legacy-owner-data.js";
import { initPersonSelection }
  from "./person-select-ui.js";
import {
  initFaceCropExport,
  setFaceCropEnabled
} from "./face-crop-export.js";
import {
  startCamera,
  stopCamera,
  getCameraInfo,
  describeCamera,
  onFpsUpdate,
  onCameraEnded,
  isCameraLive
} from "./camera.js";

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const video = document.getElementById("camera");

function setStatus(id, value) {
  // Skip the write when nothing changed: the ESP32 card is refreshed every 250 ms and most of the
  // time its text is identical (a DOM write forces style work on a busy phone).
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}

/* The same camera label on the video overlay and under the video. */
function showCameraLabel(settings) {
  const label = settings ? describeCamera(settings) : null;
  setStatus("cameraLabel", label ?? "CAMERA");
  setStatus("cameraType", `Camera: ${label ?? "--"}`);
}

const fpsHint = createFpsHint();

// FPS comes from real camera frames (camera.js). null = the browser
// cannot measure it, so "--" is shown instead of a guess.
onFpsUpdate(fps => {

  // Track ended without an "ended" event: handle it the same way.
  if (video.srcObject && !isCameraLive()) {
    handleCameraEnded();
    return;
  }

  if (fps === null) {
    fpsHint.reset();
    setStatus("fpsValue", "-- FPS");
    return;
  }

  // A phone lowers the camera rate in dim light by itself: say so instead of leaving it a mystery.
  const hint = fpsHint.push(fps);
  setStatus("fpsValue", `${fps.toFixed(1)} FPS${hint ? ` · ${hint}` : ""}`);

  // Connected but no new frame in the last second.
  if (video.srcObject) {
    setStatus("cameraStatus", fps > 0 ? "CONNECTED" : "NO FRAMES");
  }
});

/* Puts the page back in the "camera off" state. */
function resetToStopped({ cameraStatus, systemStatus }) {

  stopCamera();
  stopOwnerAI();
  setFaceCropEnabled(false);
  smoother.reset();
  session.setDecision("STOP", null);

  fpsHint.reset();
  setStatus("fpsValue", "0 FPS");
  setStatus("cameraStatus", cameraStatus);
  setStatus("resolution", "Resolution: --");
  showCameraLabel(null);
  setStatus("systemStatus", systemStatus);
  setStatus("motorStatus", "STOP");

  startBtn.disabled = false;
  stopBtn.disabled = true;
}

// The camera stopped by itself (permission revoked, taken by another app,
// unplugged): stop detection on the last frozen image and allow a restart.
function handleCameraEnded() {
  resetToStopped({
    cameraStatus: "CAMERA ENDED",
    systemStatus: "CAMERA ENDED - PRESS START CAMERA"
  });
}

onCameraEnded(handleCameraEnded);

startBtn.addEventListener("click", async () => {

  startBtn.disabled = true;

  setStatus("systemStatus", "STARTING");
  setStatus("cameraStatus", "CONNECTING");

  try {

    await startCamera();

    const settings = getCameraInfo();

    setStatus("cameraStatus", "CONNECTED");

    setStatus(
      "resolution",
      `Resolution: ${settings.width} x ${settings.height}`
    );

    showCameraLabel(settings);

    setStatus("systemStatus", "CAMERA READY");

    startBtn.disabled = true;
    stopBtn.disabled = false;

  } catch (error) {

    console.error(error);

    stopCamera();

    setStatus("cameraStatus", "ERROR");
    setStatus("systemStatus", error.message);

    startBtn.disabled = false;
    return;
  }

  // AI is started after the camera. If the AI cannot load, the camera
  // and owner registration keep working and the AI status says so.
  try {

    await initOwnerAI();

    // The user may have pressed STOP while the detectors were loading.
    if (video.srcObject) {
      startOwnerAI();
      setFaceCropEnabled(true);
    }

  } catch (error) {

    console.error("AI not ready:", error);

    setStatus("systemStatus", "CAMERA READY - AI NOT READY");
  }
});

stopBtn.addEventListener("click", () => {
  resetToStopped({
    cameraStatus: "DISCONNECTED",
    systemStatus: "SYSTEM READY"
  });
});

video.addEventListener("error", () => {
  setStatus("cameraStatus", "VIDEO ERROR");
});

// ---------------------------------------------------------------------------
// ESP32 link (M0). The motion decision still comes only from ai-owner.js /
// motion-decision.js; the session adds the transport, reconnect and the
// ARM / FOLLOW gate. The link (esp32-link.js) keeps every safety rule.
// "mock://device" talks to the in-page Mock ESP32: it is NOT hardware.
// ---------------------------------------------------------------------------

let mockNetwork = null;
const bleSockets = createBleSocketFactory();   // "ble://" = Bluetooth LE (Web Bluetooth)
let lastBleSocket = null;                      // for the timing line on the ESP32 card

const DEMO_MODE = new URLSearchParams(location.search).get("mode") === "demo";
// Detection evidence may be up to 1.2 s old and a command may run up to 1.5 s
// (normal: 0.45 s / 0.7 s). Only used in DEMO mode.
// rttGateMs 450 (normal 300): the RTT estimate is the max of the last 3 samples, and on the bench single
// Wi-Fi/phone spikes of 300-400 ms made RTT_GATE stop the wheels although the device lease still covers them.
const DEMO_LINK = DEMO_MODE ? { ageClaimMaxMs: 1200, evidenceMaxMs: 1500, rttGateMs: 450 } : {};

const session = createEsp32Session({
  createSocket(url) {
    if (url.startsWith("mock://")) {
      mockNetwork ??= createMockDeviceNetwork();
      return mockNetwork.createSocket(url);
    }
    if (url.startsWith("ble:")) {
      lastBleSocket = bleSockets.createSocket(url);
      return lastBleSocket;
    }
    return new WebSocket(url);
  },
  // Bench (phone on Wi-Fi): stalls of 0.6-1 s dropped ARM with the 600 ms
  // protocol defaults. Only the CONNECTION may now be silent up to 1200 ms;
  // motion still ends by the lease (evidenceMaxMs 700) when no fresh command
  // arrives. MUST match ProtocolConfig in firmware/esp32-follow/esp32-follow.ino
  // (movementWatchdogMs / sessionLivenessMs = 1200).
  linkOptions: {
    linkTimeoutMs: 1200,
    handshakeTimeoutMs: 1200,
    pendingTtlMs: 1200,
    // After a resync the device keeps the old session for sessionLivenessMs
    // (1200) and answers BUSY meanwhile. 2000 left too little margin on phone
    // Wi-Fi and ended in DEVICE BUSY about once a minute.
    busyMaxMs: 4000,
    ...DEMO_LINK
  }
});

// Removes noise STOPs (one missed detection, standing right at the "close"
// threshold, flipping at the edge of the turn band). See motion-smoother.js.
// DEMO mode (open the page with ?mode=demo): a detector miss is bridged for up
// to 1 s instead of 0.4 s. Needs the firmware's ProtocolConfig ageClaimMaxMs
// >= 1200 and evidenceMaxMs >= 1500 (esp32-follow.ino), see DEMO_LINK below.
const smoother = createMotionSmoother({
  ...(DEMO_MODE ? { holdMs: 1000 } : {}),
  // Resume 0.08 below the stop height (stop 95 % / resume 87 %). 0.05 made the
  // luggage stop-go when the owner stood near the threshold (detector jitter).
  ...(STOP_HEIGHT_OVERRIDE ? { resumeHeightRatio: STOP_HEIGHT_OVERRIDE - 0.08 } : {})
});

setMotionDecisionListener(decision => {

  // The ORIGINAL detection time of the target behind this decision.
  const target = getSelectedTarget();

  try {
    const smooth = smoother.apply(
      decision,
      target ? target.state : null,
      target ? target.lastSeenMs : null,
      target ? target.now : null
    );
    // Box height in % of the frame: compare with the stop height (80 % or ?stop=).
    const h = Number.isFinite(decision.heightRatio) ? ` · ${Math.round(decision.heightRatio * 100)}%` : "";
    setStatus("motorStatus", smooth.command + h);
    session.setDecision(smooth.command, smooth.detectionTime);
  } catch (error) {
    console.error("ESP32 session failed; forcing STOP:", error);
    try { session.setDecision("STOP", null); } catch { /* nothing more to do */ }
  }
});

// Keep the phone screen on while FOLLOW is on. A screen that dims or locks
// hides the page, which (on purpose) stops the luggage and drops FOLLOW; on the
// bench that happened about once a minute. Needs a secure context (the
// chrome://flags origin on the phone counts). Released when FOLLOW is off; the
// browser drops it whenever the page is hidden, so it is taken again on show.
let wakeLock = null;
let wakeLockBusy = false;

async function updateWakeLock() {
  if (wakeLockBusy) return;
  const want = session.getStatus().follow && !document.hidden;
  wakeLockBusy = true;
  try {
    if (want && !wakeLock && navigator.wakeLock?.request) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch (error) {
    console.warn("Screen wake lock unavailable:", error);
  } finally {
    wakeLockBusy = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) session.hide(); else session.show();
  updateWakeLock();
});
window.addEventListener("pagehide", () => session.hide());
window.addEventListener("pageshow", () => { if (!document.hidden) session.show(); });

const espUrl = document.getElementById("espUrl");
const espConnectBtn = document.getElementById("espConnectBtn");
const espDisconnectBtn = document.getElementById("espDisconnectBtn");
const espFollowBtn = document.getElementById("espFollowBtn");
const espEstopBtn = document.getElementById("espEstopBtn");
const espClearEstopBtn = document.getElementById("espClearEstopBtn");

// ---- Convenience (bench): remember the URL, reconnect by itself ----------
// The URL is remembered on this device. After CONNECT the page reconnects by
// itself (on reload too, and after DEVICE BUSY) until DISCONNECT is pressed.
// FOLLOW is NOT re-armed by any of this: after every reconnect the user still
// presses ARM / FOLLOW (esp32-session.js safety rule).
const STORE_URL = "esp32.url";
const STORE_AUTO = "esp32.autoConnect";
const DEFAULT_URL = "ws://192.168.137.50:81/ws";   // firmware static IP (config.h kStaticIp)
const BUSY_RETRY_MS = 2500;

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* storage may be unavailable: only the convenience is lost */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

espUrl.value = load(STORE_URL) || espUrl.value || DEFAULT_URL;
let autoConnect = load(STORE_AUTO) === "1";
let busyRetryTimer = null;

function connectNow() {
  const url = espUrl.value.trim();
  if (!url) return;
  store(STORE_URL, url);
  session.connect(url);
}

espConnectBtn.addEventListener("click", () => {
  autoConnect = true;
  store(STORE_AUTO, "1");
  connectNow();
});
espDisconnectBtn.addEventListener("click", () => {
  autoConnect = false;
  store(STORE_AUTO, null);
  clearTimeout(busyRetryTimer);
  busyRetryTimer = null;
  session.disconnect();
});

// DEVICE BUSY ends the session's own attempts; retry while the user wants a link.
setInterval(() => {
  const status = session.getStatus();
  if (
    autoConnect && !status.desired && !status.emergency && !busyRetryTimer &&
    status.lastEvent === "DEVICE_BUSY"
  ) {
    busyRetryTimer = setTimeout(() => {
      busyRetryTimer = null;
      const now = session.getStatus();
      if (autoConnect && !now.desired && !now.emergency) connectNow();
    }, BUSY_RETRY_MS);
  }
}, 500);

if (autoConnect) setTimeout(connectNow, 300);
espFollowBtn.addEventListener("click", () => {
  session.setFollow(!session.getStatus().follow);
  updateWakeLock();
});
espEstopBtn.addEventListener("click", () => session.emergencyStop());
espClearEstopBtn.addEventListener("click", () => session.clearEmergency());

/*
 * The motor the DEVICE reported in a valid ACK of the CURRENT session, or "—".
 * Display only: it changes no command, timer or protocol rule.
 *   - ESTOP latched, or no open socket / no established link: "—".
 *   - esp32-link clears lastOkAckAt whenever a session ends and sets it only
 *     from a valid ok:true ACK. While it is null, any value the link still
 *     holds belongs to a PREVIOUS session, so nothing is shown until the new
 *     session's first valid ACK arrives.
 */
function deviceMotorText(status) {

  const link = status.link;

  if (status.emergency) return "—";
  if (status.socket !== "OPEN" || !link.connected) return "—";
  if (link.lastOkAckAt === null || link.lastOkAckAt === undefined) return "—";

  return link.deviceMotor ?? "—";
}

// Diagnostics (bench): the longest gap between page timer ticks in the last
// 10 s. A gap above ~1000 ms means the browser itself stalled (busy main thread,
// throttled or hidden window) and the link went silent from the page side.
let stallLastTick = performance.now();
let stallMax = 0;
let stallShown = 0;
let stallWindowStart = performance.now();
let hiddenCount = 0;
document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenCount += 1; });
setInterval(() => {
  const t = performance.now();
  stallMax = Math.max(stallMax, t - stallLastTick);
  stallLastTick = t;
  if (t - stallWindowStart >= 10000) {
    stallShown = stallMax;
    stallMax = 0;
    stallWindowStart = t;
  }
}, 100);

// BLE only: where does the round trip go? (see getStats() in ble-socket.js)
function bleTimingLines(status) {
  if (typeof status.url !== "string" || !status.url.startsWith("ble:") || !lastBleSocket?.getStats) return [];
  const s = lastBleSocket.getStats();
  const ms = value => (value === null ? "-" : Math.round(value));
  return [
    `ble write: ${ms(s.writeAvgMs)}/${ms(s.writeMaxMs)} ms (avg/max)   send: ${ms(s.sendAvgMs)}/${ms(s.sendMaxMs)} ms   ` +
      `${s.chunksPerMessage} chunk(s) of ${s.chunkBytes} B`,
    `ble reply assembly: ${ms(s.rxAssemblyMaxMs)} ms max (${s.rxLines} lines / 10 s)`
  ];
}

/* "stops: RTT_GATE x3, STALE_DECISION x5 ... busy x2": which gate made the luggage stop (most frequent first). */
function stopReasonsLine(link) {
  // DECISION_STOP is the normal "owner is close / not tracked" stop, not a link problem.
  const entries = Object.entries(link.stopEntries ?? {})
    .filter(([reason]) => reason !== "DECISION_STOP")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason} x${count}`);
  const busy = link.counters?.busy ?? 0;
  if (busy > 0) entries.push(`BUSY x${busy}`);
  return `stops: ${entries.length ? entries.join(", ") : "-"}`;
}

function renderEspLink() {

  const status = session.getStatus();
  const link = status.link;
  const mock = typeof status.url === "string" && status.url.startsWith("mock://");

  setFollowActive(status.follow);

  let label = "DISCONNECTED";
  if (status.emergency) label = "ESTOP LATCHED";
  else if (status.hidden) label = "PAUSED (PAGE HIDDEN)";
  else if (status.lastEvent === "DEVICE_BUSY" || (status.desired && !link.connected && link.busyStart !== null)) label = "DEVICE BUSY";
  else if (link.connected) label = status.follow ? "FOLLOWING ENABLED" : "CONNECTED (STOP)";
  else if (status.desired) label = "CONNECTING";

  if (DEMO_MODE) label += " · DEMO";
  if (LITE_MODE) label += " · LITE";
  if (STOP_HEIGHT_OVERRIDE) label += ` · STOP ${Math.round(STOP_HEIGHT_OVERRIDE * 100)}%`;
  setStatus("espLinkState", mock && status.desired ? `${label} - MOCK, NOT HARDWARE` : label);
  setStatus("espStatus", label);

  espConnectBtn.disabled = status.desired;
  espDisconnectBtn.disabled = !status.desired;
  espFollowBtn.disabled = !status.follow && !(link.connected && !status.emergency);
  espFollowBtn.textContent = status.follow ? "FOLLOW OFF" : "ARM / FOLLOW";
  espClearEstopBtn.hidden = !status.emergency;

  setStatus("espDetail", [
    `socket: ${status.socket}   link: ${link.state}`,
    `follow: ${status.follow ? "ON" : "OFF"}   estop: ${status.emergency ? "LATCHED" : "no"}`,
    `sending: ${link.effective?.command ?? "-"} (${link.effective?.reason ?? "-"})`,
    `device motor: ${deviceMotorText(status)}   rtt: ${link.rttEst == null ? "-" : Math.round(link.rttEst)} ms`,
    `last: ${status.lastEvent ?? "-"}   resync: ${link.lastResyncReason ?? "-"}`,
    `page stall: ${Math.round(Math.max(stallShown, stallMax))} ms   buffered: ${status.buffered ?? "-"} B   hidden: ${hiddenCount}`,
    stopReasonsLine(link),
    ...bleTimingLines(status)
  ].join("\n"));
}

setInterval(() => { renderEspLink(); updateWakeLock(); }, 250);
renderEspLink();

// Owner recognition controls (bench, localhost only; see ai-owner.js).
if (ownerClothesEnabled()) {
  document.getElementById("ownerControls").hidden = false;
  document.getElementById("ownerHint").hidden = false;
  document.getElementById("ownerEnrolBtn").hidden = !ownerFeaturesEnabled();
  document.getElementById("ownerClothesBtn").addEventListener("click", () => {
    const r = rememberOwnerClothes();
    if (!r.ok) setStatus("ownerStatus", r.reason === "SELECT_OWNER_FIRST"
      ? "แตะเลือกตัวเองก่อน (ต้องขึ้น TRACKING)" : "จำเสื้อผ้าไม่สำเร็จ");
  });
  document.getElementById("ownerViewBtn").addEventListener("click", () => addOwnerClothesView());
  document.getElementById("ownerEnrolBtn").addEventListener("click", () => {
    const r = startOwnerEnrolment();
    if (!r.ok) setStatus("ownerStatus", r.reason === "SELECT_OWNER_FIRST"
      ? "แตะเลือกตัวเองก่อน (ต้องขึ้น TRACKING)" : "ใช้ได้เฉพาะบนคอม (localhost)");
  });
  document.getElementById("ownerFindBtn").addEventListener("click", () => findOwner());
  document.getElementById("ownerForgetBtn").addEventListener("click", () => {
    const active = getOwnerProfiles().find(p => p.active);
    if (confirm(`ลบหน้าและเสื้อผ้าของ ${active ? active.name : "เจ้าของ"} ที่จำไว้?`)) forgetOwner();
  });

  // Up to 3 users; only the selected one is searched for and followed.
  const profileSelect = document.getElementById("ownerProfileSelect");
  const profileName = document.getElementById("ownerNameInput");
  const renderProfiles = () => {
    const list = getOwnerProfiles();
    profileSelect.replaceChildren(...list.map(p => {
      const option = document.createElement("option");
      option.value = String(p.index);
      option.textContent = `${p.name} · หน้า ${p.faces} · Re-ID ${p.reid} · เสื้อ ${p.cloth}`;
      option.selected = p.active;
      return option;
    }));
    const active = list.find(p => p.active);
    if (active && document.activeElement !== profileName) profileName.value = active.name;
  };
  profileSelect.addEventListener("change", () => {
    setActiveOwnerProfile(Number(profileSelect.value));
    renderProfiles();
  });
  document.getElementById("ownerRenameBtn").addEventListener("click", () => {
    const active = getOwnerProfiles().find(p => p.active);
    if (active) renameOwnerProfile(active.index, profileName.value);
    profileName.blur();
    renderProfiles();
  });
  setInterval(() => { if (document.activeElement !== profileSelect) renderProfiles(); }, 1000);
  renderProfiles();
}

initLegacyOwnerData();
initFaceCropExport();
initPersonSelection();