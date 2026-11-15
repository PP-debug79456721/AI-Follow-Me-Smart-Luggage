// Host tests for the safety kernel, interlock, motor HAL plan and the WebSocket
// codec/handshake. Run by tests/firmware-host.test.mjs. HOST ONLY: nothing here
// runs on an ESP32, touches a GPIO or proves real-board behavior.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "../safety.h"
#include "../ws_frame.h"
#include "../ws_handshake.h"

using namespace follow;

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond) do { g_checks += 1; if (!(cond)) { g_failures += 1; printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)

namespace {

struct SeqRandom : Random32 {
  uint32_t n = 1000;
  uint32_t next() override { n += 7919; return n; }
};

struct Sink : ReplySink {
  std::vector<std::string> out;
  void send(const char* json, size_t length) override { out.emplace_back(json, length); }
  const std::string& last() const { return out.back(); }
};

struct Recorder : Observer {
  struct M { double at; Motor command; std::string reason; };
  std::vector<M> motors;
  void onMotor(double at, Motor c, const char* r) override { motors.push_back({at, c, r}); }
  bool stoppedFor(const char* reason) const {
    for (const auto& m : motors) if (m.command == Motor::Stop && m.reason == reason) return true;
    return false;
  }
};

uint32_t numberAfter(const std::string& text, const char* key) {
  const size_t at = text.find(key);
  if (at == std::string::npos) return 0;
  return static_cast<uint32_t>(strtoul(text.c_str() + at + strlen(key), nullptr, 10));
}

bool contains(const std::string& text, const char* part) { return text.find(part) != std::string::npos; }

const char* SID = "a1b2c3d4e5f60718";

struct Rig {
  SeqRandom rng;
  Sink sink;
  Recorder rec;
  Protocol protocol{&rng, &sink, &rec};
  LockedMotorHal hal;
  Interlock interlock;
  SafetyKernel kernel{protocol, hal, interlock};
  double now = 1000;
  uint32_t seq = 2;
  uint32_t ackSeq = 2;
  uint32_t tok = 0;
  uint32_t did = 0;

  explicit Rig(const InterlockConfig& cfg = InterlockConfig()) : interlock(cfg) { kernel.init(now); }

  void raw(const char* json) { kernel.onMessage(json, strlen(json), now); }

  void absorb() {
    const std::string& r = sink.last();
    if (contains(r, "\"ok\":true") && !contains(r, "\"tok\":null")) {
      tok = numberAfter(r, "\"tok\":");
      ackSeq = numberAfter(r, "\"seq\":");
    }
  }

  void open() {
    char buffer[256];
    snprintf(buffer, sizeof(buffer), "{\"v\":2,\"t\":\"HELLO\",\"sid\":\"%s\",\"seq\":1}", SID);
    raw(buffer);
    const uint32_t dn = numberAfter(sink.last(), "\"dn\":");
    now += 10;
    snprintf(buffer, sizeof(buffer), "{\"v\":2,\"t\":\"ARM\",\"sid\":\"%s\",\"seq\":2,\"dn\":%u}", SID, dn);
    raw(buffer);
    absorb();
    seq = 2;
    did = 0;
  }

  void stop() {
    char buffer[256];
    seq += 1;
    snprintf(buffer, sizeof(buffer), "{\"v\":2,\"t\":\"CMD\",\"sid\":\"%s\",\"seq\":%u,\"cmd\":\"STOP\"}", SID, seq);
    raw(buffer);
    absorb();
  }

  // Sends a movement CMD with the next did (or the given one).
  void move(const char* cmd, uint32_t withDid = 0) {
    char buffer[320];
    seq += 1;
    if (withDid == 0) { did += 1; withDid = did; }
    snprintf(buffer, sizeof(buffer),
             "{\"v\":2,\"t\":\"CMD\",\"sid\":\"%s\",\"seq\":%u,\"cmd\":\"%s\",\"did\":%u,\"age\":30,\"lease\":600,"
             "\"tok\":%u,\"ackSeq\":%u}", SID, seq, cmd, withDid, tok, ackSeq);
    raw(buffer);
    absorb();
  }

  void advance(double ms, double step = 10) {
    for (double spent = 0; spent < ms; spent += step) {
      now += step;
      kernel.tick(now);
    }
  }

  void readings(EchoStatus status, uint32_t mm, int times = 2) {
    for (int i = 0; i < times; i += 1) {
      for (int s = 0; s < Interlock::kSensors; s += 1) {
        Reading r;
        r.status = status;
        r.distanceMm = mm;
        r.at = now;
        kernel.onReading(s, r, now);
      }
    }
  }
};

InterlockConfig configured() {
  InterlockConfig c;
  c.stopDistanceMm = 500;    // a TEST value only: the real stop distance is undecided
  return c;
}

/* ---------------- kernel and motor lock ---------------- */

void test_boot_is_locked_and_latched() {
  Rig rig;
  CHECK(rig.protocol.state() == DeviceState::BootLatched);
  CHECK(rig.hal.requested() == Motor::Stop);
  CHECK(rig.hal.writes() >= 1);
  CHECK(!rig.hal.physicalOutputEnabled());
  CHECK(!LockedMotorHal::kPhysicalOutputEnabled);
  CHECK(rig.interlock.blocked());   // no stop distance, no readings: blocked from the start
}

void test_unconfigured_interlock_cancels_accepted_movement() {
  Rig rig;
  rig.open();
  rig.stop();
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(contains(rig.sink.last(), "\"ok\":true"));            // the protocol accepted a valid CMD
  CHECK(contains(rig.sink.last(), "\"motor\":\"STOP\""));     // but the ACK does not claim movement
  CHECK(rig.protocol.state() == DeviceState::Idle);           // cancelled in the same kernel step
  CHECK(rig.protocol.motor() == Motor::Stop);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);
  CHECK(rig.hal.requested() == Motor::Stop);
  CHECK(rig.hal.suppressedMovements() == 0);                  // movement never even reached the HAL
}

void test_configured_interlock_lets_the_protocol_decide_but_output_stays_locked() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  CHECK(!rig.interlock.blocked());
  rig.open();
  rig.stop();
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(rig.protocol.motor() == Motor::Forward);
  CHECK(rig.kernel.effectiveMotor() == Motor::Forward);
  CHECK(rig.hal.requested() == Motor::Forward);
  CHECK(rig.hal.suppressedMovements() >= 1);                  // asked to move, the lock suppressed it
  CHECK(!rig.hal.physicalOutputEnabled());
}

