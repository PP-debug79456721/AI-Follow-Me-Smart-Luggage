/*
 * Unit tests for js/owner-profiles.js (3 user profiles, one active).
 *
 *     node --test tests/owner-profiles.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_STORE,
  PROFILE_COUNT,
  PROFILE_NAME_MAX,
  profileKey,
  defaultProfileName,
  cleanProfileName,
  parseProfileMeta,
  bestProfileScore,
  looksLikeOtherProfile
} from "../js/owner-profiles.js";

test("profile 1 keeps the original keys; profiles 2-3 get owner.p2./owner.p3.", () => {
  assert.equal(PROFILE_STORE, "owner.profiles.v1");
  assert.equal(PROFILE_COUNT, 3);
  assert.equal(profileKey("owner.face.v1", 0), "owner.face.v1");
  assert.equal(profileKey("owner.face.v1", 1), "owner.p2.face.v1");
  assert.equal(profileKey("owner.reid.v1", 2), "owner.p3.reid.v1");
  assert.equal(profileKey("owner.cloth.v2", 1), "owner.p2.cloth.v2");
});

test("the three profiles never share a storage key", () => {
  for (const base of ["owner.face.v1", "owner.reid.v1", "owner.cloth.v2"]) {
    const keys = [0, 1, 2].map(i => profileKey(base, i));
    assert.equal(new Set(keys).size, 3, base);
  }
});

test("names: control characters removed, trimmed, length limited, empty -> default", () => {
  assert.equal(defaultProfileName(0), "ผู้ใช้ 1");
  assert.equal(cleanProfileName("  Test  ", 0), "Test");
  assert.equal(cleanProfileName("A\u0000B\nC\u007f", 0), "ABC");
  assert.equal(cleanProfileName("x".repeat(50), 0).length, PROFILE_NAME_MAX);
  assert.equal(cleanProfileName("", 1), "ผู้ใช้ 2");
  assert.equal(cleanProfileName("   ", 2), "ผู้ใช้ 3");
  assert.equal(cleanProfileName(null, 0), "ผู้ใช้ 1");
  assert.equal(cleanProfileName(undefined, 1), "ผู้ใช้ 2");
});

test("stored settings are read back", () => {
  const meta = parseProfileMeta('{"active":2,"names":["Test","Ann","Bo"]}');
  assert.deepEqual(meta, { active: 2, names: ["Test", "Ann", "Bo"] });
});

test("missing or broken settings fall back to defaults", () => {
  const defaults = { active: 0, names: ["ผู้ใช้ 1", "ผู้ใช้ 2", "ผู้ใช้ 3"] };
  for (const text of [null, "", "null", "{", "[]", "42", '"x"', "{}"]) {
    assert.deepEqual(parseProfileMeta(text), defaults, String(text));
  }
});

test("an out-of-range or non-integer active profile is refused", () => {
  for (const active of [-1, 3, 1.5, "1", null]) {
    assert.equal(parseProfileMeta(JSON.stringify({ active })).active, 0, String(active));
  }
});

test("names are cleaned on load and missing ones get the default", () => {
  const meta = parseProfileMeta(JSON.stringify({ active: 1, names: ["  A\n", ""] }));
  assert.deepEqual(meta.names, ["A", "ผู้ใช้ 2", "ผู้ใช้ 3"]);
  assert.equal(parseProfileMeta(JSON.stringify({ names: ["a", "b", "c", "d"] })).names.length, 3);
});

test("bestProfileScore picks the highest finite score and skips NaN", () => {
  const profiles = [{ name: "A" }, { name: "B" }, { name: "C" }];
  const scores = { A: 0.4, B: NaN, C: 0.7 };
  assert.deepEqual(bestProfileScore(profiles, p => scores[p.name]), { name: "C", score: 0.7 });
  assert.equal(bestProfileScore(profiles, () => NaN), null);
  assert.equal(bestProfileScore([], () => 1), null);
});

test("a person is refused when another profile matches at least as well", () => {
  const t = 0.363;
  assert.equal(looksLikeOtherProfile(0.5, { name: "B", score: 0.6 }, t), true);   // other higher
  assert.equal(looksLikeOtherProfile(0.6, { name: "B", score: 0.6 }, t), true);   // tie -> refuse
  assert.equal(looksLikeOtherProfile(NaN, { name: "B", score: 0.4 }, t), true);   // no own score
  assert.equal(looksLikeOtherProfile(0.7, { name: "B", score: 0.6 }, t), false);  // own higher
  assert.equal(looksLikeOtherProfile(0.1, { name: "B", score: 0.3 }, t), false);  // other below threshold
  assert.equal(looksLikeOtherProfile(0.5, null, t), false);                       // no other profile
});
