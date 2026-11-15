/*
 * Tests for js/esp32-session.js (M0): the session adapter around the Phase
 * 2A.1 link, run against the IN-MEMORY Mock ESP32 (js/mock-socket.js).
 *
 *   node --test tests/esp32-session.test.mjs
 *
 * IMPORTANT: everything here is simulated time and a mock device. Passing
 * proves the adapter's behavior against the mock only. It proves NOTHING
 * about a real ESP32, a real Wi-Fi network, real latency or any motor.
 *
 * Coverage (see each test name):
 *   S1  connect: handshake, first CMD is STOP, no motion, FOLLOW off
 *   S2  FOLLOW gate: no movement until ARM / FOLLOW; then movement; STOP stops it
 *   S3  FOLLOW refused when not connected / hidden / after ESTOP
 *   S4  stale detection and a missing detection time never move
 *   S5  target lost (STOP decisions) stops the motor
 *   S6  socket loss: STOP, new sid, FOLLOW off, no movement until re-armed
 *   S7  silent peer: link timeout, device latches, socket recycled, new session
 *   S8  hidden page: STOP + BYE, no socket, new session on return, no movement
 *   S9  ESTOP: device latch, repeated ESTOP, no session on reconnect, clear = new session only
 *   S10 stale replies: old socket and old sid are dropped
 *   S11 invalid frames change nothing
 *   S12 transport: send refused when closed; movement refused on a backlog, STOP still sent
 *   S13 device BUSY: never retried by itself
 *   S14 disconnect: STOP + BYE and no reconnect
 *   S15 socket creation failure and open timeout back off and recover
 *   S16 device timers: lost link while MOVING and while IDLE both latch
 *   S17 STOP/ESTOP and watchdog behavior stay the protocol's (no app bypass)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEsp32Session } from "../js/esp32-session.js";
import { createMockDeviceNetwork } from "../js/mock-socket.js";
import { seededRandom } from "./helpers/esp32-rig.mjs";

/* ---------- simulated clock and timers ---------- */

function createClock(start = 1000) {
  let t = start;
  let counter = 0;
  const entries = new Map();

  const add = (fn, ms, repeat) => {
    const id = ++counter;
    entries.set(id, { id, fn, due: t + Math.max(0, ms), every: repeat ? Math.max(1, ms) : null, order: id });
    return id;
  };

  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: id => { entries.delete(id); },
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: id => { entries.delete(id); }
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const entry of entries.values()) {
          if (entry.due > end) continue;
          if (!next || entry.due < next.due || (entry.due === next.due && entry.order < next.order)) next = entry;
        }
        if (!next) break;
        t = Math.max(t, next.due);
        if (next.every !== null) {
          next.due += next.every;
          next.order = ++counter;
        } else {
          entries.delete(next.id);
        }
        next.fn();
      }
      t = end;
    }
  };
}

/* ---------- rig ---------- */

function createRig({ latencyMs = 10, seed = 7, sessionOptions = {}, network = null, clock = null } = {}) {

  const c = clock ?? createClock();
  const net = network ?? createMockDeviceNetwork({
    timers: c.timers,
    now: c.now,
    latencyMs,
    random32: (() => { const r = seededRandom(101); return () => r.u32(); })()
  });
  const events = [];

  const session = createEsp32Session({
    createSocket: url => net.createSocket(url),
    now: c.now,
    timers: c.timers,
    randomValues: seededRandom(seed).fill,
    onChange: (status, event) => events.push(event),
    ...sessionOptions
  });

  const rig = {
    clock: c, net, session, events,

    device: () => net.device.getStatus(),
    status: () => session.getStatus(),

    connect() {
      session.connect("mock://device");
      c.advance(400);
    },

    /* Feeds one decision every 25 ms. detectionAgeMs: how old the detection is. */
    drive(ms, command, detectionAgeMs = 30) {
      for (let spent = 0; spent < ms; spent += 25) {
        session.setDecision(command, detectionAgeMs === null ? null : c.now() - detectionAgeMs);
        c.advance(25);
      }
    },

    sent(type) {
      return net.log.filter(entry => entry.dir === "app->device" && entry.message.t === type);
    },

    movedSince(index) {
      return rig.device().motorLog.slice(index).filter(entry => entry.command !== "STOP");
    },

    /* connect + ARM / FOLLOW + movement reaches the (mock) motor */
    moving() {
      rig.connect();
      assert.equal(session.setFollow(true), true);
      rig.drive(700, "FORWARD");
      assert.equal(rig.device().motor, "FORWARD", "precondition: the mock motor moves");
    }
  };

  return rig;
}

