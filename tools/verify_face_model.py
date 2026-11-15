#!/usr/bin/env python3
"""
Verify a face embedding model (ONNX) for the web app.

Run this on your own computer (or in the Codespace) where the .onnx file is:

    pip install onnx onnxruntime numpy pillow
    python tools/verify_face_model.py
    python tools/verify_face_model.py --same a1.png a2.png --diff a1.png b1.png
    python tools/verify_face_model.py --sweep --same a1.png a2.png --diff a1.png b1.png
    python tools/verify_face_model.py --dir face_crops/

PROFILES (--profile)
  sface (default) = the web app's FACE_MODEL_CONFIG
      (js/embedding/face-model-config.js) and the manifest face entry:
      OpenCV Zoo face_recognition_sface_2021dec.onnx, input "data"
      [1,3,112,112] NCHW, output "fc1" 128 values, RGB, RAW 0..255 pixels.
      The ONNX graph normalizes internally ((x - 127.5) / 128), so the
      script feeds raw pixels (mean 0, std 1) and REFUSES any other
      --mean / --std: that would normalize twice.
  arcface-garavv (legacy, only when asked for explicitly)
      The earlier garavv/arcface-onnx file (models/face/face-recognition.onnx):
      input "input_1" [N,112,112,3] NHWC, output "embedding" 512 values,
      RGB, (x - 127.5) / 128 applied by the script (no normalization in the
      graph). Kept so old measurements can be repeated; it is no longer the
      app's model.

What it checks
  1. File size and SHA-256 (compare with models/manifest.json).
  2. ONNX checker and the real input/output names, shapes and types,
     compared with the profile (name, layout, output length).
  3. Normalization inside the graph (first nodes Sub + Mul with constants).
     A graph that normalizes plus a script that normalizes = double
     normalization: reported as a PROBLEM, never silently accepted.
  4. One inference: output length, finite values, norm.
  5. Optional image pairs: cosine similarity for the same person (--same)
     and different people (--diff) with the profile's preprocessing.
     --sweep also prints the other settings that are safe for this profile:
     for sface only the color order (RGB / BGR) on raw pixels; for
     arcface-garavv RGB/BGR x three normalizations.
  6. --dir FOLDER: every PNG named <label>_<n>.png (the FACE CROP EXPORT
     file names) is paired automatically: same label = same person, other
     label = different people. For each sweep setting it prints how many
     pairs, the same-person and different-people cosine range, and the gap.

IMPORTANT
  * Pass images that are already ALIGNED 112x112 face crops, for example
    PNGs from the app's FACE CROP EXPORT panel. The script only resizes
    them. Unaligned crops give misleading similarities.
  * Similarity numbers from a few pairs do not establish accuracy and this
    script does not define a recognition threshold. Collect several same /
    different pairs from your own camera before choosing one.
  * The best-separating setting in --sweep / --dir is evidence, not proof:
    confirm it with more people and with the model's official source.
  * --dir prints NO threshold on purpose. A gap measured on a handful of
    photos says nothing about strangers, lighting or other phones.
  * This script never claims recognition works; it only reports numbers.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import sys
from pathlib import Path

SIZE = 112

# Expected model properties and the preprocessing the script applies.
# graph_normalization = (mean, std) the ONNX graph applies itself, or None.
PROFILES = {
    "sface": {
        "model": "models/face/face_recognition_sface_2021dec.onnx",
        "input_name": "data",
        "output_name": "fc1",
        "layout": "NCHW",
        "embedding_dim": 128,
        "color": "RGB",
        "mean": 0.0,
        "std": 1.0,
        "graph_normalization": (127.5, 128.0),
        "description": "OpenCV Zoo SFace (the web app's model), raw 0..255 RGB input",
    },
    "arcface-garavv": {
        "model": "models/face/face-recognition.onnx",
        "input_name": "input_1",
        "output_name": "embedding",
        "layout": "NHWC",
        "embedding_dim": 512,
        "color": "RGB",
        "mean": 127.5,
        "std": 128.0,
        "graph_normalization": None,
        "description": "LEGACY garavv/arcface-onnx (not the app's model)",
    },
}

DEFAULT_PROFILE = "sface"

# Normalizations compared by --sweep when the graph does NOT normalize.
NORMALIZATIONS = [
    (127.5, 128.0, "(x-127.5)/128"),
    (127.5, 127.5, "(x-127.5)/127.5"),
    (0.0, 255.0, "x/255"),
]

RAW = (0.0, 1.0, "raw 0..255")


def sweep_settings(profile: dict) -> list[tuple[str, float, float, str]]:
    """(color, mean, std, label) combinations that are safe for the profile.

    A model that normalizes inside its graph only gets raw pixels, so no
    combination can normalize twice.
    """
    normalizations = [RAW] if profile["graph_normalization"] else NORMALIZATIONS
    return [(color, mean, std, text) for color in ("RGB", "BGR") for mean, std, text in normalizations]


def preprocessing_arg_error(mean: float, std: float) -> str | None:
    """Error message for unusable --mean / --std values, or None."""
    if not math.isfinite(mean):
        return f"--mean must be a finite number (got {mean})."
    if not math.isfinite(std):
        return f"--std must be a finite number (got {std})."
    if std == 0:
        return "--std must not be 0."
    return None


def double_normalization_error(mean: float, std: float, graph_normalization) -> str | None:
    """Error when the script would normalize input the graph normalizes again."""
    if graph_normalization is None or (mean == 0 and std == 1):
        return None
    g_mean, g_std = graph_normalization
    return (f"double normalization: the model graph already computes (x - {g_mean:g}) / {g_std:g}; "
            f"the script must feed raw 0..255 pixels (mean 0, std 1), not (x - {mean:g}) / {std:g}.")


def graph_input_normalization(nodes, constants, input_name):
    """(mean, std) when the graph starts with Sub(input, c) then Mul(.., k).

    nodes: list of {"op": str, "inputs": [str], "outputs": [str]} in graph
    order; constants: {name: float} for scalar initializers. Returns None
    when no such normalization is found.
    """
    if len(nodes) < 2:
        return None
    first, second = nodes[0], nodes[1]
    if first["op"] != "Sub" or second["op"] != "Mul" or input_name not in first["inputs"]:
        return None
    sub_const = next((constants[n] for n in first["inputs"] if n in constants), None)
    mul_const = next((constants[n] for n in second["inputs"] if n in constants), None)
    if sub_const is None or not mul_const or first["outputs"][0] not in second["inputs"]:
        return None
    return (sub_const, 1.0 / mul_const)


def same_normalization(a, b, tolerance=1e-6) -> bool:
    return a is not None and b is not None and all(abs(x - y) <= tolerance for x, y in zip(a, b))


def model_layout(shape) -> str | None:
    if len(shape) != 4:
        return None
    if list(shape[1:]) == [SIZE, SIZE, 3]:
        return "NHWC"
    if list(shape[1:]) == [3, SIZE, SIZE]:
        return "NCHW"
    return None


def profile_problems(profile: dict, input_name, output_name, layout, output_length, graph_norm) -> list[str]:
    """Differences between the real model and the selected profile."""
    problems = []
    if input_name != profile["input_name"]:
        problems.append(f"input name {input_name!r}, the profile expects {profile['input_name']!r}")
    if output_name != profile["output_name"]:
        problems.append(f"output name {output_name!r}, the profile expects {profile['output_name']!r}")
    if layout is not None and layout != profile["layout"]:
        problems.append(f"layout {layout}, the profile expects {profile['layout']}")
    if output_length is not None and output_length != profile["embedding_dim"]:
        problems.append(f"embedding length {output_length}, the profile expects {profile['embedding_dim']}")
    expected = profile["graph_normalization"]
    if expected is not None and not same_normalization(graph_norm, expected):
        problems.append(f"the profile expects normalization (x - {expected[0]:g}) / {expected[1]:g} inside the graph, "
                        f"found {graph_norm}: feeding raw pixels would be wrong")
    if expected is None and graph_norm is not None:
        problems.append(f"the graph normalizes its input ((x - {graph_norm[0]:g}) / {graph_norm[1]:g}) but the profile "
                        "normalizes too: double normalization")
    return problems


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_rgb(image_path: str):
    import numpy as np
    from PIL import Image

    image = Image.open(image_path).convert("RGB").resize((SIZE, SIZE), Image.BILINEAR)
    return np.asarray(image, dtype=np.float32)              # H, W, C (RGB), 0..255


def to_tensor(rgb, layout: str, color: str, mean: float, std: float):
    import numpy as np

    array = rgb[..., ::-1] if color == "BGR" else rgb
    array = (array - mean) / std
    if layout == "NCHW":
        array = array.transpose(2, 0, 1)                     # C, H, W
    return np.ascontiguousarray(array[np.newaxis, ...], dtype=np.float32)


def dir_pairs(folder: str):
    """(same pairs, different pairs, labels) from <label>_<n>.png files."""
    import itertools
    import re

    files = sorted(p for p in Path(folder).glob("*.png") if re.fullmatch(r"[A-Za-z0-9_-]+_\d+", p.stem))
    labels = {}
    for path in files:
        labels.setdefault(path.stem.rsplit("_", 1)[0], []).append(str(path))
    same, diff = [], []
    for a, b in itertools.combinations(files, 2):
        la, lb = a.stem.rsplit("_", 1)[0], b.stem.rsplit("_", 1)[0]
        (same if la == lb else diff).append((str(a), str(b)))
    return same, diff, labels


def dir_report(session, input_name, output_name, layout, folder, settings):
    import numpy as np

    same, diff, labels = dir_pairs(folder)
    print(f"\nFolder   : {folder}")
    print("People   : " + ", ".join(f"{k} ({len(v)})" for k, v in sorted(labels.items())))
    print(f"Pairs    : {len(same)} same-person, {len(diff)} different-people")
    if not same or not diff:
        print("Need at least two photos of one person AND photos of a second person.")
        return ["--dir: not enough labelled photos for both pair types"]

    images = {p: load_rgb(p) for v in labels.values() for p in v}
    print("\n  color normalization      same: min / mean        diff: mean / max        gap (same min - diff max)")
    for color, mean, std, text in settings:
        vectors = {p: embed(session, input_name, output_name, to_tensor(img, layout, color, mean, std))
                   for p, img in images.items()}
        s = np.array([np.dot(vectors[a], vectors[b]) for a, b in same])
        d = np.array([np.dot(vectors[a], vectors[b]) for a, b in diff])
        gap = s.min() - d.max()
        print(f"  {color:5} {text:17}  {s.min():+.4f} / {s.mean():+.4f}      {d.mean():+.4f} / {d.max():+.4f}      {gap:+.4f}"
              + ("" if gap > 0 else "   (overlap)"))
    print("\nNo threshold is given: these photos are too few to set one.")
    return []


def embed(session, input_name, output_name, tensor):
    import numpy as np

    vector = session.run([output_name], {input_name: tensor})[0][0].astype(np.float64)
    if not np.all(np.isfinite(vector)):
        raise ValueError("Embedding contains non-finite values.")
    norm = np.linalg.norm(vector)
    if norm == 0:
        raise ValueError("Embedding has zero norm.")
    return vector / norm


def read_graph_normalization(onnx_model, input_name):
    """graph_input_normalization() for a loaded onnx.ModelProto."""
    from onnx import numpy_helper

    constants = {}
    for init in onnx_model.graph.initializer:
        values = numpy_helper.to_array(init).reshape(-1)
        if values.size == 1:
            constants[init.name] = float(values[0])
    nodes = [{"op": n.op_type, "inputs": list(n.input), "outputs": list(n.output)} for n in onnx_model.graph.node[:2]]
    return graph_input_normalization(nodes, constants, input_name)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", choices=sorted(PROFILES), default=DEFAULT_PROFILE,
                        help=f"expected model and preprocessing (default {DEFAULT_PROFILE}, the web app's model)")
    parser.add_argument("--model", default=None,
                        help="ONNX file (default: the profile's file, for sface "
                             f"{PROFILES['sface']['model']})")
    parser.add_argument("--same", nargs=2, action="append", default=[], metavar=("A", "B"),
                        help="two aligned crops of the SAME person (repeatable)")
    parser.add_argument("--diff", nargs=2, action="append", default=[], metavar=("A", "B"),
                        help="two aligned crops of DIFFERENT people (repeatable)")
    parser.add_argument("--color", choices=["RGB", "BGR"], default=None,
                        help="channel order fed to the model (default: the profile's, RGB)")
    parser.add_argument("--mean", type=float, default=None,
                        help="subtracted from 0..255 pixels (default: the profile's; sface 0, must stay 0)")
    parser.add_argument("--std", type=float, default=None,
                        help="divisor after --mean (default: the profile's; sface 1, must stay 1)")
    parser.add_argument("--sweep", action="store_true",
                        help="also print every setting that is safe for the profile, for the pairs")
    parser.add_argument("--dir", metavar="FOLDER",
                        help="pair every <label>_<n>.png in FOLDER and compare the sweep settings")
    args = parser.parse_args(argv)

    profile = PROFILES[args.profile]
    mean = profile["mean"] if args.mean is None else args.mean
    std = profile["std"] if args.std is None else args.std
    color = args.color or profile["color"]

    error = preprocessing_arg_error(mean, std) or double_normalization_error(mean, std, profile["graph_normalization"])
    if error:
        print(f"ERROR: {error}")
        return 2

    path = Path(args.model or profile["model"])
    print(f"Profile  : {args.profile} - {profile['description']}")
    if not path.is_file():
        print(f"ERROR: model file not found: {path}")
        return 2

    size = path.stat().st_size
    print(f"File     : {path}")
    print(f"Size     : {size:,} bytes")
    if size == 0:
        print("ERROR: file is empty (0 bytes).")
        return 2
    print(f"SHA-256  : {sha256_of(path)}   <- compare with models/manifest.json")

    try:
        import numpy as np
        import onnx
        import onnxruntime as ort
        import PIL  # noqa: F401  (needed for --same / --diff / --dir)
    except ModuleNotFoundError as error:
        print(f"\nMissing Python package: {error.name}")
        print("File size and SHA-256 above are valid. To run the ONNX and inference checks, install:")
        print("    python3 -m pip install onnx onnxruntime numpy pillow")
        print("If pip reports 'externally-managed-environment', use a virtual environment:")
        print("    python3 -m venv .venv && . .venv/bin/activate && pip install onnx onnxruntime numpy pillow")
        return 3

    onnx_model = onnx.load(str(path))
    onnx.checker.check_model(onnx_model)
    print("ONNX check: passed")

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    model_input = session.get_inputs()[0]
    model_output = session.get_outputs()[0]
    print(f"Input    : {model_input.name} {model_input.shape} {model_input.type}")
    print(f"Output   : {model_output.name} {model_output.shape} {model_output.type}")

    problems = []
    layout = model_layout(model_input.shape)
    if layout is None:
        problems.append(f"unexpected input shape {model_input.shape} (need [N,112,112,3] or [N,3,112,112])")
    else:
        print(f"Layout   : {layout} (read from the model input)")

    graph_norm = read_graph_normalization(onnx_model, model_input.name)
    print("In graph : " + ("no input normalization found" if graph_norm is None
                           else f"(x - {graph_norm[0]:g}) / {graph_norm[1]:g}"))
    print(f"Preproc  : {color}, (x - {mean:g}) / {std:g} applied by this script")

    output_length = None
    if layout is not None:
        zeros = np.zeros((1, SIZE, SIZE, 3) if layout == "NHWC" else (1, 3, SIZE, SIZE), dtype=np.float32)
        try:
            vector = embed(session, model_input.name, model_output.name, zeros)
            output_length = vector.shape[0]
            print(f"Inference: ok, embedding length {output_length} (unit-normalized)")
        except Exception as error:  # report, do not hide
            problems.append(f"inference failed: {error}")

    problems += profile_problems(profile, model_input.name, model_output.name, layout, output_length, graph_norm)

    # Never compare images when the model does not match the profile: the
    # numbers would come from the wrong preprocessing.
    if problems:
        print("\nPROBLEMS:")
        for item in problems:
            print(f" - {item}")
        return 1

    pairs = [("SAME person", a, b) for a, b in args.same] + [("DIFFERENT people", a, b) for a, b in args.diff]
    settings = sweep_settings(profile)

    for label, a, b in pairs:
        try:
            ra, rb = load_rgb(a), load_rgb(b)
            ea = embed(session, model_input.name, model_output.name, to_tensor(ra, layout, color, mean, std))
            eb = embed(session, model_input.name, model_output.name, to_tensor(rb, layout, color, mean, std))
            print(f"Cosine {label:<17}: {float(np.dot(ea, eb)):+.4f}   ({a} vs {b})")
        except Exception as error:
            problems.append(f"{a} vs {b}: {error}")

    if args.sweep and pairs:
        print("\nSweep (cosine per pair; SAME should be high, DIFFERENT low):")
        header = "  ".join(f"{label[:4]}:{Path(a).stem}~{Path(b).stem}"[:24].ljust(24) for label, a, b in pairs)
        print(f"  {'color':5} {'normalization':17} {header}")
        try:
            images = {p: load_rgb(p) for _, a, b in pairs for p in (a, b)}
            for s_color, s_mean, s_std, text in settings:
                cells = []
                for _, a, b in pairs:
                    ea = embed(session, model_input.name, model_output.name, to_tensor(images[a], layout, s_color, s_mean, s_std))
                    eb = embed(session, model_input.name, model_output.name, to_tensor(images[b], layout, s_color, s_mean, s_std))
                    cells.append(f"{float(np.dot(ea, eb)):+.4f}".ljust(24))
                print(f"  {s_color:5} {text:17} {'  '.join(cells)}")
        except Exception as error:
            problems.append(f"--sweep: {error}")

    if args.dir:
        if not Path(args.dir).is_dir():
            problems.append(f"--dir: not a folder: {args.dir}")
        else:
            try:
                problems += dir_report(session, model_input.name, model_output.name, layout, args.dir, settings)
            except Exception as error:
                problems.append(f"--dir: {error}")

    if problems:
        print("\nPROBLEMS:")
        for item in problems:
            print(f" - {item}")
        return 1

    print("\nDone. The file loads and produces embeddings. This does NOT prove recognition accuracy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