void test_obstacle_stops_at_once_and_never_resumes_by_itself() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  rig.open();
  rig.stop();
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(rig.protocol.motor() == Motor::Forward);

  Reading close;
  close.status = EchoStatus::Distance;
  close.distanceMm = 400;
  close.at = rig.now;
  rig.kernel.onReading(0, close, rig.now);
  CHECK(rig.interlock.reason() == BlockReason::TooClose);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);          // same step
  CHECK(rig.protocol.state() == DeviceState::Idle);           // no latch: a lease-style stop
  CHECK(rig.rec.stoppedFor("INTERLOCK"));

  rig.now += 20;
  rig.readings(EchoStatus::Distance, 900);                    // the obstacle clears
  CHECK(!rig.interlock.blocked());
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);          // nothing resumed
  rig.advance(100);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);

  rig.now += 20;
  rig.move("FORWARD", rig.did);                               // the same did: invalidated
  CHECK(contains(rig.sink.last(), "\"reason\":\"EXPIRED\""));
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);

  rig.now += 150;
  rig.move("FORWARD");                                        // a fresh did and a valid CMD
  CHECK(rig.kernel.effectiveMotor() == Motor::Forward);
}

void test_movement_cmd_during_a_block_is_cancelled() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  rig.open();
  rig.stop();
  Reading close;
  close.status = EchoStatus::Distance;
  close.distanceMm = 300;
  close.at = rig.now;
  rig.kernel.onReading(1, close, rig.now);
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(rig.hal.requested() == Motor::Stop);
  CHECK(rig.protocol.state() == DeviceState::Idle);
  rig.readings(EchoStatus::Distance, 900);                    // clears afterwards
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);          // the earlier CMD does not move it now
}