/* ---------- S1 connect ---------- */

test("S1 connect: handshake over the mock, the first CMD is STOP, no motion, FOLLOW off", () => {
  const rig = createRig();
  rig.connect();

  const status = rig.status();
  assert.equal(status.link.connected, true);
  assert.equal(status.follow, false);
  assert.equal(status.link.state, "IDLE");

  const device = rig.device();
  assert.equal(device.state, "IDLE");
  assert.equal(device.motor, "STOP");
  assert.equal(device.session, status.link.session);

  const order = rig.net.log.filter(e => e.dir === "app->device").map(e => e.message.t);
  assert.deepEqual(order.slice(0, 3), ["HELLO", "ARM", "CMD"]);
  assert.equal(rig.sent("CMD")[0].message.cmd, "STOP");
  assert.equal(rig.movedSince(0).length, 0);
});

/* ---------- S2 FOLLOW gate ---------- */

test("S2 no movement until ARM / FOLLOW; then the mock motor moves; STOP decisions stop it", () => {
  const rig = createRig();
  rig.connect();

  rig.drive(1000, "FORWARD");                       // follow is OFF
  assert.equal(rig.movedSince(0).length, 0, "FOLLOW off: the link only ever sees STOP");

  assert.equal(rig.session.setFollow(true), true);
  rig.drive(700, "FORWARD");
  assert.equal(rig.device().motor, "FORWARD");
  assert.equal(rig.device().state, "MOVING");

  rig.drive(400, "STOP");
  assert.equal(rig.device().motor, "STOP");
});

/* ---------- S3 FOLLOW refusals ---------- */

test("S3 FOLLOW is refused when not connected, when hidden and after ESTOP", () => {
  const idle = createRig();
  assert.equal(idle.session.setFollow(true), false, "no connection");
  assert.equal(idle.status().follow, false);

  const rig = createRig();
  rig.connect();
  rig.session.hide();
  assert.equal(rig.session.setFollow(true), false, "hidden page");
  rig.session.show();
  rig.clock.advance(600);

  rig.session.emergencyStop();
  assert.equal(rig.session.setFollow(true), false, "ESTOP latched");
  assert.equal(rig.status().follow, false);
});

/* ---------- S4 stale / missing detection ---------- */

test("S4 a stale detection (> 450 ms) and a missing detection time never move", () => {
  const rig = createRig();
  rig.connect();
  rig.session.setFollow(true);

  rig.drive(900, "FORWARD", 600);                   // age 600 > 450: the link's own gate
  assert.equal(rig.movedSince(0).length, 0, "stale detection");

  rig.drive(900, "FORWARD", null);                  // no detection time
  assert.equal(rig.movedSince(0).length, 0, "missing detection time");
});

/* ---------- S5 target lost ---------- */

test("S5 target lost (STOP decisions) stops the motor and it stays stopped", () => {
  const rig = createRig();
  rig.moving();

  rig.drive(300, "STOP");
  assert.equal(rig.device().motor, "STOP");
  const mark = rig.device().motorLog.length;
  rig.drive(1000, "STOP");
  assert.equal(rig.movedSince(mark).length, 0);
});

/* ---------- S6 socket loss ---------- */

