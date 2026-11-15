// Protocol v2 device core: an exact port of js/mock-esp32.js.
//
// SOURCE OF TRUTH: js/mock-esp32.js and tests/esp32-link.test.mjs,
// tests/esp32-faults.test.mjs. Where this file and the mock differ, this file
// is wrong. host/ holds a conformance harness that replays the same message
// and time sequences through both and compares every reply and every state.
//
// THIS IS NOT PROOF OF REAL-BOARD COMPATIBILITY. It proves the C++ port
// matches the JavaScript mock on a host computer. It has never run on an
// ESP32, over Wi-Fi, under real timing or with a motor.
//
// Portable C++ (no Arduino headers, no heap). The caller supplies:
//   - a monotonic clock in milliseconds (double) with every call. Time is
//     clamped so it never goes backwards. The device never compares its clock
//     with the app's clock.
//   - a Random32 source (on the board: esp_random(); a secure source).
//   - a ReplySink that receives each reply as JSON text.
//
// Preserved, in the mock's order: watchdog, then lease, then session liveness
// (housekeeping) before every message and every tick. The movement watchdog
// (600 ms) is armed only while MOVING and renewed only by an accepted
// movement CMD; the session liveness timer (600 ms) is renewed only by a
// successful ARM and by a valid in-window STOP or accepted movement CMD. The
// two timers are separate variables with separate expiry paths.
//
// Local extension (NOT part of the wire protocol): deviceStop(). The safety
// kernel uses it for the ultrasonic interlock and for a lost transport. It
// follows the existing lease-expiry path: motor STOP, MOVING -> IDLE, did
// invalidated, NO latch. It adds no ACK reason and no message.
#pragma once

#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "json_lite.h"

namespace follow {

constexpr int kRingMax = 8;   // token ring, dead-session ring, challenge table

struct ProtocolConfig {
  int protocolVersion = 2;
  double movementWatchdogMs = 600;
  double sessionLivenessMs = 600;
  double ageClaimMaxMs = 450;
  double proofMaxMs = 500;
  double minRemainMs = 50;
  double evidenceMaxMs = 700;
  double challengeTtlMs = 2000;
  int tokenRingSize = 8;
  int deadRingSize = 8;
  int challengeTableSize = 8;
  double seqWindow = 32;
  double minMoveIntervalMs = 100;
};

enum class Motor : uint8_t { Stop, Forward, Left, Right };
enum class DeviceState : uint8_t { BootLatched, Idle, Moving, Latched };

inline const char* motorName(Motor m) {
  switch (m) {
    case Motor::Forward: return "FORWARD";
    case Motor::Left: return "LEFT";
    case Motor::Right: return "RIGHT";
    default: return "STOP";
  }
}

inline const char* stateName(DeviceState s) {
  switch (s) {
    case DeviceState::BootLatched: return "BOOT_LATCHED";
    case DeviceState::Idle: return "IDLE";
    case DeviceState::Moving: return "MOVING";
    default: return "LATCHED";
  }
}

struct Random32 {
  virtual ~Random32() {}
  virtual uint32_t next() = 0;
};

struct ReplySink {
  virtual ~ReplySink() {}
  virtual void send(const char* json, size_t length) = 0;
};

// Optional observer (tests, logging). Never required.
struct Observer {
  virtual ~Observer() {}
  virtual void onMotor(double /*at*/, Motor /*command*/, const char* /*reason*/) {}
  virtual void onEvent(double /*at*/, const char* /*type*/, bool /*hasMalformed*/, bool /*malformed*/) {}
};

struct Token {
  char sid[17];
  uint32_t ackSeq;
  uint32_t tok;
  double issuedAt;
};

struct Challenge {
  char sid[17];
  uint32_t dn;
  double issuedAt;
};

struct Counters {
  uint32_t accepted = 0, rejected = 0, stops = 0, watchdogLatches = 0, leaseExpiries = 0;
  uint32_t idleTimeouts = 0, rateLimited = 0, estops = 0, byes = 0;
};

class Protocol {
 public:
  Protocol(Random32* rng, ReplySink* sink, Observer* observer = nullptr,
           const ProtocolConfig& config = ProtocolConfig())
      : config_(config), rng_(rng), sink_(sink), observer_(observer) {
    if (config_.tokenRingSize > kRingMax) config_.tokenRingSize = kRingMax;
    if (config_.deadRingSize > kRingMax) config_.deadRingSize = kRingMax;
    if (config_.challengeTableSize > kRingMax) config_.challengeTableSize = kRingMax;
    epoch_ = rng_->next();
    lastStopReason_ = "BOOT";
    latchReason_ = "BOOT";
  }

