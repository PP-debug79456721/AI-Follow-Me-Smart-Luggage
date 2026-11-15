// Real motor driver for two BTS7960 (IBT-2) boards + a motor-power relay. PHASE 2.
//
// The SafetyKernel stays the ONLY caller of write(). This class only turns the
// kernel's Motor command into pins:
//   STOP            -> every duty 0 and both EN LOW at once (coast). Relay stays on
//                      for kRelayHoldMs, then switches off.
//   FORWARD/LEFT/RIGHT -> relay on (wait kRelaySettleMs if it was off), EN HIGH,
//                      duty ramps UP at kRampPerSecond; any decrease is immediate.
// Only forward movement exists in Protocol v2, so the reverse pin of each side is
// always 0 and both PWM pins of one side are never non-zero together.
//
// Hardware kill independent of this code: the E-STOP switch in the relay coil circuit.
// If an LEDC write fails, the HAL latches a fault and keeps everything off until reboot.
#pragma once

#include <Arduino.h>

#include "config.h"
#include "motor_hal.h"
#include "protocol.h"

namespace follow {

class BtsMotorHal : public MotorHal {
 public:
  // FIRST thing in setup(): every output LOW before it becomes an output.
  void latchOutputsLow() {
    const int outs[3] = {kRelayPin, kLeftDriver.en, kRightDriver.en};
    for (int i = 0; i < 3; i += 1) {
      digitalWrite(outs[i], LOW);
      pinMode(outs[i], OUTPUT);
      digitalWrite(outs[i], LOW);
    }
    const int pwm[4] = {kLeftDriver.rpwm, kLeftDriver.lpwm, kRightDriver.rpwm, kRightDriver.lpwm};
    for (int i = 0; i < 4; i += 1) {
      digitalWrite(pwm[i], LOW);
      pinMode(pwm[i], OUTPUT);
      digitalWrite(pwm[i], LOW);
    }
  }

  // Attach LEDC to all four PWM pins at duty 0. false = stay locked (no output ever).
  bool begin() {
    const int pwm[4] = {kLeftDriver.rpwm, kLeftDriver.lpwm, kRightDriver.rpwm, kRightDriver.lpwm};
    bool ok = true;
    for (int i = 0; i < 4; i += 1) {
      ok = ledcAttach(pwm[i], kPwmFreqHz, kPwmBits) && ok;
      ok = ledcWrite(pwm[i], 0) && ok;
    }
    ready_ = ok;
    if (!ok) fault_ = true;
    allOff();
    return ok;
  }

  // Called ONLY by the SafetyKernel.
  void write(Motor command) override {
    if (!ready_ || fault_) {
      target_ = Motor::Stop;
      allOff();
      return;
    }
    if (command == Motor::Stop) {
      if (target_ != Motor::Stop || curL_ > 0 || curR_ > 0) {
        stopDrives();
        lastMoveEnd_ = millis();
      }
      target_ = Motor::Stop;
      return;
    }
    target_ = command;
    // Decreases apply at once (e.g. FORWARD -> LEFT lowers the left wheel immediately).
    float tl = 0, tr = 0;
    targets(tl, tr);
    if (driving_) {
      if (tl < curL_) { curL_ = tl; applySide(kLeftDriver, kLeftInvert, curL_); }
      if (tr < curR_) { curR_ = tr; applySide(kRightDriver, kRightInvert, curR_); }
    }
  }

