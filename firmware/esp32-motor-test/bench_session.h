// Motor Test session: PURE LOGIC. No hardware access, no Arduino header.
//
// Command parser, state machine and the ONE place that decides motor output.
// The only way to change an output is BenchOutputs::apply(plan), called by this
// class with a plan that has passed planIsSafe(). A plan is built only from the
// current state, and a motor plan exists only in RUNNING, which is reachable only
// from ARMED (relay confirmed on by the interlock). A rejected command therefore
// cannot leave a motor enabled, and a rejected command during RUNNING forces all
// motor outputs safe (decision 2).
//
// There is no reverse command in this target: LPWM is never driven, so there is
// no direction change. A restart gap separates any stop from the next start.
//
// States: BOOT_CHECK, DISARMED, ARMING, ARMED, RUNNING, ESTOP, FAULT.
// Reset is an EVENT (button), never a state, and never arms.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "bench_interlock.h"
#include "motor_test_config.h"

namespace mt {

enum class State : uint8_t { BootCheck, Disarmed, Arming, Armed, Running, Estop, Fault };

inline const char* stateName(State s) {
  switch (s) {
    case State::BootCheck: return "BOOT_CHECK";
    case State::Disarmed: return "DISARMED";
    case State::Arming: return "ARMING";
    case State::Armed: return "ARMED";
    case State::Running: return "RUNNING";
    case State::Estop: return "E-STOP";
    default: return "FAULT";
  }
}

enum class Side : uint8_t { None, Left, Right };

struct MotorOut {
  bool en = false;           // R_EN and L_EN together
  uint8_t rpwmPct = 0;
  uint8_t lpwmPct = 0;       // always 0 in this target (no reverse)
};

struct OutputPlan {
  bool relayOn = false;
  MotorOut left;
  MotorOut right;
};

inline bool planIsZero(const OutputPlan& p) {
  return !p.left.en && !p.right.en && p.left.rpwmPct == 0 && p.left.lpwmPct == 0 &&
         p.right.rpwmPct == 0 && p.right.lpwmPct == 0;
}

// Output invariants. A plan that fails is replaced by the all-off plan.
inline bool planIsSafe(const OutputPlan& p, uint8_t capPct, State s) {
  const MotorOut* sides[2] = {&p.left, &p.right};
  for (int i = 0; i < 2; i += 1) {
    const MotorOut& m = *sides[i];
    if (m.lpwmPct != 0) return false;                       // no reverse in this target
    if (m.rpwmPct > capPct) return false;                   // duty cap
    if (m.en != (m.rpwmPct > 0)) return false;              // EN high exactly when driven
  }
  if (p.left.en && p.right.en) return false;                // one motor at a time
  if ((p.left.en || p.right.en) && !p.relayOn) return false;// no EN without motor power
  if (s != State::Running && !planIsZero(p)) return false;  // motors only in RUNNING
  if ((s == State::BootCheck || s == State::Disarmed || s == State::Estop || s == State::Fault) &&
      p.relayOn) {
    return false;                                           // relay only when arming/armed/running
  }
  return true;
}

class BenchOutputs {
 public:
  virtual ~BenchOutputs() {}
  // Called with a plan that passed planIsSafe(). Driver ordering (M3): on the way
  // up relay, then EN, then duty; on the way down duty, then EN, then relay.
  virtual void apply(const OutputPlan& plan) = 0;
};

// ---------------------------------------------------------------- parser

enum class CmdKind : uint8_t { Empty, Arm, Disarm, Stop, Status, Left, Right, B, Unknown, Malformed };

struct Cmd {
  CmdKind kind = CmdKind::Empty;
  int duty = -1;
};

// Strict, lowercase, one space, printable ASCII only. Never allocates.
inline Cmd parseCommand(const char* text, size_t len, size_t maxLen) {
  Cmd c;
  while (len > 0 && (text[len - 1] == '\r' || text[len - 1] == '\n')) len -= 1;
  if (len == 0) return c;                                  // Empty
  if (len > maxLen) { c.kind = CmdKind::Malformed; return c; }
  for (size_t i = 0; i < len; i += 1) {
    const unsigned char ch = static_cast<unsigned char>(text[i]);
    if (ch < 0x20 || ch > 0x7E) { c.kind = CmdKind::Malformed; return c; }
  }
  size_t space = len;
  for (size_t i = 0; i < len; i += 1) {
    if (text[i] == ' ') { space = i; break; }
  }
  const size_t wordLen = space;
  const bool hasArg = space < len;
  const char* arg = hasArg ? text + space + 1 : nullptr;
  const size_t argLen = hasArg ? len - space - 1 : 0;
  if (hasArg) {
    if (argLen == 0 || arg[0] == ' ') { c.kind = CmdKind::Malformed; return c; }   // trailing / double space
    for (size_t i = 0; i < argLen; i += 1) {
      if (arg[i] == ' ') { c.kind = CmdKind::Malformed; return c; }
    }
  }
  auto is = [&](const char* w) {
    size_t i = 0;
    while (w[i] != 0 && i < wordLen && text[i] == w[i]) i += 1;
    return w[i] == 0 && i == wordLen;
  };

  if (is("b")) { c.kind = CmdKind::B; return c; }          // rejected whatever follows
  const bool motion = is("l") || is("r");
  if (motion) {
    if (!hasArg || argLen > 3) { c.kind = CmdKind::Malformed; return c; }
    if (argLen > 1 && arg[0] == '0') { c.kind = CmdKind::Malformed; return c; }   // no leading zeros
    int value = 0;
    for (size_t i = 0; i < argLen; i += 1) {
      if (arg[i] < '0' || arg[i] > '9') { c.kind = CmdKind::Malformed; return c; }
      value = value * 10 + (arg[i] - '0');
    }
    c.kind = is("l") ? CmdKind::Left : CmdKind::Right;
    c.duty = value;
    return c;
  }
  if (is("arm") || is("disarm") || is("s") || is("status")) {
    if (hasArg) { c.kind = CmdKind::Malformed; return c; }
    c.kind = is("arm") ? CmdKind::Arm : is("disarm") ? CmdKind::Disarm : is("s") ? CmdKind::Stop : CmdKind::Status;
    return c;
  }
  c.kind = CmdKind::Unknown;
  return c;
}

// ---------------------------------------------------------------- replies

enum class Reply : uint8_t {
  None, Ok, Status, Stopped, Arming, Armed, Disarmed, Estop, Faulted, Cleared,
  RejectMalformed, RejectUnknown, RejectB, RejectDuty, RejectConfig, RejectEstop, RejectFault,
  RejectNotArmed, RejectOtherMotor, RejectGap, RejectLimit, RejectArmCheck, RejectAlready,
  RejectBoot, ResetRefused, ResetNoop, LeaseExpired, LimitContinuous, LimitArm, LimitBoot,
  Inactivity
};

inline bool replyIsReject(Reply r) {
  return r >= Reply::RejectMalformed && r <= Reply::RejectBoot;
}

inline const char* replyName(Reply r) {
  switch (r) {
    case Reply::None: return "NONE";
    case Reply::Ok: return "OK";
    case Reply::Status: return "STATUS";
    case Reply::Stopped: return "STOPPED";
    case Reply::Arming: return "ARMING";
    case Reply::Armed: return "ARMED";
    case Reply::Disarmed: return "DISARMED";
    case Reply::Estop: return "E-STOP";
    case Reply::Faulted: return "FAULT";
    case Reply::Cleared: return "FAULT_CLEARED";
    case Reply::RejectMalformed: return "REJECT_MALFORMED";
    case Reply::RejectUnknown: return "REJECT_UNKNOWN";
    case Reply::RejectB: return "REJECT_B_ONE_MOTOR_TEST";
    case Reply::RejectDuty: return "REJECT_DUTY";
    case Reply::RejectConfig: return "REJECT_CONFIG_UNSET";
    case Reply::RejectEstop: return "REJECT_ESTOP";
    case Reply::RejectFault: return "REJECT_FAULT";
    case Reply::RejectNotArmed: return "REJECT_NOT_ARMED";
    case Reply::RejectOtherMotor: return "REJECT_OTHER_MOTOR";
    case Reply::RejectGap: return "REJECT_RESTART_GAP";
    case Reply::RejectLimit: return "REJECT_LIMIT";
    case Reply::RejectArmCheck: return "REJECT_ARM_CHECK";
    case Reply::RejectAlready: return "REJECT_ALREADY";
    case Reply::RejectBoot: return "REJECT_BOOT_CHECK";
    case Reply::ResetRefused: return "RESET_REFUSED";
    case Reply::ResetNoop: return "RESET_NOOP";
    case Reply::LeaseExpired: return "LEASE_EXPIRED";
    case Reply::LimitContinuous: return "LIMIT_CONTINUOUS";
    case Reply::LimitArm: return "LIMIT_ARM";
    case Reply::LimitBoot: return "LIMIT_BOOT";
    default: return "INACTIVITY";
  }
}

// ---------------------------------------------------------------- session

class Session {
 public:
  Session(const Thresholds& th, const Limits& lim, BenchOutputs& out)
      : lim_(lim), il_(th, lim), out_(out), limitsOk_(limitsValid(lim)) {}