  // A message arrived (JSON text). Invalid JSON and non-object values are ignored.
  void receive(const char* text, size_t length, double now) {
    Message message;
    if (!parseMessage(text, length, message) || !message.isObject) return;

    double nowD = 0;
    if (!clock(now, nowD)) return;

    housekeeping(nowD);

    // A recognizable ordinary STOP is applied first, whatever else is wrong
    // with it (K2 / Q15).
    const bool isStop = message.cmd.equals("STOP");
    if (isStop) {
      applyStop(nowD);
      // F1: a STOP carried by any other message type is only that safety action.
      if (!message.t.equals("CMD")) return;
    }

    if (message.t.equals("HELLO")) handleHello(message, nowD);
    else if (message.t.equals("ARM")) handleArm(message, nowD);
    else if (message.t.equals("ESTOP")) handleEstop(message, nowD);
    else if (message.t.equals("BYE")) handleBye(message, nowD);
    else if (message.t.equals("CMD")) handleCmd(message, nowD, isStop);
  }

  void tick(double now) {
    double nowD = 0;
    if (clock(now, nowD)) housekeeping(nowD);
  }

  // Local safety stop (interlock, lost transport). See the header comment.
  void deviceStop(double now, const char* reason) {
    double nowD = 0;
    if (!clock(now, nowD)) return;
    setMotor(Motor::Stop, nowD, reason);
    if (state_ == DeviceState::Moving) state_ = DeviceState::Idle;
    invalidateDid(nowD);
  }

  // The kernel tells the protocol that physical output is blocked, so the
  // ACK `motor` field does not claim movement that is not happening.
  void setReportBlocked(bool blocked) { reportBlocked_ = blocked; }

  Motor motor() const { return motor_; }
  DeviceState state() const { return state_; }
  const char* latchReason() const { return latchReason_; }
  bool hasSession() const { return hasSid_; }
  const char* session() const { return sid_; }
  uint32_t lastSeq() const { return lastSeq_; }
  uint32_t lastDid() const { return lastDid_; }
  bool hasExpiry() const { return hasExpiry_; }
  double expiryDid() const { return expiryDid_; }
  bool hasLive() const { return hasLive_; }
  double lastLiveAt() const { return lastLiveAt_; }
  bool hasMoveAccepted() const { return hasMove_; }
  double lastMoveAcceptedAt() const { return lastMoveAcceptedAt_; }
  bool sessionLivenessExpired() const { return sessionLivenessExpired_; }
  const char* lastStopReason() const { return lastStopReason_; }
  bool hasLastReject() const { return hasReject_; }
  const char* lastRejectReason() const { return lastRejectReason_; }
  double lastRejectSeq() const { return lastRejectSeq_; }
  uint32_t epoch() const { return epoch_; }
  const Counters& counters() const { return counters_; }
  int ringCount() const { return ringCount_; }
  const Token& ringAt(int i) const { return ring_[i]; }
  int deadCount() const { return deadCount_; }
  const char* deadAt(int i) const { return dead_[i]; }

 private:
  static bool sameSid(const char* a, const char* b) { return strcmp(a, b) == 0; }

  bool clock(double now, double& out) {
    if (!isfinite(now)) return false;
    if (!hasNow_ || now > lastNow_) lastNow_ = now;   // never goes backwards
    hasNow_ = true;
    out = lastNow_;
    return true;
  }

  void setMotor(Motor command, double nowD, const char* reason) {
    if (motor_ != command) {
      motor_ = command;
      if (observer_) observer_->onMotor(nowD, command, reason);
      if (command == Motor::Stop) lastStopReason_ = reason;
    }
  }

  void event(const char* type, double nowD, bool hasMalformed = false, bool malformed = false) {
    if (observer_) observer_->onEvent(nowD, type, hasMalformed, malformed);
  }

  bool isDead(const char* sid) const {
    for (int i = 0; i < deadCount_; i += 1) if (sameSid(dead_[i], sid)) return true;
    return false;
  }

