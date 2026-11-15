/*
 * Static tests for the Motor Test hardware layer (M3): firmware/esp32-motor-test/bench_driver.h
 * and esp32-motor-test.ino.
 *
 *   node --test tests/motor-test-driver.test.mjs
 *
 * These read the source text only. NOTHING here compiles the driver or the sketch (there is no
 * Arduino-ESP32 here, and compiling is not part of this phase), so they prove the written ORDER and
 * the absence of forbidden calls, NOT that the code builds or behaves on a board.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MT = path.join(HERE, "..", "firmware", "esp32-motor-test");
const DRIVER_FILE = path.join(MT, "bench_driver.h");
const SKETCH_FILE = path.join(MT, "esp32-motor-test.ino");

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const driver = stripComments(readFileSync(DRIVER_FILE, "utf8"));
const sketch = stripComments(readFileSync(SKETCH_FILE, "utf8"));

// Text of the first function whose header matches `header`, by brace matching.
function body(code, header) {
  const start = code.search(header);
  assert.ok(start >= 0, `function not found: ${header}`);
  const open = code.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced braces: ${header}`);
}

const countOf = (code, re) => (code.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;

// True when the call is used as a value: something other than whitespace precedes it in the statement.
function returnValueConsumed(code, callRe) {
  const re = new RegExp(callRe.source, "g");
  let m;
  let any = false;
  while ((m = re.exec(code))) {
    any = true;
    const before = code.slice(0, m.index);
    const stmtStart = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"));
    const prefix = before.slice(stmtStart + 1).trim();
    if (prefix === "") return false;
  }
  return any;
}

/* ---------- M1-M2 files are frozen ---------- */

test("MD1 the M1-M2 sources are byte-identical to the recorded fixture", () => {
  const lock = JSON.parse(readFileSync(path.join(HERE, "fixtures", "motor-test-m1m2.sha256.json"), "utf8")).files;
  assert.equal(Object.keys(lock).length, 4);
  for (const [name, hash] of Object.entries(lock)) {
    const actual = createHash("sha256").update(readFileSync(path.join(MT, name))).digest("hex");
    assert.equal(actual, hash, `M1-M2 file changed: ${name}`);
  }
});

/* ---------- forbidden APIs ---------- */

