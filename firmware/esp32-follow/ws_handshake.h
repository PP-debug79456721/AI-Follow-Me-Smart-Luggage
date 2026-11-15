// WebSocket opening handshake (server side): request parsing, SHA-1 and
// Base64 for Sec-WebSocket-Accept. Portable, no heap, no mbedtls needed.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace follow {
namespace ws {

// ---------- SHA-1 (RFC 3174) ----------

inline uint32_t rol32(uint32_t v, int s) { return (v << s) | (v >> (32 - s)); }

inline void sha1Block(uint32_t h[5], const uint8_t* block) {
  uint32_t w[80];
  for (int i = 0; i < 16; i += 1) {
    w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) | (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
           (static_cast<uint32_t>(block[i * 4 + 2]) << 8) | static_cast<uint32_t>(block[i * 4 + 3]);
  }
  for (int i = 16; i < 80; i += 1) w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (int i = 0; i < 80; i += 1) {
    uint32_t f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
    else { f = b ^ c ^ d; k = 0xCA62C1D6; }
    const uint32_t temp = rol32(a, 5) + f + e + k + w[i];
    e = d; d = c; c = rol32(b, 30); b = a; a = temp;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
}

inline void sha1(const uint8_t* data, size_t length, uint8_t out[20]) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};

  const size_t full = length / 64;
  for (size_t i = 0; i < full; i += 1) sha1Block(h, data + i * 64);

  uint8_t tail[128];
  const size_t rest = length - full * 64;
  if (rest) memcpy(tail, data + full * 64, rest);
  tail[rest] = 0x80;
  const size_t tailLength = rest < 56 ? 64 : 128;
  memset(tail + rest + 1, 0, tailLength - rest - 1);
  const uint64_t bits = static_cast<uint64_t>(length) * 8;
  for (int i = 0; i < 8; i += 1) tail[tailLength - 1 - i] = static_cast<uint8_t>(bits >> (8 * i));
  sha1Block(h, tail);
  if (tailLength == 128) sha1Block(h, tail + 64);

  for (int i = 0; i < 5; i += 1) {
    out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
  }
}

inline size_t base64(const uint8_t* in, size_t n, char* out, size_t capacity) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    const uint32_t v = (static_cast<uint32_t>(in[i]) << 16) | (i + 1 < n ? static_cast<uint32_t>(in[i + 1]) << 8 : 0) |
                       (i + 2 < n ? in[i + 2] : 0);
    if (o + 4 >= capacity) return 0;
    out[o++] = table[(v >> 18) & 63];
    out[o++] = table[(v >> 12) & 63];
    out[o++] = i + 1 < n ? table[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? table[v & 63] : '=';
  }
  out[o] = '\0';
  return o;
}

// accept must hold at least 29 bytes.
inline bool acceptKey(const char* key, char* accept, size_t capacity) {
  static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  char joined[128];
  const int n = snprintf(joined, sizeof(joined), "%s%s", key, kGuid);
  if (n <= 0 || static_cast<size_t>(n) >= sizeof(joined)) return false;
  uint8_t digest[20];
  sha1(reinterpret_cast<const uint8_t*>(joined), static_cast<size_t>(n), digest);
  return base64(digest, 20, accept, capacity) > 0;
}

// ---------- request parsing ----------

inline bool iequalsN(const char* a, const char* b, size_t n) {
  for (size_t i = 0; i < n; i += 1) {
    char x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x = static_cast<char>(x + 32);
    if (y >= 'A' && y <= 'Z') y = static_cast<char>(y + 32);
    if (x != y) return false;
  }
  return true;
}

// Finds a header value (case-insensitive name) in a request that ends in CRLFCRLF.
inline bool headerValue(const char* request, size_t length, const char* name, char* out, size_t capacity) {
  const size_t nameLength = strlen(name);
  const char* end = request + length;
  const char* line = request;
  while (line < end) {
    const char* eol = static_cast<const char*>(memchr(line, '\n', static_cast<size_t>(end - line)));
    if (!eol) eol = end;
    if (static_cast<size_t>(eol - line) > nameLength + 1 && iequalsN(line, name, nameLength) && line[nameLength] == ':') {
      const char* v = line + nameLength + 1;
      while (v < eol && (*v == ' ' || *v == '\t')) v += 1;
      const char* ve = eol;
      while (ve > v && (ve[-1] == '\r' || ve[-1] == ' ' || ve[-1] == '\t')) ve -= 1;
      const size_t vl = static_cast<size_t>(ve - v);
      if (vl + 1 > capacity) return false;
      memcpy(out, v, vl);
      out[vl] = '\0';
      return true;
    }
    line = eol + 1;
  }
  return false;
}

// Validates a GET <path> upgrade request and writes the 101 response. Returns the response
// length, or 0 when the request is not an acceptable WebSocket upgrade for `path`.
inline size_t buildHandshakeResponse(const char* request, size_t length, const char* path, char* out, size_t capacity) {
  const size_t pathLength = strlen(path);
  if (length < 5 + pathLength || memcmp(request, "GET ", 4) != 0) return 0;
  if (memcmp(request + 4, path, pathLength) != 0) return 0;
  const char after = request[4 + pathLength];
  if (after != ' ' && after != '?') return 0;

  char value[96];
  if (!headerValue(request, length, "Upgrade", value, sizeof(value)) || !iequalsN(value, "websocket", 9)) return 0;
  if (!headerValue(request, length, "Sec-WebSocket-Version", value, sizeof(value)) || strcmp(value, "13") != 0) return 0;

  char key[64];
  if (!headerValue(request, length, "Sec-WebSocket-Key", key, sizeof(key))) return 0;
  char accept[40];
  if (!acceptKey(key, accept, sizeof(accept))) return 0;

  const int n = snprintf(out, capacity,
                         "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         "Sec-WebSocket-Accept: %s\r\n\r\n", accept);
  return (n > 0 && static_cast<size_t>(n) < capacity) ? static_cast<size_t>(n) : 0;
}

}  // namespace ws
}  // namespace follow
