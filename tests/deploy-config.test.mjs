/*
 * Unit tests for js/deploy-config.js (where the owner features may run).
 *
 * Run from the repository root (Node 18+, no packages needed):
 *
 *     node --test tests/deploy-config.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EDUCATION_HOSTS,
  hostInList,
  ownerHostAllowed,
  ownerFeatureSet
} from "../js/deploy-config.js";

const EDU = ["yourname.github.io"];

test("EDUCATION_HOSTS holds plain host names only (no scheme, path, port, wildcard, upper case)", () => {
  assert.ok(Array.isArray(EDUCATION_HOSTS));
  for (const host of EDUCATION_HOSTS) {
    assert.match(host, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, host);
  }
});

test("hostInList: exact host name, case-insensitive, nothing else", () => {
  assert.equal(hostInList("yourname.github.io", EDU), true);
  assert.equal(hostInList("YourName.GitHub.io", EDU), true);
  assert.equal(hostInList("other.github.io", EDU), false);
  assert.equal(hostInList("yourname.github.io.evil.com", EDU), false);
  assert.equal(hostInList("evil-yourname.github.io", EDU), false);
  assert.equal(hostInList("sub.yourname.github.io", EDU), false);
  assert.equal(hostInList("yourname.github.io.", EDU), false);
  assert.equal(hostInList("", EDU), false);
  assert.equal(hostInList("", [""]), false);
  assert.equal(hostInList(undefined, EDU), false);
  assert.equal(hostInList("yourname.github.io", undefined), false);
  assert.equal(hostInList("yourname.github.io", [null, 5]), false);
});

test("ownerHostAllowed: this computer always, other hosts only when listed", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(ownerHostAllowed(host, []), true, host);
  }
  assert.equal(ownerHostAllowed("192.168.137.158", []), false);
  assert.equal(ownerHostAllowed("yourname.github.io", []), false);
  assert.equal(ownerHostAllowed("yourname.github.io", EDU), true);
  assert.equal(ownerHostAllowed("localhost.evil.com", EDU), false);
});

test("feature set on the laptop (not lite): everything, as before", () => {
  assert.deepEqual(
    { ...ownerFeatureSet({ hostname: "localhost", lite: false, modelsRequested: false, educationHosts: [] }) },
    { clothes: true, face: true, reid: true }
  );
});

test("feature set on a phone (lite): clothes always, Re-ID only when the models were asked for, never face", () => {
  const phone = extra => ({ ...ownerFeatureSet({ hostname: "yourname.github.io", lite: true, educationHosts: EDU, ...extra }) });
  assert.deepEqual(phone({ modelsRequested: false }), { clothes: true, face: false, reid: false });
  assert.deepEqual(phone({ modelsRequested: true }), { clothes: true, face: false, reid: true });
  assert.deepEqual(phone({ modelsRequested: true, search: "?modelMode=development&reid=0" }),
    { clothes: true, face: false, reid: false });
});

test("feature set on a host that is not listed: nothing", () => {
  for (const lite of [true, false]) {
    assert.deepEqual(
      { ...ownerFeatureSet({ hostname: "192.168.137.158", lite, modelsRequested: true, educationHosts: EDU }) },
      { clothes: false, face: false, reid: false }
    );
  }
});

test("?reid=0 switches Re-ID off on the laptop too; other values do not", () => {
  const at = search => ownerFeatureSet({ hostname: "localhost", lite: false, modelsRequested: true, search, educationHosts: [] }).reid;
  assert.equal(at("?reid=0"), false);
  assert.equal(at("?reid=1"), true);
  assert.equal(at("?reid="), true);
  assert.equal(at(""), true);
});
