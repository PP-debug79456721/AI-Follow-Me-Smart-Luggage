// Ultrasonic sources for the obstacle Interlock. PHASE 2.
//
// HcSr04Source: two HC-SR04, measured one at a time (alternating), so they never
//   hear each other's ping. Echo must reach the ESP32 through a 5 V -> 3.3 V divider.
//   Echo never rises    -> NoEcho (dead/unplugged sensor: blocks)
//   Echo rises, no fall -> Clear  (nothing within range)
//   Echo pulse measured -> Distance
//   One measurement blocks the loop for at most ~30 ms.
//
// NoSensorClearSource: used when kUltrasonicInstalled = false. Feeds "Clear" so the
//   interlock does not block. THERE IS NO OBSTACLE PROTECTION in this mode.
#pragma once

#include <Arduino.h>

#include "config.h"
#include "ultrasonic.h"

namespace follow {

class NoSensorClearSource : public UltrasonicSource {
 public:
  bool poll(int sensor, double now, Reading& out) override {
    if (sensor < 0 || sensor >= Interlock::kSensors) return false;
    if (now - last_[sensor] < 50) return false;
    last_[sensor] = now;
    out.status = EchoStatus::Clear;
    out.distanceMm = 0;
    out.at = now;
    return true;
  }

 private:
  double last_[Interlock::kSensors] = {-1000, -1000};
};

class HcSr04Source : public UltrasonicSource {
 public:
  void begin() {
    for (int i = 0; i < Interlock::kSensors; i += 1) {
      digitalWrite(kSonar[i].trig, LOW);
      pinMode(kSonar[i].trig, OUTPUT);
      pinMode(kSonar[i].echo, INPUT);
    }
  }

  bool poll(int sensor, double now, Reading& out) override {
    if (sensor != next_) return false;
    if (now - lastPing_ < kGapMs) return false;
    lastPing_ = now;
    next_ = (next_ + 1) % Interlock::kSensors;
    out = measure(sensor, now);
    return true;
  }

 private:
  static constexpr double kGapMs = 40;          // between pings (one sensor at a time)
  static constexpr uint32_t kRiseTimeoutUs = 3000;
  static constexpr uint32_t kPulseMaxUs = 25000; // ~4.3 m

  Reading measure(int i, double now) {
    Reading r;
    r.at = now;
    const int trig = kSonar[i].trig;
    const int echo = kSonar[i].echo;

    if (digitalRead(echo) == HIGH) {             // still busy / stuck high
      r.status = EchoStatus::NoEcho;
      return r;
    }
    digitalWrite(trig, LOW);
    delayMicroseconds(2);
    digitalWrite(trig, HIGH);
    delayMicroseconds(10);
    digitalWrite(trig, LOW);

    const uint32_t t0 = micros();
    while (digitalRead(echo) == LOW) {
      if (micros() - t0 > kRiseTimeoutUs) {
        r.status = EchoStatus::NoEcho;
        return r;
      }
    }
    const uint32_t rise = micros();
    while (digitalRead(echo) == HIGH) {
      if (micros() - rise > kPulseMaxUs) {
        r.status = EchoStatus::Clear;
        return r;
      }
    }
    const uint32_t width = micros() - rise;
    r.status = EchoStatus::Distance;
    r.distanceMm = width * 343u / 2000u;         // speed of sound 343 m/s, round trip
    return r;
  }

  int next_ = 0;
  double lastPing_ = -1000;
};

}  // namespace follow