  State state() const { return st_; }
  Fault fault() const { return fault_; }
  Side side() const { return side_; }
  uint8_t duty() const { return duty_; }
  Reply lastReply() const { return reply_; }
  ArmCheck lastArmCheck() const { return armCheck_; }
  uint32_t replyCount() const { return replies_; }
  const OutputPlan& lastPlan() const { return plan_; }
  const Interlock& interlock() const { return il_; }
  uint32_t invariantViolations() const { return violations_; }

  // Feeds: call before tick().
  void feedVbat(const AdcSample& s) { il_.feedVbat(s); }
  void feedVbus(const AdcSample& s) { il_.feedVbus(s); }
  void feedEstop(uint32_t now, bool valid, bool pinHigh) { il_.feedEstop(now, valid, pinHigh); }
  void feedReset(uint32_t now, bool valid, bool pinLow) { il_.feedReset(now, valid, pinLow); }

  // Boot: every output off, relay off, BOOT_CHECK. Nothing arms itself.
  void begin(uint32_t now) {
    began_ = true;
    st_ = State::BootCheck;
    bootAt_ = now;
    lastTick_ = now;
    lastCmdAt_ = now;
    if (!limitsOk_) enterFault(Fault::Config, now);
    applyPlan(now);
  }

  void onLine(const char* line, size_t len, uint32_t now) {
    if (!began_) return;
    handle(parseCommand(line, len, lim_.maxLineLen), now);
    applyPlan(now);
  }

