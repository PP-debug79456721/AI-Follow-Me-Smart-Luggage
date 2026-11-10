import {
  initOwnerAI,
  startOwnerAI,
  stopOwnerAI
} from "./ai-owner.js";
import { initOwnerRegistration }
  from "./owner-registration.js";
import {
  startCamera,
  stopCamera,
  getCameraInfo
} from "./camera.js";

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const video = document.getElementById("camera");

let animationId = null;
let lastTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();

function setStatus(id, value) {
  document.getElementById(id).textContent = value;
}

function startFpsMonitor() {

  cancelAnimationFrame(animationId);

  frameCount = 0;
  lastTime = performance.now();
  lastFpsUpdate = lastTime;

  function update() {

    if (!video.srcObject) return;

    frameCount++;

    const now = performance.now();

    if (now - lastFpsUpdate >= 1000) {

      const fps =
        frameCount * 1000 / (now - lastFpsUpdate);

      setStatus("fpsValue", `${fps.toFixed(1)} FPS`);

      frameCount = 0;
      lastFpsUpdate = now;
    }

    animationId = requestAnimationFrame(update);
  }

  animationId = requestAnimationFrame(update);
}

function stopFpsMonitor() {

  cancelAnimationFrame(animationId);

  setStatus("fpsValue", "0 FPS");
}

startBtn.addEventListener("click", async () => {

  startBtn.disabled = true;

  setStatus("systemStatus", "STARTING");
  setStatus("cameraStatus", "CONNECTING");

  try {

    await startCamera();
    
    await initOwnerAI();
    startOwnerAI();
    
    const settings = getCameraInfo();

    setStatus("cameraStatus", "CONNECTED");

    setStatus(
      "resolution",
      `Resolution: ${settings.width} x ${settings.height}`
    );

    setStatus(
      "cameraType",
      `Camera: ${settings.facingMode || "Rear"}`
    );

    setStatus("systemStatus", "CAMERA READY");

    startBtn.disabled = true;
    stopBtn.disabled = false;

    startFpsMonitor();

  } catch (error) {

    console.error(error);

    stopCamera();

    setStatus("cameraStatus", "ERROR");
    setStatus("systemStatus", error.message);

    startBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", () => {

  stopCamera();
  stopFpsMonitor();
  stopOwnerAI();

  setStatus("cameraStatus", "DISCONNECTED");
  setStatus("resolution", "Resolution: --");
  setStatus("cameraType", "Camera: Rear");
  setStatus("systemStatus", "SYSTEM READY");

  startBtn.disabled = false;
  stopBtn.disabled = true;
});

video.addEventListener("error", () => {
  setStatus("cameraStatus", "VIDEO ERROR");
});

initOwnerRegistration();

function determineOwnerState({
  faceMatch,
  reidMatch,
  trackConsistent
}) {

  if (faceMatch && trackConsistent) {
    return "OWNER_VERIFIED";
  }

  if (reidMatch && trackConsistent) {
    return "OWNER_TRACKING";
  }

  if (!trackConsistent) {
    return "IDENTITY_UNCERTAIN";
  }

  return "OWNER_LOST";
}