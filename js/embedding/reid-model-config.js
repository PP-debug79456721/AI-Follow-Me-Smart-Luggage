/*
 * Person Re-ID model configuration (no imports, so it can be unit-tested in
 * Node without ONNX Runtime).
 *
 * Chosen model (see models/MODEL_METADATA.md, "reid"): Torchreid OSNet x0.25
 * trained on MSMT17 (combineall), official Torchreid model zoo weights
 * (MIT, Kaiyang Zhou), exported to ONNX by tools/convert-osnet-to-onnx.py,
 * which also checks the ONNX output against PyTorch.
 *
 * Torchreid test-time preprocessing: RGB, resize to 256x128 (H x W), pixels
 * / 255, ImageNet mean/std. Input "input" float32 [1, 3, 256, 128] (NCHW),
 * output "embedding" float32 [1, 512] (not normalised; the engine L2-normalises).
 */
export const REID_MODEL_CONFIG = Object.freeze({
  width: 128,
  height: 256,
  layout: "NCHW",
  inputShape: Object.freeze([1, 3, 256, 128]),
  outputShape: Object.freeze([1, 512]),
  colorOrder: "RGB",
  pixelScale: 255,
  mean: Object.freeze([0.485, 0.456, 0.406]),
  std: Object.freeze([0.229, 0.224, 0.225]),
  inputName: "input",
  outputName: "embedding",
  embeddingDim: 512
});
