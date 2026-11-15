// Host tests for the Motor Test pure logic (M1-M2). Compiled and run on a computer only.
// They prove the logic against a simulated plant. They prove NOTHING about a real
// ESP32, relay, BTS7960, ADC or motor. No hardware is touched.
//
//   g++ -std=c++17 -Wall -Wextra -I.. motor_test_host.cpp -o motor_test_host && ./motor_test_host
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "bench_session.h"

using namespace mt;

// ------------------------------------------------------------------ mini framework

static int g_fail = 0;
static int g_checks = 0;
static const char* g_test = "";

#define CHECK(cond)                                                                   \
  do {                                                                                \
    g_checks += 1;                                                                    \
    if (!(cond)) {                                                                    \
      g_fail += 1;                                                                    \
      std::printf("  FAIL [%s] line %d: %s\n", g_test, __LINE__, #cond);              \
    }                                                                                 \
  } while (0)

#define RUN(fn)                                  \
  do {                                           \
    g_test = #fn;                                \
    const int before = g_fail;                   \
    fn();                                        \
    std::printf("%s %s\n", g_fail == before ? "PASS" : "FAIL", #fn); \
  } while (0)

// ------------------------------------------------------------------ test thresholds (TEST ONLY, not measurements)

static Thresholds makeTh() {
  Thresholds t;
  t.vbatScaleVPerMv = 0.0057f;   // 47k/10k divider, test value
  t.vbusScaleVPerMv = 0.0057f;
  t.adcFloorMv = 20;
  t.adcSatMv = 3100;
  t.vbatArmMinV = 9.9f;
  t.vbatArmMaxV = 12.9f;
  t.vbatFaultMaxV = 13.2f;
  t.vbatStopMinV = 9.6f;
  t.busOffV = 1.5f;
  t.busOnTolFrac = 0.10f;
  t.busOnTolMinV = 1.0f;
  t.busSagFrac = 0.70f;
  t.crossCheckFrac = 0.15f;
  t.agreeFrac = 0.03f;
  t.agreeFloorV = 0.3f;
  t.riseTimeoutMs = 500;
  t.riseStableMs = 100;
  t.settleTimeoutMs = 2000;
  t.staleMs = 100;
  return t;
}

// ------------------------------------------------------------------ fake outputs

struct FakeOut : BenchOutputs {
  OutputPlan last;
  OutputPlan prev;
  uint32_t applies = 0;
  uint32_t bad = 0;          // plans that break a rule the session must already guarantee
  uint32_t enWithoutRelayBefore = 0;
  void apply(const OutputPlan& p) override {
    if ((p.left.en || p.right.en) && !p.relayOn) bad += 1;
    if (p.left.en && p.right.en) bad += 1;
    if (p.left.lpwmPct || p.right.lpwmPct) bad += 1;
    if (p.left.rpwmPct > 20 || p.right.rpwmPct > 20) bad += 1;
    if ((p.left.en && !last.relayOn) || (p.right.en && !last.relayOn)) enWithoutRelayBefore += 1;
    prev = last;
    last = p;
    applies += 1;
  }
};

// ------------------------------------------------------------------ plant simulation

struct Rig {
  Limits lim;
  Thresholds th;
  FakeOut out;
  std::unique_ptr<Session> s;
  uint32_t now = 1000;

  float bat = 12.0f;
  float bus = 0;
  float decayVps = 20;        // bus decay with the relay open
  float loadSag = 0.3f;

  bool estopPressed = false;      // NC1 opens the coil AND NC2 reads HIGH
  bool estopWireOpen = false;     // NC2 wire open: reads HIGH, coil unaffected
  bool estopNc2StuckLow = false;  // NC2 shorted to GND: reads healthy even when pressed
  bool coilCut = false;           // coil supply interrupted
  bool welded = false;            // contacts closed whatever the coil does
  bool relayStuckOn = false;      // BC337 shorted: coil on whatever GPIO32 says
  bool resetPressed = false;

  bool batReadFail = false, busReadFail = false;
  bool batStuck = false, busStuck = false;
  float batStuckMv = 0, busStuckMv = 0;
  bool noSamples = false;

  uint32_t tickCount = 0;

  explicit Rig(uint32_t startNow = 1000) : th(makeTh()), now(startNow) {
    s.reset(new Session(th, lim, out));
  }

  void boot() {
    s.reset(new Session(th, lim, out));
    s->begin(now);
  }

  static float toMv(float v) { return v / 0.0057f; }

  void step(uint32_t dt = 10) {
    now += dt;
    tickCount += 1;
    const bool motorOn = out.last.left.en || out.last.right.en;
    const bool coil = (out.last.relayOn || relayStuckOn) && !estopPressed && !coilCut;
    const bool closed = coil || welded;
    if (closed) {
      bus = bat - (motorOn ? loadSag : 0.0f);
      if (bus < 0) bus = 0;
    } else {
      bus -= decayVps * (static_cast<float>(dt) / 1000.0f);
      if (bus < 0) bus = 0;
    }
    const float noise = static_cast<float>(static_cast<int>(tickCount % 3) - 1) * 5.0f;
    if (!noSamples) {
      AdcSample b;
      b.valid = !batReadFail;
      b.pinMv = batStuck ? batStuckMv : toMv(bat) + noise;
      b.at = now;
      s->feedVbat(b);
      AdcSample u;
      u.valid = !busReadFail;
      float mv = busStuck ? busStuckMv : toMv(bus) + noise;
      if (mv < 0) mv = 0;
      u.pinMv = mv;
      u.at = now;
      s->feedVbus(u);
    }
    const bool pinHigh = (estopPressed && !estopNc2StuckLow) || estopWireOpen;
    s->feedEstop(now, true, pinHigh);
    s->feedReset(now, true, resetPressed);
    s->tick(now);
  }

  void run(uint32_t ms) {
    for (uint32_t t = 0; t < ms; t += 10) step(10);
  }

  void line(const char* text) { s->onLine(text, std::strlen(text), now); }

  void toDisarmed() {
    boot();
    run(400);
  }

  void toArmed() {
    toDisarmed();
    line("arm");
    run(400);
  }
};

static bool noMotor(const Rig& r) { return planIsZero(r.out.last); }

// ------------------------------------------------------------------ 1. compile-time sentinels

static_assert(!Thresholds{}.configured(), "thresholds are UNSET by default");
static_assert(limitsValid(Limits{}), "shipped limits valid");
static_assert(pinsValid(kPins), "shipped pins valid");
static_assert(Limits{}.dutyCapPct == 20 && kProgramMaxDutyPct == 20, "initial duty cap 20 percent");
static_assert(!kPinsVerified, "pins unverified");

static void test_sentinels_runtime() {
  CHECK(!Thresholds{}.configured());
  CHECK(!kPinsVerified);
  Thresholds partial = makeTh();
  partial.settleTimeoutMs = 0;                 // one value unset
  CHECK(!partial.configured());
  Thresholds inconsistent = makeTh();
  inconsistent.vbatArmMinV = 14;               // above max
  CHECK(inconsistent.configured() && !inconsistent.consistent());

  // A session with the shipped (UNSET) thresholds can never arm and never drives anything.
  FakeOut out;
  Limits lim;
  Session s(Thresholds{}, lim, out);
  s.begin(1000);
  for (uint32_t t = 1000; t < 2000; t += 10) {
    s.feedEstop(t, true, false);
    s.tick(t);
  }
  CHECK(s.state() == State::Disarmed);
  s.onLine("arm", 3, 2000);
  CHECK(s.lastReply() == Reply::RejectConfig);
  CHECK(s.state() == State::Disarmed);
  s.onLine("l 10", 4, 2010);
  CHECK(s.lastReply() == Reply::RejectNotArmed);
  CHECK(planIsZero(out.last) && !out.last.relayOn);

  // Invalid limits at runtime: FAULT Config, never recoverable.
  Limits bad;
  bad.dutyCapPct = 21;
  FakeOut out2;
  Session s2(makeTh(), bad, out2);
  s2.begin(1000);
  CHECK(s2.state() == State::Fault && s2.fault() == Fault::Config);
  CHECK(!faultRecoverable(Fault::Config));
}

// ------------------------------------------------------------------ 2. parser

static Cmd P(const char* t) { return parseCommand(t, std::strlen(t), 32); }

static void test_parser() {
  CHECK(P("arm").kind == CmdKind::Arm);
  CHECK(P("disarm").kind == CmdKind::Disarm);
  CHECK(P("s").kind == CmdKind::Stop);
  CHECK(P("status").kind == CmdKind::Status);
  CHECK(P("l 10").kind == CmdKind::Left && P("l 10").duty == 10);
  CHECK(P("r 20").kind == CmdKind::Right && P("r 20").duty == 20);
  CHECK(P("l 10\r").kind == CmdKind::Left);                 // CR tolerated
  CHECK(P("").kind == CmdKind::Empty);
  CHECK(P("\r").kind == CmdKind::Empty);
  CHECK(P("b").kind == CmdKind::B);
  CHECK(P("b 10").kind == CmdKind::B);
  CHECK(P("b 50").kind == CmdKind::B);
  CHECK(P("b anything").kind == CmdKind::B);
  // value is parsed, range is the session's decision
  CHECK(P("l 21").kind == CmdKind::Left && P("l 21").duty == 21);
  CHECK(P("l 0").kind == CmdKind::Left && P("l 0").duty == 0);
  CHECK(P("l 999").duty == 999);
  // malformed
  const char* bad[] = {"l", "r", "l ", "l  10", " l 10", "l 10 ", "l -5", "l +5", "l 1.5", "l 5x", "l x",
                       "l 1000", "l 99999999999", "l 010", "l 00", "L 10", "R 10", "ARM", "Arm", "arm 1",
                       "s 1", "status x", "disarm now", "l\t10", "l\x01" "10", "l 1\x7f", "l 1\xc3\xa9"};
  for (const char* t : bad) {
    const CmdKind k = P(t).kind;
    if (!(k == CmdKind::Malformed || k == CmdKind::Unknown)) std::printf("  unexpected parse of [%s]\n", t);
    CHECK(k == CmdKind::Malformed || k == CmdKind::Unknown);
  }
  const char nul[] = {'l', ' ', '1', 0, '0'};
  CHECK(parseCommand(nul, sizeof nul, 32).kind == CmdKind::Malformed);
  CHECK(P("go").kind == CmdKind::Unknown);
  CHECK(P("lx 10").kind == CmdKind::Unknown);
  const std::string longLine(33, 'a');
  CHECK(parseCommand(longLine.c_str(), longLine.size(), 32).kind == CmdKind::Malformed);
  const std::string okLine = "l " + std::string(1, '1');
  CHECK(parseCommand(okLine.c_str(), okLine.size(), 32).kind == CmdKind::Left);
}

// ------------------------------------------------------------------ T1 .. T9

static void test_T1_power_on() {
  Rig r;
  r.boot();
  CHECK(r.s->state() == State::BootCheck);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.run(400);
  CHECK(r.s->state() == State::Disarmed);
  CHECK(!r.out.last.relayOn && noMotor(r));
  CHECK(r.bus < 0.5f);
  // nothing arms by itself, however long we wait
  r.run(60000);
  CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn);
}

static void test_T2_arm() {
  Rig r;
  r.toDisarmed();
  r.line("arm");
  CHECK(r.s->state() == State::Arming);
  CHECK(r.out.last.relayOn && noMotor(r));                // relay on, both EN low
  CHECK(!r.out.last.left.en && !r.out.last.right.en);
  r.run(400);
  CHECK(r.s->state() == State::Armed);
  CHECK(r.out.last.relayOn && noMotor(r));
  CHECK(r.bus > 11.5f);                                   // bus rose to about battery
  CHECK(r.s->interlock().relayConfirmedOn());
  CHECK(r.out.enWithoutRelayBefore == 0);
}

static void test_T2_arm_refusals() {
  {  // battery out of range
    Rig r; r.bat = 8.0f; r.toDisarmed(); r.line("arm");
    CHECK(r.s->state() == State::Disarmed && r.s->lastReply() == Reply::RejectArmCheck);
    CHECK(r.s->lastArmCheck() == ArmCheck::BatRange && !r.out.last.relayOn);
  }
  {
    Rig r; r.bat = 13.0f; r.toDisarmed(); r.line("arm");
    CHECK(r.s->state() == State::Disarmed && r.s->lastArmCheck() == ArmCheck::BatRange);
  }
  {  // battery missing (zero)
    Rig r; r.bat = 0.0f; r.toDisarmed(); r.line("arm");
    CHECK(r.s->state() == State::Disarmed && r.s->lastArmCheck() == ArmCheck::BatInvalid);
  }
  {  // battery ADC saturated
    Rig r; r.batStuck = true; r.batStuckMv = 3200; r.toDisarmed(); r.line("arm");
    CHECK(r.s->lastArmCheck() == ArmCheck::BatInvalid && r.s->state() == State::Disarmed);
  }
  {  // before the first samples: not settled / invalid, never armed
    Rig r; r.boot(); r.line("arm");
    CHECK(r.s->state() == State::BootCheck && r.s->lastReply() == Reply::RejectBoot);
  }
  {  // bus sensor dead from the start: arm needs a positive rise, so it faults
    Rig r; r.busStuck = true; r.busStuckMv = 0; r.toDisarmed(); r.line("arm"); r.run(1500);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::NoRise);
    CHECK(!r.out.last.relayOn && noMotor(r));
  }
}

