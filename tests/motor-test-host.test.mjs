/*
 * Host tests for the Motor Test target, phases M1-M2 (firmware/esp32-motor-test/).
 *
 *   node --test tests/motor-test-host.test.mjs
 *
 * 1. Compiles and runs host/motor_test_host.cpp: parser, state machine, interlock, fault
 *    injection and a seeded fuzz, against a SIMULATED plant. This is a HOST compile of pure
 *    logic. It is not a build of the firmware, the .ino or the ESP32 toolchain.
 * 2. Negative compile checks: the compile-time safety locks must reject bad configurations.
 * 3. Static checks: no hardware API anywhere outside bench_driver.h, scope of M1-M2, Motor Test
 *    isolated from the Demo and from Protocol v2 / Wi-Fi / WebSocket, shipped thresholds UNSET.
 * 4. Demo isolation: the Demo sources are byte-identical to the recorded fixture and never
 *    reference the Motor Test.
 *
 * Needs a host C++ compiler for 1 and 2 (skipped without one). Installs nothing.
 * Proves nothing about a real ESP32, relay, BTS7960, ADC or motor.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MT = path.join(HERE, "..", "firmware", "esp32-motor-test");
const DEMO = path.join(HERE, "..", "firmware", "esp32-follow");
const FIXTURE = path.join(HERE, "fixtures", "demo-lock.sha256.json");

let compiler = null;
let workDir = null;

before(() => {
  for (const candidate of ["g++", "clang++", "c++"]) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
      compiler = candidate;
      break;
    }
  }
  workDir = mkdtempSync(path.join(tmpdir(), "esp32-motor-test-host-"));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const noCompiler = () => (compiler ? false : "no host C++ compiler found");

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function walk(dir, filter = () => true) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full, filter));
    else if (filter(full)) files.push(full);
  }
  return files;
}

const mtSources = () => walk(MT, (f) => /\.(h|ino|cpp|c)$/.test(f));

/* ---------- 1. host unit and fault-injection tests ---------- */

