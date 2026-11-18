/*
 * Where the owner features may run besides this computer.
 *
 * The project is for education (non-commercial). The owner features
 * (REMEMBER CLOTHES, Re-ID, face enrolment) were limited to localhost; to
 * use them from a phone the page must be opened from a public HTTPS host,
 * so that host is named here, in ONE place.
 *
 * EDUCATION_HOSTS is empty by default: nothing changes until a host name is
 * added. Use the exact host name of the deployed page, lower case, without
 * "https://" and without a path, for example:
 *
 *   export const EDUCATION_HOSTS = Object.freeze(["yourname.github.io"]);
 *
 * Every other host is still refused. The recognition models themselves still
 * load only with ?modelMode=development (see embedding/model-policy.js).
 *
 * Pure and DOM-free so it can be unit-tested in Node.
 */
export const EDUCATION_HOSTS = Object.freeze([]);

const LOCAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]", "::1"]);

/* Exact, case-insensitive host name match. No wildcards, no suffix match. */
export function hostInList(hostname, hosts) {
  if (typeof hostname !== "string" || !Array.isArray(hosts)) return false;
  const host = hostname.toLowerCase();
  if (!host) return false;
  return hosts.some(entry => typeof entry === "string" && entry.toLowerCase() === host);
}

/* True on this computer or on a host listed in EDUCATION_HOSTS. */
export function ownerHostAllowed(hostname, educationHosts = EDUCATION_HOSTS) {
  return hostInList(hostname, LOCAL_HOSTS) || hostInList(hostname, educationHosts);
}

/*
 * Which owner features run on this page.
 *   clothes  colour album (no model)                  : any allowed host
 *   face     SFace enrolment / search                 : allowed host, not lite (needs face detection)
 *   reid     OSNet Re-ID                              : allowed host; in lite mode only when the
 *            page asked for the models (modelsRequested), so a phone opened without
 *            ?modelMode=development does not download ONNX Runtime for nothing.
 *            ?reid=0 switches it off (for a phone that gets too slow).
 */
export function ownerFeatureSet({ hostname, lite, modelsRequested, search = "", educationHosts = EDUCATION_HOSTS }) {
  const host = ownerHostAllowed(hostname, educationHosts);
  let reidOff = false;
  try {
    reidOff = new URLSearchParams(search || "").get("reid") === "0";
  } catch {
    reidOff = false;
  }
  return Object.freeze({
    clothes: host,
    face: host && !lite,
    reid: host && !reidOff && (!lite || Boolean(modelsRequested))
  });
}
