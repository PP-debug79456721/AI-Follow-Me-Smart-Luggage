// ESP32 Motor Test sketch (M3). A bench tool for ONE motor at a time over USB serial.
//
//   *** AUTHORED ONLY: NEVER COMPILED, NEVER FLASHED, NEVER RUN. ***
//   *** EVERY GPIO ASSIGNMENT AND EVERY THRESHOLD IS UNVERIFIED / UNSET. ***
//
// No Wi-Fi, no WebSocket, no protocol code. It shares nothing with the Demo
// firmware. All hardware access is in bench_driver.h; this file only sequences it.
//
// Safety order (each step is checked by tests/motor-test-driver.test.mjs):
//   setup(): outputs latched LOW then enabled -> serial -> watchdog and PWM setup
//            -> only if both succeeded: create and begin the session.
//   loop():  subscribe the loop task to the watchdog (first iteration) -> inputs ->
//            serial line -> session tick (the single output write) -> output health
//            -> feed the watchdog LAST, only if every step succeeded.
//   Startup failure: INERT. Relay off, EN low, no session, no commands read.
//   Output failure at run time: STARVED. Everything forced safe, the watchdog is
//            deliberately not fed so it resets the chip. The watchdog is a software
//            layer, not a hardware motor kill.
//
// The thresholds below are all UNSET, so ARM is refused until they are measured and
// filled in (M4, separately approved).

#include "bench_driver.h"
#include "bench_session.h"
#include "motor_test_config.h"

using namespace mt;

namespace {

enum class Mode : uint8_t { Normal, Inert, Starved };

BenchDriver g_drv;
Session* g_session = nullptr;
Mode g_mode = Mode::Normal;
bool g_subscribed = false;
const char* g_why = "";
uint32_t g_lastReplies = 0;
uint32_t g_lastStatusAt = 0;
uint32_t g_lastNoteAt = 0;

// Every field is UNSET (0): the session refuses ARM. Fill from bench measurements only.
Thresholds makeThresholds() {
  Thresholds t;
  return t;
}

// No session is used here: it never reads input, never ticks, never accepts ARM.
void inertLoop() {
  g_drv.forceSafe();
  const uint32_t now = g_drv.nowMs();
  if (static_cast<uint32_t>(now - g_lastNoteAt) >= 1000) {
    g_lastNoteAt = now;
    g_drv.say(g_why);
  }
  g_drv.pace();
}

}  // namespace

void setup() {
  g_drv.latchOutputsLowThenEnable();
  g_drv.beginSerial();
  g_drv.say("esp32-motor-test M3: UNBUILT, PINS UNVERIFIED, THRESHOLDS UNSET");

  if (!g_drv.startup()) {
    g_mode = Mode::Inert;
    g_why = "INERT: startup failed (watchdog or PWM). Relay off, EN low, no session, no ARM.";
    g_drv.forceSafe();
    g_drv.reportStartup();
    return;
  }
  g_drv.reportStartup();

  g_session = new Session(makeThresholds(), Limits(), g_drv);
  if (g_session == nullptr) {
    g_mode = Mode::Inert;
    g_why = "INERT: session could not be created. Relay off, EN low, no ARM.";
    g_drv.forceSafe();
    return;
  }
  g_session->begin(g_drv.nowMs());
}

void loop() {
  if (g_mode != Mode::Normal) {
    inertLoop();
    return;
  }

  if (!g_subscribed) {
    if (!g_drv.subscribeLoopTask()) {
      g_mode = Mode::Inert;
      g_why = "INERT: loop task could not be subscribed to the watchdog. Relay off, EN low, no ARM.";
      g_drv.forceSafe();
      return;
    }
    g_subscribed = true;
  }

  const uint32_t now = g_drv.nowMs();

  AdcSample bat;
  AdcSample bus;
  if (g_drv.readAdcIfDue(now, bat, bus)) {
    g_session->feedVbat(bat);
    g_session->feedVbus(bus);
  }
  g_session->feedEstop(now, true, g_drv.estopPinHigh());
  g_session->feedReset(now, true, g_drv.resetPinLow());

  const char* line = nullptr;
  size_t length = 0;
  const LineEvent event = g_drv.pollLine(line, length);
  if (event == LineEvent::Line) {
    g_session->onLine(line, length, now);
  } else if (event == LineEvent::Overflow) {
    g_session->onOverflow(now);
  }

  g_session->tick(now);

  if (g_session->replyCount() != g_lastReplies) {
    g_lastReplies = g_session->replyCount();
    g_drv.printReply(g_session->lastReply());
  }
  if (static_cast<uint32_t>(now - g_lastStatusAt) >= 1000) {
    g_lastStatusAt = now;
    g_drv.printStatus(*g_session);
  }

  if (g_drv.outputFault()) {
    g_mode = Mode::Starved;
    g_why = "STARVED: an output write failed. Forced safe; watchdog deliberately not fed.";
    g_drv.forceSafe();
    return;
  }

  if (!g_drv.feedWatchdog()) {
    g_mode = Mode::Starved;
    g_why = "STARVED: watchdog feed failed. Forced safe; watchdog not fed.";
    g_drv.forceSafe();
    return;
  }

  g_drv.pace();
}
