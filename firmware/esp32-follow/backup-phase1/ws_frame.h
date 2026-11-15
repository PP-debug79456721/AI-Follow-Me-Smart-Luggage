// RFC 6455 frame codec, server side. Portable, no heap, no Arduino headers.
//
// Scope for Protocol v2 (messages are tiny, single JSON objects):
//   - client frames must be masked, server frames are not;
//   - fragmented messages (FIN = 0 or a continuation frame) are rejected;
//   - control frames (close, ping, pong) must have FIN and <= 125 bytes;
//   - a payload larger than the caller's limit is rejected (close 1009).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace follow {
namespace ws {

enum Opcode : uint8_t { kContinuation = 0x0, kText = 0x1, kBinary = 0x2, kClose = 0x8, kPing = 0x9, kPong = 0xA };

struct Frame {
  bool fin = false;
  uint8_t opcode = 0;
  size_t payloadLength = 0;
  uint8_t* payload = nullptr;   // points into the caller's buffer, already unmasked
};

constexpr long kIncomplete = 0;
constexpr long kProtocolError = -1;
constexpr long kTooLarge = -2;

// Parses one client frame from buf[0..n). Returns the bytes consumed (> 0), kIncomplete when
// more bytes are needed, or a negative error. Unmasks the payload in place.
inline long parseFrame(uint8_t* buf, size_t n, size_t maxPayload, Frame& out) {
  if (n < 2) return kIncomplete;
  const uint8_t b0 = buf[0];
  const uint8_t b1 = buf[1];
  const bool fin = (b0 & 0x80) != 0;
  const uint8_t opcode = b0 & 0x0F;
  if ((b0 & 0x70) != 0) return kProtocolError;          // reserved bits
  const bool masked = (b1 & 0x80) != 0;
  if (!masked) return kProtocolError;                   // clients must mask

  uint64_t length = b1 & 0x7F;
  size_t pos = 2;
  if (length == 126) {
    if (n < 4) return kIncomplete;
    length = (static_cast<uint64_t>(buf[2]) << 8) | buf[3];
    pos = 4;
  } else if (length == 127) {
    if (n < 10) return kIncomplete;
    length = 0;
    for (int i = 0; i < 8; i += 1) length = (length << 8) | buf[2 + i];
    pos = 10;
  }

  const bool control = (opcode & 0x08) != 0;
  if (control && (!fin || length > 125)) return kProtocolError;
  if (opcode == kContinuation || (!control && !fin)) return kProtocolError;   // no fragmentation
  if (opcode != kText && opcode != kBinary && !control) return kProtocolError;
  if (length > maxPayload) return kTooLarge;

  if (n < pos + 4) return kIncomplete;
  const uint8_t mask[4] = {buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]};
  pos += 4;
  if (n < pos + static_cast<size_t>(length)) return kIncomplete;

  uint8_t* payload = buf + pos;
  for (size_t i = 0; i < static_cast<size_t>(length); i += 1) payload[i] ^= mask[i & 3];

  out.fin = fin;
  out.opcode = opcode;
  out.payloadLength = static_cast<size_t>(length);
  out.payload = payload;
  return static_cast<long>(pos + static_cast<size_t>(length));
}

// Writes one unmasked server frame into out. Returns the length, or 0 if it does not fit.
inline size_t encodeFrame(uint8_t opcode, const uint8_t* payload, size_t length, uint8_t* out, size_t capacity) {
  size_t header;
  if (length < 126) header = 2;
  else if (length < 65536) header = 4;
  else return 0;
  if (capacity < header + length) return 0;

  out[0] = static_cast<uint8_t>(0x80 | (opcode & 0x0F));
  if (header == 2) {
    out[1] = static_cast<uint8_t>(length);
  } else {
    out[1] = 126;
    out[2] = static_cast<uint8_t>(length >> 8);
    out[3] = static_cast<uint8_t>(length & 0xFF);
  }
  if (length) memcpy(out + header, payload, length);
  return header + length;
}

}  // namespace ws
}  // namespace follow
