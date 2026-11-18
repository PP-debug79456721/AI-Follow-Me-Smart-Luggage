/*
 * Host tests for the ESP32 firmware skeleton (firmware/esp32-follow/).
 *
 *   node --test tests/firmware-host.test.mjs
 *
 * 1. Compiles and runs host/firmware_test.cpp: safety kernel, obstacle interlock, locked
 *    motor HAL plan, WebSocket handshake and frame codec.
 * 2. Syntax-checks esp32-follow.ino and ws_server.h against HOST STUBS of the Arduino
 *    headers. That is NOT a build with the real ESP32 toolchain.
 * 3. Static checks of the PHASE 2 output rules (motor output enabled through BtsMotorHal):
 *    pin APIs only in the motor driver and the sonar sources, one writer (the kernel), the
 *    sketch drives only BtsMotorHal and latches every output LOW first, duty limits and the
 *    driver's stop/fault paths, pins not declared verified, no credentials file committed.
 *
 * Needs a host C++ compiler for 1 and 2 (skipped without one). Installs nothing.
 * Nothing here runs on an ESP32 or proves real-board behavior.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRMWARE = path.join(HERE, "..", "firmware", "esp32-follow");

let compiler = null;
let workDir = null;

before(() => {
  for (const candidate of ["g++", "clang++", "c++"]) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
      compiler = candidate;
      break;
    }
  }
  workDir = mkdtempSync(path.join(tmpdir(), "esp32-follow-host-"));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const noCompiler = () => (compiler ? false : "no C++ compiler");

test("F1 host unit tests: kernel, interlock, motor plan, WebSocket handshake and frames", { skip: noCompiler() }, () => {
  const binary = path.join(workDir, "firmware_test");
  execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-O1", "-o", binary,
    path.join(FIRMWARE, "host", "firmware_test.cpp")], { stdio: "pipe" });
  const result = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /checks=\d+ failures=0/);
  const checks = Number(/checks=(\d+)/.exec(result.stdout)[1]);
  assert.ok(checks >= 100, `only ${checks} checks ran`);
});

test("F2 the sketch and the WebSocket glue pass a syntax check against HOST STUBS (not the real toolchain)", { skip: noCompiler() }, () => {
  execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-fsyntax-only", "-x", "c++",
    "-I", path.join(FIRMWARE, "host", "stubs"), "-I", FIRMWARE, path.join(FIRMWARE, "esp32-follow.ino")], { stdio: "pipe" });
});

/* ---------- static hardware-lock checks ---------- */

function firmwareSources() {
  const files = [];
  for (const name of readdirSync(FIRMWARE)) {
    const full = path.join(FIRMWARE, name);
    if (statSync(full).isFile() && /\.(h|ino|cpp|c)$/.test(name)) files.push(full);
  }
  return files;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

// Pin, PWM and ADC calls. PHASE 2: allowed ONLY in the motor driver and the sonar sources.
const PIN_API = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|ledcSetup|ledcAttach|ledcAttachPin|ledcWrite|ledcDetach|gpio_[a-z_]+|dacWrite|pulseIn|attachInterrupt|touchRead|mcpwm_[a-z_]+|rmt_[a-z_]+)\s*\(/;
const PIN_API_FILES = ["bts_motor_hal.h", "sonar_sources.h"];

function sourceOf(name) {
  return stripComments(readFileSync(path.join(FIRMWARE, name), "utf8"));
}

/* Body of `signature { ... }` (brace matched), or null. */
function bodyOf(code, signature) {
  const start = code.indexOf(signature);
  if (start < 0) return null;
  const open = code.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return code.slice(open + 1, i);
  }
  return null;
}

test("F3 pin APIs appear only in the motor driver and the sonar sources (phase 2)", () => {
  const files = firmwareSources();
  assert.ok(files.length >= 8);
  const users = files
    .filter(file => PIN_API.test(stripComments(readFileSync(file, "utf8"))))
    .map(file => path.basename(file))
    .sort();
  assert.deepEqual(users, PIN_API_FILES, "a new file touches pins: review it and update this list");
});