  void addDead(const char* sid) {
    if (sid[0] == '\0' || isDead(sid)) return;           // idempotent
    if (deadCount_ == config_.deadRingSize) {
      for (int i = 1; i < deadCount_; i += 1) strcpy(dead_[i - 1], dead_[i]);
      deadCount_ -= 1;
    }
    strcpy(dead_[deadCount_], sid);
    deadCount_ += 1;
  }

  void invalidateDid(double nowD) {
    if (hasExpiry_ && nowD < expiryDid_) expiryDid_ = nowD;   // min(expiryDid, nowD)
  }

  bool sessionActive() const { return state_ == DeviceState::Idle || state_ == DeviceState::Moving; }

  const char* stateText() const {
    if (state_ == DeviceState::Moving) return "MOVING";
    if (state_ == DeviceState::Idle) return "IDLE";
    return "LATCHED";
  }

  // Terminates the active session; only a new ARM can leave LATCHED.
  void latch(const char* reason, double nowD) {
    setMotor(Motor::Stop, nowD, reason);
    state_ = DeviceState::Latched;
    latchReason_ = reason;
    if (hasSid_) addDead(sid_);
    hasSid_ = false;
    sid_[0] = '\0';
    ringCount_ = 0;
    lastDid_ = 0;
    hasExpiry_ = false;
    lastSeq_ = 0;
    hasLive_ = false;
    hasMove_ = false;
  }

  void emit(const char* format, ...) __attribute__((format(printf, 2, 3))) {
    char buffer[320];
    va_list args;
    va_start(args, format);
    const int n = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    if (n > 0 && static_cast<size_t>(n) < sizeof(buffer) && sink_) sink_->send(buffer, static_cast<size_t>(n));
  }

  void answer(const Message& m, bool ok, const char* reason, bool hasTok = false, uint32_t tok = 0,
              double expIn = 0) {
    if (!ok) {
      counters_.rejected += 1;
      hasReject_ = true;
      lastRejectReason_ = reason;
      lastRejectSeq_ = m.seq.num;
    }
    char reasonText[48];
    if (reason) snprintf(reasonText, sizeof(reasonText), "\"%s\"", reason);
    else snprintf(reasonText, sizeof(reasonText), "null");
    char tokText[24];
    if (hasTok) snprintf(tokText, sizeof(tokText), "%u", static_cast<unsigned>(tok));
    else snprintf(tokText, sizeof(tokText), "null");

    emit("{\"v\":%d,\"t\":\"ACK\",\"sid\":\"%s\",\"seq\":%.17g,\"ok\":%s,\"reason\":%s,"
         "\"st\":\"%s\",\"motor\":\"%s\",\"tok\":%s,\"epoch\":%u,\"expIn\":%.17g}",
         config_.protocolVersion, m.sid.str, m.seq.num, ok ? "true" : "false", reasonText,
         stateText(), motorName(reportBlocked_ ? Motor::Stop : motor_), tokText,
         static_cast<unsigned>(epoch_), expIn);
  }

  uint32_t issueToken(double nowD, uint32_t ackSeq) {
    const uint32_t tok = rng_->next();
    Token entry;
    strcpy(entry.sid, sid_);
    entry.ackSeq = ackSeq;
    entry.tok = tok;
    entry.issuedAt = nowD;
    if (ringCount_ == config_.tokenRingSize) {
      for (int i = 1; i < ringCount_; i += 1) ring_[i - 1] = ring_[i];
      ringCount_ -= 1;
    }
    ring_[ringCount_] = entry;
    ringCount_ += 1;
    return tok;
  }

  // Both timers and the lease, in the approved order: watchdog, lease,
  // session liveness. Called before every message and from tick().
  void housekeeping(double nowD) {
    const bool active = sessionActive();
    const bool liveExpired = active && hasLive_ && nowD - lastLiveAt_ > config_.sessionLivenessMs;
    bool watchdogLatched = false;

    if (state_ == DeviceState::Moving) {
      if (hasMove_ && nowD - lastMoveAcceptedAt_ > config_.movementWatchdogMs) {
        event("WATCHDOG", nowD);
        counters_.watchdogLatches += 1;
        latch("WATCHDOG", nowD);
        watchdogLatched = true;
        // Session expiry at the same instant is idempotent.
        if (liveExpired) sessionLivenessExpired_ = true;
      } else if (hasExpiry_ && nowD >= expiryDid_) {
        // Lease expiry: stop, back to IDLE, did invalidated, no latch.
        event("LEASE_EXPIRED", nowD);
        counters_.leaseExpiries += 1;
        setMotor(Motor::Stop, nowD, "LEASE_EXPIRED");
        state_ = DeviceState::Idle;
        invalidateDid(nowD);
      }
    }

    if (!watchdogLatched && liveExpired) {
      event("IDLE_TIMEOUT", nowD);
      counters_.idleTimeouts += 1;
      latch("IDLE_TIMEOUT", nowD);
    }
  }

