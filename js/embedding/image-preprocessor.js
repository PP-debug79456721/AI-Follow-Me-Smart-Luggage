
/*
 * AI Follow-Me Smart Luggage
 * Image Preprocessor
 *
 * Responsibilities:
 * 1. Read image dimensions
 * 2. Validate bounding boxes
 * 3. Crop image safely
 * 4. Resize image
 * 5. Align faces from facial keypoints (ArcFace 112x112 template)
 * 6. Convert pixels to a Float32Array in the layout / color order /
 *    normalization the model was trained with (per-model config)
 *
 * Per-model config fields (defaults keep the original behavior):
 *   width, height      target size
 *   layout             "NCHW" (default) | "NHWC"
 *   colorOrder         "RGB" (default) | "BGR"
 *   pixelScale         pixels are divided by this first (default 255)
 *   mean, std          per-channel normalization, in model channel order
 *   alignment          undefined | "arcface-112"
 */

// --------------------------------------------------
// Get Image Dimensions
// --------------------------------------------------

function getImageDimensions(image) {

  const width =
    image.videoWidth ||
    image.naturalWidth ||
    image.width;

  const height =
    image.videoHeight ||
    image.naturalHeight ||
    image.height;

  if (!width || !height) {
    throw new Error("Image dimensions unavailable.");
  }

  return { width, height };
}

// --------------------------------------------------
// Normalize Bounding Box
// --------------------------------------------------

function normalizeBoundingBox(box) {

  if (!box) {
    throw new Error("Bounding box is required.");
  }

  // Supports MediaPipe and standard bounding boxes.
  const x = Number(box.x ?? box.originX);
  const y = Number(box.y ?? box.originY);

  const width = Number(box.width);
  const height = Number(box.height);

  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Invalid bounding box.");
  }

  return { x, y, width, height };
}

// --------------------------------------------------
// Crop and Resize Image
// --------------------------------------------------

export function cropAndResizeImage(
  image,
  box,
  config
) {

  const { width, height } = config;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Invalid target dimensions.");
  }

  const imageSize = getImageDimensions(image);

  const bounds = normalizeBoundingBox(box);

  // Clip bounding box to image boundaries.
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);

  const right = Math.min(
    imageSize.width,
    bounds.x + bounds.width
  );

  const bottom = Math.min(
    imageSize.height,
    bounds.y + bounds.height
  );

  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error("Bounding box outside image.");
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!ctx) {
    throw new Error("Canvas context unavailable.");
  }

  ctx.drawImage(
    image,
    left,
    top,
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height
  );

  return canvas;
}

// --------------------------------------------------
// Tensor Shape For A Model Config
// --------------------------------------------------

export function getInputShape(config) {

  const layout = config.layout ?? "NCHW";

  if (layout === "NHWC") {
    return [1, config.height, config.width, 3];
  }

  if (layout === "NCHW") {
    return [1, 3, config.height, config.width];
  }

  throw new Error(`Unsupported tensor layout: ${layout}`);
}

// --------------------------------------------------
// Convert Image to Float32Array (NCHW or NHWC)
// --------------------------------------------------

export function imageToTensorData(
  image,
  config
) {

  const {
    width,
    height,
    mean,
    std
  } = config;

  const layout = config.layout ?? "NCHW";
  const colorOrder = config.colorOrder ?? "RGB";
  const pixelScale = config.pixelScale ?? 255;

  if (layout !== "NCHW" && layout !== "NHWC") {
    throw new Error(`Unsupported tensor layout: ${layout}`);
  }

  if (colorOrder !== "RGB" && colorOrder !== "BGR") {
    throw new Error(`Unsupported color order: ${colorOrder}`);
  }

  if (!Number.isFinite(pixelScale) || pixelScale <= 0) {
    throw new Error("Invalid pixel scale.");
  }

  if (
    !Array.isArray(mean) ||
    !Array.isArray(std) ||
    mean.length !== 3 ||
    std.length !== 3 ||
    mean.some(v => !Number.isFinite(v)) ||
    std.some(v => !Number.isFinite(v) || v === 0)
  ) {
    throw new Error("Invalid normalization settings.");
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!ctx) {
    throw new Error("Canvas context unavailable.");
  }

  ctx.drawImage(
    image,
    0,
    0,
    width,
    height
  );

  const pixels = ctx.getImageData(
    0,
    0,
    width,
    height
  ).data;

  const size = width * height;

  const tensorData = new Float32Array(
    3 * size
  );

  const swap = colorOrder === "BGR";

  for (let y = 0; y < height; y++) {

    for (let x = 0; x < width; x++) {

      const pixel = (y * width + x) * 4;
      const index = y * width + x;

      // Channels in the order the model expects.
      const c0 = pixels[swap ? pixel + 2 : pixel] / pixelScale;
      const c1 = pixels[pixel + 1] / pixelScale;
      const c2 = pixels[swap ? pixel : pixel + 2] / pixelScale;

      const v0 = (c0 - mean[0]) / std[0];
      const v1 = (c1 - mean[1]) / std[1];
      const v2 = (c2 - mean[2]) / std[2];

      if (layout === "NHWC") {

        tensorData[index * 3] = v0;
        tensorData[index * 3 + 1] = v1;
        tensorData[index * 3 + 2] = v2;

      } else {

        tensorData[index] = v0;
        tensorData[size + index] = v1;
        tensorData[2 * size + index] = v2;
      }
    }
  }

  return tensorData;
}