test("S6 socket loss: STOP, a NEW session, FOLLOW off, no movement until re-armed", () => {
  const rig = createRig();
  rig.moving();
  const oldSid = rig.status().link.session;

  const mark = rig.device().motorLog.length;
  rig.net.closeFromDevice();                        // 1006, as after a Wi-Fi drop
  assert.equal(rig.status().follow, false, "FOLLOW switched off at once");
  assert.equal(rig.status().link.state, "DISCONNECTED");

  rig.drive(2000, "FORWARD");                       // decisions keep coming; follow is OFF
  const status = rig.status();
  assert.equal(status.link.connected, true, "reconnected by itself");
  assert.notEqual(status.link.session, oldSid, "a new sid");
  assert.equal(status.follow, false);
  assert.ok(status.stats.reconnects >= 1);

  const afterLoss = rig.movedSince(mark);
  assert.equal(afterLoss.length, 0, "the motor never moved again after the loss");

  assert.equal(rig.session.setFollow(true), true);
  rig.drive(700, "FORWARD");
  assert.equal(rig.device().motor, "FORWARD", "fresh authorization after the user re-armed");
  assert.equal(rig.device().session, status.link.session);
});

/* ---------- S7 silent peer ---------- */

test("S7 silent peer: the device latches by its own timers, the socket is recycled, a new session follows", () => {
  const rig = createRig();
  rig.moving();
  const oldSid = rig.status().link.session;
  const mark = rig.device().motorLog.length;

  rig.net.blackhole = true;                         // sockets stay OPEN, nothing is delivered
  rig.drive(900, "FORWARD");
  assert.equal(rig.device().state, "LATCHED", "the device stops on its own timers");
  assert.equal(rig.device().motor, "STOP");
  assert.ok(["WATCHDOG", "IDLE_TIMEOUT"].includes(rig.device().latchReason));
  assert.equal(rig.status().follow, false);

  rig.drive(4000, "FORWARD");
  assert.ok(rig.status().stats.socketsLost >= 1, "the silent socket was recycled");

  rig.net.blackhole = false;
  rig.drive(5000, "FORWARD");
  assert.equal(rig.status().link.connected, true);
  assert.notEqual(rig.status().link.session, oldSid);
  assert.equal(rig.movedSince(mark).length, 0, "no movement without ARM / FOLLOW");
});

/* ---------- S8 hidden page ---------- */

test("S8 hidden page: STOP then BYE, no socket; visible: new session, no movement until re-armed", () => {
  const rig = createRig();
  rig.moving();
  const oldSid = rig.status().link.session;
  const mark = rig.device().motorLog.length;

  rig.session.hide();
  rig.clock.advance(100);
  assert.equal(rig.device().state, "LATCHED");
  assert.equal(rig.device().latchReason, "BYE");
  assert.equal(rig.device().motor, "STOP");
  assert.equal(rig.status().socket, "NONE");
  assert.equal(rig.status().follow, false);

  const sockets = rig.net.sockets.length;
  const sentBefore = rig.net.log.length;
  rig.drive(3000, "FORWARD");                       // decisions while hidden
  assert.equal(rig.net.sockets.length, sockets, "no socket is opened while hidden");
  assert.equal(rig.net.log.length, sentBefore, "nothing is sent while hidden");

  rig.session.show();
  rig.drive(1000, "FORWARD");
  assert.equal(rig.status().link.connected, true);
  assert.notEqual(rig.status().link.session, oldSid);
  assert.equal(rig.movedSince(mark).length, 0, "no movement after the page came back");

  assert.equal(rig.session.setFollow(true), true);
  rig.drive(700, "FORWARD");
  assert.equal(rig.device().motor, "FORWARD");
});

/* ---------- S9 ESTOP ---------- */