  // An ordinary STOP: stop and invalidate the did, nothing else.
  void applyStop(double nowD) {
    counters_.stops += 1;
    setMotor(Motor::Stop, nowD, "STOP");
    if (state_ == DeviceState::Moving) state_ = DeviceState::Idle;
    invalidateDid(nowD);
  }

  Challenge* findChallenge(const char* sid) {
    for (int i = 0; i < challengeCount_; i += 1) if (sameSid(challenges_[i].sid, sid)) return &challenges_[i];
    return nullptr;
  }

  void eraseChallenge(const char* sid) {
    for (int i = 0; i < challengeCount_; i += 1) {
      if (sameSid(challenges_[i].sid, sid)) {
        for (int j = i + 1; j < challengeCount_; j += 1) challenges_[j - 1] = challenges_[j];
        challengeCount_ -= 1;
        return;
      }
    }
  }

  void handleHello(const Message& m, double nowD) {
    if (m.v.kind != Kind::Number || m.v.num != config_.protocolVersion || !m.sid.isHex16() ||
        !(m.seq.kind == Kind::Number && m.seq.num == 1)) return;

    if (isDead(m.sid.str)) {
      answer(m, false, "DEAD_SESSION");
      return;
    }

    Challenge* entry = findChallenge(m.sid.str);
    if (!entry || nowD - entry->issuedAt > config_.challengeTtlMs) {
      Challenge fresh;
      strcpy(fresh.sid, m.sid.str);
      fresh.dn = rng_->next();
      fresh.issuedAt = nowD;
      eraseChallenge(m.sid.str);
      challenges_[challengeCount_] = fresh;
      challengeCount_ += 1;
      while (challengeCount_ > config_.challengeTableSize) {
        for (int j = 1; j < challengeCount_; j += 1) challenges_[j - 1] = challenges_[j];
        challengeCount_ -= 1;
      }
      entry = findChallenge(m.sid.str);
    }

    // Idempotent: the same sid inside the TTL always gets the same nonce.
    emit("{\"v\":%d,\"t\":\"CHALLENGE\",\"sid\":\"%s\",\"dn\":%u,\"epoch\":%u}",
         config_.protocolVersion, m.sid.str, static_cast<unsigned>(entry->dn),
         static_cast<unsigned>(epoch_));
  }

  void handleArm(const Message& m, double nowD) {
    if (m.v.kind != Kind::Number || m.v.num != config_.protocolVersion || !m.sid.isHex16() ||
        !(m.seq.kind == Kind::Number && m.seq.num == 2) || !m.dn.isUint32()) return;

    if (isDead(m.sid.str)) {
      answer(m, false, "DEAD_SESSION");
      return;
    }

    const bool active = sessionActive();

    if (active && hasSid_ && sameSid(m.sid.str, sid_)) {
      // Duplicate ARM: repeat the ARM token; renews nothing, changes nothing.
      const Token* found = nullptr;
      for (int i = 0; i < ringCount_; i += 1) {
        if (ring_[i].ackSeq == 2) { found = &ring_[i]; break; }
      }
      answer(m, true, "DUP_ARM", found != nullptr, found ? found->tok : 0);
      return;
    }

    if (active) {
      // The active session is fresh (housekeeping already latched a stale
      // one): no takeover.
      answer(m, false, "BUSY");
      return;
    }

    Challenge* entry = findChallenge(m.sid.str);
    if (!entry || nowD - entry->issuedAt > config_.challengeTtlMs ||
        static_cast<double>(entry->dn) != m.dn.num) {
      answer(m, false, "BAD_NONCE");
      return;
    }

    eraseChallenge(m.sid.str);

    strcpy(sid_, m.sid.str);
    hasSid_ = true;
    state_ = DeviceState::Idle;
    latchReason_ = nullptr;
    lastSeq_ = 2;
    ringCount_ = 0;
    lastLiveAt_ = nowD;
    hasLive_ = true;
    hasMove_ = false;
    lastDid_ = 0;
    hasExpiry_ = false;
    sessionLivenessExpired_ = false;
    counters_.accepted += 1;
    setMotor(Motor::Stop, nowD, "SESSION_START");
    const uint32_t tok = issueToken(nowD, 2);
    answer(m, true, nullptr, true, tok);
  }