void test_sensor_failures_block() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  CHECK(!rig.interlock.blocked());

  Reading none;
  none.status = EchoStatus::NoEcho;
  none.at = rig.now;
  rig.kernel.onReading(0, none, rig.now);
  CHECK(rig.interlock.reason() == BlockReason::NoEcho);

  rig.readings(EchoStatus::Distance, 900, 1);
  CHECK(rig.interlock.blocked());                             // one good reading is not enough
  CHECK(rig.interlock.reason() == BlockReason::Debouncing);
  rig.readings(EchoStatus::Distance, 900, 1);
  CHECK(!rig.interlock.blocked());

  rig.advance(400);                                           // no new readings: stale
  CHECK(rig.interlock.reason() == BlockReason::Stale);

  Reading gone;
  gone.status = EchoStatus::Unavailable;
  gone.at = rig.now;
  rig.kernel.onReading(1, gone, rig.now);
  CHECK(rig.interlock.blocked());
}

void test_clear_status_counts_as_free() {
  Rig rig(configured());
  rig.readings(EchoStatus::Clear, 0);
  CHECK(!rig.interlock.blocked());
}

void test_transport_closed_stops_without_latch_then_timers_latch() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  rig.open();
  rig.stop();
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(rig.kernel.effectiveMotor() == Motor::Forward);

  rig.kernel.onTransportClosed(rig.now);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);
  CHECK(rig.protocol.state() == DeviceState::Idle);
  CHECK(rig.rec.stoppedFor("LINK_CLOSED"));

  rig.readings(EchoStatus::Distance, 900);
  rig.advance(580);
  CHECK(rig.protocol.state() == DeviceState::Idle);           // the liveness timer is still running
  rig.readings(EchoStatus::Distance, 900);
  rig.advance(100);
  CHECK(rig.protocol.state() == DeviceState::Latched);        // session liveness latched by itself
  CHECK(strcmp(rig.protocol.latchReason(), "IDLE_TIMEOUT") == 0);
}

void test_movement_watchdog_latches_independently() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  rig.open();
  rig.stop();
  rig.now += 10;
  char buffer[320];
  rig.seq += 1;
  rig.did += 1;
  snprintf(buffer, sizeof(buffer),
           "{\"v\":2,\"t\":\"CMD\",\"sid\":\"%s\",\"seq\":%u,\"cmd\":\"FORWARD\",\"did\":%u,\"age\":0,\"lease\":700,"
           "\"tok\":%u,\"ackSeq\":%u}", SID, rig.seq, rig.did, rig.tok, rig.ackSeq);
  rig.raw(buffer);
  rig.absorb();
  CHECK(rig.kernel.effectiveMotor() == Motor::Forward);

  // Keep the sensors fresh so only the protocol timers act.
  for (int i = 0; i < 62; i += 1) {
    rig.now += 10;
    rig.readings(EchoStatus::Distance, 900, 1);
    rig.kernel.tick(rig.now);
  }
  CHECK(rig.protocol.state() == DeviceState::Latched);
  CHECK(strcmp(rig.protocol.latchReason(), "WATCHDOG") == 0);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);
  CHECK(rig.protocol.counters().idleTimeouts == 0);
}

void test_estop_latches_and_nothing_moves() {
  Rig rig(configured());
  rig.readings(EchoStatus::Distance, 900);
  rig.open();
  rig.stop();
  rig.now += 150;
  rig.move("FORWARD");
  rig.now += 10;
  rig.raw("{\"v\":2,\"t\":\"ESTOP\",\"sid\":\"a1b2c3d4e5f60718\"}");
  CHECK(rig.protocol.state() == DeviceState::Latched);
  CHECK(strcmp(rig.protocol.latchReason(), "ESTOP") == 0);
  CHECK(rig.kernel.effectiveMotor() == Motor::Stop);
  rig.now += 150;
  rig.move("FORWARD");
  CHECK(contains(rig.sink.last(), "\"ok\":false"));
  CHECK(rig.hal.requested() == Motor::Stop);
}

/* ---------------- motor plan ---------------- */

void test_plan_defaults_to_no_output() {
  DriveConfig cfg;                                            // dutyCap 0: unset
  for (Motor m : {Motor::Stop, Motor::Forward, Motor::Left, Motor::Right}) {
    const HalPlan p = planFor(m, cfg);
    CHECK(p.left.rpwm == 0 && p.left.lpwm == 0 && !p.left.rEn && !p.left.lEn);
    CHECK(p.right.rpwm == 0 && p.right.lpwm == 0 && !p.right.rEn && !p.right.lEn);
  }
}