test("S9 ESTOP: device latch, repeated ESTOP, no session on reconnect, clearing starts a session without moving", () => {
  const rig = createRig();
  rig.moving();

  rig.session.emergencyStop();
  rig.clock.advance(100);
  assert.equal(rig.device().state, "LATCHED");
  assert.equal(rig.device().latchReason, "ESTOP");
  assert.equal(rig.device().motor, "STOP");
  assert.equal(rig.status().follow, false);
  assert.equal(rig.status().emergency, true);

  const estops = rig.sent("ESTOP").length;
  rig.drive(1000, "FORWARD");
  assert.ok(rig.sent("ESTOP").length >= estops + 3, "ESTOP is repeated every heartbeat");
  assert.equal(rig.device().motor, "STOP");

  // A reconnect never releases the latch and never starts a session.
  const hellos = rig.sent("HELLO").length;
  rig.net.closeFromDevice();
  rig.drive(3000, "FORWARD");
  assert.equal(rig.sent("HELLO").length, hellos, "no HELLO while ESTOP is latched");
  assert.equal(rig.status().link.state, "DISCONNECTED");
  assert.equal(rig.status().emergency, true);

  const mark = rig.device().motorLog.length;
  rig.session.clearEmergency();
  rig.drive(1000, "FORWARD");
  assert.equal(rig.status().emergency, false);
  assert.equal(rig.status().link.connected, true, "a NEW session after clearing");
  assert.equal(rig.status().follow, false);
  assert.equal(rig.movedSince(mark).length, 0, "clearing ESTOP does not resume movement");

  rig.session.setFollow(true);
  rig.drive(700, "FORWARD");
  assert.equal(rig.device().motor, "FORWARD");
});

/* ---------- S10 stale replies ---------- */

test("S10 a late reply from an old socket and an ACK with an old sid are dropped", () => {
  const rig = createRig();
  rig.moving();
  const oldSid = rig.status().link.session;

  rig.net.holdReplies = true;
  rig.drive(200, "FORWARD");                        // replies are held back
  rig.net.closeFromDevice();
  rig.net.holdReplies = false;
  rig.drive(2000, "STOP");

  const before = rig.status();
  assert.equal(before.link.connected, true);
  assert.notEqual(before.link.session, oldSid);

  const released = rig.net.releaseHeld();           // old replies arrive late
  rig.clock.advance(100);
  assert.ok(released > 0, "precondition: there were held replies");

  const after = rig.status();
  assert.ok(after.stats.staleMessagesDropped >= released, "dropped before the link saw them");
  assert.equal(after.link.counters.received, before.link.counters.received);
  assert.equal(after.link.lastOkAckAt, before.link.lastOkAckAt, "stale replies renew nothing");

  // An ACK that carries the OLD sid, delivered on the NEW socket.
  const socket = rig.net.sockets.at(-1);
  socket._receive(JSON.stringify({ v: 2, t: "ACK", sid: oldSid, seq: 3, ok: true, tok: 77, epoch: 1, motor: "STOP" }));
  const last = rig.status();
  assert.equal(last.link.counters.received, before.link.counters.received);
  assert.equal(last.link.token.tok === 77, false);
});

/* ---------- S11 invalid frames ---------- */

test("S11 invalid frames (not JSON, binary, array, null, empty object) change nothing", () => {
  const rig = createRig();
  rig.connect();
  const before = rig.status();
  const socket = rig.net.sockets.at(-1);

  socket._receive("not json at all");
  socket._emit("message", { data: new Uint8Array([1, 2, 3]) });
  socket._receive("[1,2,3]");
  socket._receive("null");
  socket._receive("{}");
  socket._receive(JSON.stringify({ v: 2, t: "ACK", sid: before.link.session, seq: 99, ok: true }));

  const after = rig.status();
  assert.equal(after.stats.badFrames, 4);
  assert.equal(after.link.lastOkAckAt, before.link.lastOkAckAt, "invalid packets renew nothing");
  assert.equal(after.link.counters.received, before.link.counters.received);
  assert.equal(after.link.connected, true);
});

/* ---------- S12 transport ---------- */