  void handleEstop(const Message& m, double nowD) {
    const bool wellFormed = m.v.kind == Kind::Number && m.v.num == config_.protocolVersion && m.sid.isHex16();

    if (wellFormed && isDead(m.sid.str)) return;   // stale ESTOP

    counters_.estops += 1;
    event("ESTOP", nowD, true, !wellFormed);

    if (state_ == DeviceState::Latched || state_ == DeviceState::BootLatched) {
      setMotor(Motor::Stop, nowD, "ESTOP");
      return;
    }

    if (wellFormed) {
      latch("ESTOP", nowD);
      return;
    }

    // Malformed: stop and latch, but create or change no session.
    setMotor(Motor::Stop, nowD, "ESTOP");
    invalidateDid(nowD);
    state_ = DeviceState::Latched;
    latchReason_ = "ESTOP";
  }

  // (seq - lastSeq) >>> 0, and the reject reason for a bad distance.
  const char* seqReject(const Message& m) const {
    const uint32_t d = static_cast<uint32_t>(static_cast<uint32_t>(m.seq.num) - lastSeq_);
    if (d < 1 || d > config_.seqWindow) return (d == 0 || d > 0x80000000u) ? "OUT_OF_ORDER" : "SEQ_JUMP";
    return nullptr;
  }

  void handleBye(const Message& m, double nowD) {
    if (m.v.kind != Kind::Number || m.v.num != config_.protocolVersion || !m.sid.isHex16() || !m.seq.isSeq()) return;

    const bool active = sessionActive();

    if (!active || !hasSid_ || !sameSid(m.sid.str, sid_)) {
      answer(m, false, isDead(m.sid.str) ? "DEAD_SESSION" : "WRONG_SESSION");
      return;
    }

    if (const char* bad = seqReject(m)) {
      answer(m, false, bad);
      return;
    }

    counters_.byes += 1;
    event("BYE", nowD);
    latch("BYE", nowD);
    answer(m, true, nullptr);
  }

  static bool isMove(const Field& cmd) {
    return cmd.equals("FORWARD") || cmd.equals("LEFT") || cmd.equals("RIGHT");
  }

  static Motor moveMotor(const Field& cmd) {
    if (cmd.equals("FORWARD")) return Motor::Forward;
    if (cmd.equals("LEFT")) return Motor::Left;
    return Motor::Right;
  }