void test_plan_never_drives_both_directions() {
  DriveConfig cfg;
  cfg.dutyCap = 0.3f;
  cfg.turnInnerFraction = 0.5f;
  for (Motor m : {Motor::Stop, Motor::Forward, Motor::Left, Motor::Right}) {
    const HalPlan p = planFor(m, cfg);
    CHECK(!(p.left.rpwm > 0 && p.left.lpwm > 0));
    CHECK(!(p.right.rpwm > 0 && p.right.lpwm > 0));
    CHECK(p.left.lpwm == 0 && p.right.lpwm == 0);              // no reverse command exists
  }
  const HalPlan stop = planFor(Motor::Stop, cfg);
  CHECK(!stop.left.rEn && !stop.right.lEn);
  const HalPlan forward = planFor(Motor::Forward, cfg);
  CHECK(forward.left.rpwm == 0.3f && forward.right.rpwm == 0.3f && forward.left.rEn && forward.right.lEn);
  const HalPlan left = planFor(Motor::Left, cfg);
  CHECK(left.left.rpwm < left.right.rpwm);
  const HalPlan right = planFor(Motor::Right, cfg);
  CHECK(right.right.rpwm < right.left.rpwm);
}

/* ---------------- WebSocket ---------------- */

std::string hex(const uint8_t* d, size_t n) {
  std::string s;
  char b[4];
  for (size_t i = 0; i < n; i += 1) { snprintf(b, sizeof(b), "%02x", d[i]); s += b; }
  return s;
}