static void test_T3_one_motor() {
  Rig r;
  r.toArmed();
  CHECK(r.s->state() == State::Armed);

  r.line("l 10");                                          // T3
  CHECK(r.s->state() == State::Running && r.s->side() == Side::Left);
  CHECK(r.out.last.left.en && r.out.last.left.rpwmPct == 10 && r.out.last.left.lpwmPct == 0);
  CHECK(!r.out.last.right.en && r.out.last.right.rpwmPct == 0);
  r.run(100);

  r.line("s");                                             // stop
  CHECK(r.s->state() == State::Armed && noMotor(r) && r.out.last.relayOn);
  r.line("r 10");                                          // too soon: restart gap
  CHECK(r.s->state() == State::Armed && r.s->lastReply() == Reply::RejectGap);
  r.run(400);
  r.line("r 10");                                          // T3.1
  CHECK(r.s->state() == State::Running && r.s->side() == Side::Right);
  CHECK(r.out.last.right.en && r.out.last.right.rpwmPct == 10);
  CHECK(!r.out.last.left.en && r.out.last.left.rpwmPct == 0);

  r.line("l 10");                                          // T3.2: other motor while running
  CHECK(r.s->lastReply() == Reply::RejectOtherMotor);
  CHECK(r.s->state() == State::Armed && noMotor(r));       // all outputs forced safe
  CHECK(!r.out.last.left.en && !r.out.last.right.en);
  r.run(400);

  r.line("l 10");
  CHECK(r.s->state() == State::Running);
  r.line("r 10");                                          // T3.2 mirrored
  CHECK(r.s->lastReply() == Reply::RejectOtherMotor && noMotor(r) && r.s->state() == State::Armed);
  CHECK(r.out.bad == 0);
}

