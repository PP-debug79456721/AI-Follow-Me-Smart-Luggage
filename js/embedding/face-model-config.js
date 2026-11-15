/*
 * Face embedding model configuration (no imports, so it can be unit-tested
 * in Node without ONNX Runtime). Re-exported by face-embedding.js.
 *
 * Model: OpenCV Zoo SFace, face_recognition_sface_2021dec.onnx
 * (opencv/opencv_zoo @ ba91a3b91d00d76e86540d4013f944bd6b514e39,
 * 38,696,353 bytes, SHA-256 0ba9fbfa...4e79, see models/manifest.json).
 *
 * Read from the ONNX file itself (opset 11, converted from MXNet):
 *   input  "data"  float32 [1, 3, 112, 112]  (NCHW, fixed batch 1)
 *   output "fc1"   float32 [1, 128]          (not L2-normalized)
 *
 * NORMALIZATION IS INSIDE THE GRAPH. Its first two nodes compute
 * (x - 127.5) * 0.0078125, i.e. (x - 127.5) / 128. The model must
 * therefore receive RAW pixel values 0..255:
 *   pixelScale 1 (image-preprocessor.js defaults to 255!), mean 0, std 1.
 * Any other setting normalizes twice; the result is still finite, so no
 * check would catch it, but every embedding would be meaningless.
 *
 * Color order RGB follows OpenCV's reference code
 * (blobFromImage(..., swapRB=true) on a BGR image). It is NOT yet verified
 * on real faces. Alignment uses the ArcFace 112x112 template; OpenCV uses
 * 5 landmarks, this app has 4 (no mouth corners from BlazeFace).
 */
export const FACE_MODEL_CONFIG = Object.freeze({
  width: 112,
  height: 112,
  layout: "NCHW",
  inputShape: Object.freeze([1, 3, 112, 112]),
  outputShape: Object.freeze([1, 128]),
  colorOrder: "RGB",
  pixelScale: 1,
  mean: Object.freeze([0, 0, 0]),
  std: Object.freeze([1, 1, 1]),
  alignment: "arcface-112",
  inputName: "data",
  outputName: "fc1",
  embeddingDim: 128
});
