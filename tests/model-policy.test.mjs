/*
 * Unit tests for js/embedding/model-policy.js (Phase B1.2, fail-closed).
 *
 * Run from the repository root (Node 18+, no packages needed):
 *
 *     node --test tests/model-policy.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideModelLoad,
  resolveModelUseMode,
  checkManifest,
  BLOCK_REASON
} from "../js/embedding/model-policy.js";

const REPO_MANIFEST = JSON.parse(
  readFileSync(new URL("../models/manifest.json", import.meta.url), "utf8")
);

const SHA = "a".repeat(64);

/* A complete, loadable face entry; tests change one field at a time. */
function manifestWith(faceChanges = {}, licenseStatus = "UNVERIFIED") {
  return {
    schemaVersion: 2,
    models: {
      face: {
        file: "models/face/face-recognition.onnx",
        sizeBytes: 1000,
        sha256: SHA,
        integrity: "VERIFIED",
        localAvailability: "NOT_IN_REPOSITORY",
        distribution: "NOT_DISTRIBUTED",
        license: { status: licenseStatus },
        use: "DEVELOPMENT_ONLY",
        ...faceChanges
      }
    }
  };
}

const reason = decision => decision.allowed ? "ALLOWED" : decision.reason;

// --------------------------------------------------
// The real manifest in the repository
// --------------------------------------------------

test("repo manifest: face is blocked in production (development-only, license unverified)", () => {
  const d = decideModelLoad(REPO_MANIFEST, "face", "production");
  assert.deepEqual([d.allowed, d.state, d.reason], [false, "BLOCKED", BLOCK_REASON.NOT_APPROVED_FOR_PRODUCTION]);
});

// OpenCV Zoo SFace fp32, pinned at opencv/opencv_zoo@ba91a3b9...
const SFACE_FILE = "models/face/face_recognition_sface_2021dec.onnx";
const SFACE_SIZE = 38696353;
const SFACE_SHA = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79";

test("repo manifest: face may load in development, with size and SHA-256", () => {
  const d = decideModelLoad(REPO_MANIFEST, "face", "development");
  assert.equal(d.allowed, true);
  assert.equal(d.file, SFACE_FILE);
  assert.equal(d.sizeBytes, SFACE_SIZE);
  assert.equal(d.sha256, SFACE_SHA);
  assert.equal(d.license, "UNVERIFIED");
});

test("repo manifest: SFace entry is pinned, development-only and not commercially cleared", () => {
  const face = REPO_MANIFEST.models.face;
  assert.equal(face.use, "DEVELOPMENT_ONLY");
  assert.equal(face.integrity, "VERIFIED");
  assert.equal(face.distribution, "NOT_DISTRIBUTED");
  assert.equal(face.license.status, "UNVERIFIED");
  assert.match(face.license.trainingData, /^UNRESOLVED/);
  assert.equal(face.source.repository, "https://github.com/opencv/opencv_zoo");
  assert.equal(face.source.revision, "ba91a3b91d00d76e86540d4013f944bd6b514e39");
  assert.equal(face.input.name, "data");
  assert.deepEqual(face.input.shape, [1, 3, 112, 112]);
  assert.equal(face.output.name, "fc1");
  assert.deepEqual(face.output.shape, [1, 128]);
});

test("repo manifest: SFace never loads in production, even with its exact size and hash", () => {
  const d = decideModelLoad(REPO_MANIFEST, "face", "production");
  assert.deepEqual([d.allowed, d.reason], [false, BLOCK_REASON.NOT_APPROVED_FOR_PRODUCTION]);
});

