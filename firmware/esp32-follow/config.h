// Firmware configuration.
//
// PHASE 2 (motor output enabled). Pins below match the owner's wiring diagram
// (2x BTS7960 with R_EN+L_EN tied, relay via BC337) and were spun with quick-spin.
// The ultrasonic pins are still PROPOSALS and are only used when
// kUltrasonicInstalled = true.
#pragma once

#include <stdint.h>

namespace follow {

constexpr bool kPinsVerified = false;   // wiring checklist still not recorded

// One BTS7960 board: RPWM, LPWM, and ONE enable pin (R_EN and L_EN tied together,
// 10k pull-down to GND on the board side so the driver is off during boot/reset).
struct BtsPins {
  int rpwm;
  int lpwm;
  int en;
};

struct SonarPins {
  int trig;
  int echo;   // HC-SR04 echo is 5 V: put it behind a divider (e.g. 1k/2k) to 3.3 V
};

// Bench 2026-11-15: the diagram's "left" board (25/26/13) drives the RIGHT wheel.
// LEFT commands turned right, so the assignment is swapped to match the real wheels.
constexpr BtsPins kLeftDriver{27, 14, 33};    // physical LEFT wheel
constexpr BtsPins kRightDriver{25, 26, 13};   // physical RIGHT wheel
constexpr int kRelayPin = 32;                 // BC337 base -> relay coil pin 85

// Forward direction per wheel. false: forward = RPWM. true: forward = LPWM.
// If a wheel turns backwards on FORWARD, flip its flag (or swap M+/M- with power off).
constexpr bool kLeftInvert = false;
constexpr bool kRightInvert = false;

// ---- drive settings (start low, raise in small steps)
constexpr float kDriveDuty = 0.70f;           // outer-wheel duty for FORWARD/LEFT/RIGHT (0..1)
constexpr float kDutyMax = 0.80f;             // hard ceiling, kDriveDuty is clamped to this
constexpr float kTurnInnerFraction = 0.60f;   // inner wheel duty = kDriveDuty * this (0.30 left the inner wheel stalled)
// Per-wheel gain: compensates a weaker motor/gearbox. Raise the SLOWER wheel's gain
// (e.g. 1.10-1.30) until the luggage drives straight on FORWARD. 1.00 = no change.
// The result is still clamped to kDutyMax.
constexpr float kLeftGain = 1.00f;
constexpr float kRightGain = 1.10f;           // bench: right wheel slower even with wheels lifted (1.20 overshot)
constexpr float kRampPerSecond = 2.5f;        // duty change per second when speeding up (soft start)
constexpr uint32_t kPwmFreqHz = 5000;
constexpr uint8_t kPwmBits = 8;
constexpr uint32_t kRelaySettleMs = 250;      // relay on -> wait before enabling the drivers
constexpr uint32_t kRelayHoldMs = 5000;       // keep relay on this long after the last movement

// ---- ultrasonic obstacle interlock
// false: NO obstacle check (sensors not wired yet). The interlock is fed "clear"
//        readings so only STOP/ESTOP/link-loss/timeouts stop the motors.
// true:  two HC-SR04 on kSonar; anything closer than kStopDistanceMm stops the motors.
constexpr bool kUltrasonicInstalled = false;   // sensors NOT wired yet: true with no sensor => NO_ECHO blocks all motion
constexpr SonarPins kSonar[2] = {{18, 34}, {19, 35}};   // PROPOSAL, UNVERIFIED
constexpr uint32_t kStopDistanceMm = 500;

// Network
// Static IP so the app URL never changes (the hotspot's DHCP gave .107, .225, ...).
// Pick an address the hotspot does not hand out to another device. false = DHCP.
constexpr bool kUseStaticIp = false;   // true only on the Windows hotspot 192.168.137.x
constexpr uint8_t kStaticIp[4] = {192, 168, 137, 50};
constexpr uint8_t kGatewayIp[4] = {192, 168, 137, 1};   // the hotspot
constexpr uint8_t kSubnetMask[4] = {255, 255, 255, 0};
constexpr uint16_t kWsPort = 81;
constexpr const char* kWsPath = "/ws";

// Safety kernel loop period target. Must stay far below the two 600 ms protocol timers.
constexpr double kKernelTickMs = 10;

static_assert(kDriveDuty > 0 && kDriveDuty <= kDutyMax, "kDriveDuty must be in (0, kDutyMax]");
static_assert(kDutyMax <= 0.8f, "keep a margin below full power");
static_assert(kLeftGain >= 0.5f && kLeftGain <= 1.5f && kRightGain >= 0.5f && kRightGain <= 1.5f,
              "wheel gains must be in [0.5, 1.5]");
static_assert(kTurnInnerFraction >= 0 && kTurnInnerFraction < 1, "inner fraction must be in [0, 1)");

}  // namespace follow
