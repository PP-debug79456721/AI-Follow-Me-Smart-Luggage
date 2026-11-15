// Host conformance harness: replays a scripted sequence through the C++
// Protocol v2 port and prints every reply and the full device state after
// each step, as JSON lines. tests/firmware-conformance.test.mjs drives the
// same sequence through js/mock-esp32.js and compares the two.
//
// Input (stdin), one step per line:
//   RAND <uint32> <uint32> ...      the random values, consumed in order
//   RX <now|null> <json text>       a message from the app
//   TICK <now|null>                 a timer tick
//
// This is a HOST test. It says nothing about a real ESP32.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <memory>
#include <string>
#include <vector>

#include "../protocol.h"

using namespace follow;

namespace {

struct ListRandom : Random32 {
  std::vector<uint32_t> values;
  size_t index = 0;
  bool exhausted = false;
  uint32_t next() override {
    if (index < values.size()) return values[index++];
    exhausted = true;
    return 0xDEADBEEFu;
  }
};

struct Sink : ReplySink {
  std::vector<std::string> out;
  void send(const char* json, size_t n) override { out.emplace_back(json, n); }
};

struct MotorEntry { double at; Motor command; std::string reason; };
struct EventEntry { double at; std::string type; bool hasMalformed; bool malformed; };

struct Recorder : Observer {
  std::vector<MotorEntry> motors;
  std::vector<EventEntry> events;
  void onMotor(double at, Motor c, const char* reason) override { motors.push_back({at, c, reason}); }
  void onEvent(double at, const char* type, bool hm, bool m) override { events.push_back({at, type, hm, m}); }
};

void num(double v) { printf("%.17g", v); }
void str(const char* s) {
  if (!s) { printf("null"); return; }
  printf("\"%s\"", s);
}
void optNum(bool has, double v) { if (has) num(v); else printf("null"); }

void printStatus(const Protocol& p, const Recorder& r) {
  printf("{\"motor\":"); str(motorName(p.motor()));
  printf(",\"state\":"); str(stateName(p.state()));
  printf(",\"latchReason\":"); str(p.latchReason());
  printf(",\"session\":"); if (p.hasSession()) str(p.session()); else printf("null");
  printf(",\"lastSeq\":"); num(p.lastSeq());
  printf(",\"ring\":[");
  for (int i = 0; i < p.ringCount(); i += 1) {
    const Token& t = p.ringAt(i);
    if (i) printf(",");
    printf("{\"sid\":\"%s\",\"ackSeq\":%u,\"tok\":%u,\"issuedAt\":", t.sid, t.ackSeq, t.tok);
    num(t.issuedAt);
    printf("}");
  }
  printf("],\"deadRing\":[");
  for (int i = 0; i < p.deadCount(); i += 1) {
    if (i) printf(",");
    str(p.deadAt(i));
  }
  printf("],\"lastDid\":"); num(p.lastDid());
  printf(",\"expiryDid\":"); optNum(p.hasExpiry(), p.expiryDid());
  printf(",\"lastLiveAt\":"); optNum(p.hasLive(), p.lastLiveAt());
  printf(",\"lastMoveAcceptedAt\":"); optNum(p.hasMoveAccepted(), p.lastMoveAcceptedAt());
  printf(",\"sessionLivenessExpired\":%s", p.sessionLivenessExpired() ? "true" : "false");
  printf(",\"lastStopReason\":"); str(p.lastStopReason());
  printf(",\"lastReject\":");
  if (p.hasLastReject()) {
    printf("{\"reason\":"); str(p.lastRejectReason());
    printf(",\"seq\":"); num(p.lastRejectSeq());
    printf("}");
  } else {
    printf("null");
  }
  printf(",\"epoch\":%u", p.epoch());
  const Counters& c = p.counters();
  printf(",\"counters\":{\"accepted\":%u,\"rejected\":%u,\"stops\":%u,\"watchdogLatches\":%u,"
         "\"leaseExpiries\":%u,\"idleTimeouts\":%u,\"rateLimited\":%u,\"estops\":%u,\"byes\":%u}",
         c.accepted, c.rejected, c.stops, c.watchdogLatches, c.leaseExpiries, c.idleTimeouts,
         c.rateLimited, c.estops, c.byes);
  printf(",\"motorLog\":[");
  for (size_t i = 0; i < r.motors.size(); i += 1) {
    if (i) printf(",");
    printf("{\"at\":"); num(r.motors[i].at);
    printf(",\"command\":\"%s\",\"reason\":\"%s\"}", motorName(r.motors[i].command), r.motors[i].reason.c_str());
  }
  printf("],\"events\":[");
  for (size_t i = 0; i < r.events.size(); i += 1) {
    if (i) printf(",");
    printf("{\"at\":"); num(r.events[i].at);
    printf(",\"type\":\"%s\"", r.events[i].type.c_str());
    if (r.events[i].hasMalformed) printf(",\"malformed\":%s", r.events[i].malformed ? "true" : "false");
    printf("}");
  }
  printf("]}");
}

double parseNow(const char* token) {
  if (strncmp(token, "null", 4) == 0) return NAN;
  return strtod(token, nullptr);
}

}  // namespace

int main() {
  ListRandom rng;
  Sink sink;
  Recorder recorder;
  std::unique_ptr<Protocol> protocol;

  std::string line;
  char* buffer = nullptr;
  size_t capacity = 0;
  while (getline(&buffer, &capacity, stdin) != -1) {
    line.assign(buffer);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (line.empty()) continue;

    if (line.rfind("RAND", 0) == 0) {
      const char* p = line.c_str() + 4;
      char* end = nullptr;
      for (;;) {
        const unsigned long v = strtoul(p, &end, 10);
        if (end == p) break;
        rng.values.push_back(static_cast<uint32_t>(v));
        p = end;
      }
      protocol.reset(new Protocol(&rng, &sink, &recorder));
      continue;
    }

    if (!protocol) { fprintf(stderr, "RAND line must come first\n"); return 2; }

    sink.out.clear();
    if (line.rfind("RX ", 0) == 0) {
      const char* rest = line.c_str() + 3;
      const char* space = strchr(rest, ' ');
      if (!space) { fprintf(stderr, "bad RX line\n"); return 2; }
      const double now = parseNow(rest);
      protocol->receive(space + 1, strlen(space + 1), now);
    } else if (line.rfind("TICK ", 0) == 0) {
      protocol->tick(parseNow(line.c_str() + 5));
    } else {
      fprintf(stderr, "bad line: %s\n", line.c_str());
      return 2;
    }

    printf("{\"replies\":[");
    for (size_t i = 0; i < sink.out.size(); i += 1) {
      if (i) printf(",");
      printf("%s", sink.out[i].c_str());
    }
    printf("],\"rngExhausted\":%s,\"status\":", rng.exhausted ? "true" : "false");
    printStatus(*protocol, recorder);
    printf("}\n");
  }
  free(buffer);
  return 0;
}
