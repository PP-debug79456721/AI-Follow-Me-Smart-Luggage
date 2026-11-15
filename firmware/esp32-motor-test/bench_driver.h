// Motor Test hardware driver (M3). THE ONLY FILE THAT TOUCHES HARDWARE.
//
// STATUS: AUTHORED ONLY. NEVER COMPILED, NEVER FLASHED, NEVER RUN. Written against
// the Arduino-ESP32 3.3.12 / ESP-IDF 5.5 API as read from source on the web; the
// shipped sdkconfig and the exact ESP-IDF patch are UNVERIFIED (see README.md).
// Every GPIO assignment is UNVERIFIED (motor_test_config.h, kPinsVerified = false).
//
// Rules this file keeps (static tests in tests/motor-test-driver.test.mjs):
//   * every output latch is set LOW before the pin is switched to OUTPUT;
//   * LEDC is used on the two RPWM pins ONLY, through ledcAttach / ledcWrite
//     ONLY, and every return value is checked; no frequency readback API is used and
//     the PWM frequency is NOT verified at startup (readback returns 0 at duty 0);
//   * no detach, no frequency change, no tone/note/fade/invert/channel API;
//   * the RPWM pins are never written with digitalWrite after they are attached;
//   * the watchdog is configured with reconfigure first and init only as the
//     fallback for ESP_ERR_INVALID_STATE; the loop task is subscribed with
//     esp_task_wdt_add() from loop(); esp_task_wdt_reset() is the only feed;
//   * a failed output write forces everything safe and latches an output fault.
//
// The watchdog is a SOFTWARE containment layer. It is NOT a hardware motor kill.
// The independent kill is the E-stop contact in the relay coil circuit.
#pragma once

#include <Arduino.h>
#include <esp_err.h>
#include <esp_task_wdt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stddef.h>
#include <stdint.h>

#include "bench_session.h"
#include "motor_test_config.h"

namespace mt {

// ---------------------------------------------------------------- driver constants (PROPOSALS, UNMEASURED)

constexpr uint32_t kPwmFreqHz = 5000;           // PROPOSAL: BTS7960 and motor limits not measured
constexpr uint8_t kPwmResolutionBits = 8;       // PROPOSAL
constexpr uint32_t kPwmMaxCount = (1u << kPwmResolutionBits) - 1u;
constexpr uint32_t kWdtTimeoutMs = 1000;        // PROPOSAL: choose from the measured stall test
constexpr uint32_t kWdtIdleCoreMask = 0x01;     // PROPOSAL: core 0 idle watched (confirm against sdkconfig)
constexpr uint32_t kAdcPeriodMs = 10;
constexpr int kAdcOversample = 16;
constexpr uint32_t kSerialBaud = 115200;
constexpr size_t kLineBuf = 40;                 // above Limits::maxLineLen so the parser sees the overrun

constexpr uint32_t pwmCounts(uint32_t pct) { return (pct * kPwmMaxCount + 50u) / 100u; }

static_assert(kPwmFreqHz > 0, "PWM frequency must be set");
static_assert(kPwmResolutionBits >= 6 && kPwmResolutionBits <= 10, "PWM resolution out of range");
static_assert(pwmCounts(kProgramMaxDutyPct) < kPwmMaxCount, "the duty cap must stay far below full-on");
static_assert(Limits{}.dutyCapPct <= kProgramMaxDutyPct, "duty cap above the program ceiling");
static_assert(kWdtTimeoutMs >= 100 && kWdtTimeoutMs <= 5000, "watchdog timeout out of range");
static_assert(Limits{}.maxLineLen < kLineBuf, "line buffer must exceed the parser limit");

enum class StartupError : uint8_t { None, Watchdog, Pwm };
enum class LineEvent : uint8_t { None, Line, Overflow };

class BenchDriver : public BenchOutputs {
 public:
  // ---- 1. FIRST statement of setup(): latch LOW, then enable OUTPUT, for every output.
  // Order: relay, both EN, both LPWM, both RPWM. RPWM pins stay plain GPIO until ledcAttach.
  void latchOutputsLowThenEnable() {
    const int outputs[7] = {kPins.relayEnable, kPins.leftEn, kPins.rightEn,
                            kPins.leftLpwm, kPins.rightLpwm, kPins.leftRpwm, kPins.rightRpwm};
    for (int i = 0; i < 7; i += 1) {
      digitalWrite(outputs[i], LOW);       // latch LOW while the pin is not yet an output
      pinMode(outputs[i], OUTPUT);
      digitalWrite(outputs[i], LOW);       // and again once it is
    }
    cur_ = OutputPlan();
  }