static void test_T3_3_and_duty() {
  Rig r;
  r.toArmed();
  r.line("b 10");                                          // T3.3
  CHECK(r.s->lastReply() == Reply::RejectB && r.s->state() == State::Armed && noMotor(r));
  r.line("b");
  CHECK(r.s->lastReply() == Reply::RejectB && noMotor(r));
  // T3.4 duty range 1..20
  const char* rejected[] = {"l 21", "l 50", "l 100", "l 0", "r 21", "r 0", "r 255"};
  for (const char* t : rejected) {
    r.line(t);
    CHECK(r.s->lastReply() == Reply::RejectDuty);
    CHECK(r.s->state() == State::Armed && noMotor(r));
  }
  r.line("l 20");
  CHECK(r.s->state() == State::Running && r.out.last.left.rpwmPct == 20);
  r.line("s");
  r.run(400);
  r.line("r 1");
  CHECK(r.s->state() == State::Running && r.out.last.right.rpwmPct == 1);
  r.line("s");
  CHECK(r.out.bad == 0);
}

static void test_T3_5_reject_during_running_forces_safe() {
  const char* rejects[] = {"b 10", "l 21", "l 0", "l", "garbage", "L 10", "arm", "r 10", "l 1.5", "\x01"};
  for (const char* t : rejects) {
    Rig r;
    r.toArmed();
    r.line("l 10");
    CHECK(r.s->state() == State::Running && r.out.last.left.en);
    r.line(t);
    CHECK(replyIsReject(r.s->lastReply()));
    CHECK(r.s->state() == State::Armed);
    CHECK(noMotor(r));                                     // both EN low, both duty 0
    CHECK(!r.out.last.left.en && !r.out.last.right.en);
    CHECK(r.out.last.relayOn);                             // relay stays on (decision 2)
    r.run(500);
    CHECK(r.s->state() == State::Armed && noMotor(r));
  }
  Rig r;                                                   // overflow of the receive buffer
  r.toArmed();
  r.line("l 10");
  r.s->onOverflow(r.now);
  CHECK(r.s->lastReply() == Reply::RejectMalformed && noMotor(r) && r.s->state() == State::Armed);
}

