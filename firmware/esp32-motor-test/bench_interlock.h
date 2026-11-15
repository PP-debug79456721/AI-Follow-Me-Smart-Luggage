// Motor Test interlock: PURE LOGIC. No hardware access, no Arduino header.
//
// Judges what the relay and the two voltage monitors report, and the E-stop and
// reset inputs. The driver (M3, later) feeds raw values; this decides.
//
// Fail-safe rules:
//   * An ADC that fails, saturates or reads zero is never "safe". Zero is
//     tolerated only for the motor bus while the relay is OFF (a dead bus
//     legitimately reads ~0); it can never prove anything: the proof that the
//     bus sensor lives is the rise at ARM.
//   * No decision rests on one reading: ARM needs 5 agreeing samples, a fault
//     needs 3 consecutive bad samples, a rise needs 3 good samples plus a stable
//     window.
//   * E-STOP input never read, an invalid read, or a HIGH level (pressed or wire
//     open) is E-STOP. Release needs a stable LOW. Releasing never arms.
//   * Reset fires only on a fresh press, after the button was seen released
//     since boot, and never while held or stuck low.
#pragma once

#include <stdint.h>

#include "motor_test_config.h"

namespace mt {

enum class AdcQuality : uint8_t { None, Ok, Zero, Saturated, ReadFail };

struct AdcSample {
  bool valid = false;     // false: the read itself failed
  float pinMv = 0;        // calibrated millivolts at the ADC pin
  uint32_t at = 0;        // device clock, ms
};

enum class Fault : uint8_t {
  None, Config, BootSensor, BusLiveAtBoot, BusLiveRelayOff, WeldedContact, NoRise, BusLost,
  BusSag, CrossCheck, SensorBat, SensorBus, StaleBat, StaleBus, BatLow, BatHigh, LoopStall,
  OutputInvariant
};

inline const char* faultName(Fault f) {
  switch (f) {
    case Fault::None: return "NONE";
    case Fault::Config: return "CONFIG";
    case Fault::BootSensor: return "BOOT_SENSOR";
    case Fault::BusLiveAtBoot: return "BUS_LIVE_AT_BOOT";
    case Fault::BusLiveRelayOff: return "BUS_LIVE_RELAY_OFF";
    case Fault::WeldedContact: return "WELDED_CONTACT";
    case Fault::NoRise: return "NO_RISE";
    case Fault::BusLost: return "BUS_LOST";
    case Fault::BusSag: return "BUS_SAG";
    case Fault::CrossCheck: return "CROSS_CHECK";
    case Fault::SensorBat: return "SENSOR_BAT";
    case Fault::SensorBus: return "SENSOR_BUS";
    case Fault::StaleBat: return "STALE_BAT";
    case Fault::StaleBus: return "STALE_BUS";
    case Fault::BatLow: return "BAT_LOW";
    case Fault::BatHigh: return "BAT_HIGH";
    case Fault::LoopStall: return "LOOP_STALL";
    default: return "OUTPUT_INVARIANT";
  }
}

// Faults that a Reset may clear (when the safe conditions hold). Config cannot be
// cleared by a button; OutputInvariant is an internal error and needs a power cycle.
inline bool faultRecoverable(Fault f) { return f != Fault::Config && f != Fault::OutputInvariant; }

enum class ArmCheck : uint8_t { Ok, Config, Estop, NotSettled, BatInvalid, BatRange, BusInvalid, BusLive };

inline const char* armCheckName(ArmCheck a) {
  switch (a) {
    case ArmCheck::Ok: return "OK";
    case ArmCheck::Config: return "CONFIG_UNSET";
    case ArmCheck::Estop: return "ESTOP";
    case ArmCheck::NotSettled: return "BUS_NOT_SETTLED";
    case ArmCheck::BatInvalid: return "BAT_INVALID";
    case ArmCheck::BatRange: return "BAT_RANGE";
    case ArmCheck::BusInvalid: return "BUS_INVALID";
    default: return "BUS_LIVE";
  }
}

// What the interlock believes the relay path is doing. Boot: relay state unknown,
// bus not yet proven off.
enum class RelayPhase : uint8_t { Boot, Off, TurningOn, On, TurningOff };

inline float absf(float x) { return x < 0 ? -x : x; }

class AdcChannel {
 public:
  static constexpr int kN = 5;

