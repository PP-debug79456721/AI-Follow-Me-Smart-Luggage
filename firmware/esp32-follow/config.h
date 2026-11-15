// Firmware configuration. EVERY GPIO ASSIGNMENT BELOW IS UNVERIFIED.
//
// The pin numbers are PROPOSALS taken from general ESP32 30-pin references
// (avoid flash pins 6-11, strapping pins 0/2/5/12/15, UART0 1/3; echo inputs
// on input-only 34/35). They have NOT been matched to the NA709 board, the
// CB005 screw terminals or any wiring. Nothing in this phase reads or drives
// them: the motor HAL is locked (motor_hal.h) and the ultrasonic source is a
// null source (ultrasonic.h). kPinsVerified must stay false until each pin is
// confirmed by continuity and a boot-state measurement.
#pragma once

#include <stdint.h>

namespace follow {

constexpr bool kPinsVerified = false;   // do not change without the wiring checklist

struct BtsPins {
  int rpwm;   // PROPOSAL, UNVERIFIED
  int lpwm;
  int rEn;
  int lEn;
};

struct SonarPins {
  int trig;   // PROPOSAL, UNVERIFIED
  int echo;   // input-only pin behind a divider or level shifter (UNVERIFIED)
};

constexpr BtsPins kLeftDriver{25, 26, 27, 13};     // UNVERIFIED
constexpr BtsPins kRightDriver{32, 33, 4, 21};     // UNVERIFIED
constexpr SonarPins kSonar[2] = {{18, 34}, {19, 35}};   // UNVERIFIED

// Network (PROPOSALS)
constexpr uint16_t kWsPort = 81;
constexpr const char* kWsPath = "/ws";

// Safety kernel loop period target (PROPOSAL). Must stay far below the two
// 600 ms protocol timers.
constexpr double kKernelTickMs = 10;

}  // namespace follow
