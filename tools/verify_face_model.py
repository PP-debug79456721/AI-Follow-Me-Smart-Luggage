#!/usr/bin/env python3
"""
Verify the face embedding model the web app uses.

Run this on your own computer (or in the Codespace) where the .onnx file is:

    pip install onnx onnxruntime numpy pillow
    python tools/verify_face_model.py
    python tools/verify_face_model.py --same a1.jpg a2.jpg --diff a1.jpg b1.jpg

What it checks
  1. File size and SHA-256 (put the SHA-256 into models/manifest.json).
  2. ONNX checker and the real input/output names, shapes and types.
  3. One inference: output length, finite values, norm.
  4. Optional image pairs: cosine similarity for the same person (--same)
     and different people (--diff), using EXACTLY the preprocessing of the
     web app (RGB, (x - 127.5) / 128, NHWC, 112x112).

IMPORTANT
  * Pass images that are already ALIGNED 112x112 face crops. The script only
    resizes them. Unaligned crops give misleading similarities. The web app
    aligns faces from detector keypoints; this script does not.
  * Similarity numbers from a few pairs do not establish accuracy and this
    script does not define a recognition threshold. Collect several same /
    different pairs from your own camera before choosing one.
  * This script never claims recognition works; it only reports numbers.
"""

import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np

DEFAULT_MODEL = "models/face/face-recognition.onnx"

# Keep in sync with FACE_MODEL_CONFIG in js/embedding/face-embedding.js
SIZE = 112
MEAN = 127.5
STD = 128.0


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preprocess(image_path: str) -> np.ndarray:
    from PIL import Image

    image = Image.open(image_path).convert("RGB").resize((SIZE, SIZE), Image.BILINEAR)
    array = np.asarray(image, dtype=np.float32)          # H, W, C (RGB)
    array = (array - MEAN) / STD
    return array[np.newaxis, ...]                          # 1, H, W, C (NHWC)


def embed(session, input_name, output_name, tensor):
    vector = session.run([output_name], {input_name: tensor})[0][0].astype(np.float64)
    if not np.all(np.isfinite(vector)):
        raise ValueError("Embedding contains non-finite values.")
    norm = np.linalg.norm(vector)
    if norm == 0:
        raise ValueError("Embedding has zero norm.")
    return vector / norm


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--same", nargs=2, action="append", default=[], metavar=("A", "B"),
                        help="two aligned crops of the SAME person (repeatable)")
    parser.add_argument("--diff", nargs=2, action="append", default=[], metavar=("A", "B"),
                        help="two aligned crops of DIFFERENT people (repeatable)")
    args = parser.parse_args()

    path = Path(args.model)
    if not path.is_file():
        print(f"ERROR: model file not found: {path}")
        return 2

    size = path.stat().st_size
    print(f"File     : {path}")
    print(f"Size     : {size:,} bytes")
    if size == 0:
        print("ERROR: file is empty (0 bytes).")
        return 2
    print(f"SHA-256  : {sha256_of(path)}   <- put this in models/manifest.json")

    import onnx
    import onnxruntime as ort

    onnx.checker.check_model(onnx.load(str(path)))
    print("ONNX check: passed")

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    model_input = session.get_inputs()[0]
    model_output = session.get_outputs()[0]
    print(f"Input    : {model_input.name} {model_input.shape} {model_input.type}")
    print(f"Output   : {model_output.name} {model_output.shape} {model_output.type}")

    problems = []
    shape = model_input.shape
    if len(shape) != 4:
        problems.append(f"input rank is {len(shape)}, expected 4")
    elif shape[1:] == [SIZE, SIZE, 3]:
        print("Layout   : NHWC (matches the web app config)")
    elif shape[1:] == [3, SIZE, SIZE]:
        problems.append("input is NCHW but the web app config uses NHWC: update FACE_MODEL_CONFIG.layout")
    else:
        problems.append(f"unexpected input shape {shape}")

    gray = np.full((1, SIZE, SIZE, 3), 0.0, dtype=np.float32)
    try:
        vector = embed(session, model_input.name, model_output.name, gray)
        print(f"Inference: ok, embedding length {vector.shape[0]} (unit-normalized)")
        if vector.shape[0] != 512:
            problems.append(f"embedding length {vector.shape[0]}, the app config expects 512")
    except Exception as error:  # report, do not hide
        problems.append(f"inference failed: {error}")

    for label, pairs in (("SAME person", args.same), ("DIFFERENT people", args.diff)):
        for a, b in pairs:
            try:
                ea = embed(session, model_input.name, model_output.name, preprocess(a))
                eb = embed(session, model_input.name, model_output.name, preprocess(b))
                print(f"Cosine {label:<17}: {float(np.dot(ea, eb)):+.4f}   ({a} vs {b})")
            except Exception as error:
                problems.append(f"{a} vs {b}: {error}")

    if problems:
        print("\nPROBLEMS:")
        for item in problems:
            print(f" - {item}")
        return 1

    print("\nDone. The file loads and produces embeddings. This does NOT prove recognition accuracy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