test("MD2 no detach, no changeFrequency, no frequency readback and no other forbidden LEDC, watchdog or GPIO-reset API", () => {
  const forbidden = /\b(ledcDetach|ledcChangeFrequency|ledcReadFreq|ledcWriteTone|ledcWriteNote|ledcSetClockSource|ledcOutputInvert|ledcFade\w*|ledcAttachChannel|ledcWriteChannel|ledcRead|ledcGetClockSource|analogWrite|gpio_reset_pin|gpio_set_level|gpio_config|esp_task_wdt_delete|esp_task_wdt_deinit|esp_task_wdt_add_user|esp_task_wdt_reset_user|enableLoopWDT|disableLoopWDT|feedLoopWDT|enableCore[01]WDT|disableCore[01]WDT|WiFi\w*|esp_wifi\w*|WebSocket\w*)\b/;
  for (const [name, code] of [["bench_driver.h", driver], ["esp32-motor-test.ino", sketch]]) {
    const hit = code.match(forbidden);
    assert.equal(hit, null, `${name} uses a forbidden API: ${hit && hit[0]}`);
  }
  // the only LEDC functions present
  const used = new Set([...driver.matchAll(/\b(ledc[A-Za-z]*)\s*\(/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["ledcAttach", "ledcWrite"]);
});

/* ---------- GPIO latch ---------- */

test("MD3 every output latch is written LOW before the pin becomes OUTPUT, for relay, both EN and all PWM pins", () => {
  const latch = body(driver, /void latchOutputsLowThenEnable\s*\(\)/);
  for (const pin of ["relayEnable", "leftEn", "rightEn", "leftLpwm", "rightLpwm", "leftRpwm", "rightRpwm"]) {
    assert.match(latch, new RegExp(`kPins\\.${pin}\\b`), `${pin} is covered by the latch`);
  }
  const firstWrite = latch.indexOf("digitalWrite(outputs[i], LOW)");
  const mode = latch.indexOf("pinMode(outputs[i], OUTPUT)");
  const secondWrite = latch.indexOf("digitalWrite(outputs[i], LOW)", mode);
  assert.ok(firstWrite >= 0 && mode > firstWrite && secondWrite > mode, "digitalWrite LOW, pinMode OUTPUT, digitalWrite LOW");
  assert.equal(/digitalWrite\([^)]*HIGH/.test(latch), false, "the latch never writes HIGH");
  assert.match(latch, /for \(int i = 0; i < 7; i \+= 1\)/);
  // it must be the very first statement of setup()
  const setup = body(sketch, /void setup\s*\(\)/);
  assert.ok(setup.replace(/^\{\s*/, "").startsWith("g_drv.latchOutputsLowThenEnable();"), "the latch is the first statement of setup()");
});

test("MD4 LPWM pins are only latched LOW as plain GPIO; RPWM pins are never digitalWrite'n outside the latch", () => {
  assert.equal(countOf(driver, /kPins\.(left|right)Lpwm\b/), 2, "LPWM appears only in the latch list");
  const latch = body(driver, /void latchOutputsLowThenEnable\s*\(\)/);
  assert.equal(countOf(latch, /kPins\.(left|right)Lpwm\b/), 2);
  const withoutLatch = driver.replace(latch, "");
  assert.equal(/digitalWrite\(\s*kPins\.(left|right)Rpwm/.test(withoutLatch), false, "digitalWrite on an RPWM pin");
  assert.equal(/pinMode\(\s*kPins\.(left|right)(Rpwm|Lpwm)/.test(withoutLatch), false);
  for (const m of withoutLatch.matchAll(/digitalWrite\(\s*([^,)]+)\s*,/g)) {
    assert.ok(["kPins.leftEn", "kPins.rightEn", "kPins.relayEnable"].includes(m[1].trim()), `digitalWrite on ${m[1]}`);
  }
});

/* ---------- LEDC ---------- */

test("MD5 LEDC: RPWM pins only, every return value consumed, setup order attach then write, no frequency readback criterion", () => {
  for (const m of driver.matchAll(/\b(ledcAttach|ledcWrite)\(\s*([^,)]+?)\s*[,)]/g)) {
    assert.ok(["kPins.leftRpwm", "kPins.rightRpwm", "rpwmPin"].includes(m[2]), `${m[1]} on ${m[2]}`);
  }
  assert.ok(returnValueConsumed(driver, /\bledcAttach\(/), "ledcAttach result is used");
  assert.ok(returnValueConsumed(driver, /\bledcWrite\(/), "ledcWrite result is used");

  const pwm = body(driver, /bool setupPwm\s*\(\)/);
  const attachL = pwm.indexOf("ledcAttach(kPins.leftRpwm");
  const attachR = pwm.indexOf("ledcAttach(kPins.rightRpwm");
  const writeL = pwm.indexOf("ledcWrite(kPins.leftRpwm, 0)");
  const writeR = pwm.indexOf("ledcWrite(kPins.rightRpwm, 0)");
  assert.ok(attachL >= 0 && attachR > attachL && writeL > attachR && writeR > writeL);
  // the frequency is NOT a startup criterion: no readback or frequency-change API anywhere in the driver
  assert.equal(/\bledc(ReadFreq|ChangeFrequency)\b/.test(driver), false, "no frequency readback or change API in the driver");
  assert.equal(/freqClose|pwmFreq/.test(pwm), false, "setupPwm has no frequency pass/fail check");
  assert.match(driver, /FREQUENCY NOT VERIFIED/, "the diagnostic states the frequency is unverified");
  assert.match(pwm, /return true;\s*\}\s*$/, "setupPwm ends in success after the two duty-0 writes");
  assert.match(pwm, /if \(!ledcWrite\(kPins\.leftRpwm, 0\)\) return false;/);
  assert.match(pwm, /if \(!ledcWrite\(kPins\.rightRpwm, 0\)\) return false;/);
  assert.match(pwm, /kPwmFreqHz, kPwmResolutionBits/, "one frequency and one resolution for both pins");
  assert.equal(countOf(driver, /\bledcAttach\(/), 2);

  // runtime writes: checked, and a failure forces everything safe
  const set = body(driver, /static bool setDuty\s*\(/);
  assert.match(set, /return ledcWrite\(rpwmPin, pwmCounts\(pct\)\);/);
  const apply = body(driver, /void apply\(const OutputPlan& p\) override/);
  assert.equal(countOf(apply, /!setDuty\(/), 4);
  assert.equal(countOf(apply, /failSafe\(\);\s*return;/), 5, "every failed setDuty and an unacceptable plan fail safe");
  const safe = body(driver, /void forceSafe\s*\(\)/);
  assert.match(safe, /if \(leftPwm_ && !ledcWrite\(kPins\.leftRpwm, 0\)\) outFault_ = true;/);
  assert.match(safe, /if \(rightPwm_ && !ledcWrite\(kPins\.rightRpwm, 0\)\) outFault_ = true;/);
  assert.ok(safe.indexOf("kPins.leftEn") < safe.indexOf("ledcWrite") && safe.indexOf("kPins.relayEnable") < safe.indexOf("ledcWrite"),
    "forceSafe drops EN and the relay before touching duty");
  // the duty is never full-on and the cap stays under the program ceiling
  assert.match(driver, /static_assert\(pwmCounts\(kProgramMaxDutyPct\) < kPwmMaxCount/);
  assert.match(driver, /if \(pct > kProgramMaxDutyPct\) return false;/);
});

test("MD6 output ordering: way down is duty, EN, relay; way up is relay, EN, duty", () => {
  const apply = body(driver, /void apply\(const OutputPlan& p\) override/);
  const idx = (s) => {
    const i = apply.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  const dutyDown = idx("p.left.rpwmPct < c.left.rpwmPct");
  const enDown = idx("c.left.en && !p.left.en");
  const relayDown = idx("c.relayOn && !p.relayOn");
  const relayUp = idx("!c.relayOn && p.relayOn");
  const enUp = idx("!c.left.en && p.left.en");
  const dutyUp = idx("p.left.rpwmPct > c.left.rpwmPct");
  assert.ok(dutyDown < enDown && enDown < relayDown && relayDown < relayUp && relayUp < enUp && enUp < dutyUp);
  assert.match(apply, /if \(!ready_ \|\| outFault_\) \{\s*forceSafe\(\);\s*return;\s*\}/, "no output after a latched fault");
  assert.ok(apply.indexOf("planAcceptable(p)") < dutyDown, "the plan is vetted before any write");
  const accept = body(driver, /static bool planAcceptable\(const OutputPlan& p\)/);
  for (const rule of ["lpwmPct != 0", "p.left.en && p.right.en", "!p.relayOn", "kProgramMaxDutyPct"]) {
    assert.ok(accept.includes(rule), `planAcceptable lacks ${rule}`);
  }
});

/* ---------- watchdog ---------- */

test("MD7 watchdog setup: reconfigure first, init only as the ESP_ERR_INVALID_STATE fallback, panic explicit, every return checked", () => {
  const wdt = body(driver, /bool setupWatchdog\s*\(\)/);
  assert.match(wdt, /cfg\.trigger_panic = true;/);
  assert.match(wdt, /cfg\.timeout_ms = kWdtTimeoutMs;/);
  assert.match(wdt, /cfg\.idle_core_mask = kWdtIdleCoreMask;/);
  const reconf = wdt.indexOf("esp_task_wdt_reconfigure(&cfg)");
  const okBranch = wdt.indexOf("if (e == ESP_OK)");
  const otherErr = wdt.indexOf("if (e != ESP_ERR_INVALID_STATE)");
  const init = wdt.indexOf("esp_task_wdt_init(&cfg)");
  assert.ok(reconf >= 0 && okBranch > reconf && otherErr > okBranch && init > otherErr, "order: reconfigure, ok, other-error, init");
  assert.equal(countOf(driver, /\besp_task_wdt_init\(/), 1);
  assert.equal(countOf(driver, /\besp_task_wdt_reconfigure\(/), 1);
  const otherBranch = wdt.slice(otherErr, init);
  assert.match(otherBranch, /return false;/, "any other reconfigure error is a startup failure before init is reached");
  for (const call of [/\besp_task_wdt_reconfigure\(/, /\besp_task_wdt_init\(/, /\besp_task_wdt_add\(/, /\besp_task_wdt_reset\(/]) {
    assert.ok(returnValueConsumed(driver, call), `${call} return value is consumed`);
  }
  const start = body(driver, /bool startup\s*\(\)/);
  assert.ok(start.indexOf("setupWatchdog()") < start.indexOf("setupPwm()"), "watchdog before PWM");
  assert.match(start, /if \(!setupWatchdog\(\)\) \{[\s\S]*?return false;/);
  assert.match(start, /if \(!setupPwm\(\)\) \{[\s\S]*?return false;/);
});

test("MD8 the loop task is subscribed from loop(), the only feed is last, and nothing else touches the watchdog", () => {
  assert.equal(countOf(driver, /\besp_task_wdt_add\(/), 1);
  assert.equal(countOf(driver, /\besp_task_wdt_reset\(/), 1);
  const sub = body(driver, /bool subscribeLoopTask\s*\(\)/);
  assert.match(sub, /esp_task_wdt_add\(xTaskGetCurrentTaskHandle\(\)\)/);
  assert.equal(/esp_task_wdt_add\(\s*(NULL|nullptr|0)\s*\)/.test(driver), false);

  const setup = body(sketch, /void setup\s*\(\)/);
  const loop = body(sketch, /void loop\s*\(\)/);
  assert.equal(setup.includes("subscribeLoopTask"), false, "never subscribed from setup()");
  assert.equal(setup.includes("feedWatchdog"), false);
  assert.equal(countOf(sketch, /\bfeedWatchdog\(/), 1);
  assert.equal(countOf(sketch, /\bsubscribeLoopTask\(/), 1);
  assert.equal(countOf(sketch, /\bsubscribeLoopTask\(/) + countOf(sketch, /\bfeedWatchdog\(/), 2);

  const order = ["subscribeLoopTask()", "readAdcIfDue(", "feedEstop(", "feedReset(", "pollLine(", "g_session->tick(now)", "outputFault()", "feedWatchdog()"];
  let last = -1;
  for (const token of order) {
    const i = loop.indexOf(token);
    assert.ok(i > last, `loop() order: ${token}`);
    last = i;
  }
  // the feed sits behind the output-health check and is followed only by pacing
  const afterFeed = loop.slice(loop.indexOf("feedWatchdog()"));
  assert.equal(/g_session->/.test(afterFeed), false, "no session work after the feed");
  assert.match(loop, /if \(g_drv\.outputFault\(\)\) \{[\s\S]*?Mode::Starved[\s\S]*?return;\s*\}/);
  assert.match(loop, /if \(!g_drv\.feedWatchdog\(\)\) \{[\s\S]*?Mode::Starved[\s\S]*?return;\s*\}/);
  assert.match(loop, /if \(!g_drv\.subscribeLoopTask\(\)\) \{[\s\S]*?Mode::Inert[\s\S]*?return;\s*\}/);
  assert.ok(loop.indexOf("g_subscribed = true") > loop.indexOf("subscribeLoopTask()"));
  // the feed is not reachable in the non-normal modes
  const inert = body(sketch, /void inertLoop\s*\(\)/);
  assert.equal(inert.includes("feedWatchdog"), false);
});

/* ---------- startup failure is inert ---------- */

test("MD9 startup failure stays inert: relay off, EN low, no session, no input, no ARM", () => {
  const setup = body(sketch, /void setup\s*\(\)/);
  const failIdx = setup.indexOf("if (!g_drv.startup())");
  const newIdx = setup.indexOf("g_session = new Session(");
  const beginIdx = setup.indexOf("g_session->begin(");
  assert.ok(failIdx > 0 && newIdx > failIdx && beginIdx > newIdx, "the session exists only after a successful startup");
  const failBranch = setup.slice(failIdx, newIdx);
  assert.match(failBranch, /g_mode = Mode::Inert;/);
  assert.match(failBranch, /g_drv\.forceSafe\(\);/);
  assert.match(failBranch, /return;/);
  assert.equal(/g_session/.test(failBranch), false, "no session in the failure branch");
  assert.ok(setup.indexOf("beginSerial()") < setup.indexOf("startup()"));
  assert.match(setup, /if \(g_session == nullptr\) \{[\s\S]*?Mode::Inert[\s\S]*?return;/);

  const inert = body(sketch, /void inertLoop\s*\(\)/);
  assert.equal(/g_session|onLine|tick|feedEstop|feedReset|feedVbat|feedVbus|pollLine|readAdcIfDue/.test(inert), false,
    "the inert loop never reads input or uses a session");
  assert.match(inert, /g_drv\.forceSafe\(\);/);
  const loop = body(sketch, /void loop\s*\(\)/);
  assert.ok(loop.indexOf("g_mode != Mode::Normal") < loop.indexOf("g_session->"), "non-normal modes return before the session");
  assert.match(loop, /if \(g_mode != Mode::Normal\) \{\s*inertLoop\(\);\s*return;\s*\}/);
  // ARM stays impossible until thresholds are measured
  const th = body(sketch, /Thresholds makeThresholds\s*\(\)/);
  assert.equal(/=\s*[0-9]/.test(th), false, "no threshold value is set in the sketch");
  assert.match(sketch, /new Session\(makeThresholds\(\), Limits\(\), g_drv\)/);
});

/* ---------- scope and honesty ---------- */

test("MD10 hardware vocabulary stays in the driver, the sketch is hardware-free, no Wi-Fi or protocol", () => {
  assert.equal(/\b(Serial|digitalWrite|digitalRead|pinMode|analogRead\w*|millis|delay|ledc\w*|esp_\w+)\b/.test(sketch), false);
  assert.equal(/#\s*include\s*[<"](WiFi|esp_wifi|protocol|ws_|motor_hal|safety|ultrasonic|config)\b/.test(driver + sketch), false);
  assert.equal(/\b(Protocol|WsServer|MotorHal|LockedMotorHal|SafetyKernel)\b/.test(driver + sketch), false);
  const includes = [...driver.matchAll(/#\s*include\s*([<"][^>"]+[>"])/g)].map((m) => m[1]).sort();
  assert.deepEqual(includes, [
    '"bench_session.h"', '"motor_test_config.h"', "<Arduino.h>", "<esp_err.h>", "<esp_task_wdt.h>",
    "<freertos/FreeRTOS.h>", "<freertos/task.h>", "<stddef.h>", "<stdint.h>",
  ].sort());
  assert.equal(/#\s*(if|ifdef|ifndef|define|undef)\b/.test(driver + sketch), false, "no preprocessor switch");
  const raw = readFileSync(DRIVER_FILE, "utf8") + readFileSync(SKETCH_FILE, "utf8");
  assert.match(raw, /NEVER COMPILED, NEVER FLASHED/);
});
