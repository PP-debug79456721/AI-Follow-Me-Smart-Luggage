# ONNX model metadata

Machine-readable details (size, SHA-256, availability) live in
`manifest.json`. ONNX files are not stored in Git (see `.gitignore`).

## models/face/face-recognition.onnx

- Source: https://huggingface.co/garavv/arcface-onnx (file `arc.onnx`, about 137 MB)
- Size: 136,619,444 bytes; ONNX checker passed; 162 nodes (checked locally by the project owner)
- Input: `input_1`, shape `[dynamic batch, 112, 112, 3]` (NHWC)
- Output: `embedding`, shape `[dynamic batch, 512]`
- Preprocessing used by the app (`FACE_MODEL_CONFIG`): RGB, `(x - 127.5) / 128`,
  aligned 112x112 face. These values come from the model card and are NOT yet
  verified on real faces. Run `tools/verify_face_model.py` first.
- License: UNVERIFIED. No license is declared on the model page and the
  training data is not documented. Do not upload to a public release or
  publish until the license and origin are confirmed.
- SHA-256: not recorded yet. Run `sha256sum models/face/face-recognition.onnx`
  and put the value in `manifest.json` to enable the integrity check and cache.

## models/person-reid/person-reid.onnx

- NO MODEL. The local file is 0 bytes and fails the ONNX check
  (`The model does not have an ir_version set properly.`). The app shows
  `NO MODEL` for Re-ID until a verified Re-ID embedding model (not a
  classifier) with a checked license replaces it.
