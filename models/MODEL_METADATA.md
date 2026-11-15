# ONNX model metadata

Machine-readable details live in `manifest.json` (schema 2). ONNX files are
not stored in Git (see `.gitignore`).

## Manifest fields (schema 2)

Each model keeps separate facts. No single word such as "AVAILABLE" stands
for several of them.

| Field | Values | Meaning |
|---|---|---|
| `integrity` | `VERIFIED`, `NONE` | `VERIFIED` = `sizeBytes` and `sha256` were recorded from a checked file. It identifies the file; it says nothing about origin or license. |
| `localAvailability` | `NOT_IN_REPOSITORY`, `NO_VALID_FILE` | Where the file can exist. `NOT_IN_REPOSITORY` = only where it was placed by hand; every clone, Codespace and deployment is missing it. Whether the file is present at run time is checked by the loader (it reports `MODEL FILE NOT FOUND`). |
| `distribution` | `NOT_DISTRIBUTED`, `DISTRIBUTED` | Whether the file is published anywhere (release, hosting). |
| `license.status` | `VERIFIED`, `UNVERIFIED`, `REJECTED`, `NOT_APPLICABLE` | Model, weights and training data are recorded separately under `license`. |
| `use` | `APPROVED_FOR_PRODUCTION`, `DEVELOPMENT_ONLY`, `DISABLED` | What the app may do with the model. |

### Load policy (`js/embedding/model-policy.js`, fail-closed)

Checked before any model file is requested:

- No manifest, `schemaVersion` not 2, or a missing model entry: **not loaded**.
- Any field with a value not listed above (for example the old `AVAILABLE`): **not loaded**.
- `use: DISABLED`: shown as `NO MODEL`.
- An active model (`use` not `DISABLED`) with `license.status: NOT_APPLICABLE`:
  **not loaded** (`INVALID_STATUS`). `NOT_APPLICABLE` is only for a slot with
  no model chosen.
- `license.status: REJECTED`: **never loaded**, in any mode, whatever `use`
  says (`LICENSE_REJECTED`).
- `integrity` not `VERIFIED`, or `sizeBytes` / `sha256` missing or malformed: **not loaded**.
- `file` must be a relative path: `models/`, one or more segments separated
  by `/`, ending in `.onnx` (for example `models/face/face_recognition_sface_2021dec.onnx`).
  Segments use only `A-Z a-z 0-9 _ -`: no `.`, `..`, `%` encoding, backslash,
  scheme, empty segment, query or fragment.
- **Production** (the default): only `use: APPROVED_FOR_PRODUCTION` **and**
  `license.status: VERIFIED`. A model with an unverified license never loads
  in production, whatever `use` says.
- **Development**: only when the page is opened with `?modelMode=development`
  on `localhost`, `127.0.0.1` or a GitHub Codespaces forwarded address
  (`*.app.github.dev`). `DEVELOPMENT_ONLY` models may then load with an
  unverified license. Keep the Codespaces port **private**: a public port
  would distribute the model file. The app **cannot detect** whether a
  forwarded port is private or public (the address looks the same), so this
  is an operating rule, not something the code enforces.
- `?modelMode=development` is ignored on every other host (for example a
  GitHub Pages or any production address), and only the exact value
  `development` counts (first value wins if repeated).

When loading is allowed, the file size and SHA-256 are checked against the
manifest **before** the ONNX session is created; a cached copy is checked
again every time.

Face recognition is also switched off in the app itself
(`LOAD_RECOGNITION_MODELS = false` in `js/ai-owner.js`), so in Phase C the
manifest is not read at all.

## face: models/face/face_recognition_sface_2021dec.onnx (SFace, OpenCV Zoo)

| Fact | Status | Evidence |
|---|---|---|
| File identity | `integrity: VERIFIED` | `face_recognition_sface_2021dec.onnx`, **38,696,353 bytes**, SHA-256 `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`. Matches the Git LFS pointer of `opencv/opencv_zoo` `models/face_recognition_sface/face_recognition_sface_2021dec.onnx` at commit `ba91a3b91d00d76e86540d4013f944bd6b514e39`; downloaded from that pinned commit and re-checked 2026-11-13. |
| Where the file is | `NOT_IN_REPOSITORY` | Ignored by Git (`models/**/*.onnx`); placed by hand in the owner's Codespace only. |
| Published | `NOT_DISTRIBUTED` | Must not be published (repository, release, static hosting, public forwarded port) while commercial clearance is unverified. |
| License (weights) | Apache-2.0 **as stated by OpenCV Zoo** | "All files in this directory are licensed under Apache 2.0 License" (`models/face_recognition_sface/README.md`, `LICENSE`). The LICENSE copyright line is an unfilled template placeholder. |
| License status in the manifest | **UNVERIFIED** | Not cleared for commercial use, because the training data is unknown (next row). |
| Training data | **UNRESOLVED** | Not stated for this file. The SFace paper (arXiv 2205.12010) reports models trained on MS1MV2 (derived from MS-Celeb-1M) and VGGFace2; which dataset trained this MobileFaceNet file is unknown, and those datasets' terms may restrict commercial use. |
| Use | `DEVELOPMENT_ONLY` | Never loaded in production by `model-policy.js`. No commercial approval is claimed. |
| Attribution | — | SFace: Yaoyao Zhong et al. (arXiv 2205.12010); ONNX conversion by Chengrui Wang (OpenCV Zoo). |