static void test_refresh_lease_and_limits() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  r.run(900);
  CHECK(r.s->state() == State::Running);
  r.line("l 12");                                          // refresh with a new duty
  CHECK(r.s->state() == State::Running && r.out.last.left.rpwmPct == 12);
  r.run(900);
  CHECK(r.s->state() == State::Running);                   // lease refreshed
  r.run(300);                                              // lease expires
  CHECK(r.s->state() == State::Armed && noMotor(r) && r.s->lastReply() == Reply::LeaseExpired);

  // continuous cap: refresh every 500 ms, still stops at maxContinuousMs
  Rig c;
  c.toArmed();
  c.line("l 10");
  for (int i = 0; i < 20 && c.s->state() == State::Running; i += 1) {
    c.run(500);
    if (c.s->state() == State::Running) c.line("l 10");
  }
  CHECK(c.s->state() == State::Armed && c.s->lastReply() == Reply::LimitContinuous && noMotor(c));

  // total per ARM: repeated runs end in DISARM and a relay-off plan
  Rig t;
  t.lim.totalPerArmMs = 12000;
  t.s.reset(new Session(t.th, t.lim, t.out));
  t.s->begin(t.now);
  t.run(400);
  t.line("arm");
  t.run(400);
  for (int i = 0; i < 40 && t.s->state() != State::Disarmed; i += 1) {
    if (t.s->state() == State::Armed) t.line("l 10");
    t.run(1100);
    if (t.s->state() == State::Running) t.line("s");
    t.run(400);
  }
  CHECK(t.s->state() == State::Disarmed);
  CHECK(!t.out.last.relayOn && noMotor(t));
  CHECK(t.s->lastReply() == Reply::LimitArm);
}

static void test_boot_total_limit() {
  Rig r;
  r.lim.totalPerArmMs = 5000;
  r.lim.maxContinuousMs = 5000;
  r.lim.totalPerBootMs = 8000;
  r.s.reset(new Session(r.th, r.lim, r.out));
  r.s->begin(r.now);
  r.run(400);
  bool hitBoot = false;
  for (int arms = 0; arms < 6 && !hitBoot; arms += 1) {
    r.line("arm");
    r.run(400);
    if (r.s->state() != State::Armed) break;
    r.line("l 10");
    for (int i = 0; i < 70 && r.s->state() == State::Running; i += 1) {
      r.run(100);
      if (r.s->state() == State::Running && (i % 5) == 4) r.line("l 10");
    }
    if (r.s->lastReply() == Reply::LimitBoot) hitBoot = true;
    r.run(2500);
  }
  CHECK(hitBoot);
  r.line("arm");
  CHECK(r.s->lastReply() == Reply::RejectLimit && !r.out.last.relayOn);    // needs a reboot
}

static void test_inactivity_disarms() {
  Rig r;
  r.toArmed();
  r.run(29000);
  CHECK(r.s->state() == State::Armed);
  r.run(2000);
  CHECK(r.s->state() == State::Disarmed && r.s->lastReply() == Reply::Inactivity);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.run(1500);
  CHECK(r.s->interlock().phase() == RelayPhase::Off);       // bus decayed, verified off
}

// T4/T5/T6/T7
static void test_T4_T5_estop() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  CHECK(r.s->state() == State::Running);
  r.estopPressed = true;                                   // T4: coil opens, NC2 reads HIGH
  r.step();
  CHECK(r.s->state() == State::Estop);
  CHECK(r.s->lastReply() == Reply::Estop);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.run(1500);                                             // bus falls: no fault
  CHECK(r.s->state() == State::Estop);
  CHECK(r.bus < 0.5f);

  r.estopPressed = false;                                  // T5: release
  r.run(200);
  CHECK(r.s->state() == State::Disarmed);                  // NOT armed again
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.run(5000);
  CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn);
  r.line("l 10");
  CHECK(r.s->lastReply() == Reply::RejectNotArmed && noMotor(r));
  r.line("arm");                                           // explicit arm works again
  r.run(400);
  CHECK(r.s->state() == State::Armed);
}

static void test_T6_arm_while_estop_held() {
  Rig r;
  r.toDisarmed();
  r.estopPressed = true;
  r.run(100);
  CHECK(r.s->state() == State::Estop);
  r.line("arm");
  CHECK(r.s->lastReply() == Reply::RejectEstop && !r.out.last.relayOn);
  CHECK(r.s->state() == State::Estop);
  // pressed at boot
  Rig b;
  b.estopPressed = true;
  b.boot();
  b.run(300);
  CHECK(b.s->state() == State::Estop);
  b.line("arm");
  CHECK(b.s->lastReply() == Reply::RejectEstop && !b.out.last.relayOn && noMotor(b));
  // released but still debouncing: arm refused
  Rig d;
  d.toDisarmed();
  d.estopPressed = true;
  d.run(100);
  d.estopPressed = false;
  d.step();
  d.line("arm");
  CHECK(d.s->state() == State::Estop && !d.out.last.relayOn);
}

static void test_T7_estop_wire_open() {
  Rig r;
  r.toArmed();
  r.estopWireOpen = true;                                  // NC2 wire disconnected
  r.step();
  CHECK(r.s->state() == State::Estop);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.line("arm");
  CHECK(r.s->lastReply() == Reply::RejectEstop);

  Rig q;                                                   // disconnected while DISARMED
  q.toDisarmed();
  q.estopWireOpen = true;
  q.run(100);
  CHECK(q.s->state() == State::Estop);

  Rig n;                                                   // E-stop pin never read: E-STOP
  FakeOut out;
  Limits lim;
  Session s(makeTh(), lim, out);
  s.begin(1000);
  for (uint32_t t = 1010; t < 3000; t += 10) {
    AdcSample a; a.valid = true; a.pinMv = 2100; a.at = t; s.feedVbat(a);
    AdcSample u; u.valid = true; u.pinMv = 5; u.at = t; s.feedVbus(u);
    s.tick(t);
  }
  CHECK(s.state() == State::Estop);
  s.onLine("arm", 3, 3000);
  CHECK(s.lastReply() == Reply::RejectEstop && !out.last.relayOn);
  // invalid read of the pin is also E-STOP
  Rig v;
  v.toDisarmed();
  v.s->feedEstop(v.now, false, false);
  v.s->tick(v.now + 10);
  CHECK(v.s->state() == State::Estop);
}