  void feed(const AdcSample& s, float scale, float offsetV, const Thresholds& th) {
    seq_ += 1;
    has_ = true;
    at_ = s.at;
    if (!s.valid || !(s.pinMv == s.pinMv)) {
      q_ = AdcQuality::ReadFail;
    } else if (s.pinMv >= th.adcSatMv) {
      q_ = AdcQuality::Saturated;
    } else if (s.pinMv <= th.adcFloorMv) {
      q_ = AdcQuality::Zero;
    } else {
      q_ = AdcQuality::Ok;
    }
    if (q_ == AdcQuality::Ok || q_ == AdcQuality::Zero) {
      v_ = s.pinMv * scale + offsetV;
      for (int i = 0; i < kN - 1; i += 1) h_[i] = h_[i + 1];
      h_[kN - 1] = v_;
      if (n_ < kN) n_ += 1;
    } else {
      v_ = 0;
      n_ = 0;               // a bad sample breaks agreement
    }
  }

  AdcQuality quality() const { return q_; }
  float volts() const { return v_; }
  uint32_t seq() const { return seq_; }

  bool fresh(uint32_t now, uint32_t staleMs) const {
    if (!has_) return false;
    const int32_t age = static_cast<int32_t>(now - at_);
    return age <= static_cast<int32_t>(staleMs);
  }

  bool agreeing(const Thresholds& th) const {
    if (n_ < kN) return false;
    float mn = h_[0], mx = h_[0], sum = 0;
    for (int i = 0; i < kN; i += 1) {
      if (h_[i] < mn) mn = h_[i];
      if (h_[i] > mx) mx = h_[i];
      sum += h_[i];
    }
    float tol = th.agreeFrac * (sum / kN);
    if (tol < th.agreeFloorV) tol = th.agreeFloorV;
    return (mx - mn) <= tol;
  }

 private:
  AdcQuality q_ = AdcQuality::None;
  float v_ = 0;
  uint32_t at_ = 0;
  uint32_t seq_ = 0;
  bool has_ = false;
  float h_[kN] = {0, 0, 0, 0, 0};
  int n_ = 0;
};

struct Verdict {
  Fault fault = Fault::None;
};

class Interlock {
 public:
  static constexpr uint8_t kConfirmSamples = 3;

  Interlock(const Thresholds& th, const Limits& lim) : th_(th), lim_(lim) {}

  bool configured() const { return th_.configured() && th_.consistent(); }

  void feedVbat(const AdcSample& s) { bat_.feed(s, th_.vbatScaleVPerMv, th_.vbatOffsetV, th_); }
  void feedVbus(const AdcSample& s) { bus_.feed(s, th_.vbusScaleVPerMv, th_.vbusOffsetV, th_); }

  // E-stop NC2 to GND, internal pull-up: LOW = released and healthy. A pin that is
  // invalid, never read, HIGH (pressed) or open-circuit (pulled HIGH) is E-STOP.
  void feedEstop(uint32_t now, bool valid, bool pinHigh) {
    if (!valid || pinHigh) {
      estop_ = true;
      relSet_ = false;
      return;
    }
    if (!relSet_) {
      relSet_ = true;
      relSince_ = now;
    }
    if (estop_ && static_cast<uint32_t>(now - relSince_) >= lim_.estopDebounceMs) estop_ = false;
  }
  bool estopActive() const { return estop_; }

  // Reset button to GND. Fires once per fresh press, only after the button has
  // been seen released since boot. Held at boot, stuck low or invalid: never.
  void feedReset(uint32_t now, bool valid, bool pinLow) {
    if (!valid) {
      seenReleased_ = false;
      pressing_ = false;
      rstRelSet_ = false;
      return;
    }
    if (!pinLow) {
      if (!rstRelSet_) {
        rstRelSet_ = true;
        rstRelFrom_ = now;
      }
      if (static_cast<uint32_t>(now - rstRelFrom_) >= lim_.resetDebounceMs) seenReleased_ = true;
      pressing_ = false;
      fired_ = false;
      return;
    }
    rstRelSet_ = false;
    if (!pressing_) {
      pressing_ = true;
      pressStart_ = now;
      fired_ = false;
    }
    if (seenReleased_ && !fired_ && static_cast<uint32_t>(now - pressStart_) >= lim_.resetDebounceMs) {
      fired_ = true;
      resetEvent_ = true;
    }
  }
  bool takeResetEvent() {
    const bool e = resetEvent_;
    resetEvent_ = false;
    return e;
  }

