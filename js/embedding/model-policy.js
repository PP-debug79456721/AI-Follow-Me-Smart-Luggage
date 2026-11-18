/*
 * Model load policy (fail-closed).
 *
 * Decides from models/manifest.json whether a model may be loaded, BEFORE
 * any model file is requested. Pure logic: no DOM, no network, no imports,
 * so it can be unit-tested in Node.
 *
 * Manifest schema 2 keeps four separate facts per model (see
 * models/MODEL_METADATA.md), instead of one overloaded "AVAILABLE":
 *   integrity          VERIFIED | NONE        size + SHA-256 recorded from a checked file
 *   localAvailability  NOT_IN_REPOSITORY | NO_VALID_FILE   where the file can exist
 *   distribution       NOT_DISTRIBUTED | DISTRIBUTED       whether the file is published
 *   license.status     VERIFIED | UNVERIFIED | REJECTED | NOT_APPLICABLE
 * plus the decision itself:
 *   use                APPROVED_FOR_PRODUCTION | DEVELOPMENT_ONLY | DISABLED
 *
 * Rules (anything else is refused):
 *   - no manifest, wrong schema, unknown value     -> BLOCKED
 *   - use DISABLED                                 -> NO_MODEL
 *   - an active model (not DISABLED) with license
 *     NOT_APPLICABLE                               -> BLOCKED INVALID_STATUS
 *   - integrity not VERIFIED, or missing / invalid
 *     sizeBytes or sha256, or an invalid file path -> BLOCKED
 *   - production: only use APPROVED_FOR_PRODUCTION with license VERIFIED
 *   - development: also DEVELOPMENT_ONLY (license may be UNVERIFIED)
 *   - license REJECTED                             -> BLOCKED LICENSE_REJECTED
 *                                                     (in every mode)
 */

export const MANIFEST_SCHEMA_VERSION = 2;

export const MODEL_USE = Object.freeze([
  "APPROVED_FOR_PRODUCTION",
  "DEVELOPMENT_ONLY",
  "DISABLED"
]);

export const INTEGRITY = Object.freeze(["VERIFIED", "NONE"]);

export const LOCAL_AVAILABILITY = Object.freeze(["NOT_IN_REPOSITORY", "NO_VALID_FILE"]);

export const DISTRIBUTION = Object.freeze(["NOT_DISTRIBUTED", "DISTRIBUTED"]);

export const LICENSE_STATUS = Object.freeze([
  "VERIFIED",
  "UNVERIFIED",
  "REJECTED",
  "NOT_APPLICABLE"
]);

/* Reasons a model is not loaded (shown to the user as BLOCKED: <reason>). */
export const BLOCK_REASON = Object.freeze({
  NO_MANIFEST: "NO_MANIFEST",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  NO_ENTRY: "NO_ENTRY",
  INVALID_STATUS: "INVALID_STATUS",
  NO_INTEGRITY: "NO_INTEGRITY",
  INVALID_FILE: "INVALID_FILE",
  LICENSE_UNVERIFIED: "LICENSE_UNVERIFIED",
  LICENSE_REJECTED: "LICENSE_REJECTED",
  NOT_APPROVED_FOR_PRODUCTION: "NOT_APPROVED_FOR_PRODUCTION"
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Same-origin relative path under models/, ending in .onnx. Segments are
// [A-Za-z0-9_-]+ only: no ".", "..", "%" (encoded traversal), "\\",
// ":" (schemes), empty segments ("//"), query or fragment.
const FILE_PATTERN = /^models(?:\/[A-Za-z0-9_-]+)+\.onnx$/;

/*
 * "development" only when explicitly asked for (?modelMode=development)
 * on a development host: this machine, a GitHub Codespaces forwarded
 * port, or a host named in extraHosts (the education deployment, see
 * js/deploy-config.js; exact host name match only). Everything else is
 * "production".
 */
export function resolveModelUseMode(location, extraHosts = []) {

  let params;
  try {
    params = new URLSearchParams(location?.search || "");
  } catch {
    return "production";
  }

  if (params.get("modelMode") !== "development") return "production";

  const host = String(location?.hostname || "").toLowerCase();

  const developmentHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".app.github.dev") ||
    (host !== "" && Array.isArray(extraHosts) &&
      extraHosts.some(entry => typeof entry === "string" && entry.toLowerCase() === host));

  return developmentHost ? "development" : "production";
}

/* null when the manifest can be used, else a BLOCK_REASON. */
export function checkManifest(manifest) {

  if (manifest === null || manifest === undefined) return BLOCK_REASON.NO_MANIFEST;

  if (
    typeof manifest !== "object" ||
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !manifest.models ||
    typeof manifest.models !== "object"
  ) {
    return BLOCK_REASON.INVALID_MANIFEST;
  }

  return null;
}

const blocked = reason => ({ allowed: false, state: "BLOCKED", reason });

/*
 * Decision for one model key ("face" / "reid").
 * Returns { allowed: true, file, sizeBytes, sha256, mode, license }
 *      or { allowed: false, state: "BLOCKED" | "NO_MODEL", reason }.
 */
export function decideModelLoad(manifest, key, mode) {

  const manifestProblem = checkManifest(manifest);
  if (manifestProblem) return blocked(manifestProblem);

  if (mode !== "production" && mode !== "development") {
    return blocked(BLOCK_REASON.INVALID_STATUS);
  }

  const entry = manifest.models[key];
  if (!entry || typeof entry !== "object") return blocked(BLOCK_REASON.NO_ENTRY);

  const license = entry.license?.status;

  if (
    !MODEL_USE.includes(entry.use) ||
    !INTEGRITY.includes(entry.integrity) ||
    !LOCAL_AVAILABILITY.includes(entry.localAvailability) ||
    !DISTRIBUTION.includes(entry.distribution) ||
    !LICENSE_STATUS.includes(license)
  ) {
    return blocked(BLOCK_REASON.INVALID_STATUS);
  }

  if (entry.use === "DISABLED") {
    return { allowed: false, state: "NO_MODEL", reason: "DISABLED" };
  }

  // NOT_APPLICABLE only makes sense for a model that is not in use (no
  // model chosen). An active model must state its license.
  if (license === "NOT_APPLICABLE") {
    return blocked(BLOCK_REASON.INVALID_STATUS);
  }

  if (
    entry.integrity !== "VERIFIED" ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes <= 0 ||
    typeof entry.sha256 !== "string" ||
    !SHA256_PATTERN.test(entry.sha256)
  ) {
    return blocked(BLOCK_REASON.NO_INTEGRITY);
  }

  if (typeof entry.file !== "string" || !FILE_PATTERN.test(entry.file) || entry.file.includes("..")) {
    return blocked(BLOCK_REASON.INVALID_FILE);
  }

  // A rejected license never loads, in any mode, whatever "use" says.
  if (license === "REJECTED") return blocked(BLOCK_REASON.LICENSE_REJECTED);

  if (mode === "production") {
    if (entry.use !== "APPROVED_FOR_PRODUCTION") {
      return blocked(BLOCK_REASON.NOT_APPROVED_FOR_PRODUCTION);
    }
    if (license !== "VERIFIED") return blocked(BLOCK_REASON.LICENSE_UNVERIFIED);
  }

  return {
    allowed: true,
    file: entry.file,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    mode,
    license
  };
}
