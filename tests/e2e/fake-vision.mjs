/*
 * Test stand-in for "@mediapipe/tasks-vision" (vision_bundle.mjs).
 *
 * The e2e test serves this file in place of the CDN module so the page
 * runs without network access or model files. Detections come from
 * window.__persons and window.__faces, which the test sets.
 * Shapes follow MediaPipe: boundingBox in video pixels, keypoints 0..1.
 */

export const FilesetResolver = {
  forVisionTasks: async () => ({})
};

export class FaceDetector {
  static async createFromOptions() { return new FaceDetector(); }
  detectForVideo() {
    return { detections: structuredClone(window.__faces || []) };
  }
  close() {}
}

export class ObjectDetector {
  static async createFromOptions() { return new ObjectDetector(); }
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