  // The approved fixed CMD validation order (steps 2 to 15, plus the rate limit).
  void handleCmd(const Message& m, double nowD, bool isStop) {
    // Step 2: schema. A malformed STOP was already applied and gets no reply.
    if (m.v.kind != Kind::Number || m.v.num != config_.protocolVersion || !m.sid.isHex16() ||
        !m.seq.isSeq() || !m.cmd.isString()) return;

    // Step 3: session.
    const bool active = sessionActive();
    if (!active) {
      answer(m, false, isDead(m.sid.str) ? "DEAD_SESSION" : "LATCHED");
      return;
    }
    if (!hasSid_ || !sameSid(m.sid.str, sid_)) {
      answer(m, false, isDead(m.sid.str) ? "DEAD_SESSION" : "WRONG_SESSION");
      return;
    }

    // Step 4: sequence window.
    if (const char* bad = seqReject(m)) {
      answer(m, false, bad);
      return;
    }

    // Step 4b: movement CMD rate limit. Mutates nothing.
    if (isMove(m.cmd) && hasMove_ && nowD - lastMoveAcceptedAt_ < config_.minMoveIntervalMs) {
      counters_.rateLimited += 1;
      answer(m, false, "RATE_LIMITED");
      return;
    }

    // Step 5: consume the sequence number.
    const uint32_t previousSeq = lastSeq_;
    lastSeq_ = static_cast<uint32_t>(m.seq.num);

    // Step 6: a valid STOP renews session liveness only and issues a token.
    if (isStop) {
      lastLiveAt_ = nowD;
      hasLive_ = true;
      counters_.accepted += 1;
      const uint32_t tok = issueToken(nowD, lastSeq_);
      answer(m, true, nullptr, true, tok);
      return;
    }

    auto reject = [&](const char* reason) {
      setMotor(Motor::Stop, nowD, reason);
      if (state_ == DeviceState::Moving) state_ = DeviceState::Idle;
      answer(m, false, reason);
    };

    // Step 7.
    if (!isMove(m.cmd)) { reject("INVALID_COMMAND"); return; }

    // Step 8.
    if (!m.did.isSeq() || !m.ackSeq.isSeq() || !m.tok.isUint32() ||
        !m.age.isInteger() || m.age.num < 0 || m.age.num > config_.evidenceMaxMs ||
        !m.lease.isInteger() || m.lease.num < 0 || m.lease.num > config_.evidenceMaxMs) {
      reject("MALFORMED");
      return;
    }

    // Steps 9 and 10: the token must exist (not evicted) and be bound to this
    // sid, ackSeq and tok, and to an earlier sequence number.
    const Token* entry = nullptr;
    for (int i = 0; i < ringCount_; i += 1) {
      if (sameSid(ring_[i].sid, m.sid.str) && static_cast<double>(ring_[i].ackSeq) == m.ackSeq.num &&
          static_cast<double>(ring_[i].tok) == m.tok.num) {
        entry = &ring_[i];
        break;
      }
    }
    if (!entry || !(m.ackSeq.num < m.seq.num) || !(m.ackSeq.num <= static_cast<double>(previousSeq))) {
      reject("BAD_TOKEN");
      return;
    }

    // Step 11: proof age on the device clock.
    const double proofAge = nowD - entry->issuedAt;
    if (proofAge > config_.proofMaxMs) { reject("PROOF_STALE"); return; }

    // Step 12: range check of the claimed age (not a verification).
    if (m.age.num > config_.ageClaimMaxMs) { reject("DETECTION_TOO_OLD"); return; }

    // Step 13: did.
    if (m.did.num < static_cast<double>(lastDid_)) { reject("STALE_DID"); return; }
    if (m.did.num == static_cast<double>(lastDid_) && (!hasExpiry_ || nowD >= expiryDid_)) {
      reject("EXPIRED");
      return;
    }

    // Step 14: lease.
    double remain = fmin(m.lease.num, config_.evidenceMaxMs - m.age.num - proofAge);
    if (m.did.num == static_cast<double>(lastDid_)) remain = fmin(remain, expiryDid_ - nowD);
    if (remain < config_.minRemainMs) { reject("EXPIRED"); return; }

    // Step 15: accept.
    lastDid_ = static_cast<uint32_t>(m.did.num);
    expiryDid_ = nowD + remain;          // never above the previous cap
    hasExpiry_ = true;
    lastMoveAcceptedAt_ = nowD;          // movement watchdog
    hasMove_ = true;
    lastLiveAt_ = nowD;                  // session liveness
    hasLive_ = true;
    state_ = DeviceState::Moving;
    counters_.accepted += 1;
    setMotor(moveMotor(m.cmd), nowD, "COMMAND");
    const uint32_t tok = issueToken(nowD, lastSeq_);
    answer(m, true, nullptr, true, tok, remain);
  }

  ProtocolConfig config_;
  Random32* rng_;
  ReplySink* sink_;
  Observer* observer_;

  double lastNow_ = 0;
  bool hasNow_ = false;
  Motor motor_ = Motor::Stop;
  DeviceState state_ = DeviceState::BootLatched;
  const char* latchReason_ = nullptr;
  char sid_[17] = {0};
  bool hasSid_ = false;
  uint32_t lastSeq_ = 0;
  Token ring_[kRingMax];
  int ringCount_ = 0;
  char dead_[kRingMax][17];
  int deadCount_ = 0;
  Challenge challenges_[kRingMax + 1];
  int challengeCount_ = 0;
  double lastLiveAt_ = 0;
  bool hasLive_ = false;
  double lastMoveAcceptedAt_ = 0;
  bool hasMove_ = false;
  uint32_t lastDid_ = 0;
  double expiryDid_ = 0;
  bool hasExpiry_ = false;
  bool sessionLivenessExpired_ = false;
  const char* lastStopReason_ = nullptr;
  bool hasReject_ = false;
  const char* lastRejectReason_ = nullptr;
  double lastRejectSeq_ = 0;
  uint32_t epoch_ = 0;
  bool reportBlocked_ = false;
  Counters counters_;
};

}  // namespace follow
