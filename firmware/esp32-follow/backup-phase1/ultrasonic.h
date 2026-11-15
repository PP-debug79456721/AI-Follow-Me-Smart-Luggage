// Ultrasonic interface and obstacle interlock logic. NOT part of Protocol v2.
//
// PHASE 1: no sensor is read. NullUltrasonicSource reports "unavailable", so
// the interlock stays BLOCKED (fail-safe). No pin is touched.
//
// Rules (all fail-safe):
//   - the interlock is blocked until a stop distance is configured (0 = unset);
//   - a sensor that never reported, whose last reading is older than
//     maxReadingAgeMs, or that reports no echo / unavailable, blocks;
//   - a distance at or below stopDistanceMm blocks;
//   - blocking is immediate (one bad reading); clearing needs
//     clearReadingsRequired consecutive good readings on EVERY sensor.
//
// "Clear" (an echo that started but returned nothing) vs "no echo" (the echo
// never started) is how a free path is told from a dead sensor. That
// behavior of the AB043 / HC-SR04 is UNVERIFIED and must be measured.
// maxReadingAgeMs and clearReadingsRequired are PROPOSALS, not measurements.
#pragma once

#include <stdint.h>

namespace follow {

enum class EchoStatus : uint8_t {
  Unavailable,   // no measurement possible
  NoEcho,        // the echo never started: treated as a sensor failure
  Clear,         // the echo started and nothing came back: free path
  Distance       // a distance was measured
};

struct Reading {
  EchoStatus status = EchoStatus::Unavailable;
  uint32_t distanceMm = 0;
  double at = 0;            // device clock, ms
};

enum class BlockReason : uint8_t {
  None, Unconfigured, NoReading, Stale, Unavailable, NoEcho, TooClose, Debouncing
};

inline const char* blockReasonName(BlockReason r) {
  switch (r) {
    case BlockReason::None: return "NONE";
    case BlockReason::Unconfigured: return "UNCONFIGURED";
    case BlockReason::NoReading: return "NO_READING";
    case BlockReason::Stale: return "STALE";
    case BlockReason::Unavailable: return "UNAVAILABLE";
    case BlockReason::NoEcho: return "NO_ECHO";
    case BlockReason::TooClose: return "TOO_CLOSE";
    default: return "DEBOUNCING";
  }
}

struct InterlockConfig {
  uint32_t stopDistanceMm = 0;        // 0 = UNCONFIGURED: always blocked
  double maxReadingAgeMs = 300;       // PROPOSAL
  int clearReadingsRequired = 2;      // PROPOSAL
};

class UltrasonicSource {
 public:
  virtual ~UltrasonicSource() {}
  // Returns true and fills `out` when a new measurement completed for sensor i.
  virtual bool poll(int sensor, double now, Reading& out) = 0;
};

class NullUltrasonicSource : public UltrasonicSource {
 public:
  bool poll(int, double, Reading&) override { return false; }
};

class Interlock {
 public:
  static constexpr int kSensors = 2;

  explicit Interlock(const InterlockConfig& config = InterlockConfig()) : config_(config) {}

  void feed(int sensor, const Reading& reading) {
    if (sensor < 0 || sensor >= kSensors) return;
    Sensor& s = sensors_[sensor];
    s.has = true;
    s.reading = reading;
    if (isGood(reading)) s.good += 1; else s.good = 0;
  }

  // Call before the kernel gates the output (every kernel step).
  void update(double now) {
    reason_ = evaluate(now);
  }

  bool blocked() const { return reason_ != BlockReason::None; }
  BlockReason reason() const { return reason_; }

 private:
  struct Sensor {
    bool has = false;
    Reading reading;
    int good = 0;
  };

  bool isGood(const Reading& r) const {
    if (r.status == EchoStatus::Clear) return true;
    if (r.status == EchoStatus::Distance) return r.distanceMm > config_.stopDistanceMm;
    return false;
  }

  BlockReason evaluate(double now) {
    if (config_.stopDistanceMm == 0) return BlockReason::Unconfigured;

    BlockReason first = BlockReason::None;
    for (int i = 0; i < kSensors; i += 1) {
      Sensor& s = sensors_[i];
      BlockReason r = BlockReason::None;
      if (!s.has) {
        r = BlockReason::NoReading;
      } else if (now - s.reading.at > config_.maxReadingAgeMs) {
        s.good = 0;
        r = BlockReason::Stale;
      } else if (s.reading.status == EchoStatus::Unavailable) {
        r = BlockReason::Unavailable;
      } else if (s.reading.status == EchoStatus::NoEcho) {
        r = BlockReason::NoEcho;
      } else if (s.reading.status == EchoStatus::Distance && s.reading.distanceMm <= config_.stopDistanceMm) {
        r = BlockReason::TooClose;
      } else if (s.good < config_.clearReadingsRequired) {
        r = BlockReason::Debouncing;
      }
      if (first == BlockReason::None) first = r;
    }
    return first;
  }

  InterlockConfig config_;
  Sensor sensors_[kSensors];
  BlockReason reason_ = BlockReason::NoReading;   // blocked from the start
};

}  // namespace follow
