import {
  initOwnerAI,
  startOwnerAI,
  stopOwnerAI
} from "./ai-owner.js";
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

  setStatus("fpsValue", "0 FPS");
  setStatus("cameraStatus", cameraStatus);
  setStatus("resolution", "Resolution: --");
  showCameraLabel(null);
  setStatus("systemStatus", systemStatus);

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

initLegacyOwnerData();
initFaceCropExport();
initPersonSelection();