static void test_T8_coil_power_interrupted() {
  Rig r;
  r.toArmed();
  r.decayVps = 400;
  r.coilCut = true;                                        // relay releases, no E-stop, NC2 healthy
  r.run(300);
  CHECK(r.s->state() == State::Fault);
  CHECK(r.s->fault() == Fault::BusLost || r.s->fault() == Fault::BusSag);
  CHECK(!r.out.last.relayOn && noMotor(r));

  Rig m;                                                   // while a motor runs
  m.toArmed();
  m.decayVps = 400;
  m.line("l 10");
  m.coilCut = true;
  m.run(300);
  CHECK(m.s->state() == State::Fault && noMotor(m) && !m.out.last.relayOn);
  CHECK(m.s->fault() == Fault::BusLost || m.s->fault() == Fault::BusSag);
}

static void test_T9_reset_never_arms() {
  {  // reset while DISARMED: nothing happens
    Rig r;
    r.toDisarmed();
    r.resetPressed = true;
    r.run(200);
    r.resetPressed = false;
    r.run(200);
    CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn);
    CHECK(r.s->lastReply() == Reply::ResetNoop);
  }
  {  // reset in FAULT with safe conditions: DISARMED, then explicit arm needed
    Rig r;
    r.toArmed();
    r.decayVps = 400;
    r.coilCut = true;
    r.run(300);
    CHECK(r.s->state() == State::Fault);
    r.coilCut = false;
    r.run(500);                                            // bus settled low
    r.resetPressed = true;
    r.run(100);
    r.resetPressed = false;
    r.run(100);
    CHECK(r.s->state() == State::Disarmed);                // cleared, NOT armed
    CHECK(r.s->lastReply() == Reply::Cleared || r.s->state() == State::Disarmed);
    CHECK(!r.out.last.relayOn && noMotor(r));
    r.run(3000);
    CHECK(r.s->state() == State::Disarmed);
    r.line("arm");
    r.run(400);
    CHECK(r.s->state() == State::Armed);
  }
  {  // reset while E-stop held: refused, still FAULT
    Rig r;
    r.toArmed();
    r.decayVps = 400;
    r.coilCut = true;
    r.run(300);
    CHECK(r.s->state() == State::Fault);
    r.estopWireOpen = true;
    r.run(100);
    r.resetPressed = true;
    r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->lastReply() == Reply::ResetRefused);
    r.resetPressed = false;
    r.run(100);
    r.estopWireOpen = false;
    r.coilCut = false;
    r.run(200);
    CHECK(r.s->state() == State::Fault);                   // releasing E-stop does not clear the fault
    r.resetPressed = true;
    r.run(100);
    r.resetPressed = false;
    r.run(100);
    CHECK(r.s->state() == State::Disarmed);
  }
  {  // reset while armed or running: ignored, does not stop, does not change relay
    Rig r;
    r.toArmed();
    r.line("l 10");
    r.resetPressed = true;
    r.run(100);
    r.resetPressed = false;
    CHECK(r.s->state() == State::Running && r.s->lastReply() == Reply::ResetNoop);
  }
}

// ------------------------------------------------------------------ added tests M1-M12

static void test_M1_reset_brownout_reboot() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  CHECK(r.out.last.left.en);
  r.boot();                                                // ESP32 reset / brownout mid-run
  CHECK(r.s->state() == State::BootCheck && !r.out.last.relayOn && noMotor(r));
  r.run(200);
  // relay dropped on reset; the bus is still decaying: unexpected bus at boot is a FAULT
  CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusLiveAtBoot);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.run(1500);
  r.resetPressed = true;
  r.run(100);
  r.resetPressed = false;
  r.run(100);
  CHECK(r.s->state() == State::Disarmed);                  // nothing resumed, nothing armed
  CHECK(r.s->side() == Side::None && !r.out.last.relayOn);
}

static void test_M2_loop_stall() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  r.step(400);                                             // one tick 400 ms late
  CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::LoopStall);
  CHECK(!r.out.last.relayOn && noMotor(r));
  Rig a;                                                   // stalled while merely ARMED
  a.toArmed();
  a.step(400);
  CHECK(a.s->state() == State::Fault && a.s->fault() == Fault::LoopStall);
  Rig d;                                                   // a gap while DISARMED is not a fault
  d.toDisarmed();
  d.step(400);
  CHECK(d.s->state() == State::Disarmed);
}

static void test_M3_serial_disconnect() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  r.run(1200);                                             // PC vanished: no more lines
  CHECK(r.s->state() == State::Armed && noMotor(r));
  CHECK(r.out.last.relayOn);
  r.run(31000);
  CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn);
}

static void test_M4_malformed_commands() {
  const char* lines[] = {"l", "l ", "l  10", "l -5", "l 5x", "l 99999999999", "l 010", "L 10", "ARM", "arm 1",
                         "xyz", "l\t10", "\x01\x02", "l 1\x7f", "arm\x01"};
  for (const char* t : lines) {
    Rig r;
    r.toArmed();
    r.line("r 10");
    r.line(t);
    CHECK(replyIsReject(r.s->lastReply()));
    CHECK(r.s->state() == State::Armed && noMotor(r) && r.out.last.relayOn);
    Rig q;
    q.toArmed();
    q.line(t);                                             // while not running: no output change
    CHECK(replyIsReject(q.s->lastReply()) && q.s->state() == State::Armed && noMotor(q));
  }
  Rig f;                                                   // flood of garbage lines
  f.toArmed();
  for (int i = 0; i < 2000; i += 1) {
    char buf[40];
    for (int k = 0; k < 39; k += 1) buf[k] = static_cast<char>(32 + ((i * 7 + k * 13) % 95));
    f.s->onLine(buf, 1 + (i % 39), f.now);
    f.step();
  }
  CHECK(f.out.bad == 0 && noMotor(f));
}