test("SFace entry with a wrong or malformed hash / size is refused before any download", () => {
  const sface = changes => ({
    schemaVersion: 2,
    models: { face: { ...REPO_MANIFEST.models.face, ...changes } }
  });
  for (const changes of [
    { sha256: SFACE_SHA.slice(0, 63) },          // one hex digit short
    { sha256: `${SFACE_SHA}0` },                 // one hex digit long
    { sha256: SFACE_SHA.toUpperCase() },         // policy wants lowercase hex
    { sha256: SFACE_SHA.replace(/^0/, "g") },    // not hex
    { sizeBytes: 0 },
    { sizeBytes: -SFACE_SIZE },
    { sizeBytes: SFACE_SIZE + 0.5 },
    { sizeBytes: String(SFACE_SIZE) },
    { sizeBytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.equal(reason(decideModelLoad(sface(changes), "face", "development")), BLOCK_REASON.NO_INTEGRITY, JSON.stringify(changes));
  }
});

test("a well-formed but different hash / size is passed through unchanged, so the loader rejects the file", () => {
  // The policy cannot see the file; it must hand the loader exactly the
  // recorded values, which the engine then compares (CHECKSUM_MISMATCH /
  // SIZE_MISMATCH, covered by tests/e2e/phase-c.e2e.mjs).
  const other = "f".repeat(64);
  const d = decideModelLoad({ schemaVersion: 2, models: { face: { ...REPO_MANIFEST.models.face, sha256: other, sizeBytes: SFACE_SIZE + 1 } } }, "face", "development");
  assert.equal(d.allowed, true);
  assert.equal(d.sha256, other);
  assert.notEqual(d.sha256, SFACE_SHA);
  assert.equal(d.sizeBytes, SFACE_SIZE + 1);
});

test("repo manifest: Re-ID (OSNet, DEVELOPMENT_ONLY) loads only in development mode", () => {
  const prod = decideModelLoad(REPO_MANIFEST, "reid", "production");
  assert.deepEqual([prod.allowed, prod.state, prod.reason],
    [false, "BLOCKED", BLOCK_REASON.NOT_APPROVED_FOR_PRODUCTION]);
  const dev = decideModelLoad(REPO_MANIFEST, "reid", "development");
  assert.equal(dev.allowed, true);
  assert.equal(dev.file, "models/person-reid/person-reid.onnx");
  assert.equal(dev.sizeBytes, 891011);
  assert.equal(dev.license, "UNVERIFIED");
});

test("repo manifest: no field uses the old overloaded value AVAILABLE", () => {
  assert.equal(JSON.stringify(REPO_MANIFEST).includes('"AVAILABLE"'), false);
});

// --------------------------------------------------
// Manifest problems
// --------------------------------------------------

test("missing manifest -> NO_MANIFEST", () => {
  assert.equal(checkManifest(null), BLOCK_REASON.NO_MANIFEST);
  assert.equal(reason(decideModelLoad(null, "face", "development")), BLOCK_REASON.NO_MANIFEST);
});

test("old schema 1 manifest (status AVAILABLE) -> INVALID_MANIFEST", () => {
  const old = { schemaVersion: 1, models: { face: { status: "AVAILABLE", file: "models/face/face-recognition.onnx", sizeBytes: 1, sha256: SHA } } };
  assert.equal(reason(decideModelLoad(old, "face", "development")), BLOCK_REASON.INVALID_MANIFEST);
});

test("missing model entry -> NO_ENTRY", () => {
  assert.equal(reason(decideModelLoad({ schemaVersion: 2, models: {} }, "face", "development")), BLOCK_REASON.NO_ENTRY);
});

test("unknown status values -> INVALID_STATUS", () => {
  for (const changes of [
    { use: "AVAILABLE" },
    { use: undefined },
    { integrity: "OK" },
    { localAvailability: "AVAILABLE" },
    { distribution: "PUBLIC" },
    { license: { status: "MIT" } },
    { license: undefined }
  ]) {
    assert.equal(reason(decideModelLoad(manifestWith(changes), "face", "development")), BLOCK_REASON.INVALID_STATUS, JSON.stringify(changes));
  }
});

test("unknown mode -> INVALID_STATUS", () => {
  assert.equal(reason(decideModelLoad(manifestWith(), "face", "test")), BLOCK_REASON.INVALID_STATUS);
});

// --------------------------------------------------
// Integrity evidence
// --------------------------------------------------

test("missing or malformed size / hash, or integrity NONE -> NO_INTEGRITY", () => {
  for (const changes of [
    { sha256: null },
    { sha256: "abc" },
    { sha256: "A".repeat(64) },
    { sizeBytes: null },
    { sizeBytes: 0 },
    { sizeBytes: -5 },
    { sizeBytes: "1000" },
    { integrity: "NONE" }
  ]) {
    assert.equal(reason(decideModelLoad(manifestWith(changes), "face", "development")), BLOCK_REASON.NO_INTEGRITY, JSON.stringify(changes));
  }
});

test("file must be a relative models/*.onnx path -> INVALID_FILE", () => {
  for (const file of [
    "https://example.com/model.onnx",
    "//evil.com/models/x.onnx",
    "/models/face/x.onnx",
    "file:///etc/x.onnx",
    "data:application/octet-stream,models/x.onnx",
    "models/../secret.onnx",
    "models/./x.onnx",
    // URL-encoded and double-encoded traversal
    "models/%2e%2e/secret.onnx",
    "models/%2E%2E/secret.onnx",
    "models/%252e%252e/x.onnx",
    "models/..%2fx.onnx",
    "models/face/x%00.onnx",
    // backslashes
    "models\\face\\x.onnx",
    "models/face/..\\..\\x.onnx",
    // empty segments, query, fragment, case, whitespace, look-alike letters
    "models/face//x.onnx",
    "models//evil.com/x.onnx",
    "models/.onnx",
    "models/face/x.onnx?x=1",
    "models/face/x.onnx#a",
    "models/face/x.onnx/",
    "models/face/x.ONNX",
    " models/face/x.onnx",
    "models/face/x.onnx\n",
    "models/fa\u0441e/x.onnx",
    "models/face/x.bin",
    "face/x.onnx",
    null
  ]) {
    assert.equal(reason(decideModelLoad(manifestWith({ file }), "face", "development")), BLOCK_REASON.INVALID_FILE, String(file));
  }
});

// --------------------------------------------------
// Production vs development and license
// --------------------------------------------------

test("production needs APPROVED_FOR_PRODUCTION and a VERIFIED license", () => {
  assert.equal(reason(decideModelLoad(manifestWith({ use: "DEVELOPMENT_ONLY" }, "VERIFIED"), "face", "production")), BLOCK_REASON.NOT_APPROVED_FOR_PRODUCTION);
  assert.equal(reason(decideModelLoad(manifestWith({ use: "APPROVED_FOR_PRODUCTION" }, "UNVERIFIED"), "face", "production")), BLOCK_REASON.LICENSE_UNVERIFIED);
  assert.equal(reason(decideModelLoad(manifestWith({ use: "APPROVED_FOR_PRODUCTION" }, "VERIFIED"), "face", "production")), "ALLOWED");
});

test("a REJECTED license never loads, in any mode or use -> LICENSE_REJECTED", () => {
  for (const use of ["DEVELOPMENT_ONLY", "APPROVED_FOR_PRODUCTION"]) {
    for (const mode of ["development", "production"]) {
      assert.equal(reason(decideModelLoad(manifestWith({ use }, "REJECTED"), "face", mode)), BLOCK_REASON.LICENSE_REJECTED, `${use} / ${mode}`);
    }
  }
  assert.notEqual(BLOCK_REASON.LICENSE_REJECTED, BLOCK_REASON.LICENSE_UNVERIFIED);
});

test("an active model with license NOT_APPLICABLE is refused -> INVALID_STATUS", () => {
  for (const use of ["DEVELOPMENT_ONLY", "APPROVED_FOR_PRODUCTION"]) {
    for (const mode of ["development", "production"]) {
      const d = decideModelLoad(manifestWith({ use }, "NOT_APPLICABLE"), "face", mode);
      assert.deepEqual([d.allowed, d.state, d.reason], [false, "BLOCKED", BLOCK_REASON.INVALID_STATUS], `${use} / ${mode}`);
    }
  }
});

test("a DISABLED model may still use NOT_APPLICABLE (no model chosen) -> NO_MODEL", () => {
  const d = decideModelLoad(manifestWith({ use: "DISABLED", integrity: "NONE", sizeBytes: null, sha256: null }, "NOT_APPLICABLE"), "face", "development");
  assert.deepEqual([d.allowed, d.state], [false, "NO_MODEL"]);
});

test("development allows DEVELOPMENT_ONLY with an unverified license", () => {
  assert.equal(reason(decideModelLoad(manifestWith(), "face", "development")), "ALLOWED");
});

test("use DISABLED -> NO_MODEL, not an error", () => {
  const d = decideModelLoad(manifestWith({ use: "DISABLED" }), "face", "development");
  assert.deepEqual([d.allowed, d.state], [false, "NO_MODEL"]);
});

// --------------------------------------------------
// Mode from the page address
// --------------------------------------------------

test("development only with ?modelMode=development on a development host", () => {
  const at = (hostname, search) => resolveModelUseMode({ hostname, search });
  assert.equal(at("localhost", "?modelMode=development"), "development");
  assert.equal(at("127.0.0.1", "?modelMode=development"), "development");
  assert.equal(at("[::1]", "?modelMode=development"), "development");
  assert.equal(at("my-space-8080.app.github.dev", "?modelMode=development"), "development");
  assert.equal(at("localhost", ""), "production");
  assert.equal(at("localhost", "?modelMode=dev"), "production");
  assert.equal(at("user.github.io", "?modelMode=development"), "production");
  assert.equal(at("app.github.dev.evil.com", "?modelMode=development"), "production");
  assert.equal(at("evilapp.github.dev", "?modelMode=development"), "production");
  assert.equal(at("localhost.evil.com", "?modelMode=development"), "production");
  assert.equal(at("127.0.0.1.nip.io", "?modelMode=development"), "production");
  assert.equal(at("localhost.", "?modelMode=development"), "production");
  assert.equal(at("localhost", "?modelMode=Development"), "production");
  assert.equal(at("localhost", "?modelmode=development"), "production");
  // The first value wins, so a later "development" cannot override.
  assert.equal(at("localhost", "?modelMode=production&modelMode=development"), "production");
  assert.equal(at("localhost", "?modelMode=development%00"), "production");
  assert.equal(resolveModelUseMode(undefined), "production");
});

test("education host: development mode only on an exactly listed host, and still only when asked", () => {
  const edu = ["yourname.github.io"];
  const at = (hostname, search, hosts = edu) => resolveModelUseMode({ hostname, search }, hosts);
  assert.equal(at("yourname.github.io", "?modelMode=development"), "development");
  assert.equal(at("YourName.GitHub.io", "?modelMode=development"), "development");
  assert.equal(at("yourname.github.io", ""), "production");
  assert.equal(at("yourname.github.io", "?modelMode=dev"), "production");
  assert.equal(at("other.github.io", "?modelMode=development"), "production");
  assert.equal(at("yourname.github.io.evil.com", "?modelMode=development"), "production");
  assert.equal(at("sub.yourname.github.io", "?modelMode=development"), "production");
  assert.equal(at("evil-yourname.github.io", "?modelMode=development"), "production");
  // Without a list (the default) nothing new is allowed.
  assert.equal(at("yourname.github.io", "?modelMode=development", []), "production");
  assert.equal(resolveModelUseMode({ hostname: "yourname.github.io", search: "?modelMode=development" }), "production");
  // Malformed lists never allow anything, and an empty host never matches.
  assert.equal(at("yourname.github.io", "?modelMode=development", "yourname.github.io"), "production");
  assert.equal(at("yourname.github.io", "?modelMode=development", [null, 5, ""]), "production");
  assert.equal(at("", "?modelMode=development", [""]), "production");
  // localhost keeps working whatever the list says.
  assert.equal(at("localhost", "?modelMode=development", []), "development");
});
