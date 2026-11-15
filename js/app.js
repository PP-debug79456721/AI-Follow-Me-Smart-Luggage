import {
  initOwnerAI,
  startOwnerAI,
  stopOwnerAI,
  setMotionDecisionListener,
  getSelectedTarget
} from "./ai-owner.js";
import { createEsp32Session } from "./esp32-session.js";
import { createMockDeviceNetwork } from "./mock-socket.js";
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
  document.getElementById(id).textContent = value;
}

/* The same camera label on the video overlay and under the video. */
function showCameraLabel(settings) {
  const label = settings ? describeCamera(settings) : null;
  setStatus("cameraLabel", label ?? "CAMERA");
  setStatus("cameraType", `Camera: ${label ?? "--"}`);
}

// FPS comes from real camera frames (camera.js). null = the browser
// cannot measure it, so "--" is shown instead of a guess.
onFpsUpdate(fps => {

  // Track ended without an "ended" event: handle it the same way.
  if (video.srcObject && !isCameraLive()) {
    handleCameraEnded();
    return;
  }

  if (fps === null) {
    setStatus("fpsValue", "-- FPS");
    return;
  }

  setStatus("fpsValue", `${fps.toFixed(1)} FPS`);

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
  session.setDecision("STOP", null);

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

const session = createEsp32Session({
  createSocket(url) {
    if (url.startsWith("mock://")) {
      mockNetwork ??= createMockDeviceNetwork();
      return mockNetwork.createSocket(url);
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
    pendingTtlMs: 1200
  }
});

setMotionDecisionListener(decision => {

  setStatus("motorStatus", decision.command);

  // The ORIGINAL detection time of the target behind this decision.
  const target = getSelectedTarget();

  try {
    session.setDecision(decision.command, target ? target.lastSeenMs : null);
  } catch (error) {
    console.error("ESP32 session failed; forcing STOP:", error);
    try { session.setDecision("STOP", null); } catch { /* nothing more to do */ }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) session.hide(); else session.show();
});
window.addEventListener("pagehide", () => session.hide());
window.addEventListener("pageshow", () => { if (!document.hidden) session.show(); });

const espUrl = document.getElementById("espUrl");
const espConnectBtn = document.getElementById("espConnectBtn");
const espDisconnectBtn = document.getElementById("espDisconnectBtn");
const espFollowBtn = document.getElementById("espFollowBtn");
const espEstopBtn = document.getElementById("espEstopBtn");
const espClearEstopBtn = document.getElementById("espClearEstopBtn");

espConnectBtn.addEventListener("click", () => session.connect(espUrl.value));
espDisconnectBtn.addEventListener("click", () => session.disconnect());
espFollowBtn.addEventListener("click", () => {
  session.setFollow(!session.getStatus().follow);
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

function renderEspLink() {

  const status = session.getStatus();
  const link = status.link;
  const mock = typeof status.url === "string" && status.url.startsWith("mock://");

  let label = "DISCONNECTED";
  if (status.emergency) label = "ESTOP LATCHED";
  else if (status.hidden) label = "PAUSED (PAGE HIDDEN)";
  else if (status.desired && !link.connected && link.busyStart !== null) label = "DEVICE BUSY";
  else if (link.connected) label = status.follow ? "FOLLOWING ENABLED" : "CONNECTED (STOP)";
  else if (status.desired) label = "CONNECTING";

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
    `device motor: ${deviceMotorText(status)}   rtt: ${link.rttEst ?? "-"} ms`,
    `last: ${status.lastEvent ?? "-"}   resync: ${link.lastResyncReason ?? "-"}`
  ].join("\n"));
}

setInterval(renderEspLink, 250);
renderEspLink();

initLegacyOwnerData();
initFaceCropExport();
initPersonSelection();
