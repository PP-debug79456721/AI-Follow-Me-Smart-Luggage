let cameraStream = null;

const video = document.getElementById("camera");

// --------------------------------------------------
// Camera label
// --------------------------------------------------

/*
 * One label for the camera in use, shown both on the video overlay and
 * under the video, so the two never disagree. On the luggage the phone's
 * rear camera is the one that looks forward.
 */
export function describeCamera(settings) {

  const facingMode = settings?.facingMode;

  if (facingMode === "environment") return "FORWARD CAMERA (REAR)";
  if (facingMode === "user") return "FRONT CAMERA (SELFIE)";

  // The browser did not report which camera is in use.
  return "CAMERA (UNKNOWN)";
}

// --------------------------------------------------
// Real video frames (FPS and "no new frame" detection)
// --------------------------------------------------

// requestVideoFrameCallback runs once per video frame actually shown, so
// it measures the camera's frame rate, not the screen refresh rate.
export const hasVideoFrameCallback =
  typeof HTMLVideoElement !== "undefined" &&
  "requestVideoFrameCallback" in HTMLVideoElement.prototype;

let frameCallbackId = null;
let fpsTimer = null;
let framesSinceReport = 0;
let lastReportTime = 0;
let lastVideoFrameTime = 0;
let fpsListener = null;

function onVideoFrame() {

  framesSinceReport++;
  lastVideoFrameTime = performance.now();

  frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
}

/*
 * Time (performance.now) of the last real video frame, or null when the
 * browser cannot tell (no requestVideoFrameCallback).
 */
export function getLastVideoFrameTime() {
  return hasVideoFrameCallback ? lastVideoFrameTime : null;
}

/*
 * listener(fps): called about once a second with the real camera frame
 * rate (0 when no frame arrived), or with null when the browser has no
 * requestVideoFrameCallback and the rate cannot be measured.
 */
export function onFpsUpdate(listener) {
  fpsListener = listener;
}

function reportFps(value) {
  try {
    fpsListener?.(value);
  } catch (error) {
    console.error("FPS listener failed:", error);
  }
}

function startFrameMonitor() {

  stopFrameMonitor();

  if (!hasVideoFrameCallback) {
    reportFps(null);
    return;
  }

  framesSinceReport = 0;
  lastReportTime = performance.now();
  // Start counting "no new frame" time from now, not from page load.
  lastVideoFrameTime = lastReportTime;

  frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);

  // A timer, not the frame callback, reports the rate: when frames stop
  // the callback stops too, and the rate must drop to 0.
  fpsTimer = setInterval(() => {
    const now = performance.now();
    reportFps(framesSinceReport * 1000 / Math.max(1, now - lastReportTime));
    framesSinceReport = 0;
    lastReportTime = now;
  }, 1000);
}

function stopFrameMonitor() {

  if (frameCallbackId !== null && hasVideoFrameCallback) {
    video.cancelVideoFrameCallback(frameCallbackId);
  }

  frameCallbackId = null;

  clearInterval(fpsTimer);
  fpsTimer = null;
}

// --------------------------------------------------
// Camera ended by the system
// --------------------------------------------------

let endedListener = null;

/*
 * listener(): called when the camera stops by itself (permission revoked,
 * camera taken by another app, device unplugged). Not called for
 * stopCamera(), because track.stop() does not fire "ended".
 */
export function onCameraEnded(listener) {
  endedListener = listener;
}

/* True while the current camera track is delivering video. */
export function isCameraLive() {
  const track = cameraStream?.getVideoTracks()[0];
  return Boolean(track) && track.readyState === "live";
}

// --------------------------------------------------
// Start / stop
// --------------------------------------------------

export async function startCamera() {

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera API unavailable. Please use HTTPS and a supported browser."
    );
  }

  stopCamera();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,

    video: {
      facingMode: {
        ideal: "environment"
      },

      width: {
        ideal: 640
      },

      height: {
        ideal: 480
      },

      frameRate: {
        ideal: 15,
        max: 20
      }
    }
  });

  cameraStream = stream;

  for (const track of stream.getVideoTracks()) {
    track.addEventListener("ended", () => {
      // Ignore a stream that was already replaced or stopped.
      if (cameraStream !== stream) return;
      stopFrameMonitor();
      try {
        endedListener?.();
      } catch (error) {
        console.error("Camera ended listener failed:", error);
      }
    });
  }

  video.srcObject = stream;

  await video.play();

  startFrameMonitor();

  return stream;
}

export function stopCamera() {

  stopFrameMonitor();

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => {
      track.stop();
    });

    cameraStream = null;
  }

  video.srcObject = null;
}

export function getCameraInfo() {

  if (!cameraStream) {
    return null;
  }

  const track = cameraStream.getVideoTracks()[0];

  return track.getSettings();
}
