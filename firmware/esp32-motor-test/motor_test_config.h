// Motor Test target configuration. M1-M2: PURE CONFIG, NO HARDWARE ACCESS.
//
// This header names pins and limits. It calls no pin, PWM, ADC or serial API
// and includes no Arduino header. Only bench_driver.h (M3, not yet written) may
// touch hardware.
//
// EVERY GPIO ASSIGNMENT IS UNVERIFIED. They are the Revision 2 proposal and are
// not matched to the NA709 / CB005 by continuity. kPinsVerified must stay false
// until that is done and recorded.
//
// Two kinds of values:
//   * Thresholds (voltages, calibration, timeouts that depend on the hardware)
//     are UNSET (0) in this file. While any is unset, ARM is refused. They are
//     filled in only from bench measurements.
//   * Limits are protective maxima (duty cap, lease, inactivity, totals). They
//     are PROPOSALS, bounded by compile-time checks below. They can only be
//     made stricter without touching the checks.
#pragma once

#include <stdint.h>

namespace mt {

constexpr bool kPinsVerified = false;   // do not change without the wiring checklist

// ---------------------------------------------------------------- pins

struct PinMap {
  int relayEnable;                          // BC337 base drive (Power Enable)
  int leftRpwm, leftLpwm, leftEn;           // BTS7960 #1, R_EN and L_EN tied
  int rightRpwm, rightLpwm, rightEn;        // BTS7960 #2, R_EN and L_EN tied
  int vbatAdc, vbusAdc;                     // voltage monitoring (ADC1, input-only)
  int estopIn, resetIn;                     // active-low, internal pull-up
  int reserved[4];                          // HC-SR04 pins: NOT used or configured here
};

constexpr PinMap kPins = {
    32,           // relayEnable   UNVERIFIED
    25, 26, 13,   // left          UNVERIFIED
    27, 14, 33,   // right         UNVERIFIED
    35, 34,       // vbat, vbus    UNVERIFIED
    23, 22,       // estop, reset  UNVERIFIED
    {18, 19, 4, 21}  // reserved (ultrasonic); never touched by Motor Test
};

constexpr int kPinCount = 15;

constexpr int pinAt(const PinMap& m, int i) {
  return i == 0 ? m.relayEnable
       : i == 1 ? m.leftRpwm : i == 2 ? m.leftLpwm : i == 3 ? m.leftEn
       : i == 4 ? m.rightRpwm : i == 5 ? m.rightLpwm : i == 6 ? m.rightEn
       : i == 7 ? m.vbatAdc : i == 8 ? m.vbusAdc
       : i == 9 ? m.estopIn : i == 10 ? m.resetIn
       : m.reserved[i - 11];
}

constexpr bool isFlashPin(int p) { return p >= 6 && p <= 11; }
constexpr bool isUart0Pin(int p) { return p == 1 || p == 3; }
constexpr bool isStrappingPin(int p) { return p == 0 || p == 2 || p == 5 || p == 12 || p == 15; }
constexpr bool isInputOnlyPin(int p) { return p >= 34 && p <= 39; }
constexpr bool isAdc1Pin(int p) { return p >= 32 && p <= 39; }
constexpr bool isExistingGpio(int p) {
  return (p >= 0 && p <= 19) || (p >= 21 && p <= 23) || (p >= 25 && p <= 27) || (p >= 32 && p <= 39);
}

constexpr bool isDriveOutput(int p) {
  return isExistingGpio(p) && !isFlashPin(p) && !isUart0Pin(p) && !isStrappingPin(p) && !isInputOnlyPin(p);
}

constexpr bool pinsValid(const PinMap& m) {
  // every pin exists, none is a flash or UART0 pin
  for (int i = 0; i < kPinCount; i += 1) {
    const int p = pinAt(m, i);
    if (!isExistingGpio(p) || isFlashPin(p) || isUart0Pin(p)) return false;
  }
  // all distinct
  for (int i = 0; i < kPinCount; i += 1) {
    for (int j = i + 1; j < kPinCount; j += 1) {
      if (pinAt(m, i) == pinAt(m, j)) return false;
    }
  }
  // outputs: output-capable, not strapping, not input-only
  for (int i = 0; i <= 6; i += 1) {
    if (!isDriveOutput(pinAt(m, i))) return false;
  }
  // ADC inputs: ADC1 only
  if (!isAdc1Pin(m.vbatAdc) || !isAdc1Pin(m.vbusAdc)) return false;
  // digital inputs need the internal pull-up: not input-only, not strapping
  if (isInputOnlyPin(m.estopIn) || isStrappingPin(m.estopIn)) return false;
  if (isInputOnlyPin(m.resetIn) || isStrappingPin(m.resetIn)) return false;
  return true;
}

static_assert(pinsValid(kPins), "Motor Test pin map violates a pin rule (flash/strapping/input-only/duplicate)");
static_assert(!kPinsVerified, "pins are UNVERIFIED; do not set kPinsVerified without the wiring checklist");

// ---------------------------------------------------------------- limits

constexpr uint8_t kProgramMaxDutyPct = 20;   // initial program ceiling (decision 1)

struct Limits {
  uint8_t dutyCapPct = 20;            // percent; l/r accept 1..cap
  uint32_t leaseMs = 1000;            // one l/r command runs this long unless refreshed
  uint32_t maxContinuousMs = 5000;    // one motor run, however often refreshed
  uint32_t inactivityMs = 30000;      // no accepted command while ARMED: DISARM
  uint32_t totalPerArmMs = 30000;     // cumulative motor-on time per ARM
  uint32_t totalPerBootMs = 120000;   // cumulative motor-on time per boot
  uint32_t restartGapMs = 300;        // coast time between any stop and the next start
  uint32_t maxTickGapMs = 250;        // longer gap between ticks = loop stall
  uint32_t bootSampleTimeoutMs = 2000;// ADC must report within this after boot
  uint32_t estopDebounceMs = 50;      // release must be stable this long
  uint32_t resetDebounceMs = 50;      // press must be stable this long
  uint8_t maxLineLen = 32;
};

constexpr bool limitsValid(const Limits& l) {
  return l.dutyCapPct >= 1 && l.dutyCapPct <= kProgramMaxDutyPct
      && l.leaseMs >= 100 && l.leaseMs <= 2000
      && l.maxContinuousMs >= l.leaseMs && l.maxContinuousMs <= 10000
      && l.inactivityMs >= 1000 && l.inactivityMs <= 60000
      && l.totalPerArmMs >= l.maxContinuousMs && l.totalPerArmMs <= l.totalPerBootMs
      && l.totalPerBootMs <= 600000
      && l.restartGapMs >= 100 && l.restartGapMs <= 5000
      && l.maxTickGapMs >= 50 && l.maxTickGapMs <= 1000
      && l.bootSampleTimeoutMs >= 100 && l.bootSampleTimeoutMs <= 10000
      && l.estopDebounceMs >= 10 && l.estopDebounceMs <= 200
      && l.resetDebounceMs >= 10 && l.resetDebounceMs <= 200
      && l.maxLineLen >= 8 && l.maxLineLen <= 64;
}

static_assert(limitsValid(Limits{}), "shipped Motor Test limits violate their own bounds");

// ---------------------------------------------------------------- thresholds (UNSET until measured)

struct Thresholds {
  // pin millivolts -> volts: volts = pinMv * scale + offsetV. scale is the divider
  // ratio times the DMM calibration gain. 0 = UNSET.
  float vbatScaleVPerMv = 0;
  float vbatOffsetV = 0;
  float vbusScaleVPerMv = 0;
  float vbusOffsetV = 0;
  float adcFloorMv = 0;        // at or below: "zero" reading
  float adcSatMv = 0;          // at or above: saturated reading
  float vbatArmMinV = 0;
  float vbatArmMaxV = 0;
  float vbatFaultMaxV = 0;     // above while armed: FAULT
  float vbatStopMinV = 0;      // below while armed: FAULT
  float busOffV = 0;           // bus below this is "off"
  float busOnTolFrac = 0;      // bus ~ battery tolerance (fraction)
  float busOnTolMinV = 0;      // ... or at least this many volts
  float busSagFrac = 0;        // bus below this fraction of battery: FAULT
  float crossCheckFrac = 0;    // idle disagreement bus vs battery: FAULT
  float agreeFrac = 0;         // 5 samples agree within this fraction ...
  float agreeFloorV = 0;       // ... or this many volts
  uint32_t riseTimeoutMs = 0;  // relay command to confirmed bus rise
  uint32_t riseStableMs = 0;   // bus must stay near battery this long
  uint32_t settleTimeoutMs = 0;// relay off to bus below busOffV
  uint32_t staleMs = 0;        // a sample older than this is stale

