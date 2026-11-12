/*
 * Test stand-in for "@mediapipe/tasks-vision" (vision_bundle.mjs).
 *
 * The e2e test serves this file in place of the CDN module so the page
 * runs without network access or model files. Detections come from
 * window.__persons and window.__faces, which the test sets.
 * Shapes follow MediaPipe: boundingBox in video pixels, keypoints 0..1.
 * window.__fakeFail = { face: true } / { person: true } makes that
 * detector fail to load, like a model file that cannot be downloaded.
 */

function failIfAsked(kind) {
  if (window.__fakeFail?.[kind]) {
    throw new Error(`fake: ${kind} model download failed`);
  }
}

export const FilesetResolver = {
  forVisionTasks: async () => ({})
};

export class FaceDetector {
  static async createFromOptions() { failIfAsked("face"); return new FaceDetector(); }
  detectForVideo() {
    return { detections: structuredClone(window.__faces || []) };
  }
  close() {}
}

export class ObjectDetector {
  static async createFromOptions() { failIfAsked("person"); return new ObjectDetector(); }
  detectForVideo() {
    return {
      detections: (window.__persons || []).map(box => ({
        boundingBox: { ...box },
        categories: [{ categoryName: "person", score: 0.9 }]
      }))
    };
  }
  close() {}
}