  // Call every loop iteration (after the kernel tick).
  void service() {
    const uint32_t now = millis();
    if (!ready_ || fault_) {
      allOff();
      return;
    }

    if (target_ == Motor::Stop) {
      if (relayOn_ && now - lastMoveEnd_ >= kRelayHoldMs) {
        digitalWrite(kRelayPin, LOW);
        relayOn_ = false;
      }
      lastService_ = now;
      return;
    }

    // Movement requested.
    if (!relayOn_) {
      digitalWrite(kRelayPin, HIGH);
      relayOn_ = true;
      relayOnAt_ = now;
    }
    if (now - relayOnAt_ < kRelaySettleMs) {
      lastService_ = now;
      return;
    }
    if (!driving_) {
      digitalWrite(kLeftDriver.en, HIGH);
      digitalWrite(kRightDriver.en, HIGH);
      driving_ = true;
      lastService_ = now;
    }

    float tl = 0, tr = 0;
    targets(tl, tr);
    const float dt = static_cast<float>(now - lastService_) / 1000.0f;
    lastService_ = now;
    const float step = kRampPerSecond * (dt > 0.1f ? 0.1f : dt);
    curL_ = approach(curL_, tl, step);
    curR_ = approach(curR_, tr, step);
    applySide(kLeftDriver, kLeftInvert, curL_);
    applySide(kRightDriver, kRightInvert, curR_);
  }

  bool physicalOutputEnabled() const override { return ready_ && !fault_; }
  bool fault() const { return fault_; }
  bool relayOn() const { return relayOn_; }
  float dutyLeft() const { return curL_; }
  float dutyRight() const { return curR_; }

 private:
  static float clampDuty(float d) { return d < 0 ? 0 : (d > kDutyMax ? kDutyMax : d); }

  void targets(float& l, float& r) const {
    const float outer = clampDuty(kDriveDuty);
    const float inner = outer * kTurnInnerFraction;
    l = outer;
    r = outer;
    if (target_ == Motor::Left) l = inner;
    if (target_ == Motor::Right) r = inner;
    if (target_ == Motor::Stop) l = r = 0;
    l = clampDuty(l * kLeftGain);              // per-wheel compensation (config.h)
    r = clampDuty(r * kRightGain);
  }

  static float approach(float cur, float target, float step) {
    if (target <= cur) return target;                 // slowing down: immediate
    return cur + step >= target ? target : cur + step;
  }

  static uint32_t counts(float duty) {
    const uint32_t maxCount = (1u << kPwmBits) - 1u;
    return static_cast<uint32_t>(clampDuty(duty) * maxCount + 0.5f);
  }

  void applySide(const BtsPins& p, bool invert, float duty) {
    const int fwd = invert ? p.lpwm : p.rpwm;
    const int rev = invert ? p.rpwm : p.lpwm;
    bool ok = ledcWrite(rev, 0);                      // reverse pin first, always 0
    ok = ledcWrite(fwd, counts(duty)) && ok;
    if (!ok) {
      fault_ = true;
      allOff();
    }
  }

  void stopDrives() {
    ledcWrite(kLeftDriver.rpwm, 0);
    ledcWrite(kLeftDriver.lpwm, 0);
    ledcWrite(kRightDriver.rpwm, 0);
    ledcWrite(kRightDriver.lpwm, 0);
    digitalWrite(kLeftDriver.en, LOW);
    digitalWrite(kRightDriver.en, LOW);
    curL_ = curR_ = 0;
    driving_ = false;
  }

  void allOff() {
    digitalWrite(kLeftDriver.en, LOW);
    digitalWrite(kRightDriver.en, LOW);
    digitalWrite(kRelayPin, LOW);
    if (ready_) {
      ledcWrite(kLeftDriver.rpwm, 0);
      ledcWrite(kLeftDriver.lpwm, 0);
      ledcWrite(kRightDriver.rpwm, 0);
      ledcWrite(kRightDriver.lpwm, 0);
    }
    curL_ = curR_ = 0;
    driving_ = false;
    relayOn_ = false;
  }

  bool ready_ = false;
  bool fault_ = false;
  Motor target_ = Motor::Stop;
  bool relayOn_ = false;
  bool driving_ = false;
  uint32_t relayOnAt_ = 0;
  uint32_t lastMoveEnd_ = 0;
  uint32_t lastService_ = 0;
  float curL_ = 0, curR_ = 0;
};

}  // namespace follow