  // A line that overflowed the receive buffer: malformed.
  void onOverflow(uint32_t now) {
    if (!began_) return;
    reject(Reply::RejectMalformed, now);
    applyPlan(now);
  }

  void tick(uint32_t now) {
    if (!began_) return;
    const uint32_t gap = static_cast<uint32_t>(now - lastTick_);
    const bool stalled = gap > lim_.maxTickGapMs;
    lastTick_ = now;
    if (st_ == State::Running && !stalled) {
      armRunMs_ += gap;
      bootRunMs_ += gap;
    }
    if (stalled && (st_ == State::Arming || st_ == State::Armed || st_ == State::Running)) {
      enterFault(Fault::LoopStall, now);
    }

    const Verdict v = il_.update(now, st_ == State::Running);

    if (il_.estopActive()) {
      if (st_ != State::Estop && st_ != State::Fault) enterEstop(now);
    } else if (st_ == State::Estop) {
      st_ = il_.phase() == RelayPhase::Boot ? State::BootCheck : State::Disarmed;
      setReply(Reply::Disarmed);                     // released: DISARMED, never re-armed
    }

    if (v.fault != Fault::None && st_ != State::Fault) enterFault(v.fault, now);

    if (il_.phase() == RelayPhase::Boot && il_.configured() && st_ != State::Fault &&
        static_cast<uint32_t>(now - bootAt_) > lim_.bootSampleTimeoutMs) {
      enterFault(Fault::BootSensor, now);
    }

    if (il_.takeResetEvent()) onReset(now);

    switch (st_) {
      case State::BootCheck:
        if (!il_.configured() || il_.phase() == RelayPhase::Off) st_ = State::Disarmed;
        break;
      case State::Arming:
        if (il_.relayConfirmedOn()) {
          st_ = State::Armed;
          armRunMs_ = 0;
          hasStopped_ = false;
          lastCmdAt_ = now;
          setReply(Reply::Armed);
        }
        break;
      case State::Armed:
        if (static_cast<uint32_t>(now - lastCmdAt_) >= lim_.inactivityMs) doDisarm(now, Reply::Inactivity);
        break;
      case State::Running:
        if (armRunMs_ >= lim_.totalPerArmMs) {
          doDisarm(now, Reply::LimitArm);
        } else if (bootRunMs_ >= lim_.totalPerBootMs) {
          bootLimitHit_ = true;
          doDisarm(now, Reply::LimitBoot);
        } else if (static_cast<uint32_t>(now - runStart_) >= lim_.maxContinuousMs) {
          stopMotor(now);
          setReply(Reply::LimitContinuous);
        } else if (static_cast<int32_t>(now - leaseUntil_) >= 0) {
          stopMotor(now);
          setReply(Reply::LeaseExpired);
        }
        break;
      default:
        break;
    }
    applyPlan(now);
  }

