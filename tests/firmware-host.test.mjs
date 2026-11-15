/*
 * Host tests for the ESP32 firmware skeleton (firmware/esp32-follow/).
 *
 *   node --test tests/firmware-host.test.mjs
 *
 * 1. Compiles and runs host/firmware_test.cpp: safety kernel, obstacle interlock, locked
 *    motor HAL plan, WebSocket handshake and frame codec.
 * 2. Syntax-checks esp32-follow.ino and ws_server.h against HOST STUBS of the Arduino
 *    headers. That is NOT a build with the real ESP32 toolchain.
 * 3. Static checks of the hardware output lock: no GPIO, PWM or pin API anywhere in the
 *    firmware sources, one MotorHal implementation (locked), one writer (the kernel), pins
 *    still marked UNVERIFIED, no credentials file committed.
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

test("F3 hardware output lock: no GPIO, PWM, ADC or pin API appears anywhere in the firmware sources", () => {
  const forbidden = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|ledcSetup|ledcAttach|ledcAttachPin|ledcWrite|ledcDetach|gpio_[a-z_]+|dacWrite|pulseIn|attachInterrupt|touchRead|mcpwm_[a-z_]+|rmt_[a-z_]+)\s*\(/;
  const files = firmwareSources();
  assert.ok(files.length >= 8);
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(forbidden.test(code), false, `${path.basename(file)} uses a pin API`);
  }
});

test("F4 one MotorHal implementation (locked), one writer (the safety kernel)", () => {
  const files = firmwareSources();
  let implementations = 0;
  const writers = [];

  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    implementations += (code.match(/:\s*public\s+MotorHal\b/g) ?? []).length;
    if (/\bhal\w*\s*\.\s*write\s*\(|\bhal\w*\s*->\s*write\s*\(/.test(code)) writers.push(path.basename(file));
  }

  assert.equal(implementations, 1, "exactly one HAL implementation exists in this phase");
  assert.deepEqual(writers, ["safety.h"], "only the safety kernel writes motor output");

  const hal = readFileSync(path.join(FIRMWARE, "motor_hal.h"), "utf8");
  assert.match(hal, /class LockedMotorHal : public MotorHal/);
  assert.match(hal, /kPhysicalOutputEnabled = false/);
  assert.match(hal, /static_assert\(!LockedMotorHal::kPhysicalOutputEnabled/);
  assert.match(hal, /float dutyCap = 0;/, "the duty cap defaults to no output");
});

test("F5 no runtime or build switch can unlock the output; the sketch uses only the locked HAL", () => {
  const sketch = stripComments(readFileSync(path.join(FIRMWARE, "esp32-follow.ino"), "utf8"));
  assert.match(sketch, /LockedMotorHal hal;/);
  assert.equal(/#\s*(if|ifdef|ifndef)\s+\w*(ENABLE|UNLOCK|MOTOR_OUTPUT|FORCE)\w*/i.test(sketch), false);

  for (const file of firmwareSources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(/#\s*define\s+\w*(UNLOCK|ENABLE_MOTOR|MOTOR_ENABLE|FORCE_OUTPUT)\w*/i.test(code), false,
      `${path.basename(file)} defines an unlock switch`);
  }

  // The protocol core offers no way to ask for physical output either.
  const protocol = stripComments(readFileSync(path.join(FIRMWARE, "protocol.h"), "utf8"));
  assert.equal(/MotorHal/.test(protocol), false, "the protocol core knows nothing about the HAL");
});

test("F6 every GPIO assignment is marked UNVERIFIED and the pins are not declared verified", () => {
  const config = readFileSync(path.join(FIRMWARE, "config.h"), "utf8");
  assert.match(config, /constexpr bool kPinsVerified = false;/);
  for (const name of ["kLeftDriver", "kRightDriver", "kSonar"]) {
    const line = config.split("\n").find(l => l.includes(`${name}`) && l.includes("constexpr"));
    assert.ok(line, `${name} is declared`);
    assert.match(line, /UNVERIFIED/, `${name} is marked UNVERIFIED`);
  }
});

test("F7 no credentials file is committed beside the sketch and the example is ignored by git", () => {
  assert.equal(existsSync(path.join(FIRMWARE, "wifi_secrets.h")), false, "wifi_secrets.h must not exist in the repository");
  assert.ok(existsSync(path.join(FIRMWARE, "wifi_secrets.example.h")));
  const ignore = readFileSync(path.join(HERE, "..", ".gitignore"), "utf8");
  assert.match(ignore, /firmware\/esp32-follow\/wifi_secrets\.h/);
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