  void beginSerial() { Serial.begin(kSerialBaud); }
  void say(const char* text) { Serial.println(text); }

  // ---- 2. watchdog and PWM. false = startup failure: the caller must stay inert.
  bool startup() {
    pinMode(kPins.estopIn, INPUT_PULLUP);
    pinMode(kPins.resetIn, INPUT_PULLUP);
    pinMode(kPins.vbatAdc, INPUT);
    pinMode(kPins.vbusAdc, INPUT);
    analogReadResolution(12);
    analogSetPinAttenuation(kPins.vbatAdc, ADC_11db);
    analogSetPinAttenuation(kPins.vbusAdc, ADC_11db);

    if (!setupWatchdog()) {
      startupError_ = StartupError::Watchdog;
      return false;
    }
    if (!setupPwm()) {
      startupError_ = StartupError::Pwm;
      return false;
    }
    ready_ = true;
    return true;
  }

  void reportStartup() {
    Serial.print("watchdog branch=");
    Serial.print(wdtBranch_);
    Serial.print(" err=");
    Serial.println(static_cast<int>(wdtErr_));
    Serial.print("startup error=");
    Serial.println(static_cast<int>(startupError_));
    printPwmDiag();
  }

  StartupError startupError() const { return startupError_; }
  bool ready() const { return ready_; }
  bool outputFault() const { return outFault_; }

  // ---- watchdog: subscribe the loop task FROM loop(), feed only after every step succeeded.
  bool subscribeLoopTask() {
    const esp_err_t e = esp_task_wdt_add(xTaskGetCurrentTaskHandle());
    wdtErr_ = e;
    return e == ESP_OK;
  }

  bool feedWatchdog() {
    const esp_err_t e = esp_task_wdt_reset();
    wdtErr_ = e;
    return e == ESP_OK;
  }

  // ---- inputs
  uint32_t nowMs() const { return static_cast<uint32_t>(millis()); }
  bool estopPinHigh() const { return digitalRead(kPins.estopIn) == HIGH; }   // HIGH = pressed or wire open
  bool resetPinLow() const { return digitalRead(kPins.resetIn) == LOW; }

  // One calibrated-millivolt sample per channel every kAdcPeriodMs (median of kAdcOversample).
  // analogReadMilliVolts() has no error channel; a failed read cannot be told from 0 mV.
  bool readAdcIfDue(uint32_t now, AdcSample& bat, AdcSample& bus) {
    if (haveAdc_ && static_cast<uint32_t>(now - lastAdcAt_) < kAdcPeriodMs) return false;
    haveAdc_ = true;
    lastAdcAt_ = now;
    bat.valid = true;
    bat.pinMv = medianMv(kPins.vbatAdc);
    bat.at = now;
    bus.valid = true;
    bus.pinMv = medianMv(kPins.vbusAdc);
    bus.at = now;
    return true;
  }

  LineEvent pollLine(const char*& line, size_t& len) {
    int budget = 64;
    while (budget > 0 && Serial.available() > 0) {
      budget -= 1;
      const int c = Serial.read();
      if (c < 0) break;
      if (c == '\n') {
        const bool over = overflow_;
        const size_t n = n_;
        n_ = 0;
        overflow_ = false;
        if (over) return LineEvent::Overflow;
        buf_[n] = 0;
        line = buf_;
        len = n;
        return LineEvent::Line;
      }
      if (!overflow_) {
        if (n_ < kLineBuf - 1) {
          buf_[n_] = static_cast<char>(c);
          n_ += 1;
        } else {
          overflow_ = true;
        }
      }
    }
    return LineEvent::None;
  }

  void pace() { delay(1); }

  void printStatus(const Session& session) {
    const OutputPlan& p = session.lastPlan();
    Serial.print("state=");
    Serial.print(stateName(session.state()));
    Serial.print(" fault=");
    Serial.print(faultName(session.fault()));
    Serial.print(" relay=");
    Serial.print(p.relayOn ? "ON" : "OFF");
    Serial.print(" L=");
    Serial.print(p.left.en ? p.left.rpwmPct : 0);
    Serial.print(" R=");
    Serial.print(p.right.en ? p.right.rpwmPct : 0);
    Serial.print(" vbat=");
    Serial.print(session.interlock().vbat().volts());
    Serial.print(" vbus=");
    Serial.print(session.interlock().vbus().volts());
    // Read-only diagnostic: raw electrical level of the E-STOP input (GPIO23).
    // HIGH = pressed or wire open; LOW = released and healthy. Changes nothing.
    Serial.print(" estop_pin=");
    Serial.println(estopPinHigh() ? "HIGH" : "LOW");
  }