 private:
  void setReply(Reply r) {
    reply_ = r;
    replies_ += 1;
  }

  void clearRun() {
    side_ = Side::None;
    duty_ = 0;
  }

  void stopMotor(uint32_t now) {
    clearRun();
    st_ = State::Armed;
    lastStopAt_ = now;
    hasStopped_ = true;
  }

  void doDisarm(uint32_t now, Reply r) {
    clearRun();
    st_ = State::Disarmed;
    il_.relayCommandedOff(now);
    setReply(r);
  }

  void enterEstop(uint32_t now) {
    clearRun();
    st_ = State::Estop;
    il_.relayCommandedOff(now);
    setReply(Reply::Estop);
  }

  void enterFault(Fault f, uint32_t now) {
    if (st_ == State::Fault) return;                  // first fault stays latched
    clearRun();
    st_ = State::Fault;
    fault_ = f;
    il_.relayCommandedOff(now);
    setReply(Reply::Faulted);
  }

  // Reset never arms. It clears a recoverable FAULT only when every safe
  // condition holds (E-stop released, battery valid, bus settled off).
  void onReset(uint32_t now) {
    (void)now;
    if (st_ != State::Fault) {
      setReply(Reply::ResetNoop);
      return;
    }
    if (faultRecoverable(fault_) && il_.preArm(now) == ArmCheck::Ok) {
      st_ = State::Disarmed;
      fault_ = Fault::None;
      setReply(Reply::Cleared);
    } else {
      setReply(Reply::ResetRefused);
    }
  }

  // Any rejection during RUNNING forces all motor outputs safe.
  void reject(Reply r, uint32_t now) {
    setReply(r);
    if (st_ == State::Running) stopMotor(now);
  }

  void handle(const Cmd& c, uint32_t now) {
    switch (c.kind) {
      case CmdKind::Empty: return;
      case CmdKind::Status: setReply(Reply::Status); return;
      case CmdKind::Stop:
        if (st_ == State::Running) stopMotor(now);
        setReply(Reply::Stopped);
        return;
      case CmdKind::Disarm:
        if (st_ == State::Arming || st_ == State::Armed || st_ == State::Running) {
          doDisarm(now, Reply::Disarmed);
        } else {
          setReply(Reply::Disarmed);
        }
        return;
      case CmdKind::Arm: handleArm(now); return;
      case CmdKind::B: reject(Reply::RejectB, now); return;
      case CmdKind::Unknown: reject(Reply::RejectUnknown, now); return;
      case CmdKind::Malformed: reject(Reply::RejectMalformed, now); return;
      case CmdKind::Left: handleMotion(Side::Left, c.duty, now); return;
      case CmdKind::Right: handleMotion(Side::Right, c.duty, now); return;
    }
  }