  constexpr bool configured() const {
    return vbatScaleVPerMv > 0 && vbusScaleVPerMv > 0
        && adcFloorMv > 0 && adcSatMv > 0
        && vbatArmMinV > 0 && vbatArmMaxV > 0 && vbatFaultMaxV > 0 && vbatStopMinV > 0
        && busOffV > 0 && busOnTolFrac > 0 && busOnTolMinV > 0 && busSagFrac > 0
        && crossCheckFrac > 0 && agreeFrac > 0 && agreeFloorV > 0
        && riseTimeoutMs > 0 && riseStableMs > 0 && settleTimeoutMs > 0 && staleMs > 0;
  }

  // Meaningful only when configured(). An inconsistent set is treated as unset.
  constexpr bool consistent() const {
    return adcFloorMv < adcSatMv
        && vbatStopMinV <= vbatArmMinV && vbatArmMinV < vbatArmMaxV && vbatArmMaxV <= vbatFaultMaxV
        && busOffV < vbatStopMinV
        && busOnTolFrac < 1 && busSagFrac < 1 && crossCheckFrac < 1 && agreeFrac < 1
        && riseStableMs < riseTimeoutMs;
  }
};

static_assert(!Thresholds{}.configured(), "shipped Motor Test thresholds must be UNSET (ARM refused until measured)");

}  // namespace mt
