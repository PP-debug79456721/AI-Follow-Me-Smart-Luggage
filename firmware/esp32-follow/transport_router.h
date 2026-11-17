// Lets more than one transport (Wi-Fi WebSocket, BLE) feed the SAME protocol and safety kernel.
// Portable (no Arduino includes), unit-tested on the host (host/transport_test.cpp).
//
//   - A message is handed to the kernel together with the channel it came from. Every reply the
//     protocol produces while handling it goes back to THAT channel (so a BUSY answer for a
//     second client never reaches the first one). A reply outside message handling goes to the
//     channel that spoke last.
//   - The protocol itself is untouched: one session at a time, BUSY for a second one, and the
//     600/1200 ms timers decide everything. The router adds no new way to move the motors.
//   - FAIL-SAFE: when ANY channel closes, the kernel is told to stop at once (deviceStop: motor
//     STOP, no latch). A newer command with a fresh id is needed to move again. This can stop a
//     healthy session when an unrelated client disconnects; that is the safe direction.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

namespace follow {

// One way to reach one connected client.
struct Channel {
  virtual ~Channel() {}
  virtual bool sendText(const char* json, size_t length) = 0;
};

// What the router needs from the safety kernel.
struct RouterTarget {
  virtual ~RouterTarget() {}
  virtual void onMessage(const char* text, size_t length, double now) = 0;
  virtual void onTransportClosed(double now) = 0;
};

class TransportRouter : public ReplySink {
 public:
  static constexpr int kMaxChannels = 2;

  // The kernel is built after the protocol, which needs this router as its sink, so the target
  // is attached later. Until then incoming messages are ignored.
  void setTarget(RouterTarget* target) { target_ = target; }

  // Returns the channel id (0, 1, ...) or -1 when full.
  int addChannel(Channel* channel) {
    if (channel == nullptr || count_ >= kMaxChannels) return -1;
    channels_[count_] = channel;
    return count_++;
  }

  void onText(int id, const char* text, size_t length, double now) {
    if (id < 0 || id >= count_ || target_ == nullptr) return;
    const int previous = current_;
    current_ = id;
    last_ = id;
    target_->onMessage(text, length, now);
    current_ = previous;
  }

  void onClosed(int id, double now) {
    if (id < 0 || id >= count_ || target_ == nullptr) return;
    closes_[id] += 1;
    target_->onTransportClosed(now);
  }

  // ReplySink: used by the protocol.
  void send(const char* json, size_t length) override {
    const int id = current_ >= 0 ? current_ : last_;
    if (id < 0 || id >= count_) return;
    if (channels_[id]->sendText(json, length)) sent_[id] += 1;
    else dropped_[id] += 1;
  }

  int lastChannel() const { return last_; }
  uint32_t sent(int id) const { return (id >= 0 && id < count_) ? sent_[id] : 0; }
  uint32_t dropped(int id) const { return (id >= 0 && id < count_) ? dropped_[id] : 0; }
  uint32_t closes(int id) const { return (id >= 0 && id < count_) ? closes_[id] : 0; }

 private:
  Channel* channels_[kMaxChannels] = {nullptr, nullptr};
  RouterTarget* target_ = nullptr;
  int count_ = 0;
  int current_ = -1;
  int last_ = -1;
  uint32_t sent_[kMaxChannels] = {0, 0};
  uint32_t dropped_[kMaxChannels] = {0, 0};
  uint32_t closes_[kMaxChannels] = {0, 0};
};

}  // namespace follow