  void handleArm(uint32_t now) {
    switch (st_) {
      case State::Disarmed: break;
      case State::Estop: reject(Reply::RejectEstop, now); return;
      case State::Fault: reject(Reply::RejectFault, now); return;
      case State::BootCheck: reject(Reply::RejectBoot, now); return;
      default: reject(Reply::RejectAlready, now); return;
    }
    if (bootLimitHit_) { reject(Reply::RejectLimit, now); return; }
    armCheck_ = il_.preArm(now);
    if (armCheck_ != ArmCheck::Ok) {
      reject(armCheck_ == ArmCheck::Config ? Reply::RejectConfig
             : armCheck_ == ArmCheck::Estop ? Reply::RejectEstop : Reply::RejectArmCheck, now);
      return;
    }
    st_ = State::Arming;
    il_.relayCommandedOn(now);
    lastCmdAt_ = now;
    setReply(Reply::Arming);
  }

  void handleMotion(Side side, int duty, uint32_t now) {
    switch (st_) {
      case State::Running:
        if (side != side_) { reject(Reply::RejectOtherMotor, now); return; }
        if (duty < 1 || duty > lim_.dutyCapPct) { reject(Reply::RejectDuty, now); return; }
        duty_ = static_cast<uint8_t>(duty);                // refresh the lease
        leaseUntil_ = now + lim_.leaseMs;
        lastCmdAt_ = now;
        setReply(Reply::Ok);
        return;
      case State::Armed:
        break;
      case State::Estop: reject(Reply::RejectEstop, now); return;
      case State::Fault: reject(Reply::RejectFault, now); return;
      default: reject(Reply::RejectNotArmed, now); return;
    }
    if (duty < 1 || duty > lim_.dutyCapPct) { reject(Reply::RejectDuty, now); return; }
    if (bootLimitHit_ || armRunMs_ >= lim_.totalPerArmMs || bootRunMs_ >= lim_.totalPerBootMs) {
      reject(Reply::RejectLimit, now);
      return;
    }
    if (hasStopped_ && static_cast<uint32_t>(now - lastStopAt_) < lim_.restartGapMs) {
      reject(Reply::RejectGap, now);
      return;
    }
    st_ = State::Running;
    side_ = side;
    duty_ = static_cast<uint8_t>(duty);
    runStart_ = now;
    leaseUntil_ = now + lim_.leaseMs;
    lastCmdAt_ = now;
    setReply(Reply::Ok);
  }

  OutputPlan planNow() const {
    OutputPlan p;
    switch (st_) {
      case State::Arming:
      case State::Armed:
        p.relayOn = true;
        break;
      case State::Running: {
        p.relayOn = true;
        MotorOut& m = side_ == Side::Left ? p.left : p.right;
        if (side_ == Side::None) break;
        m.en = true;
        m.rpwmPct = duty_;
        break;
      }
      default:
        break;
    }
    return p;
  }

  // The single write point. A plan that fails its invariants is replaced by the
  // all-off plan and latches an internal FAULT.
  void applyPlan(uint32_t now) {
    OutputPlan p = planNow();
    if (!planIsSafe(p, lim_.dutyCapPct, st_)) {
      violations_ += 1;
      p = OutputPlan();
      enterFault(Fault::OutputInvariant, now);
    }
    plan_ = p;
    out_.apply(p);
  }

  Limits lim_;
  Interlock il_;
  BenchOutputs& out_;
  bool limitsOk_;
  bool began_ = false;
  State st_ = State::BootCheck;
  Fault fault_ = Fault::None;
  Side side_ = Side::None;
  uint8_t duty_ = 0;
  Reply reply_ = Reply::None;
  ArmCheck armCheck_ = ArmCheck::Ok;
  uint32_t replies_ = 0;
  OutputPlan plan_;
  uint32_t violations_ = 0;

  uint32_t bootAt_ = 0, lastTick_ = 0, lastCmdAt_ = 0, runStart_ = 0, leaseUntil_ = 0, lastStopAt_ = 0;
  uint32_t armRunMs_ = 0, bootRunMs_ = 0;
  bool hasStopped_ = false, bootLimitHit_ = false;
};

}  // namespace mt