  void printReply(Reply r) { Serial.println(replyName(r)); }

  // ---- outputs. The single write point of the Session (BenchOutputs).
  // Way down: duty, then EN, then relay. Way up: relay, then EN, then duty.
  void apply(const OutputPlan& p) override {
    if (!ready_ || outFault_) {
      forceSafe();
      return;
    }
    if (!planAcceptable(p)) {
      failSafe();
      return;
    }
    const OutputPlan& c = cur_;

    if (p.left.rpwmPct < c.left.rpwmPct && !setDuty(kPins.leftRpwm, p.left.rpwmPct)) { failSafe(); return; }
    if (p.right.rpwmPct < c.right.rpwmPct && !setDuty(kPins.rightRpwm, p.right.rpwmPct)) { failSafe(); return; }
    if (c.left.en && !p.left.en) digitalWrite(kPins.leftEn, LOW);
    if (c.right.en && !p.right.en) digitalWrite(kPins.rightEn, LOW);
    if (c.relayOn && !p.relayOn) digitalWrite(kPins.relayEnable, LOW);

    if (!c.relayOn && p.relayOn) digitalWrite(kPins.relayEnable, HIGH);
    if (!c.left.en && p.left.en) digitalWrite(kPins.leftEn, HIGH);
    if (!c.right.en && p.right.en) digitalWrite(kPins.rightEn, HIGH);
    if (p.left.rpwmPct > c.left.rpwmPct && !setDuty(kPins.leftRpwm, p.left.rpwmPct)) { failSafe(); return; }
    if (p.right.rpwmPct > c.right.rpwmPct && !setDuty(kPins.rightRpwm, p.right.rpwmPct)) { failSafe(); return; }

    cur_ = p;
  }

  // EN low and relay off first (these cannot fail), then duty 0 on every attached RPWM pin.
  void forceSafe() {
    digitalWrite(kPins.leftEn, LOW);
    digitalWrite(kPins.rightEn, LOW);
    digitalWrite(kPins.relayEnable, LOW);
    if (leftPwm_ && !ledcWrite(kPins.leftRpwm, 0)) outFault_ = true;
    if (rightPwm_ && !ledcWrite(kPins.rightRpwm, 0)) outFault_ = true;
    cur_ = OutputPlan();
  }

 private:
  void failSafe() {
    outFault_ = true;               // latched: the caller stops feeding the watchdog
    forceSafe();
  }

  // Defence in depth: the Session already guarantees this.
  static bool planAcceptable(const OutputPlan& p) {
    if (p.left.lpwmPct != 0 || p.right.lpwmPct != 0) return false;
    if (p.left.en && p.right.en) return false;
    if ((p.left.en || p.right.en) && !p.relayOn) return false;
    if (p.left.rpwmPct > kProgramMaxDutyPct || p.right.rpwmPct > kProgramMaxDutyPct) return false;
    if (p.left.en != (p.left.rpwmPct > 0) || p.right.en != (p.right.rpwmPct > 0)) return false;
    return true;
  }

  static bool setDuty(int rpwmPin, uint8_t pct) {
    if (pct > kProgramMaxDutyPct) return false;
    return ledcWrite(rpwmPin, pwmCounts(pct));
  }

  static float medianMv(int pin) {
    uint32_t v[kAdcOversample];
    for (int i = 0; i < kAdcOversample; i += 1) v[i] = analogReadMilliVolts(pin);
    for (int i = 1; i < kAdcOversample; i += 1) {
      const uint32_t key = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > key) {
        v[j + 1] = v[j];
        j -= 1;
      }
      v[j + 1] = key;
    }
    return (static_cast<float>(v[kAdcOversample / 2 - 1]) + static_cast<float>(v[kAdcOversample / 2])) / 2.0f;
  }

