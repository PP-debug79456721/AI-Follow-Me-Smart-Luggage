// WebSocket server glue for the Arduino-ESP32 core. NEEDS NO EXTRA LIBRARY: it uses
// only WiFiServer / WiFiClient from the core plus ws_handshake.h and ws_frame.h.
//
// STATUS: COMPILE-CHECKED ONLY AGAINST HOST STUBS (host/stubs). It has never been built with
// the real ESP32 toolchain and has never run on a board. The portable pieces it uses
// (handshake, SHA-1, frames) are unit-tested on the host; this glue is not.
//
// One client at a time. A new TCP connection replaces the old one (the old socket may be a
// dead phone). That is transport only: protocol sessions are unaffected, and a new app
// session is BUSY until the old one is stale (Protocol v2, no takeover). When a handshaken
// socket closes, the handler is told so the kernel can stop at once.
//
// PHASE 2: every write is NON-BLOCKING (send(MSG_DONTWAIT) on the socket). WiFiClient::write
// waits up to 10 x 1 s when the TCP send buffer is full (weak Wi-Fi, busy phone/laptop); on the
// bench that stalled loop() long enough to trip the 600 ms protocol timers and finally the task
// watchdog (reset). Now a frame that cannot be sent at once is dropped (the app treats a missing
// reply as a timeout and stops), and a frame that was only partly sent closes the socket
// (a cut frame would corrupt the stream).
#pragma once

#include <WiFi.h>
#include <errno.h>
#include <string.h>
#include <lwip/sockets.h>

#include "ws_frame.h"
#include "ws_handshake.h"

namespace follow {

class WsServer {
 public:
  struct Handler {
    virtual ~Handler() {}
    virtual void onText(const char* text, size_t length, double now) = 0;
    virtual void onClosed(double now) = 0;
  };

  WsServer(uint16_t port, const char* path, Handler& handler)
      : server_(port), path_(path), handler_(handler) {}

  void begin() { server_.begin(); }

  bool connected() { return handshaken_ && client_.connected(); }

  bool sendText(const char* json, size_t length) {
    if (!connected()) return false;
    uint8_t frame[400];
    const size_t n = ws::encodeFrame(ws::kText, reinterpret_cast<const uint8_t*>(json), length, frame, sizeof(frame));
    if (n == 0) return false;
    return writeNow(frame, n);
  }

  void poll(double now) {
    WiFiClient incoming = server_.available();
    if (incoming) {
      closeClient(now, "REPLACED");                    // replaces the previous socket
      client_ = incoming;
      client_.setNoDelay(true);
      used_ = 0;
      handshaken_ = false;
      haveClient_ = true;
      broken_ = false;
    }

    if (!haveClient_) return;
    if (broken_ || !client_.connected()) {
      closeClient(now, broken_ ? "SEND_ERROR" : "PEER_CLOSED");
      return;
    }

    while (client_.available() > 0 && used_ < sizeof(buffer_)) {
      const int got = client_.read(buffer_ + used_, sizeof(buffer_) - used_);
      if (got <= 0) break;
      used_ += static_cast<size_t>(got);
    }

    if (!handshaken_) {
      if (!tryHandshake()) {
        if (used_ >= sizeof(buffer_)) closeClient(now, "HTTP_TOO_LARGE");   // oversized request
        return;
      }
    }

    for (;;) {
      ws::Frame frame;
      const long consumed = ws::parseFrame(buffer_, used_, kMaxPayload, frame);
      if (consumed == ws::kIncomplete) {
        if (used_ >= sizeof(buffer_)) { sendClose(1009); closeClient(now, "FRAME_TOO_LARGE"); }
        return;
      }
      if (consumed < 0) {
        sendClose(consumed == ws::kTooLarge ? 1009 : 1002);
        closeClient(now, "BAD_FRAME");
        return;
      }

      switch (frame.opcode) {
        case ws::kText:
          handler_.onText(reinterpret_cast<const char*>(frame.payload), frame.payloadLength, now);
          break;
        case ws::kPing: {
          uint8_t pong[140];
          const size_t n = ws::encodeFrame(ws::kPong, frame.payload, frame.payloadLength, pong, sizeof(pong));
          if (n) writeNow(pong, n);
          break;
        }
        case ws::kPong:
          break;
        case ws::kClose:
          sendClose(1000);
          closeClient(now, "CLOSE_FRAME");
          return;
        default:                           // binary: not used by Protocol v2
          sendClose(1003);
          closeClient(now, "BINARY_FRAME");
          return;
      }

      used_ -= static_cast<size_t>(consumed);
      if (used_ > 0) memmove(buffer_, buffer_ + consumed, used_);
      if (!haveClient_) return;
      if (used_ == 0) return;
    }
  }

