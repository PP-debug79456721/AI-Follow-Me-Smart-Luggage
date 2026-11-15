// Minimal JSON reader for Protocol v2 messages. No dependencies, no heap.
//
// It reads ONE top-level value and keeps only the fields Protocol v2 uses.
// The type of each field is kept (number, string, bool, null, other) because
// the protocol checks types exactly like the JavaScript mock does
// (Number.isInteger, typeof === "string", === 2). Nested values are skipped
// (depth <= kMaxDepth; deeper input is treated as invalid and ignored).
//
// JS semantics reproduced on purpose:
//   - a top-level array is an "object" (typeof [] === "object"): it has no
//     fields, but the device clock and timers still run for it;
//   - null, numbers, strings and booleans at the top level are ignored;
//   - duplicate keys: the last one wins; keys and strings may use escapes.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace follow {

enum class Kind : uint8_t { Absent, Number, String, Bool, Null, Other };

struct Field {
  Kind kind = Kind::Absent;
  double num = 0;
  bool boolean = false;
  char str[24] = {0};
  bool strTooLong = false;   // longer than the buffer: equal to no valid value

  bool isString() const { return kind == Kind::String; }
  bool equals(const char* text) const {
    return kind == Kind::String && !strTooLong && strcmp(str, text) == 0;
  }
  bool isInteger() const {
    return kind == Kind::Number && isfinite(num) && floor(num) == num;
  }
  bool isUint32() const { return isInteger() && num >= 0 && num <= 4294967295.0; }
  bool isSeq() const { return isInteger() && num >= 1 && num <= 4294967295.0; }
  bool isHex16() const {
    if (kind != Kind::String || strTooLong || strlen(str) != 16) return false;
    for (int i = 0; i < 16; i += 1) {
      const char c = str[i];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
  }
};

struct Message {
  bool isObject = false;   // an object or an array (JS typeof === "object")
  Field v, t, sid, seq, cmd, did, age, lease, tok, ackSeq, dn;
};

namespace json_detail {

constexpr int kMaxDepth = 8;

struct Reader {
  const char* p;
  const char* end;
  bool ok = true;

  // An explicit constructor: with a default member initializer Reader is not an
  // aggregate in C++11, so `Reader r{begin, end}` would not compile there.
  Reader(const char* begin, const char* finish) : p(begin), end(finish) {}