  RelayPhase phase() const { return phase_; }
  bool relayConfirmedOn() const { return phase_ == RelayPhase::On; }
  const AdcChannel& vbat() const { return bat_; }
  const AdcChannel& vbus() const { return bus_; }

  void relayCommandedOn(uint32_t now) {
    phase_ = RelayPhase::TurningOn;
    onAt_ = now;
    stableActive_ = false;
    nearCount_ = 0;
    resetTrackers();
  }

  void relayCommandedOff(uint32_t now) {
    if (phase_ == RelayPhase::On || phase_ == RelayPhase::TurningOn) {
      phase_ = RelayPhase::TurningOff;
      offAt_ = now;
      lowRun_ = 0;
      resetTrackers();
    }
  }

  // Everything that must hold before the relay may be commanded on.
  ArmCheck preArm(uint32_t now) const {
    if (!configured()) return ArmCheck::Config;
    if (estop_) return ArmCheck::Estop;
    if (phase_ != RelayPhase::Off) return ArmCheck::NotSettled;
    if (!bat_.fresh(now, th_.staleMs) || bat_.quality() != AdcQuality::Ok || !bat_.agreeing(th_)) {
      return ArmCheck::BatInvalid;
    }
    if (bat_.volts() < th_.vbatArmMinV || bat_.volts() > th_.vbatArmMaxV) return ArmCheck::BatRange;
    const bool busReadable = bus_.quality() == AdcQuality::Ok || bus_.quality() == AdcQuality::Zero;
    if (!bus_.fresh(now, th_.staleMs) || !busReadable || !bus_.agreeing(th_)) return ArmCheck::BusInvalid;
    if (bus_.volts() >= th_.busOffV) return ArmCheck::BusLive;
    return ArmCheck::Ok;
  }

  // Call every tick, after feeding. loadActive: a motor is being driven (bus sag allowed).
  Verdict update(uint32_t now, bool loadActive) {
    Verdict v;
    if (!configured()) return v;

    const bool newBat = bat_.seq() != batSeen_;
    const bool newBus = bus_.seq() != busSeen_;
    batSeen_ = bat_.seq();
    busSeen_ = bus_.seq();

    switch (phase_) {
      case RelayPhase::Boot:
      case RelayPhase::Off: {
        batT_.step(Fault::None, kConfirmSamples);
        if (newBus) {
          Fault cand = Fault::None;
          const AdcQuality q = bus_.quality();
          if (q == AdcQuality::Saturated || (q == AdcQuality::Ok && bus_.volts() >= th_.busOffV)) {
            cand = phase_ == RelayPhase::Boot ? Fault::BusLiveAtBoot : Fault::BusLiveRelayOff;
          }
          v.fault = busT_.step(cand, kConfirmSamples);
        }
        if (phase_ == RelayPhase::Boot && v.fault == Fault::None && bus_.agreeing(th_) &&
            bus_.volts() < th_.busOffV) {
          phase_ = RelayPhase::Off;
        }
        break;
      }

      case RelayPhase::TurningOn: {
        v.fault = batChecks(now, newBat);
        if (v.fault != Fault::None) break;
        const bool both = bat_.fresh(now, th_.staleMs) && bus_.fresh(now, th_.staleMs);
        const bool near = both && bat_.quality() == AdcQuality::Ok && bus_.quality() == AdcQuality::Ok &&
                          absf(bus_.volts() - bat_.volts()) <= tolerance();
        if (newBus) nearCount_ = near ? (nearCount_ < 255 ? nearCount_ + 1 : 255) : 0;
        if (near) {
          if (!stableActive_) {
            stableActive_ = true;
            stableSince_ = now;
          }
        } else {
          stableActive_ = false;
        }
        if (stableActive_ && nearCount_ >= kConfirmSamples &&
            static_cast<uint32_t>(now - stableSince_) >= th_.riseStableMs) {
          phase_ = RelayPhase::On;
          busT_.step(Fault::None, kConfirmSamples);
          break;
        }
        if (static_cast<uint32_t>(now - onAt_) >= th_.riseTimeoutMs) v.fault = Fault::NoRise;
        break;
      }

      case RelayPhase::On: {
        v.fault = batChecks(now, newBat);
        if (v.fault != Fault::None) break;
        if (!bus_.fresh(now, th_.staleMs)) {
          v.fault = Fault::StaleBus;
          break;
        }
        if (newBus) {
          Fault cand = Fault::None;
          const AdcQuality q = bus_.quality();
          if (q == AdcQuality::Zero) {
            cand = Fault::BusLost;
          } else if (q != AdcQuality::Ok) {
            cand = Fault::SensorBus;
          } else if (bus_.volts() < th_.busOffV) {
            cand = Fault::BusLost;
          } else if (bat_.quality() == AdcQuality::Ok && bus_.volts() < th_.busSagFrac * bat_.volts()) {
            cand = Fault::BusSag;
          } else if (!loadActive && bat_.quality() == AdcQuality::Ok &&
                     absf(bus_.volts() - bat_.volts()) > th_.crossCheckFrac * bat_.volts()) {
            cand = Fault::CrossCheck;
          }
          v.fault = busT_.step(cand, kConfirmSamples);
        }
        break;
      }

      case RelayPhase::TurningOff: {
        batT_.step(Fault::None, kConfirmSamples);
        if (newBus) {
          const AdcQuality q = bus_.quality();
          const bool low = q == AdcQuality::Zero || (q == AdcQuality::Ok && bus_.volts() < th_.busOffV);
          lowRun_ = low ? (lowRun_ < 255 ? lowRun_ + 1 : 255) : 0;
        }
        if (lowRun_ >= kConfirmSamples) {
          phase_ = RelayPhase::Off;
          busT_.step(Fault::None, kConfirmSamples);
          break;
        }
        if (static_cast<uint32_t>(now - offAt_) >= th_.settleTimeoutMs) {
          const AdcQuality q = bus_.quality();
          if (q == AdcQuality::Ok && bus_.volts() >= th_.busOffV) {
            const bool nearBat = bat_.quality() == AdcQuality::Ok &&
                                 absf(bus_.volts() - bat_.volts()) <= tolerance();
            v.fault = nearBat ? Fault::WeldedContact : Fault::BusLiveRelayOff;
          } else if (q == AdcQuality::Saturated) {
            v.fault = Fault::BusLiveRelayOff;
          } else {
            v.fault = Fault::SensorBus;     // bus never proven off
          }
        }
        break;
      }
    }
    return v;
  }