 private:
  static constexpr size_t kMaxPayload = 384;   // Protocol v2 messages are far smaller

  bool tryHandshake() {
    // Look for the end of the HTTP request.
    for (size_t i = 3; i < used_; i += 1) {
      if (buffer_[i] == '\n' && buffer_[i - 1] == '\r' && buffer_[i - 2] == '\n' && buffer_[i - 3] == '\r') {
        char response[256];
        const size_t n = ws::buildHandshakeResponse(reinterpret_cast<const char*>(buffer_), i + 1, path_,
                                                    response, sizeof(response));
        if (n == 0) {
          client_.print("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          client_.stop();
          haveClient_ = false;
          used_ = 0;
          return false;
        }
        if (!writeNow(reinterpret_cast<const uint8_t*>(response), n)) return false;
        const size_t rest = used_ - (i + 1);
        if (rest) memmove(buffer_, buffer_ + i + 1, rest);
        used_ = rest;
        handshaken_ = true;
        return true;
      }
    }
    return false;
  }

  void sendClose(uint16_t code) {
    uint8_t payload[2] = {static_cast<uint8_t>(code >> 8), static_cast<uint8_t>(code & 0xFF)};
    uint8_t frame[8];
    const size_t n = ws::encodeFrame(ws::kClose, payload, 2, frame, sizeof(frame));
    if (n) writeNow(frame, n);
  }

  // Sends all n bytes at once or nothing. Never waits.
  //   all sent          -> true
  //   nothing sent      -> false, socket kept (the frame is simply lost)
  //   partly sent/error -> false, socket marked broken and closed on the next poll
  bool writeNow(const uint8_t* data, size_t n) {
    if (!haveClient_) return false;
    const int fd = client_.fd();
    if (fd < 0) { broken_ = true; return false; }
    const int sent = ::send(fd, data, n, MSG_DONTWAIT);
    if (sent == static_cast<int>(n)) return true;
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS || errno == ENOMEM)) {
      dropped_ += 1;                 // lwIP buffers full for a moment: lose this frame, keep the socket
      return false;
    }
    lastErrno_ = sent < 0 ? errno : -1;   // -1 = partial send
    broken_ = true;
    return false;
  }

 public:
  uint32_t droppedFrames() const { return dropped_; }
  uint32_t closes() const { return closes_; }
  const char* lastCloseReason() const { return lastCloseReason_; }

 private:

  void closeClient(double now, const char* why = "CLOSED") {
    const bool wasOpen = haveClient_ && handshaken_;
    if (haveClient_) {
      closes_ += 1;
      lastCloseReason_ = why;
      Serial.print("WS close: ");
      Serial.print(why);
      if (strcmp(why, "SEND_ERROR") == 0) { Serial.print(" errno="); Serial.print(lastErrno_); }
      Serial.println();
    }
    if (haveClient_) client_.stop();
    haveClient_ = false;
    broken_ = false;
    handshaken_ = false;
    used_ = 0;
    if (wasOpen) handler_.onClosed(now);
  }

  WiFiServer server_;
  WiFiClient client_;
  const char* path_;
  Handler& handler_;
  uint8_t buffer_[1024];
  size_t used_ = 0;
  bool haveClient_ = false;
  bool handshaken_ = false;
  bool broken_ = false;
  uint32_t dropped_ = 0;
  uint32_t closes_ = 0;
  const char* lastCloseReason_ = "-";
  int lastErrno_ = 0;
};

}  // namespace follow