void test_sha1_and_accept_key() {
  uint8_t out[20];
  ws::sha1(reinterpret_cast<const uint8_t*>("abc"), 3, out);
  CHECK(hex(out, 20) == "a9993e364706816aba3e25717850c26c9cd0d89d");
  const char* two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";   // 56 bytes: two-block padding
  ws::sha1(reinterpret_cast<const uint8_t*>(two), strlen(two), out);
  CHECK(hex(out, 20) == "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  ws::sha1(reinterpret_cast<const uint8_t*>(""), 0, out);
  CHECK(hex(out, 20) == "da39a3ee5e6b4b0d3255bfef95601890afd80709");

  char accept[40];
  CHECK(ws::acceptKey("dGhlIHNhbXBsZSBub25jZQ==", accept, sizeof(accept)));     // RFC 6455 section 1.3
  CHECK(strcmp(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0);
}

void test_handshake_request() {
  const char* good =
      "GET /ws HTTP/1.1\r\nHost: 192.168.1.50:81\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:8080\r\n\r\n";
  char response[256];
  size_t n = ws::buildHandshakeResponse(good, strlen(good), "/ws", response, sizeof(response));
  CHECK(n > 0);
  CHECK(strstr(response, "101 Switching Protocols") != nullptr);
  CHECK(strstr(response, "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") != nullptr);

  const char* lower =
      "GET /ws HTTP/1.1\r\nupgrade: WebSocket\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "sec-websocket-version: 13\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(lower, strlen(lower), "/ws", response, sizeof(response)) > 0);

  const char* wrongPath = "GET /other HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(wrongPath, strlen(wrongPath), "/ws", response, sizeof(response)) == 0);
  const char* noKey = "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(noKey, strlen(noKey), "/ws", response, sizeof(response)) == 0);
  const char* badVersion = "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 8\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(badVersion, strlen(badVersion), "/ws", response, sizeof(response)) == 0);
  const char* notWs = "GET /ws HTTP/1.1\r\nHost: x\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(notWs, strlen(notWs), "/ws", response, sizeof(response)) == 0);
  const char* post = "POST /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n";
  CHECK(ws::buildHandshakeResponse(post, strlen(post), "/ws", response, sizeof(response)) == 0);
}

void test_frames() {
  // RFC 6455 section 5.7: a single-frame masked text message "Hello".
  uint8_t masked[] = {0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  ws::Frame f;
  long n = ws::parseFrame(masked, sizeof(masked), 64, f);
  CHECK(n == static_cast<long>(sizeof(masked)));
  CHECK(f.opcode == ws::kText && f.fin && f.payloadLength == 5 && memcmp(f.payload, "Hello", 5) == 0);

  uint8_t partial[] = {0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f};
  CHECK(ws::parseFrame(partial, sizeof(partial), 64, f) == ws::kIncomplete);
  CHECK(ws::parseFrame(partial, 1, 64, f) == ws::kIncomplete);

  uint8_t unmasked[] = {0x81, 0x05, 'H', 'e', 'l', 'l', 'o'};          // clients must mask
  CHECK(ws::parseFrame(unmasked, sizeof(unmasked), 64, f) == ws::kProtocolError);

  uint8_t fragmented[] = {0x01, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  CHECK(ws::parseFrame(fragmented, sizeof(fragmented), 64, f) == ws::kProtocolError);
  uint8_t continuation[] = {0x80, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  CHECK(ws::parseFrame(continuation, sizeof(continuation), 64, f) == ws::kProtocolError);
  uint8_t reserved[] = {0xC1, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  CHECK(ws::parseFrame(reserved, sizeof(reserved), 64, f) == ws::kProtocolError);

  uint8_t big[] = {0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  CHECK(ws::parseFrame(big, sizeof(big), 3, f) == ws::kTooLarge);

  uint8_t ping[] = {0x89, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};
  CHECK(ws::parseFrame(ping, sizeof(ping), 64, f) > 0 && f.opcode == ws::kPing);

  uint8_t closeFrame[] = {0x88, 0x82, 0x01, 0x02, 0x03, 0x04, 0x02, 0xEB};   // close 1000
  CHECK(ws::parseFrame(closeFrame, sizeof(closeFrame), 64, f) > 0 && f.opcode == ws::kClose);

  // A 200-byte masked frame uses the 16-bit length.
  std::vector<uint8_t> wide(4 + 4 + 200);
  wide[0] = 0x81; wide[1] = 0x80 | 126; wide[2] = 0; wide[3] = 200;
  const uint8_t mask[4] = {1, 2, 3, 4};
  memcpy(&wide[4], mask, 4);
  for (int i = 0; i < 200; i += 1) wide[8 + i] = static_cast<uint8_t>('a' ^ mask[i & 3]);
  CHECK(ws::parseFrame(wide.data(), wide.size(), 256, f) == static_cast<long>(wide.size()));
  CHECK(f.payloadLength == 200 && f.payload[0] == 'a' && f.payload[199] == 'a');

  // Two frames back to back are parsed one at a time.
  const uint8_t helloMasked[11] = {0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58};   // parseFrame unmasks in place
  uint8_t two[22];
  memcpy(two, helloMasked, 11);
  memcpy(two + 11, helloMasked, 11);
  n = ws::parseFrame(two, sizeof(two), 64, f);
  CHECK(n == 11);
  n = ws::parseFrame(two + 11, sizeof(two) - 11, 64, f);
  CHECK(n == 11 && memcmp(f.payload, "Hello", 5) == 0);

  // Server frames are unmasked.
  uint8_t out[16];
  CHECK(ws::encodeFrame(ws::kText, reinterpret_cast<const uint8_t*>("Hello"), 5, out, sizeof(out)) == 7);
  CHECK(out[0] == 0x81 && out[1] == 0x05 && memcmp(out + 2, "Hello", 5) == 0);
  uint8_t tiny[3];
  CHECK(ws::encodeFrame(ws::kText, reinterpret_cast<const uint8_t*>("Hello"), 5, tiny, sizeof(tiny)) == 0);
  std::vector<uint8_t> payload(200, 'z'), frame(220);
  CHECK(ws::encodeFrame(ws::kText, payload.data(), payload.size(), frame.data(), frame.size()) == 204);
  CHECK(frame[1] == 126 && frame[2] == 0 && frame[3] == 200);
}

}  // namespace

int main() {
  test_boot_is_locked_and_latched();
  test_unconfigured_interlock_cancels_accepted_movement();
  test_configured_interlock_lets_the_protocol_decide_but_output_stays_locked();
  test_obstacle_stops_at_once_and_never_resumes_by_itself();
  test_movement_cmd_during_a_block_is_cancelled();
  test_sensor_failures_block();
  test_clear_status_counts_as_free();
  test_transport_closed_stops_without_latch_then_timers_latch();
  test_movement_watchdog_latches_independently();
  test_estop_latches_and_nothing_moves();
  test_plan_defaults_to_no_output();
  test_plan_never_drives_both_directions();
  test_sha1_and_accept_key();
  test_handshake_request();
  test_frames();

  printf("checks=%d failures=%d\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