  // Order: reconfigure first; init ONLY when reconfigure says the TWDT is not initialized.
  bool setupWatchdog() {
    esp_task_wdt_config_t cfg = {};
    cfg.timeout_ms = kWdtTimeoutMs;
    cfg.idle_core_mask = kWdtIdleCoreMask;
    cfg.trigger_panic = true;

    esp_err_t e = esp_task_wdt_reconfigure(&cfg);
    if (e == ESP_OK) {
      wdtBranch_ = "reconfigure";
      wdtErr_ = e;
      return true;
    }
    if (e != ESP_ERR_INVALID_STATE) {
      wdtBranch_ = "reconfigure-error";
      wdtErr_ = e;
      return false;
    }
    e = esp_task_wdt_init(&cfg);
    wdtErr_ = e;
    if (e == ESP_OK) {
      wdtBranch_ = "init";
      return true;
    }
    wdtBranch_ = "init-error";
    return false;
  }

  // LEDC on the two RPWM pins only. One frequency and one resolution (one shared timer).
  // The frequency is requested ONCE, in ledcAttach (kPwmFreqHz, kPwmResolutionBits). It is
  // NOT verified by readback: the Core's frequency readback returns 0 while duty is 0, and
  // no duty above 0 and no timer reconfiguration is allowed at startup. Startup passes when
  // both attaches and both duty-0 writes report success. FREQUENCY UNVERIFIED.
  // Diagnostic: pwmRes_[step] records every step (0 = not run, 1 = pass, 2 = fail), so
  // reportStartup() can say which step failed. Failure codes: 1 attach L, 2 attach R,
  // 3 write L, 4 write R. The first failing step still returns false at once.
  bool setupPwm() {
    leftPwm_ = ledcAttach(kPins.leftRpwm, kPwmFreqHz, kPwmResolutionBits);
    rightPwm_ = ledcAttach(kPins.rightRpwm, kPwmFreqHz, kPwmResolutionBits);
    pwmRes_[1] = leftPwm_ ? 1 : 2;
    pwmRes_[2] = rightPwm_ ? 1 : 2;
    if (!leftPwm_ || !rightPwm_) return false;
    // ledcWrite fails on an unattached pin, so writing 0 also proves the attachment.
    pwmRes_[3] = 2;
    if (!ledcWrite(kPins.leftRpwm, 0)) return false;
    pwmRes_[3] = 1;
    pwmRes_[4] = 2;
    if (!ledcWrite(kPins.rightRpwm, 0)) return false;
    pwmRes_[4] = 1;
    return true;
  }

  // 0 = no PWM failure; otherwise the first failing step (see setupPwm).
  uint8_t pwmFailureCode() const {
    for (uint8_t i = 1; i <= 4; i += 1) {
      if (pwmRes_[i] == 2) return i;
    }
    return 0;
  }

  void printPwmStep(uint8_t step, const char* name, int gpio) const {
    Serial.print("pwm step");
    Serial.print(step);
    Serial.print(" ");
    Serial.print(name);
    Serial.print(" gpio=");
    Serial.print(gpio);
    if (pwmRes_[step] == 0) {
      Serial.println(" NOT RUN");
      return;
    }
    Serial.print(" ret=");
    Serial.print(pwmRes_[step] == 1 ? 1 : 0);
    Serial.println(pwmRes_[step] == 1 ? " PASS" : " FAIL");
  }

  void printPwmDiag() const {
    printPwmStep(1, "ledcAttach", kPins.leftRpwm);
    printPwmStep(2, "ledcAttach", kPins.rightRpwm);
    printPwmStep(3, "ledcWrite duty=0", kPins.leftRpwm);
    printPwmStep(4, "ledcWrite duty=0", kPins.rightRpwm);
    Serial.print("pwm requested=");
    Serial.print(kPwmFreqHz);
    Serial.print("Hz/");
    Serial.print(kPwmResolutionBits);
    Serial.println("bit FREQUENCY NOT VERIFIED (no readback at duty 0)");
    Serial.print("pwm failure code=");
    Serial.println(static_cast<int>(pwmFailureCode()));
  }

  OutputPlan cur_;
  bool ready_ = false;
  bool outFault_ = false;
  bool leftPwm_ = false;
  bool rightPwm_ = false;
  StartupError startupError_ = StartupError::None;
  uint8_t pwmRes_[5] = {0, 0, 0, 0, 0};   // index 1..4: 0 not run, 1 pass, 2 fail
  const char* wdtBranch_ = "none";
  esp_err_t wdtErr_ = ESP_OK;

  bool haveAdc_ = false;
  uint32_t lastAdcAt_ = 0;

  char buf_[kLineBuf] = {0};
  size_t n_ = 0;
  bool overflow_ = false;
};

}  // namespace mt
