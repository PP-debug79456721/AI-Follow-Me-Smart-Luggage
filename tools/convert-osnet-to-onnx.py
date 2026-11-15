"""
Convert the official Torchreid OSNet x0.25 MSMT17 (combineall) checkpoint to
the ONNX file the web app loads (models/person-reid/person-reid.onnx), and
check that ONNX Runtime gives the same embedding as PyTorch.

Usage (any machine with Python 3.9+):
  pip install torch onnx onnxruntime numpy
  python tools/convert-osnet-to-onnx.py <checkpoint.pth> <out.onnx>

The network definition is tools/osnet_torchreid.py (Torchreid's osnet.py,
MIT, vendored unchanged), so the torchreid package is not needed.

The checkpoint is NOT downloaded by this script. Get it by hand from the
Torchreid model zoo (docs/MODEL_ZOO.md, "MSMT17 (combineall=True)", row
osnet_x0_25). Prints size and SHA-256 for models/manifest.json.
"""
import hashlib
import sys

import numpy as np
import onnx
import onnxruntime as ort
import os
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osnet_torchreid import osnet_x0_25  # noqa: E402


def load_feature_weights(model, ckpt):
    """Same as torchreid.utils.load_pretrained_weights: keep layers whose
    name and shape match (the classifier of another dataset is dropped)."""
    raw = torch.load(ckpt, map_location="cpu", weights_only=False)
    state = raw.get("state_dict", raw) if isinstance(raw, dict) else raw
    own = model.state_dict()
    kept, dropped = {}, []
    for k, v in state.items():
        k = k[7:] if k.startswith("module.") else k
        if k in own and own[k].shape == v.shape:
            kept[k] = v
        else:
            dropped.append(k)
    missing = [k for k in own if k not in kept and not k.startswith("classifier.")]
    assert not missing, f"checkpoint lacks feature layers: {missing[:5]}"
    own.update(kept)
    model.load_state_dict(own)
    print("loaded", len(kept), "tensors; dropped", dropped)


def main(ckpt, out):
    model = osnet_x0_25(num_classes=1000, pretrained=False)
    if ckpt != "--random":
        load_feature_weights(model, ckpt)
    model.eval()                           # eval: forward returns the 512-D feature

    dummy = torch.randn(1, 3, 256, 128)
    torch.onnx.export(model, dummy, out, input_names=["input"], output_names=["embedding"],
                      opset_version=13, do_constant_folding=True)
    onnx.checker.check_model(onnx.load(out))

    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    inp, outp = sess.get_inputs()[0], sess.get_outputs()[0]
    assert inp.name == "input" and list(inp.shape) == [1, 3, 256, 128], (inp.name, inp.shape)
    assert outp.name == "embedding" and list(outp.shape) == [1, 512], (outp.name, outp.shape)

    worst = 0.0
    for seed in range(5):
        x = torch.from_numpy(np.random.default_rng(seed).standard_normal((1, 3, 256, 128)).astype(np.float32))
        with torch.no_grad():
            ref = model(x).numpy()
        got = sess.run(["embedding"], {"input": x.numpy()})[0]
        worst = max(worst, float(np.abs(ref - got).max()))
    assert worst < 1e-3, f"ONNX differs from PyTorch: {worst}"

    data = open(out, "rb").read()
    print("OK  max |onnx - torch| =", worst)
    print("sizeBytes", len(data))
    print("sha256   ", hashlib.sha256(data).hexdigest())
    if ckpt != "--random":
        print("checkpoint sha256", hashlib.sha256(open(ckpt, "rb").read()).hexdigest())


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
