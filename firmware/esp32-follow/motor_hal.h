// Motor HAL for two BTS7960 drivers (RPWM, LPWM, R_EN, L_EN each).
//
// PHASE 1: PHYSICAL OUTPUT IS PERMANENTLY DISABLED.
// The only implementation here is LockedMotorHal. It contains NO GPIO code,
// no PWM code and no pin configuration. There is no runtime switch, no build
// flag and no message that turns it into a real driver. A real driver would
// be a new class added in a later, separately approved phase (after the
// wiring, level-shift and stall-current checks). This file does NOT make the
// firmware ready for motor operation.
//
// planFor() is pure arithmetic: it says what a real driver WOULD be asked to
// do for a command. Its duty cap defaults to 0, so even a future driver would
// output nothing until a cap is chosen from measurements.
#pragma once

#include <stdint.h>

#include "protocol.h"

namespace follow {

struct HalSide {
  float rpwm = 0;     // duty 0..1
  float lpwm = 0;
  bool rEn = false;
  bool lEn = false;
};

struct HalPlan {
  HalSide left;
  HalSide right;
};

struct DriveConfig {
  float dutyCap = 0;           // 0 = no output at all (UNSET: choose from measurements)
  float turnInnerFraction = 0; // inner wheel duty as a fraction of the outer (UNSET)
};

// STOP: every duty 0 and both enables low (coast; PROPOSAL, brake vs coast is open).
// Movement is always forward-ish: the protocol has no reverse command, so LPWM
// stays 0 and RPWM and LPWM are never both non-zero.
inline HalPlan planFor(Motor command, const DriveConfig& cfg) {
  HalPlan plan;
  if (command == Motor::Stop || cfg.dutyCap <= 0) return plan;

  const float outer = cfg.dutyCap;
  const float inner = cfg.dutyCap * cfg.turnInnerFraction;
  float left = outer;
  float right = outer;
  if (command == Motor::Left) left = inner;
  if (command == Motor::Right) right = inner;

  plan.left.rpwm = left;
  plan.left.rEn = left > 0;
  plan.left.lEn = left > 0;
  plan.right.rpwm = right;
  plan.right.rEn = right > 0;
  plan.right.lEn = right > 0;
  return plan;
}

class MotorHal {
 public:
  virtual ~MotorHal() {}
  // Called ONLY by the SafetyKernel (the single authoritative motor-output writer).
  virtual void write(Motor command) = 0;
  virtual bool physicalOutputEnabled() const = 0;
};

class LockedMotorHal : public MotorHal {
 public:
  static constexpr bool kPhysicalOutputEnabled = false;

  void write(Motor command) override {
    requested_ = command;
    writes_ += 1;
    if (command != Motor::Stop) suppressed_ += 1;   // asked to move, output is locked
  }
  bool physicalOutputEnabled() const override { return kPhysicalOutputEnabled; }

  Motor requested() const { return requested_; }
  uint32_t writes() const { return writes_; }
  uint32_t suppressedMovements() const { return suppressed_; }

 private:
  Motor requested_ = Motor::Stop;
  uint32_t writes_ = 0;
  uint32_t suppressed_ = 0;
};

static_assert(!LockedMotorHal::kPhysicalOutputEnabled,
              "Phase 1: physical motor output must stay disabled");

}  // namespace follow