test("MT1 host tests: parser, state machine, interlock, fault injection, seeded fuzz", { skip: noCompiler() }, () => {
  const exe = path.join(workDir, "motor_test_host");
  const build = spawnSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", MT,
    path.join(MT, "host", "motor_test_host.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(build.status, 0, `host build failed:\n${build.stderr}`);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, `host tests failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /\d+ checks, 0 failed/);
  assert.equal(/^FAIL/m.test(run.stdout), false);
});

/* ---------- 2. compile-time locks reject bad configuration ---------- */

function compileSnippet(name, body) {
  const file = path.join(workDir, `${name}.cpp`);
  writeFileSync(file, `#include "motor_test_config.h"\nusing namespace mt;\n${body}\nint main() { return 0; }\n`);
  return spawnSync(compiler, ["-std=c++17", "-fsyntax-only", "-I", MT, file], { encoding: "utf8" });
}

test("MT2 compile-time locks: the shipped config compiles, every bad config is rejected", { skip: noCompiler() }, () => {
  const ok = compileSnippet("control", "static_assert(pinsValid(kPins) && limitsValid(Limits{}) && !Thresholds{}.configured(), \"ok\");");
  assert.equal(ok.status, 0, ok.stderr);

  const bad = {
    thresholds_must_be_unset: "static_assert(Thresholds{}.configured(), \"x\");",
    pins_must_stay_unverified: "static_assert(kPinsVerified, \"x\");",
    duty_cap_21: "constexpr Limits mk() { Limits l; l.dutyCapPct = 21; return l; } static_assert(limitsValid(mk()), \"x\");",
    duty_cap_0: "constexpr Limits mk() { Limits l; l.dutyCapPct = 0; return l; } static_assert(limitsValid(mk()), \"x\");",
    lease_too_long: "constexpr Limits mk() { Limits l; l.leaseMs = 3000; return l; } static_assert(limitsValid(mk()), \"x\");",
    arm_total_above_boot_total: "constexpr Limits mk() { Limits l; l.totalPerArmMs = 200000; return l; } static_assert(limitsValid(mk()), \"x\");",
    pin_duplicate: "constexpr PinMap mk() { PinMap m = kPins; m.leftLpwm = m.leftRpwm; return m; } static_assert(pinsValid(mk()), \"x\");",
    output_on_flash_pin: "constexpr PinMap mk() { PinMap m = kPins; m.leftEn = 9; return m; } static_assert(pinsValid(mk()), \"x\");",
    output_on_strapping_pin: "constexpr PinMap mk() { PinMap m = kPins; m.leftEn = 12; return m; } static_assert(pinsValid(mk()), \"x\");",
    output_on_input_only_pin: "constexpr PinMap mk() { PinMap m = kPins; m.rightEn = 34; return m; } static_assert(pinsValid(mk()), \"x\");",
    adc_on_adc2_pin: "constexpr PinMap mk() { PinMap m = kPins; m.vbusAdc = 27; return m; } static_assert(pinsValid(mk()), \"x\");",
    estop_on_input_only_pin: "constexpr PinMap mk() { PinMap m = kPins; m.estopIn = 36; return m; } static_assert(pinsValid(mk()), \"x\");",
    nonexistent_pin: "constexpr PinMap mk() { PinMap m = kPins; m.relayEnable = 24; return m; } static_assert(pinsValid(mk()), \"x\");",
    uart0_pin: "constexpr PinMap mk() { PinMap m = kPins; m.resetIn = 3; return m; } static_assert(pinsValid(mk()), \"x\");",
  };
  for (const [name, body] of Object.entries(bad)) {
    const result = compileSnippet(name, body);
    assert.notEqual(result.status, 0, `${name}: a bad configuration compiled`);
  }
});

/* ---------- 3. static checks ---------- */

test("MT3 no hardware API or hardware header appears anywhere outside bench_driver.h", () => {
  const forbiddenCalls = /\b(pinMode|digitalWrite|digitalRead|analogRead|analogReadMilliVolts|analogWrite|analogSetAttenuation|analogReadResolution|analogSetPinAttenuation|ledc[A-Za-z]*|gpio_[a-z_]+|dacWrite|pulseIn|attachInterrupt|detachInterrupt|touchRead|mcpwm_[a-z_]+|rmt_[a-z_]+|adc[0-9_]*[a-z_]*|esp_task_wdt[a-z_]*|esp_[a-z_]+|delay|delayMicroseconds|millis|micros)\s*\(/;
  const forbiddenNames = /\b(Serial[0-9]?|HardwareSerial|WiFi|SPI|Wire|Arduino|INPUT_PULLUP|OUTPUT|HIGH|LOW)\b/;
  const forbiddenIncludes = /#\s*include\s*[<"](Arduino\.h|WiFi\.h|esp[_a-z0-9]*\.h|driver\/[^>"]*|soc\/[^>"]*|freertos\/[^>"]*|hal\/[^>"]*)[>"]/;
  const files = mtSources().filter((f) => path.basename(f) !== "bench_driver.h" && !f.includes(`${path.sep}host${path.sep}`));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    const name = path.relative(MT, file);
    assert.equal(forbiddenCalls.test(code), false, `${name} calls a hardware or timing API`);
    assert.equal(forbiddenNames.test(code), false, `${name} names a hardware identifier`);
    assert.equal(forbiddenIncludes.test(code), false, `${name} includes a hardware header`);
  }
  // the host test itself is not hardware code either
  const host = stripComments(readFileSync(path.join(MT, "host", "motor_test_host.cpp"), "utf8"));
  assert.equal(forbiddenCalls.test(host.replace(/std::printf|std::strlen|std::strcmp/g, "")), false);
  assert.equal(forbiddenIncludes.test(host), false);
});

test("MT4 scope of M1-M3: exactly the M1-M2 files plus bench_driver.h, the .ino and the README (no M4 files)", () => {
  const names = walk(MT).map((f) => path.relative(MT, f).split(path.sep).join("/")).sort();
  assert.deepEqual(names, [
    "README.md",
    "bench_driver.h",
    "bench_interlock.h",
    "bench_session.h",
    "esp32-motor-test.ino",
    "host/motor_test_host.cpp",
    "motor_test_config.h",
  ]);
});

test("MT5 Motor Test is isolated: no Demo, Protocol v2, Wi-Fi, WebSocket, HAL or FOLLOW reference", () => {
  const allowedIncludes = new Set(["bench_driver.h", "bench_interlock.h", "bench_session.h", "motor_test_config.h"]);
  for (const file of mtSources().filter((f) => !f.includes(`${path.sep}host${path.sep}`))) {
    const code = stripComments(readFileSync(file, "utf8"));
    const name = path.relative(MT, file);
    if (path.basename(file) !== "bench_driver.h") {      // the driver's hardware includes are checked in motor-test-driver.test.mjs
      for (const m of code.matchAll(/#\s*include\s*"([^"]+)"/g)) {
        assert.ok(allowedIncludes.has(m[1]), `${name} includes ${m[1]}`);
      }
      for (const m of code.matchAll(/#\s*include\s*<([^>]+)>/g)) {
        assert.ok(["stdint.h", "stddef.h"].includes(m[1]), `${name} includes <${m[1]}>`);
      }
    }
    assert.equal(/\b(Protocol|WsServer|WebSocket|MotorHal|LockedMotorHal|SafetyKernel|kPhysicalOutputEnabled|follow)\b/i.test(code), false,
      `${name} references Demo or Follow code`);
    assert.equal(/#\s*(if|ifdef|ifndef|define)\b/.test(code.replace(/#\s*pragma once/, "")), false,
      `${name} has a preprocessor switch or macro`);
  }
  const host = readFileSync(path.join(MT, "host", "motor_test_host.cpp"), "utf8");
  assert.equal(/esp32-follow|protocol\.h|motor_hal\.h/.test(host), false);
});

test("MT6 shipped thresholds are all UNSET, pins UNVERIFIED, duty cap 20, one output write point", () => {
  const config = readFileSync(path.join(MT, "motor_test_config.h"), "utf8");
  assert.match(config, /constexpr bool kPinsVerified = false;/);
  assert.match(config, /kProgramMaxDutyPct = 20;/);
  assert.match(config, /uint8_t dutyCapPct = 20;/);
  assert.match(config, /static_assert\(!Thresholds\{\}\.configured\(\)/);

  const struct = config.match(/struct Thresholds \{([\s\S]*?)constexpr bool configured/);
  assert.ok(struct, "Thresholds struct found");
  const inits = [...stripComments(struct[1]).matchAll(/=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(inits.length >= 20, "all threshold fields have initializers");
  for (const value of inits) assert.equal(value, "0", `a shipped threshold default is not 0: ${value}`);

  const pinsBlock = config.match(/constexpr PinMap kPins = \{([\s\S]*?)\};/)[1];
  assert.equal((pinsBlock.match(/UNVERIFIED/g) ?? []).length >= 5, true, "pin rows are marked UNVERIFIED");

  const session = stripComments(readFileSync(path.join(MT, "bench_session.h"), "utf8"));
  assert.equal((session.match(/\bout_\.apply\(/g) ?? []).length, 1, "exactly one call writes the outputs");
  assert.equal((session.match(/relayOn\s*=\s*true/g) ?? []).length, 2, "relay is requested only in planNow()");
  assert.match(session, /planIsSafe\(p, lim_\.dutyCapPct, st_\)/);
});

/* ---------- 4. Demo isolation ---------- */

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Local, git-ignored files that may sit beside the sketch and are not Demo sources.
const DEMO_LOCAL_ONLY = new Set(["wifi_secrets.h"]);

test("MT7 Demo sources are byte-identical to the recorded fixture (no file added, removed or changed)", () => {
  const lock = JSON.parse(readFileSync(FIXTURE, "utf8")).files;
  const actual = {};
  const isLocalOnly = (f) => path.dirname(f) === DEMO && DEMO_LOCAL_ONLY.has(path.basename(f));
  for (const file of walk(DEMO, (f) => !/pastedcontent/.test(path.basename(f)) && !isLocalOnly(f))) {
    actual[path.relative(DEMO, file).split(path.sep).join("/")] = sha256(file);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(lock).sort(), "the Demo file set changed");
  for (const [name, hash] of Object.entries(lock)) assert.equal(actual[name], hash, `Demo file changed: ${name}`);
});

test("MT8 the Demo (phase 2) drives only BtsMotorHal, touches pins only in its driver and sonar, never references the Motor Test", () => {
  const hal = readFileSync(path.join(DEMO, "motor_hal.h"), "utf8");
  assert.match(hal, /class LockedMotorHal : public MotorHal/);
  assert.match(hal, /kPhysicalOutputEnabled = false/);
  assert.match(hal, /static_assert\(!LockedMotorHal::kPhysicalOutputEnabled/);
  assert.match(readFileSync(path.join(DEMO, "config.h"), "utf8"), /constexpr bool kPinsVerified = false;/);
  assert.match(stripComments(readFileSync(path.join(DEMO, "esp32-follow.ino"), "utf8")), /BtsMotorHal hal;/);

  // Phase 2: pin calls are allowed only in the Demo's own driver and sonar sources (top level).
  const pinFiles = new Set(["bts_motor_hal.h", "sonar_sources.h"]);
  const forbiddenCalls = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|ledcSetup|ledcAttach|ledcAttachPin|ledcWrite|gpio_[a-z_]+|dacWrite|pulseIn|attachInterrupt)\s*\(/;
  for (const file of walk(DEMO, (f) => /\.(h|ino|cpp|c)$/.test(f))) {
    if (file.includes(`${path.sep}host${path.sep}`)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    const name = path.relative(DEMO, file);
    const pinsAllowed = path.dirname(file) === DEMO && pinFiles.has(path.basename(file));
    if (!pinsAllowed) assert.equal(forbiddenCalls.test(code), false, `${name} uses a pin API`);
    assert.equal(/esp32-motor-test|motor_test_config|bench_(session|interlock|driver)|\bmt::/.test(readFileSync(file, "utf8")), false,
      `${name} references the Motor Test`);
    assert.equal(/#\s*(if|ifdef|ifndef)\s+\w*(MOTOR_TEST|BENCH|ENABLE_MOTOR|UNLOCK)\w*/i.test(code), false,
      `${name} has a build switch toward motor output`);
  }
});
