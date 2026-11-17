// Portable helpers for the BLE transport (no Arduino or BLE includes, so they are unit-tested on
// the host, see host/transport_test.cpp).
//
// BLE has no message boundaries and carries only ~20..244 bytes per write/notification, so a
// Protocol v2 JSON message is sent as ONE LINE ended by '\n', cut into as many writes as needed:
//   central -> device : writes to the RX characteristic, reassembled by LineAssembler
//   device  -> central: frameLine() + notifications of chunkPayload() bytes on the TX characteristic
//
// The BLE stack calls its callbacks from its OWN task. The safety kernel is not thread-safe, so
// the callback only pushes finished lines into a MessageQueue and loop() pops them.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace follow {
namespace ble {

constexpr size_t kMaxLine = 512;   // longest accepted message (protocol messages are < 400 bytes)

// Cuts a byte stream into lines. A line longer than kMaxLine is dropped whole (up to its
// '\n'), never delivered cut in half. Empty lines and '\r' are ignored.
class LineAssembler {
 public:
  // onLine(const char* nulTerminated, size_t length) is called for every complete line.
  template <class OnLine>
  void feed(const uint8_t* data, size_t length, OnLine&& onLine) {
    for (size_t i = 0; i < length; i += 1) {
      const uint8_t c = data[i];
      if (c == '\n') {
        if (!discarding_ && size_ > 0) {
          buffer_[size_] = '\0';
          onLine(static_cast<const char*>(buffer_), size_);
        }
        size_ = 0;
        discarding_ = false;
      } else if (c == '\r') {
        // ignored
      } else if (!discarding_) {
        if (size_ >= kMaxLine) {
          discarding_ = true;
          size_ = 0;
          overflows_ += 1;
        } else {
          buffer_[size_] = static_cast<char>(c);
          size_ += 1;
        }
      }
    }
  }

  void reset() {
    size_ = 0;
    discarding_ = false;
  }

  uint32_t overflows() const { return overflows_; }

 private:
  char buffer_[kMaxLine + 1] = {0};
  size_t size_ = 0;
  bool discarding_ = false;
  uint32_t overflows_ = 0;
};

// json + '\n' into out. Returns the bytes written, 0 when it is empty or does not fit.
inline size_t frameLine(const char* json, size_t length, uint8_t* out, size_t capacity) {
  if (length == 0 || length + 1 > capacity) return 0;
  memcpy(out, json, length);
  out[length] = '\n';
  return length + 1;
}

// Payload bytes per notification: MTU minus the 3-byte ATT header, never below 20 (the default
// MTU 23) and never above maxChunk.
inline size_t chunkPayload(size_t mtu, size_t maxChunk) {
  size_t payload = mtu > 23 ? mtu - 3 : 20;
  if (payload > maxChunk) payload = maxChunk;
  if (payload < 20) payload = 20;
  return payload;
}

struct NoLock {
  void lock() {}
  void unlock() {}
};

// Fixed-size FIFO of messages between two tasks. Lock is a critical section on the ESP32.
// A message that does not fit (queue full or too long) is dropped and counted.
template <size_t Slots, size_t Length, class Lock = NoLock>
class MessageQueue {
 public:
  bool push(const char* text, size_t length) {
    bool ok = false;
    lock_.lock();
    if (length > 0 && length < Length && count_ < Slots) {
      memcpy(data_[tail_], text, length);
      data_[tail_][length] = '\0';
      size_[tail_] = length;
      tail_ = (tail_ + 1) % Slots;
      count_ += 1;
      ok = true;
    } else {
      dropped_ += 1;
    }
    lock_.unlock();
    return ok;
  }

  // capacity must be at least Length; a message that would not fit is discarded and counted.
  bool pop(char* out, size_t capacity, size_t& length) {
    bool ok = false;
    lock_.lock();
    if (count_ > 0) {
      const size_t n = size_[head_];
      if (n < capacity) {
        memcpy(out, data_[head_], n + 1);
        length = n;
        ok = true;
      } else {
        dropped_ += 1;
      }
      head_ = (head_ + 1) % Slots;
      count_ -= 1;
    }
    lock_.unlock();
    return ok;
  }

  void clear() {
    lock_.lock();
    head_ = tail_ = count_ = 0;
    lock_.unlock();
  }

  uint32_t dropped() const { return dropped_; }

 private:
  char data_[Slots][Length] = {};
  size_t size_[Slots] = {};
  size_t head_ = 0;
  size_t tail_ = 0;
  size_t count_ = 0;
  volatile uint32_t dropped_ = 0;
  Lock lock_;
};

}  // namespace ble
}  // namespace follow