 private:
  struct Tracker {
    Fault pending = Fault::None;
    uint8_t run = 0;
    Fault step(Fault cand, uint8_t need) {
      if (cand == Fault::None) {
        pending = Fault::None;
        run = 0;
        return Fault::None;
      }
      if (cand == pending) {
        if (run < 255) run += 1;
      } else {
        pending = cand;
        run = 1;
      }
      return run >= need ? cand : Fault::None;
    }
  };

  float tolerance() const {
    const float frac = th_.busOnTolFrac * bat_.volts();
    return frac > th_.busOnTolMinV ? frac : th_.busOnTolMinV;
  }

  Fault batChecks(uint32_t now, bool newBat) {
    if (!bat_.fresh(now, th_.staleMs)) return Fault::StaleBat;
    if (!newBat) return Fault::None;
    Fault cand = Fault::None;
    if (bat_.quality() != AdcQuality::Ok) {
      cand = Fault::SensorBat;
    } else if (bat_.volts() > th_.vbatFaultMaxV) {
      cand = Fault::BatHigh;
    } else if (bat_.volts() < th_.vbatStopMinV) {
      cand = Fault::BatLow;
    }
    return batT_.step(cand, kConfirmSamples);
  }

  void resetTrackers() {
    batT_ = Tracker();
    busT_ = Tracker();
  }

  Thresholds th_;
  Limits lim_;
  AdcChannel bat_, bus_;
  RelayPhase phase_ = RelayPhase::Boot;
  uint32_t onAt_ = 0, offAt_ = 0, stableSince_ = 0;
  bool stableActive_ = false;
  uint8_t nearCount_ = 0, lowRun_ = 0;
  uint32_t batSeen_ = 0, busSeen_ = 0;
  Tracker batT_, busT_;

  bool estop_ = true;               // never read = E-STOP
  bool relSet_ = false;
  uint32_t relSince_ = 0;

  bool seenReleased_ = false, pressing_ = false, fired_ = false, rstRelSet_ = false, resetEvent_ = false;
  uint32_t pressStart_ = 0, rstRelFrom_ = 0;
};

}  // namespace mt