static void test_M5_stuck_inputs() {
  {  // reset held low at boot: never fires; released then pressed: fires
    Rig r;
    r.resetPressed = true;
    r.toArmed();                                           // E-stop fine, bus fine
    CHECK(r.s->state() == State::Disarmed || r.s->state() == State::Armed);
  }
  {
    Rig r;
    r.toArmed();
    r.decayVps = 400;
    r.coilCut = true;
    r.run(300);
    CHECK(r.s->state() == State::Fault);
    r.coilCut = false;
    r.boot();                                              // reboot with the button stuck low
    r.resetPressed = true;
    r.run(2500);
    CHECK(r.s->state() != State::Armed && r.s->state() != State::Arming);
    CHECK(r.s->lastReply() != Reply::Cleared);
    r.resetPressed = false;                                // released, then a fresh press works
    r.run(200);
    r.resetPressed = true;
    r.run(100);
    r.resetPressed = false;
    r.run(100);
    CHECK(r.s->state() == State::Disarmed || r.s->state() == State::Fault);
    CHECK(!r.out.last.relayOn);
  }
  {  // NC2 stuck low (shorted) while E-stop pressed: coil still opens; bus loss is a FAULT
    Rig r;
    r.toArmed();
    r.decayVps = 400;
    r.estopNc2StuckLow = true;
    r.estopPressed = true;
    r.run(300);
    CHECK(r.s->state() == State::Fault);
    CHECK(!r.out.last.relayOn && noMotor(r));
  }
  {  // reset event while the estop input toggles: never arms
    Rig r;
    r.toDisarmed();
    for (int i = 0; i < 50; i += 1) {
      r.resetPressed = (i % 2) == 0;
      r.run(60);
      CHECK(r.s->state() != State::Armed && r.s->state() != State::Arming);
    }
  }
}

static void test_M6_adc_faults() {
  {  // a single bad reading never faults (3 consecutive needed)
    Rig r;
    r.toArmed();
    r.busStuck = true; r.busStuckMv = 0;
    r.step();
    r.busStuck = false;
    r.run(100);
    CHECK(r.s->state() == State::Armed);
    r.batReadFail = true;
    r.step();
    r.batReadFail = false;
    r.run(100);
    CHECK(r.s->state() == State::Armed);
  }
  {  // bus sensor reads zero while armed
    Rig r; r.toArmed(); r.busStuck = true; r.busStuckMv = 0; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusLost && noMotor(r) && !r.out.last.relayOn);
  }
  {  // bus sensor read fails
    Rig r; r.toArmed(); r.busReadFail = true; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::SensorBus);
  }
  {  // bus sensor saturates
    Rig r; r.toArmed(); r.busStuck = true; r.busStuckMv = 3300; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::SensorBus);
  }
  {  // battery sensor fails / saturates / reads zero
    Rig r; r.toArmed(); r.batReadFail = true; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::SensorBat);
    Rig s; s.toArmed(); s.batStuck = true; s.batStuckMv = 3300; s.run(100);
    CHECK(s.s->state() == State::Fault && s.s->fault() == Fault::SensorBat);
    Rig z; z.toArmed(); z.batStuck = true; z.batStuckMv = 0; z.run(100);
    CHECK(z.s->state() == State::Fault && z.s->fault() == Fault::SensorBat);
  }
  {  // samples stop arriving: stale
    Rig r; r.toArmed(); r.line("l 10"); r.noSamples = true; r.run(300);
    CHECK(r.s->state() == State::Fault && (r.s->fault() == Fault::StaleBat || r.s->fault() == Fault::StaleBus));
    CHECK(noMotor(r) && !r.out.last.relayOn);
  }
  {  // battery above plausible max / below stop minimum while armed
    Rig r; r.toArmed(); r.bat = 13.8f; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BatHigh);
    Rig s; s.toArmed(); s.line("l 10"); s.bat = 9.0f; s.run(100);
    CHECK(s.s->state() == State::Fault && s.s->fault() == Fault::BatLow && noMotor(s));
  }
  {  // idle disagreement between the two sensors
    Rig r; r.toArmed(); r.busStuck = true; r.busStuckMv = Rig::toMv(9.8f); r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::CrossCheck);
  }
  {  // sag under load is allowed, collapse is not
    Rig r; r.toArmed(); r.loadSag = 1.5f; r.line("l 10"); r.run(300);
    CHECK(r.s->state() == State::Running);
    r.loadSag = 6.0f; r.run(100);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusSag && noMotor(r));
  }
  {  // noisy ADC: arm refused until readings agree
    Rig r; r.toDisarmed();
    r.batStuck = true;
    for (int i = 0; i < 10; i += 1) { r.batStuckMv = (i % 2) ? 1800.0f : 2300.0f; r.step(); }
    r.line("arm");
    CHECK(r.s->state() == State::Disarmed && r.s->lastArmCheck() == ArmCheck::BatInvalid);
  }
}

static void test_M7_welded_contact() {
  Rig r;
  r.toArmed();
  r.welded = true;                                         // contacts weld
  r.line("disarm");
  CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn);
  r.run(1900);
  CHECK(r.s->state() == State::Disarmed);                  // still inside the settle window
  r.run(300);
  CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::WeldedContact);
  CHECK(!r.out.last.relayOn && noMotor(r));
  r.resetPressed = true; r.run(100); r.resetPressed = false; r.run(100);
  CHECK(r.s->state() == State::Fault && r.s->lastReply() == Reply::ResetRefused);   // bus still live
  r.line("arm");
  CHECK(r.s->lastReply() == Reply::RejectFault && !r.out.last.relayOn);
  r.welded = false;                                        // weld removed, bus decays
  r.run(1000);
  r.resetPressed = true; r.run(100); r.resetPressed = false; r.run(100);
  CHECK(r.s->state() == State::Disarmed);
}

static void test_M9_M11_bus_live_at_boot_and_stuck_relay() {
  {
    Rig r; r.welded = true; r.boot(); r.run(300);          // bus powered by something at boot
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusLiveAtBoot);
    CHECK(!r.out.last.relayOn && noMotor(r));
    r.line("arm");
    CHECK(r.s->lastReply() == Reply::RejectFault && !r.out.last.relayOn);
  }
  {  // BC337 shorted: relay on whatever the GPIO says
    Rig r; r.relayStuckOn = true; r.boot(); r.run(300);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusLiveAtBoot);
  }
  {  // BC337 shorts later: after DISARM the bus stays up, near battery: contact-weld class fault
    Rig r; r.toArmed(); r.relayStuckOn = true; r.line("disarm"); r.run(2500);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::WeldedContact);
  }
  {  // bus appears while DISARMED and settled
    Rig r; r.toDisarmed(); r.welded = true; r.run(200);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BusLiveRelayOff);
    CHECK(!r.out.last.relayOn);
  }
  {  // boot with no bus samples at all: fault, never "safe"
    Rig r; r.noSamples = true; r.boot(); r.run(2500);
    CHECK(r.s->state() == State::Fault && r.s->fault() == Fault::BootSensor);
    r.line("arm");
    CHECK(r.s->lastReply() == Reply::RejectFault);
  }
}

