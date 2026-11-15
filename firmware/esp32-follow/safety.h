// Safety kernel: the ONE authoritative writer of motor output.
//
//   motor output = protocol motor AND NOT obstacle interlock
//
// Nothing else holds a MotorHal or calls write(). The kernel runs the
// protocol's timers (watchdog, then lease, then session liveness) and then the
// interlock, on every tick and after every message.
//
// Interlock and lost transport use Protocol::deviceStop(): motor STOP, MOVING
// -> IDLE, did invalidated, no latch. So an obstacle that clears, or a socket
// that comes back, NEVER resumes movement: a newer did from a fresh, valid CMD
// is required. While the interlock is blocked, a movement CMD that the
// protocol accepts is cancelled in the same kernel step, so the physical
// output never leaves STOP, and the ACK `motor` field reports STOP.
//
// Protocol v2 itself (timers, ACK reasons, STOP/ESTOP, BOOT_LATCHED, leases,
// sessions, tokens) is untouched: see protocol.h and the conformance tests.
#pragma once

#include "motor_hal.h"
#include "protocol.h"
#include "ultrasonic.h"

namespace follow {

class SafetyKernel {
 public:
  SafetyKernel(Protocol& protocol, MotorHal& hal, Interlock& interlock)
      : protocol_(protocol), hal_(hal), interlock_(interlock) {}

  // Boot: output STOP, interlock evaluated (blocked until sensors report).
  void init(double now) {
    interlock_.update(now);
    step(now);
  }

  // A text frame arrived from the socket.
  void onMessage(const char* text, size_t length, double now) {
    protocol_.receive(text, length, now);
    interlock_.update(now);
    step(now);
  }

  // A sensor measurement completed.
  void onReading(int sensor, const Reading& reading, double now) {
    interlock_.feed(sensor, reading);
    interlock_.update(now);
    step(now);
  }

  // Call every kernel period (kKernelTickMs target).
  void tick(double now) {
    protocol_.tick(now);          // watchdog, lease, session liveness (in that order)
    interlock_.update(now);
    step(now);
  }

  // The socket closed or Wi-Fi dropped: stop at once. The protocol timers
  // still run and latch by themselves; nothing resumes on reconnect.
  void onTransportClosed(double now) {
    protocol_.deviceStop(now, "LINK_CLOSED");
    interlock_.update(now);
    step(now);
  }

  Motor effectiveMotor() const { return effective_; }

 private:
  void step(double now) {
    const bool blocked = interlock_.blocked();
    protocol_.setReportBlocked(blocked);
    if (blocked && (protocol_.motor() != Motor::Stop || protocol_.state() == DeviceState::Moving)) {
      protocol_.deviceStop(now, "INTERLOCK");
    }
    effective_ = blocked ? Motor::Stop : protocol_.motor();
    hal_.write(effective_);
  }

  Protocol& protocol_;
  MotorHal& hal_;
  Interlock& interlock_;
  Motor effective_ = Motor::Stop;
};

}  // namespace follow
