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
#pragma once

#include <WiFi.h>
#include <string.h>

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
    return client_.write(frame, n) == n;
  }

  void poll(double now) {
    WiFiClient incoming = server_.available();
    if (incoming) {
      closeClient(now);                    // replaces the previous socket
      client_ = incoming;
      client_.setNoDelay(true);
      used_ = 0;
      handshaken_ = false;
      haveClient_ = true;
    }

    if (!haveClient_) return;
    if (!client_.connected()) {
      closeClient(now);
      return;
    }

    while (client_.available() > 0 && used_ < sizeof(buffer_)) {
      const int got = client_.read(buffer_ + used_, sizeof(buffer_) - used_);
      if (got <= 0) break;
      used_ += static_cast<size_t>(got);
    }

    if (!handshaken_) {
      if (!tryHandshake()) {
        if (used_ >= sizeof(buffer_)) closeClient(now);   // oversized request
        return;
      }
    }

    for (;;) {
      ws::Frame frame;
      const long consumed = ws::parseFrame(buffer_, used_, kMaxPayload, frame);
      if (consumed == ws::kIncomplete) {
        if (used_ >= sizeof(buffer_)) { sendClose(1009); closeClient(now); }
        return;
      }
      if (consumed < 0) {
        sendClose(consumed == ws::kTooLarge ? 1009 : 1002);
        closeClient(now);
        return;
      }

      switch (frame.opcode) {
        case ws::kText:
          handler_.onText(reinterpret_cast<const char*>(frame.payload), frame.payloadLength, now);
          break;
        case ws::kPing: {
          uint8_t pong[140];
          const size_t n = ws::encodeFrame(ws::kPong, frame.payload, frame.payloadLength, pong, sizeof(pong));
          if (n) client_.write(pong, n);
          break;
        }
        case ws::kPong:
          break;
        case ws::kClose:
          sendClose(1000);
          closeClient(now);
          return;
        default:                           // binary: not used by Protocol v2
          sendClose(1003);
          closeClient(now);
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
        client_.write(reinterpret_cast<const uint8_t*>(response), n);
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
    if (n) client_.write(frame, n);
  }

  void closeClient(double now) {
    const bool wasOpen = haveClient_ && handshaken_;
    if (haveClient_) client_.stop();
    haveClient_ = false;
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
};

}  // namespace follow
