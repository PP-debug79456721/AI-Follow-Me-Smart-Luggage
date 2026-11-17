// Host tests for the transport layer (BLE framing, queue, router) and for two transports feeding
// ONE protocol/safety kernel. HOST ONLY: nothing here touches Wi-Fi, BLE or a board.
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "../ble_framing.h"
#include "../safety.h"
#include "../transport_router.h"

using namespace follow;

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond) do { g_checks += 1; if (!(cond)) { g_failures += 1; printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)

namespace {

bool contains(const std::string& text, const char* part) { return text.find(part) != std::string::npos; }

uint32_t numberAfter(const std::string& text, const char* key) {
  const size_t at = text.find(key);
  if (at == std::string::npos) return 0;
  return static_cast<uint32_t>(strtoul(text.c_str() + at + strlen(key), nullptr, 10));
}

struct FakeChannel : Channel {
  std::vector<std::string> out;
  bool accept = true;
  bool sendText(const char* json, size_t length) override {
    if (!accept) return false;
    out.emplace_back(json, length);
    return true;
  }
};

struct FakeTarget : RouterTarget {
  std::vector<std::string> messages;
  int closes = 0;
  ReplySink* reply = nullptr;       // answers every message, like the protocol does
  void onMessage(const char* text, size_t length, double) override {
    messages.emplace_back(text, length);
    if (reply) reply->send("reply", 5);
  }
  void onTransportClosed(double) override { closes += 1; }
};

/* ---------- LineAssembler ---------- */

void testAssembler() {
  ble::LineAssembler a;
  std::vector<std::string> lines;
  auto sink = [&](const char* s, size_t n) { lines.emplace_back(s, n); };
  const char* one = "{\"a\":1}\n";

  // one message cut into 3 writes
  a.feed(reinterpret_cast<const uint8_t*>(one), 3, sink);
  CHECK(lines.empty());
  a.feed(reinterpret_cast<const uint8_t*>(one) + 3, 3, sink);
  CHECK(lines.empty());
  a.feed(reinterpret_cast<const uint8_t*>(one) + 6, 2, sink);
  CHECK(lines.size() == 1 && lines[0] == "{\"a\":1}");

  // two messages in one write, CRLF and empty lines ignored
  lines.clear();
  const char* many = "x1\r\n\n\r\nx2\nx3";
  a.feed(reinterpret_cast<const uint8_t*>(many), strlen(many), sink);
  CHECK(lines.size() == 2 && lines[0] == "x1" && lines[1] == "x2");
  a.feed(reinterpret_cast<const uint8_t*>("\n"), 1, sink);
  CHECK(lines.size() == 3 && lines[2] == "x3");

  // a line longer than kMaxLine is dropped whole, the next line is fine
  lines.clear();
  std::string longLine(ble::kMaxLine + 50, 'z');
  longLine += "\nok\n";
  a.feed(reinterpret_cast<const uint8_t*>(longLine.data()), longLine.size(), sink);
  CHECK(lines.size() == 1 && lines[0] == "ok");
  CHECK(a.overflows() == 1);

  // exactly kMaxLine bytes is still accepted
  lines.clear();
  std::string exact(ble::kMaxLine, 'q');
  exact += "\n";
  a.feed(reinterpret_cast<const uint8_t*>(exact.data()), exact.size(), sink);
  CHECK(lines.size() == 1 && lines[0].size() == ble::kMaxLine);

  // reset drops a half-received line
  lines.clear();
  a.feed(reinterpret_cast<const uint8_t*>("half"), 4, sink);
  a.reset();
  a.feed(reinterpret_cast<const uint8_t*>("new\n"), 4, sink);
  CHECK(lines.size() == 1 && lines[0] == "new");
}

/* ---------- frameLine / chunkPayload ---------- */

void testFraming() {
  uint8_t buf[16];
  CHECK(ble::frameLine("abc", 3, buf, sizeof(buf)) == 4);
  CHECK(buf[3] == '\n' && memcmp(buf, "abc", 3) == 0);
  CHECK(ble::frameLine("", 0, buf, sizeof(buf)) == 0);
  CHECK(ble::frameLine("0123456789abcdef", 16, buf, sizeof(buf)) == 0);   // no room for '\n'
  CHECK(ble::chunkPayload(23, 180) == 20);
  CHECK(ble::chunkPayload(247, 180) == 180);
  CHECK(ble::chunkPayload(100, 180) == 97);
  CHECK(ble::chunkPayload(0, 180) == 20);
  CHECK(ble::chunkPayload(247, 10) == 20);
}

/* ---------- MessageQueue ---------- */

void testQueue() {
  ble::MessageQueue<3, 16> q;
  char out[16];
  size_t n = 0;
  CHECK(!q.pop(out, sizeof(out), n));
  CHECK(q.push("a", 1) && q.push("bb", 2) && q.push("ccc", 3));
  CHECK(!q.push("dddd", 4));                 // full
  CHECK(q.dropped() == 1);
  CHECK(q.pop(out, sizeof(out), n) && n == 1 && strcmp(out, "a") == 0);
  CHECK(q.push("eeee", 4));                  // wraps around
  CHECK(q.pop(out, sizeof(out), n) && strcmp(out, "bb") == 0);
  CHECK(q.pop(out, sizeof(out), n) && strcmp(out, "ccc") == 0);
  CHECK(q.pop(out, sizeof(out), n) && strcmp(out, "eeee") == 0);
  CHECK(!q.pop(out, sizeof(out), n));
  CHECK(!q.push("0123456789abcdef", 16));    // too long for a slot
  CHECK(!q.push("", 0));
  CHECK(q.dropped() == 3);
  q.push("x", 1);
  q.clear();
  CHECK(!q.pop(out, sizeof(out), n));
}

/* ---------- TransportRouter with a fake target ---------- */

void testRouter() {
  TransportRouter router;
  FakeChannel ws, ble;
  FakeTarget target;
  target.reply = &router;
  const int wsId = router.addChannel(&ws);
  const int bleId = router.addChannel(&ble);
  FakeChannel extra;
  CHECK(wsId == 0 && bleId == 1);
  CHECK(router.addChannel(&extra) == -1);     // only two channels
  CHECK(router.addChannel(nullptr) == -1);

  // before a target is attached nothing is delivered
  router.onText(wsId, "early", 5, 1);
  CHECK(target.messages.empty());
  router.setTarget(&target);

  // replies go back to the channel the message came from
  router.onText(wsId, "m1", 2, 10);
  router.onText(bleId, "m2", 2, 20);
  router.onText(wsId, "m3", 2, 30);
  CHECK(target.messages.size() == 3);
  CHECK(ws.out.size() == 2 && ble.out.size() == 1);
  CHECK(router.sent(wsId) == 2 && router.sent(bleId) == 1);

  // a reply outside message handling goes to the channel that spoke last
  router.send("late", 4);
  CHECK(ws.out.size() == 3 && ws.out.back() == "late");

  // a channel that cannot send counts a drop and the other one is not disturbed
  ble.accept = false;
  router.onText(bleId, "m4", 2, 40);
  CHECK(router.dropped(bleId) == 1 && ws.out.size() == 3);

  // ids out of range are ignored
  router.onText(7, "x", 1, 50);
  router.onText(-1, "x", 1, 50);
  CHECK(target.messages.size() == 4);

  // any channel closing tells the target to stop
  router.onClosed(bleId, 60);
  router.onClosed(wsId, 70);
  CHECK(target.closes == 2);
  CHECK(router.closes(bleId) == 1 && router.closes(wsId) == 1);
  router.onClosed(9, 80);
  CHECK(target.closes == 2);
}

/* ---------- two transports, ONE real protocol and safety kernel ---------- */

struct SeqRandom : Random32 {
  uint32_t n = 1000;
  uint32_t next() override { n += 7919; return n; }
};

struct KernelTarget : RouterTarget {
  SafetyKernel* kernel = nullptr;
  void onMessage(const char* text, size_t length, double now) override { kernel->onMessage(text, length, now); }
  void onTransportClosed(double now) override { kernel->onTransportClosed(now); }
};

InterlockConfig configured() {
  InterlockConfig c;
  c.stopDistanceMm = 500;       // 0 would mean UNCONFIGURED: always blocked
  return c;
}

struct Rig {
  SeqRandom rng;
  TransportRouter router;
  FakeChannel ws, ble;
  Protocol protocol{&rng, &router, nullptr};
  LockedMotorHal hal;
  Interlock interlock{configured()};
  SafetyKernel kernel{protocol, hal, interlock};
  KernelTarget target;
  int wsId = 0;
  int bleId = 0;
  double now = 1000;

  Rig() {
    wsId = router.addChannel(&ws);
    bleId = router.addChannel(&ble);
    target.kernel = &kernel;
    router.setTarget(&target);
    kernel.init(now);
    // The obstacle interlock stays blocked until every sensor reports; report a clear distance.
    for (int times = 0; times < 2; times += 1) {
      for (int s = 0; s < Interlock::kSensors; s += 1) {
        Reading reading;
        reading.status = EchoStatus::Distance;
        reading.distanceMm = 900;
        reading.at = now;
        kernel.onReading(s, reading, now);
      }
    }
  }

  void send(int id, const char* json) { router.onText(id, json, strlen(json), now); }

  static std::string lastOf(const FakeChannel& ch) { return ch.out.empty() ? std::string() : ch.out.back(); }

  // HELLO + ARM over one channel; returns the channel's last reply.
  std::string open(int id, FakeChannel& ch, const char* sid) {
    char buffer[256];
    snprintf(buffer, sizeof(buffer), "{\"v\":2,\"t\":\"HELLO\",\"sid\":\"%s\",\"seq\":1}", sid);
    send(id, buffer);
    const uint32_t dn = numberAfter(lastOf(ch), "\"dn\":");
    now += 10;
    snprintf(buffer, sizeof(buffer), "{\"v\":2,\"t\":\"ARM\",\"sid\":\"%s\",\"seq\":2,\"dn\":%u}", sid, dn);
    send(id, buffer);
    return lastOf(ch);
  }
};

void testTwoTransportsOneKernel() {
  Rig r;
  const std::string armWs = r.open(r.wsId, r.ws, "a1b2c3d4e5f60718");
  CHECK(contains(armWs, "\"ok\":true"));
  CHECK(r.ble.out.empty());                                   // nothing leaked to the other channel

  // a second client on BLE asks for a session: BUSY, and only the BLE channel hears it
  const size_t wsBefore = r.ws.out.size();
  const std::string armBle = r.open(r.bleId, r.ble, "0f0e0d0c0b0a0908");
  CHECK(contains(armBle, "BUSY"));
  CHECK(r.ws.out.size() == wsBefore);

  // the first client still moves the motors
  const std::string tokText = armWs;
  const uint32_t tok = numberAfter(tokText, "\"tok\":");
  const uint32_t ackSeq = numberAfter(tokText, "\"seq\":");
  char cmd[320];
  snprintf(cmd, sizeof(cmd),
           "{\"v\":2,\"t\":\"CMD\",\"sid\":\"a1b2c3d4e5f60718\",\"seq\":3,\"cmd\":\"FORWARD\",\"did\":1,\"age\":30,"
           "\"lease\":600,\"tok\":%u,\"ackSeq\":%u}", tok, ackSeq);
  r.now += 10;
  r.send(r.wsId, cmd);
  CHECK(r.kernel.effectiveMotor() == Motor::Forward);

  // the BLE client (not the owner of the session) disconnects: fail-safe stop, no latch needed
  r.now += 10;
  r.router.onClosed(r.bleId, r.now);
  CHECK(r.kernel.effectiveMotor() == Motor::Stop);

  // movement does not resume by itself: the same did is refused
  r.now += 10;
  r.send(r.wsId, cmd);
  CHECK(r.kernel.effectiveMotor() == Motor::Stop);
}

}  // namespace

int main() {
  testAssembler();
  testFraming();
  testQueue();
  testRouter();
  testTwoTransportsOneKernel();
  printf("checks=%d failures=%d\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