test("S12 send is refused on a closed socket (no throw); a backlog blocks movement but not STOP", () => {
  const closed = createRig();
  closed.moving();
  closed.net.closeFromDevice();
  assert.doesNotThrow(() => closed.session.emergencyStop());
  assert.doesNotThrow(() => closed.session.setDecision("FORWARD", closed.clock.now() - 10));

  const rig = createRig();
  rig.connect();
  rig.session.setFollow(true);
  const socket = rig.net.sockets.at(-1);
  socket.bufferedAmount = 5000;                     // above the proposal limit

  const moves = rig.sent("CMD").filter(e => e.message.cmd !== "STOP").length;
  rig.drive(500, "FORWARD");
  assert.equal(rig.sent("CMD").filter(e => e.message.cmd !== "STOP").length, moves, "no movement CMD on a backlog");
  assert.ok(rig.status().stats.sendRefused > 0);

  const stops = rig.sent("CMD").filter(e => e.message.cmd === "STOP").length;
  rig.drive(400, "STOP");
  assert.ok(rig.sent("CMD").filter(e => e.message.cmd === "STOP").length > stops, "STOP is still sent");
});

/* ---------- S13 BUSY ---------- */

test("S13 a BUSY device is never retried by itself", () => {
  const clock = createClock();
  const a = createRig({ clock });
  a.connect();
  assert.equal(a.status().link.connected, true);

  const b = createRig({ clock, network: a.net, seed: 99 });
  b.session.connect("mock://device");
  for (let spent = 0; spent < 4000; spent += 50) {
    a.session.setDecision("STOP", null);            // A keeps its session fresh
    clock.advance(50);
  }

  assert.equal(b.status().desired, false);
  assert.equal(b.status().lastEvent, "DEVICE_BUSY");
  assert.equal(b.status().socket, "NONE");
  assert.equal(b.status().stats.reconnects, 0);
  assert.equal(a.status().link.connected, true, "the first session was not disturbed");
  assert.equal(a.device().session, a.status().link.session);
});

/* ---------- S14 disconnect ---------- */

test("S14 disconnect sends STOP then BYE and never reconnects", () => {
  const rig = createRig();
  rig.moving();
  rig.session.disconnect();
  rig.clock.advance(100);

  assert.equal(rig.device().latchReason, "BYE");
  assert.equal(rig.device().motor, "STOP");
  assert.equal(rig.status().desired, false);

  const sockets = rig.net.sockets.length;
  rig.drive(4000, "FORWARD");
  assert.equal(rig.net.sockets.length, sockets);
  assert.equal(rig.status().stats.reconnects, 0);
});

/* ---------- S15 creation failure / open timeout ---------- */

test("S15 a failing createSocket and a socket that never opens back off and recover", () => {
  const clock = createClock();
  let calls = 0;
  const failing = createEsp32Session({
    createSocket() { calls += 1; throw new Error("boom"); },
    now: clock.now,
    timers: clock.timers,
    randomValues: seededRandom(5).fill
  });
  assert.doesNotThrow(() => failing.connect("ws://x/ws"));
  clock.advance(4000);
  assert.ok(calls >= 3, "retried with backoff");
  failing.dispose();

  const rig = createRig();
  rig.net.neverOpen = true;
  rig.session.connect("mock://device");
  rig.clock.advance(3100);
  assert.ok(rig.events.includes("SOCKET_LOST:OPEN_TIMEOUT"));
  rig.net.neverOpen = false;
  rig.clock.advance(4000);
  assert.equal(rig.status().link.connected, true);
});

/* ---------- S16 device timers ---------- */

test("S16 losing the link while MOVING and while IDLE both end latched on the device timers", () => {
  const moving = createRig();
  moving.moving();
  moving.net.blackhole = true;
  moving.drive(800, "FORWARD");
  assert.equal(moving.device().state, "LATCHED");
  assert.equal(moving.device().motor, "STOP");

  const idle = createRig();
  idle.connect();
  idle.net.blackhole = true;
  idle.drive(800, "STOP");
  assert.equal(idle.device().state, "LATCHED");
  assert.equal(idle.device().latchReason, "IDLE_TIMEOUT", "session liveness expired with no movement armed");
});

/* ---------- S17 no app bypass ---------- */