static void test_M10_power_loss_during_test() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  r.bat = 0.0f;                                            // battery gone, ESP32 still alive on USB
  r.decayVps = 400;
  r.run(100);
  CHECK(r.s->state() == State::Fault && noMotor(r) && !r.out.last.relayOn);
  Rig q;                                                   // battery sags during a run
  q.toArmed();
  q.line("l 10");
  q.bat = 9.0f;
  q.run(100);
  CHECK(q.s->state() == State::Fault && q.s->fault() == Fault::BatLow);
}

static void test_time_wraparound() {
  Rig r(0xFFFFFFFFu - 1200u);                              // the 32-bit ms clock wraps during the test
  r.toArmed();
  r.line("l 10");
  CHECK(r.s->state() == State::Running);
  r.run(1200);
  CHECK(r.s->state() == State::Armed && r.s->lastReply() == Reply::LeaseExpired);
  CHECK(r.now < 100000u);                      // we crossed zero
  r.run(500);
  r.line("r 10");
  CHECK(r.s->state() == State::Running && r.s->side() == Side::Right);
  r.line("s");
  r.estopPressed = true;
  r.step();
  CHECK(r.s->state() == State::Estop);
}

static void test_status_and_misc() {
  Rig r;
  r.toArmed();
  r.line("l 10");
  r.line("status");                                        // a valid command does not stop motion
  CHECK(r.s->lastReply() == Reply::Status && r.s->state() == State::Running);
  r.line("disarm");
  CHECK(r.s->state() == State::Disarmed && !r.out.last.relayOn && noMotor(r));
  r.line("s");                                             // stop is always accepted
  CHECK(r.s->lastReply() == Reply::Stopped);
  CHECK(std::strlen(stateName(State::Fault)) > 0 && std::strlen(faultName(Fault::NoRise)) > 0);
  CHECK(std::strlen(replyName(Reply::RejectB)) > 0 && std::strlen(armCheckName(ArmCheck::BusLive)) > 0);
}

static void test_plan_safety_function() {
  OutputPlan p;
  CHECK(planIsSafe(p, 20, State::Disarmed));
  p.relayOn = true;
  CHECK(!planIsSafe(p, 20, State::Disarmed));              // relay on while DISARMED
  CHECK(planIsSafe(p, 20, State::Armed));
  p.left.en = true; p.left.rpwmPct = 10;
  CHECK(!planIsSafe(p, 20, State::Armed));                 // motor outside RUNNING
  CHECK(planIsSafe(p, 20, State::Running));
  p.right.en = true; p.right.rpwmPct = 10;
  CHECK(!planIsSafe(p, 20, State::Running));               // two motors
  p.right = MotorOut();
  p.left.lpwmPct = 5;
  CHECK(!planIsSafe(p, 20, State::Running));               // LPWM driven
  p.left.lpwmPct = 0; p.left.rpwmPct = 21;
  CHECK(!planIsSafe(p, 20, State::Running));               // above cap
  p.left.rpwmPct = 10; p.relayOn = false;
  CHECK(!planIsSafe(p, 20, State::Running));               // EN without motor power
  p.relayOn = true; p.left.en = false;
  CHECK(!planIsSafe(p, 20, State::Running));               // duty without EN
}

static void test_interlock_reset_and_estop_units() {
  Limits lim;
  {  // reset held low from boot: never fires, however long
    Interlock il(makeTh(), lim);
    for (uint32_t t = 0; t < 3000; t += 10) il.feedReset(t, true, true);
    CHECK(!il.takeResetEvent());
    // released long enough, then a fresh press: exactly one event
    for (uint32_t t = 3000; t < 3200; t += 10) il.feedReset(t, true, false);
    CHECK(!il.takeResetEvent());
    uint32_t events = 0;
    for (uint32_t t = 3200; t < 3600; t += 10) { il.feedReset(t, true, true); if (il.takeResetEvent()) events += 1; }
    CHECK(events == 1);                                    // held: still one event
    // a bounce shorter than the debounce does not fire
    for (uint32_t t = 3600; t < 3800; t += 10) il.feedReset(t, true, false);
    il.feedReset(3800, true, true); il.feedReset(3810, true, true); il.feedReset(3820, true, false);
    CHECK(!il.takeResetEvent());
  }
  {  // invalid reset pin read never fires and forgets "released"
    Interlock il(makeTh(), lim);
    for (uint32_t t = 0; t < 500; t += 10) il.feedReset(t, true, false);
    il.feedReset(500, false, false);
    for (uint32_t t = 510; t < 700; t += 10) il.feedReset(t, true, true);
    CHECK(!il.takeResetEvent());
  }
  {  // E-stop: starts active, release needs stable LOW, any HIGH re-asserts at once
    Interlock il(makeTh(), lim);
    CHECK(il.estopActive());
    il.feedEstop(0, true, false);
    CHECK(il.estopActive());                               // not yet debounced
    il.feedEstop(30, true, false);
    CHECK(il.estopActive());
    il.feedEstop(60, true, false);
    CHECK(!il.estopActive());
    il.feedEstop(70, true, true);
    CHECK(il.estopActive());
    il.feedEstop(80, true, false);
    il.feedEstop(120, true, false);
    CHECK(il.estopActive());                               // debounce restarted by the glitch
    il.feedEstop(140, true, false);
    CHECK(!il.estopActive());
    il.feedEstop(150, false, false);                       // invalid read
    CHECK(il.estopActive());
  }
}

// ------------------------------------------------------------------ fuzz / fault injection