  void ws() {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p += 1;
  }
  bool more() const { return p < end; }
};

inline int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Reads a JSON string into out (decoded). Non-ASCII code points become 0xFF,
// which never equals any character a valid sid, command or type contains.
inline bool readString(Reader& r, char* out, size_t cap, bool& tooLong) {
  tooLong = false;
  size_t n = 0;
  if (!r.more() || *r.p != '"') return false;
  r.p += 1;
  auto put = [&](char c) {
    if (n + 1 < cap) out[n++] = c; else tooLong = true;
  };
  while (r.more()) {
    const unsigned char c = static_cast<unsigned char>(*r.p);
    if (c == '"') {
      r.p += 1;
      out[n < cap ? n : cap - 1] = '\0';
      return true;
    }
    if (c < 0x20) return false;
    if (c == '\\') {
      r.p += 1;
      if (!r.more()) return false;
      const char e = *r.p;
      r.p += 1;
      switch (e) {
        case '"': put('"'); break;
        case '\\': put('\\'); break;
        case '/': put('/'); break;
        case 'b': put('\b'); break;
        case 'f': put('\f'); break;
        case 'n': put('\n'); break;
        case 'r': put('\r'); break;
        case 't': put('\t'); break;
        case 'u': {
          if (r.end - r.p < 4) return false;
          int code = 0;
          for (int i = 0; i < 4; i += 1) {
            const int h = hexValue(r.p[i]);
            if (h < 0) return false;
            code = code * 16 + h;
          }
          r.p += 4;
          put(code < 0x80 ? static_cast<char>(code) : static_cast<char>(0xFF));
          break;
        }
        default: return false;
      }
      continue;
    }
    put(static_cast<char>(c));
    r.p += 1;
  }
  return false;
}

inline bool readNumber(Reader& r, double& value) {
  const char* start = r.p;
  const char* q = r.p;
  if (q < r.end && *q == '-') q += 1;
  if (q >= r.end) return false;
  if (*q == '0') {
    q += 1;
  } else if (*q >= '1' && *q <= '9') {
    while (q < r.end && *q >= '0' && *q <= '9') q += 1;
  } else {
    return false;
  }
  if (q < r.end && *q == '.') {
    q += 1;
    if (q >= r.end || *q < '0' || *q > '9') return false;
    while (q < r.end && *q >= '0' && *q <= '9') q += 1;
  }
  if (q < r.end && (*q == 'e' || *q == 'E')) {
    q += 1;
    if (q < r.end && (*q == '+' || *q == '-')) q += 1;
    if (q >= r.end || *q < '0' || *q > '9') return false;
    while (q < r.end && *q >= '0' && *q <= '9') q += 1;
  }
  char buffer[64];
  const size_t length = static_cast<size_t>(q - start);
  if (length >= sizeof(buffer)) return false;
  memcpy(buffer, start, length);
  buffer[length] = '\0';
  value = strtod(buffer, nullptr);
  r.p = q;
  return true;
}

inline bool literal(Reader& r, const char* word) {
  const size_t n = strlen(word);
  if (static_cast<size_t>(r.end - r.p) < n || memcmp(r.p, word, n) != 0) return false;
  r.p += n;
  return true;
}

inline bool skipValue(Reader& r, int depth);

inline bool skipContainer(Reader& r, char open, char close, int depth) {
  if (depth > kMaxDepth) return false;
  r.p += 1;   // open
  r.ws();
  if (r.more() && *r.p == close) { r.p += 1; return true; }
  for (;;) {
    r.ws();
    if (open == '{') {
      char key[8];
      bool tooLong = false;
      if (!readString(r, key, sizeof(key), tooLong)) return false;
      r.ws();
      if (!r.more() || *r.p != ':') return false;
      r.p += 1;
      r.ws();
    }
    if (!skipValue(r, depth + 1)) return false;
    r.ws();
    if (!r.more()) return false;
    if (*r.p == ',') { r.p += 1; continue; }
    if (*r.p == close) { r.p += 1; return true; }
    return false;
  }
}

inline bool skipValue(Reader& r, int depth) {
  r.ws();
  if (!r.more()) return false;
  char scratch[8];
  bool tooLong = false;
  double number = 0;
  switch (*r.p) {
    case '{': return skipContainer(r, '{', '}', depth);
    case '[': return skipContainer(r, '[', ']', depth);
    case '"': return readString(r, scratch, sizeof(scratch), tooLong);
    case 't': return literal(r, "true");
    case 'f': return literal(r, "false");
    case 'n': return literal(r, "null");
    default: return readNumber(r, number);
  }
}

// Reads the value at r.p into a Field (scalars) or skips it (containers).
inline bool readField(Reader& r, Field& field, int depth) {
  r.ws();
  if (!r.more()) return false;
  Field fresh;
  switch (*r.p) {
    case '"': {
      fresh.kind = Kind::String;
      if (!readString(r, fresh.str, sizeof(fresh.str), fresh.strTooLong)) return false;
      break;
    }
    case 't':
      if (!literal(r, "true")) return false;
      fresh.kind = Kind::Bool; fresh.boolean = true;
      break;
    case 'f':
      if (!literal(r, "false")) return false;
      fresh.kind = Kind::Bool; fresh.boolean = false;
      break;
    case 'n':
      if (!literal(r, "null")) return false;
      fresh.kind = Kind::Null;
      break;
    case '{':
    case '[':
      if (!skipValue(r, depth)) return false;
      fresh.kind = Kind::Other;
      break;
    default:
      fresh.kind = Kind::Number;
      if (!readNumber(r, fresh.num)) return false;
      break;
  }
  field = fresh;
  return true;
}

inline Field* fieldFor(Message& m, const char* key) {
  if (strcmp(key, "v") == 0) return &m.v;
  if (strcmp(key, "t") == 0) return &m.t;
  if (strcmp(key, "sid") == 0) return &m.sid;
  if (strcmp(key, "seq") == 0) return &m.seq;
  if (strcmp(key, "cmd") == 0) return &m.cmd;
  if (strcmp(key, "did") == 0) return &m.did;
  if (strcmp(key, "age") == 0) return &m.age;
  if (strcmp(key, "lease") == 0) return &m.lease;
  if (strcmp(key, "tok") == 0) return &m.tok;
  if (strcmp(key, "ackSeq") == 0) return &m.ackSeq;
  if (strcmp(key, "dn") == 0) return &m.dn;
  return nullptr;
}

}  // namespace json_detail

// Returns false for text that is not valid JSON (the caller ignores it).
// On true, out.isObject tells whether the value is an object or an array.
inline bool parseMessage(const char* text, size_t length, Message& out) {
  using namespace json_detail;
  out = Message();
  Reader r{text, text + length};
  r.ws();
  if (!r.more()) return false;

  if (*r.p == '[') {
    if (!skipValue(r, 1)) return false;
    r.ws();
    if (r.more()) return false;
    out.isObject = true;
    return true;
  }

  if (*r.p != '{') {
    if (!skipValue(r, 1)) return false;
    r.ws();
    if (r.more()) return false;
    out.isObject = false;          // null, number, string, bool: ignored
    return true;
  }

  r.p += 1;
  r.ws();
  if (r.more() && *r.p == '}') {
    r.p += 1;
    r.ws();
    out.isObject = !r.more();
    return out.isObject;
  }

  for (;;) {
    r.ws();
    char key[16];
    bool keyTooLong = false;
    if (!readString(r, key, sizeof(key), keyTooLong)) return false;
    r.ws();
    if (!r.more() || *r.p != ':') return false;
    r.p += 1;

    Field* slot = keyTooLong ? nullptr : fieldFor(out, key);
    if (slot) {
      if (!readField(r, *slot, 2)) return false;
    } else if (!skipValue(r, 2)) {
      return false;
    }

    r.ws();
    if (!r.more()) return false;
    if (*r.p == ',') { r.p += 1; continue; }
    if (*r.p == '}') { r.p += 1; break; }
    return false;
  }

  r.ws();
  if (r.more()) return false;
  out.isObject = true;
  return true;
}

}  // namespace follow
