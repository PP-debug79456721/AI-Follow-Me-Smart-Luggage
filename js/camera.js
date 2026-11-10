
let cameraStream = null;

const video = document.getElementById("camera");

export async function startCamera() {

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera API unavailable. Please use HTTPS and a supported browser."
    );
  }

  stopCamera();

  cameraStream = await navigator.mediaDevices.getUserMedia({
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

  video.srcObject = cameraStream;

  await video.play();

  return cameraStream;
}

export function stopCamera() {

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