test("S17 the app cannot move the device without the protocol: no CMD movement before ARM ack, no token reuse across sessions", () => {
  const rig = createRig();
  rig.connect();
  rig.session.setFollow(true);
  rig.drive(700, "FORWARD");

  const log = rig.net.log.filter(e => e.dir === "app->device");
  const firstMove = log.findIndex(e => e.message.t === "CMD" && e.message.cmd !== "STOP");
  const arm = log.findIndex(e => e.message.t === "ARM");
  assert.ok(arm >= 0 && firstMove > arm, "movement only after ARM");

  const move = log[firstMove].message;
  assert.ok(Number.isInteger(move.tok) && Number.isInteger(move.did) && Number.isInteger(move.ackSeq));
  assert.ok(move.age <= 450, "the age claim stays within the unchanged 450 ms gate");

  // After a new session no CMD may carry a token from the old one.
  const oldTokens = new Set(log.filter(e => e.message.tok !== undefined).map(e => e.message.tok));
  rig.net.closeFromDevice();
  rig.drive(2000, "FORWARD");
  rig.session.setFollow(true);
  rig.drive(700, "FORWARD");
  const newSid = rig.status().link.session;
  const fresh = rig.net.log
    .filter(e => e.dir === "app->device" && e.message.sid === newSid && e.message.t === "CMD" && e.message.cmd !== "STOP");
  assert.ok(fresh.length > 0);
  for (const entry of fresh) assert.equal(oldTokens.has(entry.message.tok), false, "no token reuse");
});

/* ---------- S18 / S19: the data the panel's "device motor" display relies on ---------- */
/*
 * js/app.js shows the device motor only while: no ESTOP, an OPEN socket, an
 * established link, and link.lastOkAckAt !== null (a valid ok:true ACK of the
 * CURRENT session). The link itself keeps its last motor value after ESTOP and
 * across sessions, which is why the display rule is needed. These tests pin
 * the facts that rule depends on.
 */

test("S18 ESTOP: the link keeps its last motor value but reports the latch (the display must hide it)", () => {
  const rig = createRig();
  rig.moving();
  assert.equal(rig.status().link.deviceMotor, "FORWARD");

  rig.session.emergencyStop();
  rig.drive(800, "FORWARD");

  const status = rig.status();
  assert.equal(status.emergency, true, "the display hides the motor on this flag");
  assert.equal(status.link.deviceMotor, "FORWARD", "stale: replies are ignored while ESTOP is latched");
  assert.equal(rig.device().motor, "STOP", "the device itself is stopped");
});

test("S19 socket loss and reconnect: lastOkAckAt is empty until the new session's first valid ACK", () => {
  const rig = createRig({ latencyMs: 40 });                    // a slower wire makes the handshake window visible
  rig.moving();
  assert.equal(rig.status().link.deviceMotor, "FORWARD");
  assert.notEqual(rig.status().link.lastOkAckAt, null);

  rig.net.closeFromDevice();
  const lost = rig.status();
  assert.equal(lost.link.connected, false);
  assert.notEqual(lost.socket, "OPEN");
  assert.equal(lost.link.lastOkAckAt, null, "cleared when the session ended");

  // Step through the reconnect and inspect every state before the first valid ACK.
  let sawWindow = false;
  for (let spent = 0; spent < 3000; spent += 5) {
    rig.clock.advance(5);
    const status = rig.status();
    if (status.link.connected) break;
    if (status.socket === "OPEN" && status.link.state !== "DISCONNECTED") {
      sawWindow = true;
      assert.equal(status.link.lastOkAckAt, null, "no valid ACK of the new session yet");
      assert.equal(status.link.deviceMotor, "FORWARD", "the old session's value is still held: the display must not show it");
    }
  }
  assert.equal(sawWindow, true, "the handshake window was observed");

  const fresh = rig.status();
  assert.equal(fresh.link.connected, true);
  assert.notEqual(fresh.link.lastOkAckAt, null, "set by the new session's own ACK");
  assert.equal(fresh.link.deviceMotor, "STOP", "the value now comes from the new session's ACK");
});