Tensor facts (read from the ONNX file itself on 2026-11-13 with a read-only
protobuf parser; **no inference has been run yet**):

- ONNX IR 6, opset 11, graph name `mxnet_converted_model` (converted from
  MXNet). 88 nodes, standard operators only: `Conv` x27,
  `BatchNormalization` x29, `PRelu` x27, `Sub`, `Mul`, `Dropout`, `Flatten`,
  `Gemm`. 174 float32 initializers, 9,667,074 parameters. No custom domains.
- Input **`data`**, float32, **`[1, 3, 112, 112]`, NCHW**. The batch size is
  fixed at 1 (no dynamic dimensions).
- Output **`fc1`**, float32, **`[1, 128]`**, **not** L2-normalized (the last
  node is a `BatchNormalization`); the app L2-normalizes it.
- **Normalization is inside the graph.** The first two nodes compute
  `(x - 127.5) * 0.0078125`, i.e. **`(x - 127.5) / 128`**. The model must
  therefore receive **raw pixel values 0..255**.
- App preprocessing (`FACE_MODEL_CONFIG` in
  `js/embedding/face-model-config.js`): **RGB**, NCHW, `pixelScale: 1`,
  `mean: [0, 0, 0]`, `std: [1, 1, 1]` (raw 0..255), ArcFace-template aligned
  112x112. **Never normalize twice**: the old ArcFace settings
  (`mean 127.5`, `std 128`) or the preprocessor default `pixelScale: 255`
  would still give finite numbers, so no runtime check would notice, but
  every embedding would be meaningless. `tests/face-model-config.test.mjs`
  guards against both.
- Color order RGB follows OpenCV's reference code
  (`blobFromImage(..., swapRB=true)` on a BGR image); it is **UNVERIFIED**
  on real faces. Check it with
  `tools/verify_face_model.py --sweep` / `--dir` (profile `sface` compares
  RGB and BGR on raw pixels only).
- Alignment: OpenCV aligns with 5 landmarks (eyes, nose, mouth corners) to
  the ArcFace 112x112 template. The app uses 4 points from BlazeFace (no
  mouth corners; the mouth centre is mapped to the corners' midpoint). The
  effect on accuracy is **not measured**.
- Operator support in ONNX Runtime Web (WASM) is expected (standard
  opset-11 operators) but **not yet tested** in a browser; speed and memory
  on Android are **not measured**.

## Previous face model: garavv/arcface-onnx (not in the manifest)

Used as the face entry until 2026-11-13; replaced by SFace and no longer
loaded by the app. Kept for reference (`tools/verify_face_model.py
--profile arcface-garavv` can still check it).

- `models/face/face-recognition.onnx` (`arc.onnx`, revision
  `224c23cbbdc27a22add7fa538dee5b2aa9304b83`), 136,619,444 bytes, SHA-256
  `ffe014a45c9488506719d37fd578ece6661bb385535b36e8039975fa5d4683db`.
- License **UNVERIFIED**: no license tag, no LICENSE file, README silent;
  weights origin and training data not documented (tf2onnx 1.16.1 export of
  a Keras ResNet34).
- Input `input_1`, `[N, 112, 112, 3]`, NHWC; output `embedding`, `[N, 512]`,
  not normalized; no normalization inside the graph (the app applied
  `(x - 127.5) / 128`).

## AuraFace-v1 (candidate, not in the manifest)

Evaluated in Phase B1 for comparison; not added to the manifest and not used
by the app.

- Source: `fal/AuraFace-v1`, `glintr100.onnx`, revision
  `af6d057c9b0ec4071d4c49c80e3539258798b609`, 260,694,151 bytes, SHA-256
  `a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60`.
- Input `data`, `[N, 3, 112, 112]`, float32, **NCHW**; output `1333`, 512,
  not normalized; PyTorch 2.3.0 export, ResNet100, 65.2 M parameters.
- Preprocessing per the InsightFace library the model card points to: RGB,
  `(x - 127.5) / 127.5`. Not confirmed by the model author; **UNVERIFIED**
  on real faces.
- License: model card says Apache-2.0; training data is described only as
  "a commercial dataset" without a name (to be reviewed in Phase B4).

## reid: models/person-reid/person-reid.onnx

- `integrity: NONE`, `localAvailability: NO_VALID_FILE` (the owner's local file
  was 0 bytes and failed the ONNX check), `use: DISABLED`.
- The app shows `NO MODEL` for Re-ID. An OSNet source and its code, weight
  and dataset licenses must be proposed and reviewed before any download.