// --------------------------------------------------
// Face Alignment (ArcFace 112x112)
// --------------------------------------------------

// Standard ArcFace template for a 112x112 aligned face.
// The mouth point is the midpoint of the two mouth-corner template
// points because the face detector provides a single mouth center.
export const ARCFACE_112_TEMPLATE = Object.freeze({
  leftEye: [38.2946, 51.6963],
  rightEye: [73.5318, 51.5014],
  nose: [56.0252, 71.7366],
  mouth: [56.1396, 92.2848]
});

/*
 * MediaPipe FaceDetector returns keypoints normalized to 0..1.
 * Converts them to pixel coordinates of the source image.
 */
export function mediapipeKeypointsToPixels(
  keypoints,
  imageWidth,
  imageHeight
) {

  if (!Array.isArray(keypoints)) {
    throw new Error("Keypoints are required.");
  }

  return keypoints.map(point => ({
    x: point.x * imageWidth,
    y: point.y * imageHeight
  }));
}

/*
 * Least-squares similarity transform (rotation + uniform scale +
 * translation, no reflection) mapping src points onto dst points:
 *   x' = a*x - b*y + tx
 *   y' = b*x + a*y + ty
 */
export function estimateSimilarityTransform(src, dst) {

  if (
    !Array.isArray(src) ||
    !Array.isArray(dst) ||
    src.length !== dst.length ||
    src.length < 2
  ) {
    throw new Error("At least two matching points are required.");
  }

  const n = src.length;

  let msx = 0, msy = 0, mdx = 0, mdy = 0;

  for (let i = 0; i < n; i++) {
    msx += src[i][0]; msy += src[i][1];
    mdx += dst[i][0]; mdy += dst[i][1];
  }

  msx /= n; msy /= n; mdx /= n; mdy /= n;

  let aNum = 0, bNum = 0, denom = 0;

  for (let i = 0; i < n; i++) {

    const sx = src[i][0] - msx;
    const sy = src[i][1] - msy;
    const dx = dst[i][0] - mdx;
    const dy = dst[i][1] - mdy;

    aNum += sx * dx + sy * dy;
    bNum += sx * dy - sy * dx;
    denom += sx * sx + sy * sy;
  }

  if (!Number.isFinite(denom) || denom < 1e-9) {
    throw new Error("Degenerate keypoints.");
  }

  const a = aNum / denom;
  const b = bNum / denom;

  return {
    a,
    b,
    tx: mdx - (a * msx - b * msy),
    ty: mdy - (b * msx + a * msy)
  };
}

/*
 * Builds source/destination point lists from detector keypoints
 * (pixel coordinates, MediaPipe order: eye, eye, nose, mouth, ...).
 * The two eyes are ordered by x so the result does not depend on
 * which eye the detector labels first.
 */
function buildAlignmentPoints(keypoints, size) {

  if (!Array.isArray(keypoints) || keypoints.length < 4) {
    throw new Error(
      "Face alignment requires keypoints for both eyes, nose and mouth."
    );
  }

  const pts = keypoints.slice(0, 4).map(point => {

    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new Error("Invalid face keypoint.");
    }

    return [point.x, point.y];
  });

  const eyes = [pts[0], pts[1]].sort((p, q) => p[0] - q[0]);

  const nose = pts[2];
  const mouth = pts[3];

  const eyeY = (eyes[0][1] + eyes[1][1]) / 2;

  if (eyes[1][0] - eyes[0][0] < 1 || mouth[1] <= eyeY) {
    throw new Error(
      "Face keypoints are inconsistent (eyes must be above the mouth)."
    );
  }

  const k = size / 112;

  const t = ARCFACE_112_TEMPLATE;

  const scale = p => [p[0] * k, p[1] * k];

  return {
    src: [eyes[0], eyes[1], nose, mouth],
    dst: [t.leftEye, t.rightEye, t.nose, t.mouth].map(scale)
  };
}

/*
 * Warps the source image so the face matches the ArcFace template.
 * Returns a size x size canvas.
 */
export function alignFaceToCanvas(image, keypoints, size = 112) {

  const { src, dst } = buildAlignmentPoints(keypoints, size);

  const { a, b, tx, ty } = estimateSimilarityTransform(src, dst);

  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!ctx) {
    throw new Error("Canvas context unavailable.");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Canvas matrix: x' = a*x + c*y + e, y' = b*x + d*y + f
  ctx.setTransform(a, b, -b, a, tx, ty);

  ctx.drawImage(image, 0, 0);

  return canvas;
}

// --------------------------------------------------
// Complete Image Preprocessing
// --------------------------------------------------

export function preprocessImageData(
  image,
  box,
  config
) {

  let prepared;

  if (config.alignment === "arcface-112") {

    if (config.width !== 112 || config.height !== 112) {
      throw new Error("ArcFace alignment requires a 112x112 input.");
    }

    if (!Array.isArray(box?.keypoints)) {
      // Never fall back to an unaligned crop: it would silently
      // produce poor embeddings for a model trained on aligned faces.
      throw new Error(
        "Face alignment keypoints are required for this model."
      );
    }

    prepared = alignFaceToCanvas(
      image,
      box.keypoints,
      config.width
    );

  } else if (!config.alignment) {

    prepared = cropAndResizeImage(
      image,
      box,
      config
    );

  } else {

    throw new Error(
      `Unsupported alignment: ${config.alignment}`
    );
  }

  return imageToTensorData(
    prepared,
    config
  );
}