struct Rng {
  uint32_t x;
  explicit Rng(uint32_t seed) : x(seed ? seed : 1) {}
  uint32_t next() { x ^= x << 13; x ^= x >> 17; x ^= x << 5; return x; }
  uint32_t below(uint32_t n) { return next() % n; }
};

static void fuzzOne(uint32_t seed) {
  Rig r;
  Rng rng(seed);
  r.boot();
  const char* corpus[] = {"arm", "arm", "disarm", "s", "status", "l 10", "l 20", "r 10", "r 20", "l 21", "r 0",
                          "b 10", "b", "l", "xyz", "L 10", "l -1", "l 5x", "", "l 10", "r 10", "l 1", "r 1"};
  const int nCorpus = static_cast<int>(sizeof corpus / sizeof corpus[0]);
  State prev = r.s->state();
  uint32_t violations = 0;
  uint32_t armedByReset = 0;
  for (int i = 0; i < 30000; i += 1) {
    const uint32_t a = rng.below(100);
    bool armLine = false;
    bool sentLine = false;
    State beforeLine = r.s->state();
    if (a < 12) {
      char buf[64];
      const char* src = corpus[rng.below(nCorpus)];
      if (rng.below(8) == 0) {                             // random bytes
        const size_t n = rng.below(40);
        for (size_t k = 0; k < n; k += 1) buf[k] = static_cast<char>(rng.below(256));
        r.s->onLine(buf, n, r.now);
      } else {
        r.line(src);
        armLine = std::strcmp(src, "arm") == 0;
      }
      sentLine = true;
    }
    if (sentLine && beforeLine == State::Running && replyIsReject(r.s->lastReply())) {
      // decision 2: a rejection during RUNNING leaves all motor outputs safe at once
      if (!(planIsZero(r.out.last) && r.s->state() == State::Armed)) violations += 1;
    }
    const uint32_t b = rng.below(1000);
    if (b < 6) r.estopPressed = !r.estopPressed;
    else if (b < 9) r.estopWireOpen = !r.estopWireOpen;
    else if (b < 12) r.coilCut = !r.coilCut;
    else if (b < 15) r.welded = !r.welded;
    else if (b < 18) r.resetPressed = !r.resetPressed;
    else if (b < 21) r.busStuck = !r.busStuck, r.busStuckMv = static_cast<float>(rng.below(3400));
    else if (b < 24) r.batStuck = !r.batStuck, r.batStuckMv = static_cast<float>(rng.below(3400));
    else if (b < 26) r.batReadFail = !r.batReadFail;
    else if (b < 28) r.busReadFail = !r.busReadFail;
    else if (b < 30) r.noSamples = !r.noSamples;
    else if (b < 33) r.relayStuckOn = !r.relayStuckOn;
    else if (b < 36) r.bat = 8.0f + static_cast<float>(rng.below(60)) / 10.0f;
    else if (b < 38) r.decayVps = 5.0f + static_cast<float>(rng.below(500));
    if (rng.below(2000) == 0) r.boot();                    // a reset at any moment
    r.step(5 + rng.below(30) * (rng.below(200) == 0 ? 12 : 1));   // occasional stall

    const State cur = r.s->state();
    const OutputPlan& p = r.out.last;
    if (!planIsSafe(p, 20, cur)) violations += 1;
    if (cur != State::Running && !planIsZero(p)) violations += 1;
    if (cur != State::Arming && cur != State::Armed && cur != State::Running && p.relayOn) violations += 1;
    if (p.left.en && p.right.en) violations += 1;
    if (p.left.lpwmPct || p.right.lpwmPct) violations += 1;
    // nothing but an explicit "arm" line (from DISARMED) may start arming: reset and E-stop release never do
    if (prev != State::Arming && cur == State::Arming && !armLine) armedByReset += 1;
    if (prev == State::Estop && (cur == State::Arming || cur == State::Armed || cur == State::Running)) armedByReset += 1;
    if (prev == State::Fault && (cur == State::Arming || cur == State::Armed || cur == State::Running)) armedByReset += 1;
    if (r.s->invariantViolations() != 0) violations += 1;
    prev = cur;
  }
  CHECK(violations == 0);
  CHECK(armedByReset == 0);
  CHECK(r.out.bad == 0);
  CHECK(r.out.enWithoutRelayBefore == 0);
}

static void test_fuzz_fault_injection() {
  const uint32_t seeds[] = {1, 2, 3, 0xBEEF, 0xC0FFEE, 12345, 987654321u};
  for (uint32_t seed : seeds) fuzzOne(seed);
}

// ------------------------------------------------------------------ main

int main() {
  RUN(test_sentinels_runtime);
  RUN(test_parser);
  RUN(test_T1_power_on);
  RUN(test_T2_arm);
  RUN(test_T2_arm_refusals);
  RUN(test_T3_one_motor);
  RUN(test_T3_3_and_duty);
  RUN(test_T3_5_reject_during_running_forces_safe);
  RUN(test_refresh_lease_and_limits);
  RUN(test_boot_total_limit);
  RUN(test_inactivity_disarms);
  RUN(test_T4_T5_estop);
  RUN(test_T6_arm_while_estop_held);
  RUN(test_T7_estop_wire_open);
  RUN(test_T8_coil_power_interrupted);
  RUN(test_T9_reset_never_arms);
  RUN(test_M1_reset_brownout_reboot);
  RUN(test_M2_loop_stall);
  RUN(test_M3_serial_disconnect);
  RUN(test_M4_malformed_commands);
  RUN(test_M5_stuck_inputs);
  RUN(test_M6_adc_faults);
  RUN(test_M7_welded_contact);
  RUN(test_M9_M11_bus_live_at_boot_and_stuck_relay);
  RUN(test_M10_power_loss_during_test);
  RUN(test_time_wraparound);
  RUN(test_status_and_misc);
  RUN(test_plan_safety_function);
  RUN(test_interlock_reset_and_estop_units);
  RUN(test_fuzz_fault_injection);
  std::printf("\n%d checks, %d failed\n", g_checks, g_fail);
  return g_fail == 0 ? 0 : 1;
}