test("F4 MotorHal implementations are LockedMotorHal and BtsMotorHal; one writer (the safety kernel)", () => {
  const implementations = [];
  const writers = [];

  for (const file of firmwareSources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/class\s+(\w+)\s*:\s*public\s+MotorHal\b/g)) implementations.push(m[1]);
    if (/\bhal\w*\s*\.\s*write\s*\(|\bhal\w*\s*->\s*write\s*\(/.test(code)) writers.push(path.basename(file));
  }

  assert.deepEqual(implementations.sort(), ["BtsMotorHal", "LockedMotorHal"]);
  assert.deepEqual(writers, ["safety.h"], "only the safety kernel writes motor output");

  // The phase-1 locked HAL is kept unchanged as the no-output fallback.
  const hal = readFileSync(path.join(FIRMWARE, "motor_hal.h"), "utf8");
  assert.match(hal, /class LockedMotorHal : public MotorHal/);
  assert.match(hal, /kPhysicalOutputEnabled = false/);
  assert.match(hal, /static_assert\(!LockedMotorHal::kPhysicalOutputEnabled/);
  assert.match(hal, /float dutyCap = 0;/, "the duty cap defaults to no output");
});

test("F5 the sketch drives only BtsMotorHal, latches every output LOW first, and has no unlock switch", () => {
  const sketch = sourceOf("esp32-follow.ino");
  assert.equal((sketch.match(/\b\w*MotorHal\s+\w+\s*;/g) ?? []).join(), "BtsMotorHal hal;", "one HAL instance");

  const setup = bodyOf(sketch, "void setup()");
  assert.ok(setup, "setup() exists");
  assert.match(setup.trim(), /^hal\.latchOutputsLow\(\);/, "the first statement of setup() latches outputs LOW");
  assert.equal(PIN_API.test(sketch), false, "the sketch itself never touches pins");

  assert.equal(/#\s*(if|ifdef|ifndef)\s+\w*(ENABLE|UNLOCK|MOTOR_OUTPUT|FORCE)\w*/i.test(sketch), false);
  for (const file of firmwareSources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(/#\s*define\s+\w*(UNLOCK|ENABLE_MOTOR|MOTOR_ENABLE|FORCE_OUTPUT)\w*/i.test(code), false,
      `${path.basename(file)} defines an unlock switch`);
  }

  // The protocol core offers no way to reach the HAL.
  const protocol = sourceOf("protocol.h");
  assert.equal(/MotorHal/.test(protocol), false, "the protocol core knows nothing about the HAL");
});

test("F6 pins are not declared verified; duty limits are bounded at compile time", () => {
  const config = readFileSync(path.join(FIRMWARE, "config.h"), "utf8");
  assert.match(config, /constexpr bool kPinsVerified = false;/);
  for (const name of ["kLeftDriver", "kRightDriver", "kRelayPin", "kSonar"]) {
    assert.ok(config.split("\n").some(l => l.includes(name) && l.includes("constexpr")), `${name} is declared`);
  }
  const sonar = config.split("\n").find(l => l.includes("kSonar") && l.includes("constexpr"));
  assert.match(sonar, /UNVERIFIED/, "the ultrasonic pins are still marked UNVERIFIED");

  const value = name => Number(new RegExp(`constexpr float ${name} = ([0-9.]+)f;`).exec(config)?.[1]);
  const drive = value("kDriveDuty");
  const max = value("kDutyMax");
  assert.ok(drive > 0 && drive <= max && max <= 0.8, `kDriveDuty ${drive} <= kDutyMax ${max} <= 0.8`);
  assert.match(config, /static_assert\(kDriveDuty > 0 && kDriveDuty <= kDutyMax/);
  assert.match(config, /static_assert\(kDutyMax <= 0\.8f/);
});

test("F6b BtsMotorHal: STOP and faults switch everything off; reverse pin written 0 first", () => {
  const drv = sourceOf("bts_motor_hal.h");

  const write = bodyOf(drv, "void write(Motor command) override");
  assert.match(write, /^\s*if \(!ready_ \|\| fault_\) \{[^}]*allOff\(\);/, "not ready or faulted: all off before anything else");
  assert.match(write, /command == Motor::Stop\)[\s\S]*stopDrives\(\);/, "STOP stops the drives");

  const stop = bodyOf(drv, "void stopDrives()");
  for (const pin of ["kLeftDriver.rpwm", "kLeftDriver.lpwm", "kRightDriver.rpwm", "kRightDriver.lpwm"]) {
    assert.ok(stop.includes(`ledcWrite(${pin}, 0)`), `STOP sets ${pin} to 0`);
  }
  assert.ok(stop.includes("digitalWrite(kLeftDriver.en, LOW)") && stop.includes("digitalWrite(kRightDriver.en, LOW)"),
    "STOP pulls both enables LOW");

  const off = bodyOf(drv, "void allOff()");
  assert.ok(off.includes("digitalWrite(kRelayPin, LOW)"), "all-off also drops the relay");

  const apply = bodyOf(drv, "void applySide(const BtsPins& p, bool invert, float duty)");
  assert.ok(apply.indexOf("ledcWrite(rev, 0)") >= 0 && apply.indexOf("ledcWrite(rev, 0)") < apply.indexOf("ledcWrite(fwd"),
    "reverse pin is set to 0 before the forward pin");
  assert.match(apply, /if \(!ok\) \{\s*fault_ = true;\s*allOff\(\);/, "a failed write latches a fault and switches off");

  const service = bodyOf(drv, "void service()");
  assert.match(service, /^\s*const uint32_t now = millis\(\);\s*if \(!ready_ \|\| fault_\) \{\s*allOff\(\);/,
    "service() keeps everything off while not ready or faulted");
});

function gitTracked(relative) {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", relative], { cwd: path.join(HERE, ".."), encoding: "utf8" });
  return r.status === 0;
}

test("F7 no credentials file is committed beside the sketch and the real one is ignored by git", () => {
  // A local wifi_secrets.h is needed to build; it must never be tracked.
  for (const name of ["wifi_secrets.h", "wifi_secrets"]) {
    assert.equal(gitTracked(`firmware/esp32-follow/${name}`), false, `${name} must not be committed`);
  }
  assert.ok(existsSync(path.join(FIRMWARE, "wifi_secrets.example.h")));
  const ignore = readFileSync(path.join(HERE, "..", ".gitignore"), "utf8");
  assert.match(ignore, /firmware\/esp32-follow\/wifi_secrets\.h/);
  assert.match(ignore, /^firmware\/esp32-follow\/wifi_secrets$/m);
});

test("F8 the kernel keeps the protocol's timer order and the ultrasonic interlock stays outside Protocol v2", () => {
  const safety = stripComments(readFileSync(path.join(FIRMWARE, "safety.h"), "utf8"));
  const tick = /void tick\(double now\) \{([\s\S]*?)\n  \}/.exec(safety)[1];
  assert.ok(tick.indexOf("protocol_.tick") < tick.indexOf("interlock_.update"), "timers first, then the interlock");
  assert.ok(tick.indexOf("interlock_.update") < tick.indexOf("step("), "the single output write comes last");

  // No new wire reason or message type was added for the interlock.
  const protocol = readFileSync(path.join(FIRMWARE, "protocol.h"), "utf8");
  assert.equal(/"INTERLOCK"|"TOO_CLOSE"|"OBSTACLE"/.test(stripComments(protocol)), false);
});
