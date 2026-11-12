
/*
 * AI Follow-Me Smart Luggage
 * Image Preprocessor
 *
 * Responsibilities:
 * 1. Read image dimensions
 * 2. Validate bounding boxes
 * 3. Crop image safely
 * 4. Resize image
 * 5. Convert RGB pixels to NCHW Float32Array
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
// Convert Image to NCHW Float32Array
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

  for (let y = 0; y < height; y++) {

    for (let x = 0; x < width; x++) {

      const pixel = (y * width + x) * 4;
      const index = y * width + x;

      const r = pixels[pixel] / 255;
      const g = pixels[pixel + 1] / 255;
      const b = pixels[pixel + 2] / 255;

      tensorData[index] =
        (r - mean[0]) / std[0];

      tensorData[size + index] =
        (g - mean[1]) / std[1];

      tensorData[2 * size + index] =
        (b - mean[2]) / std[2];
    }
  }

  return tensorData;
}

// --------------------------------------------------
// Complete Image Preprocessing
// --------------------------------------------------

export function preprocessImageData(
  image,
  box,
  config
) {

  const croppedImage = cropAndResizeImage(
    image,
    box,
    config
  );

  return imageToTensorData(
    croppedImage,
    config
  );
}
