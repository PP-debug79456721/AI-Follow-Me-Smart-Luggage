/*
 * Owner user profiles (up to 3, ONE active): storage keys, names, and the
 * "looks more like another user" rule.
 *
 * Profile 1 keeps the original "owner.*" keys (no migration); profiles 2-3
 * use "owner.p2.*" / "owner.p3.*". Settings live in owner.profiles.v1.
 *
 * Pure and DOM-free (no localStorage access here) so it can be unit-tested
 * in Node. ai-owner.js does the storage reads and writes.
 */

export const PROFILE_STORE = "owner.profiles.v1";
export const PROFILE_COUNT = 3;
export const PROFILE_NAME_MAX = 20;

/* Storage key of `base` (an "owner.*" key) for profile index i (0-based). */
export function profileKey(base, i) {
  return i === 0 ? base : base.replace(/^owner\./, `owner.p${i + 1}.`);
}

export function defaultProfileName(i) {
  return `ผู้ใช้ ${i + 1}`;
}

/* Control characters removed, trimmed, at most PROFILE_NAME_MAX; empty -> default. */
export function cleanProfileName(name, i) {
  const t = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PROFILE_NAME_MAX);
  return t || defaultProfileName(i);
}

/* Profile settings from the stored JSON text; anything invalid -> defaults. */
export function parseProfileMeta(text) {
  const meta = {
    active: 0,
    names: Array.from({ length: PROFILE_COUNT }, (_, i) => defaultProfileName(i))
  };
  let raw = null;
  try { raw = JSON.parse(text || "null"); } catch { return meta; }
  if (raw && Number.isInteger(raw.active) && raw.active >= 0 && raw.active < PROFILE_COUNT) meta.active = raw.active;
  if (raw && Array.isArray(raw.names)) meta.names = meta.names.map((n, i) => cleanProfileName(raw.names[i] ?? n, i));
  return meta;
}

/* Best { name, score } among `profiles` (finite scores only), or null. */
export function bestProfileScore(profiles, scoreOf) {
  let best = null;
  for (const p of profiles) {
    const s = scoreOf(p);
    if (Number.isFinite(s) && (!best || s > best.score)) best = { name: p.name, score: s };
  }
  return best;
}

/*
 * True when a person must NOT be chosen for the active profile: another
 * registered profile reaches the threshold and the active profile's own
 * score is not strictly higher (NaN own score counts as not higher).
 */
export function looksLikeOtherProfile(ownScore, other, threshold) {
  return Boolean(other && other.score >= threshold && !(ownScore > other.score));
}
