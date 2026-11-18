/*
 * Tests for js/esp32-link.js (app side) and the app/device wiring, protocol v2.
 * Everything is in memory with simulated, INDEPENDENT app and device clocks:
 * no timers, no network.
 *   node --test tests/esp32-link.test.mjs
 * The K1/K2 timer, STOP, ESTOP and did rules of the device are in
 * tests/esp32-faults.test.mjs. Shared rig: tests/helpers/esp32-rig.mjs.
 *
 * ---- Migration ledger: the 60 tests of the previous version of this file ----
 * K = kept, U = updated (same intent, new API/semantics), R = replaced.
 *  L01 documented defaults ................ U  "documented v2 constants..."
 *  L02 transport is required .............. K  "transport is required"
 *  L03 every message is v2 ................ R  "every message is v2 with a hex16 sid..."
 *  L04 starts DISCONNECTED ................ K  "starts DISCONNECTED and sends nothing"
 *  L05 connect: ARM flow .................. R  "handshake: HELLO, CHALLENGE, ARM, ACK..."
 *  L06 CONNECTING ARM retried ............. R  "HELLO is resent every 200 ms..."
 *  L07 decision while CONNECTING .......... U  "a decision given during the handshake..."
 *  L08 disconnect() final STOP ............ R  "disconnect() sends STOP then BYE..."
 *  L09 STOP/FORWARD/LEFT/RIGHT ............ U  "STOP, FORWARD, LEFT and RIGHT all reach the motor"
 *  L10 changed command sent at once ....... U  "a new movement decision is sent at once"
 *  L11 every decision a new did ........... R  "did follows the detection time..."
 *  L12 unknown commands are STOP .......... U  "unknown commands are sent as STOP"
 *  L13 heartbeat in STOP .................. U  "heartbeat in STOP..."
 *  L14 heartbeat while following .......... U  "heartbeat while following..."
 *  L15 heartbeat keeps watchdog quiet ..... U  "heartbeat keeps the device timers quiet"
 *  L16 never closer than 100 ms ........... U  "the link never sends two movement CMDs closer than 100 ms..."
 *  L17 450 ms stale ....................... U  "gate boundary: age 450 moves, 451 is STOP" + rig test
 *  L18 detectionLatencyMs ................. U  "detectionLatencyMs is added..."
 *  L19 resume after a stale STOP .......... U  "after a stale STOP only a newer detection resumes movement"
 *  L20 repeated stale never sent .......... U  "a stale decision is never sent as movement"
 *  L21 emergencyStop latches .............. R  "emergencyStop sends ESTOP..."
 *  L22 clearEmergency ..................... R  "clearEmergency starts a new session..."
 *  L23 STOP is the next message ........... R  "ESTOP is the very next message"
 *  L24 not rate limited ................... U  "ESTOP and STOP are never delayed..."
 *  L25 emergency before connect ........... U  "emergencyStop before connecting is safe"
 *  L26 link timeout ....................... U  "link timeout: ..."
 *  L27 app stops sending movement ......... U  "link timeout: the app sends no movement..."
 *  L28 600/601 boundary ................... U  "link timeout boundary..."
 *  L29 device says session gone ........... R  "device replies that end the session RESYNC..." + latch recovery E2E
 *  L30 ARM to a higher sid ................ R  "BUSY..." tests
 *  L31 device watchdog .................... R  "device watchdog latches..."
 *  L32 default limits did expiry .......... R  "device lease..."
 *  L33 device stops when app vanishes ..... R  "device stops and latches when the app vanishes"
 *  L34 sequence numbers ................... U  "sequence numbers increase by one..."
 *  L35 duplicates and older seq ........... U  "device rejects duplicates and older..."
 *  L36 late old movement vs newer STOP .... U  "a late old movement command cannot override a newer STOP"
 *  L37 reordered delivery ................. U  "reordered delivery over the rig..."
 *  L38 stale age claim .................... U  "device rejects an age claim over 450..."
 *  L39 invalid ageMs ...................... U  "device rejects missing, negative or invalid age/lease fields"
 *  L40 STOP regardless of age ............. U  "a STOP is always accepted..."
 *  L41 unknown command .................... U  "unknown command is rejected..."
 *  L42 CMD before ARM ..................... U  "CMD before a session is rejected..."
 *  L43 v1 messages ........................ U  "v1-style messages never move the motor"
 *  L44 another session .................... U  "CMD for another session is rejected..."
 *  L45 malformed messages ................. U  "malformed messages are ignored..."
 *  L46 link ignores foreign ACKs .......... U  "ACK correlation: ..."
 *  L47 records rejections ................. U  "the link records rejections..."
 *  L48 reconnect begins in STOP ........... U  "reconnect begins in STOP..."
 *  L49 reconnect after stale .............. U  "reconnect after the old decision became stale..."
 *  L50 ARM with a new sid resets .......... R  "an ARM from another sid while the session is fresh gets BUSY..."
 *  L51 old-session messages ............... R  "dead sessions are rejected..."
 *  L52 manual connect() again ............. U  "connect() again releases the old session..."
 *  L53 100 ms latency ..................... U  "with 100 ms latency each way..."
 *  L54 lost messages ...................... U  "lost messages: ..."
 *  L55 transport that throws .............. U  "a transport that throws ..."
 *  L56 status exposes ..................... U  "status exposes ..."
 *  L57 status objects are copies .......... K  "status objects are copies"
 *  L58 motor only shows command ........... U  "motor only ever shows ..."
 *  L59 no imports / motion-decision ....... U  "the link and the mock have no imports..."
 *  L60 documentation test ................. R  "DOC: ..." plus "no Math.random is used"
 * New tests (approved decisions Q6, Q14-Q21, ACK correlation, gates, clocks, faults)
 * are the rest of the file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createEsp32Link,
  LINK_STATE,
  STOP_REASON,
  LINK_DEFAULTS,
  PROTOCOL_VERSION
} from "../js/esp32-link.js";

import { createMockEsp32, MOCK_DEFAULTS } from "../js/mock-esp32.js";
import {
  STEP, SID_A, SID_B, createRig, connected, createDevice, createAppHarness,
  seededRandom, isHex16, frozenState
} from "./helpers/esp32-rig.mjs";

const ESTABLISHED = [LINK_STATE.IDLE, LINK_STATE.FOLLOWING];

// ============================ constants and set-up ============================

test("documented v2 constants: 450 age, 500 proof, 50 remain, 300 RTT, 75 remainEst, 700, 2000, 8/8, 32, 100, 200, 600/600/600", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(LINK_DEFAULTS.heartbeatMs, 200);
  assert.equal(LINK_DEFAULTS.linkTimeoutMs, 600);
  assert.equal(LINK_DEFAULTS.handshakeTimeoutMs, 600);
  assert.equal(LINK_DEFAULTS.minMoveIntervalMs, 100);
  assert.equal(LINK_DEFAULTS.ageClaimMaxMs, 450);
  assert.equal(LINK_DEFAULTS.rttGateMs, 300);
  assert.equal(LINK_DEFAULTS.proofEstMaxMs, 500);
  assert.equal(LINK_DEFAULTS.remainEstMinMs, 75);
  assert.equal(LINK_DEFAULTS.evidenceMaxMs, 700);
  assert.equal(LINK_DEFAULTS.busyRetryMs, 200);
  assert.equal(LINK_DEFAULTS.busyMaxMs, 2000);
  assert.equal(LINK_DEFAULTS.pendingMax, 8);
  assert.equal(LINK_DEFAULTS.pendingTtlMs, 600);
  assert.equal(LINK_DEFAULTS.seqRejectLimit, 3);
  assert.equal(LINK_DEFAULTS.detectionLatencyMs, 0, "placeholder, to be measured on the phone");

  assert.equal(MOCK_DEFAULTS.protocolVersion, 2);
  assert.equal(MOCK_DEFAULTS.movementWatchdogMs, 600);
  assert.equal(MOCK_DEFAULTS.sessionLivenessMs, 600);
  assert.equal(MOCK_DEFAULTS.ageClaimMaxMs, 450);
  assert.equal(MOCK_DEFAULTS.proofMaxMs, 500);
  assert.equal(MOCK_DEFAULTS.minRemainMs, 50);
  assert.equal(MOCK_DEFAULTS.evidenceMaxMs, 700);
  assert.equal(MOCK_DEFAULTS.challengeTtlMs, 2000);
  assert.equal(MOCK_DEFAULTS.tokenRingSize, 8);
  assert.equal(MOCK_DEFAULTS.deadRingSize, 8);
  assert.equal(MOCK_DEFAULTS.seqWindow, 32);
  assert.equal(MOCK_DEFAULTS.minMoveIntervalMs, 100);

  assert.equal(LINK_DEFAULTS.ageClaimMaxMs, MOCK_DEFAULTS.ageClaimMaxMs);
  assert.equal(LINK_DEFAULTS.minMoveIntervalMs, MOCK_DEFAULTS.minMoveIntervalMs);
  assert.equal(LINK_DEFAULTS.evidenceMaxMs, MOCK_DEFAULTS.evidenceMaxMs);
  assert.ok(Object.isFrozen(LINK_DEFAULTS));
  assert.ok(Object.isFrozen(MOCK_DEFAULTS));
});

test("transport is required", () => {
  assert.throws(() => createEsp32Link({}), TypeError);
  assert.throws(() => createEsp32Link({ transport: {} }), TypeError);
});

test("Q6: the sid comes from the injected random source, as 16 hex characters", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const expected = Array.from(seededRandom(5).fill(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
  assert.equal(h.sid(), expected);
  assert.ok(isHex16(h.sid()));
});

test("Q6: fail closed when no secure random source exists; Math.random is never used", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    assert.throws(() => createEsp32Link({ transport: { send() {} } }), TypeError);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }

  const mathRandom = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used"); };
  try {
    const rig = connected();
    rig.follow("FORWARD", 600);
    assert.equal(rig.motor(), "FORWARD");
  } finally {
    Math.random = mathRandom;
  }

  // a source that repeats the previous sid is refused rather than reused
  const stuck = createEsp32Link({
    transport: { send() {} },
    randomValues: bytes => bytes.fill(7)
  });
  stuck.connect(0);
  assert.throws(() => stuck.connect(1));
});

test("every message is v2 with a hex16 sid and the approved fields", () => {
  const rig = connected();
  rig.follow("FORWARD", 1000);
  rig.link.suspend(rig.now);
  assert.ok(rig.toDevice.length > 8);
  const types = new Set();
  for (const m of rig.toDevice) {
    assert.equal(m.v, 2);
    assert.ok(isHex16(m.sid), m.sid);
    types.add(m.t);
    assert.equal("session" in m, false);
    assert.equal("type" in m, false);
    if (m.t === "HELLO") assert.equal(m.seq, 1);
    if (m.t === "ARM") { assert.equal(m.seq, 2); assert.ok(Number.isInteger(m.dn)); }
    if (m.t === "CMD" && m.cmd !== "STOP") {
      for (const field of ["did", "age", "lease", "tok", "ackSeq"]) {
        assert.ok(Number.isInteger(m[field]), `${field} on ${JSON.stringify(m)}`);
      }
      assert.ok(m.ackSeq < m.seq);
    }
  }
  assert.deepEqual([...types].sort(), ["ARM", "BYE", "CMD", "HELLO"]);
});

// ============================ handshake and sessions ============================

test("starts DISCONNECTED and sends nothing", () => {
  const rig = createRig();
  rig.run(1000);
  assert.equal(rig.state(), LINK_STATE.DISCONNECTED);
  assert.equal(rig.toDevice.length, 0);
  assert.equal(rig.motor(), "STOP");
});

test("handshake: HELLO, CHALLENGE, ARM, ACK, then the first CMD of the session is STOP", () => {
  const rig = createRig();
  rig.link.connect(rig.now);
  assert.equal(rig.state(), LINK_STATE.HELLO_SENT);
  assert.equal(rig.toDevice[0].t, "HELLO");
  rig.deliver();
  assert.deepEqual(rig.toDevice.slice(0, 3).map(m => m.t === "CMD" ? "CMD:" + m.cmd : m.t), ["HELLO", "ARM", "CMD:STOP"]);
  assert.deepEqual(rig.toApp.slice(0, 3).map(m => m.t), ["CHALLENGE", "ACK", "ACK"]);
  assert.equal(rig.state(), LINK_STATE.IDLE);
  const arm = rig.toDevice.find(m => m.t === "ARM");
  assert.equal(arm.dn, rig.toApp.find(m => m.t === "CHALLENGE").dn, "ARM carries the device nonce");
  const first = rig.cmds()[0];
  assert.equal(first.cmd, "STOP");
  assert.equal(first.seq, 3);
  assert.equal(rig.mock.getStatus().state, "IDLE");
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.mock.getStatus().session, rig.link.getStatus(rig.now).session);
});

test("HELLO is resent every 200 ms with the same sid; 600 ms of silence is allowed, 601 RESYNCs to a new sid", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const sid = h.sid();
  for (const at of [200, 400, 600]) h.tick(at);
  const hellos = h.sent.filter(m => m.t === "HELLO");
  assert.deepEqual(hellos.map(m => m.sid), [sid, sid, sid, sid]);
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
  assert.equal(h.cmds().length, 0, "no CMD before the device answered");
  h.tick(601);
  assert.notEqual(h.sid(), sid, "a new sid after the handshake deadline");
  assert.equal(h.status().lastResyncReason, "HANDSHAKE_TIMEOUT");
});

test("a valid CHALLENGE refreshes the handshake deadline; the deadline is greater-than 600", () => {
  const h = createAppHarness();
  h.link.connect(0);
  h.challenge(500);
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(1100);                                  // exactly 600 after the CHALLENGE
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(1101);
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
  assert.equal(h.status().lastResyncReason, "HANDSHAKE_TIMEOUT");
});

test("BAD_NONCE goes back to HELLO with the same sid", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const sid = h.sid();
  h.challenge(10);
  h.ack(2, 20, { ok: false, reason: "BAD_NONCE" });
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
  assert.equal(h.sid(), sid);
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 2);
});

test("a decision given during the handshake never moves the motor after connect", () => {
  const rig = createRig();
  rig.link.connect(rig.now);
  rig.decide("FORWARD");                            // before IDLE: not sent
  rig.deliver();
  rig.run(1000);
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.movement().length, 0);
});

test("disconnect() sends STOP then BYE, the device latches LATCHED(BYE), and the link stops talking", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  const before = rig.toDevice.length;
  rig.link.disconnect(rig.now);
  assert.deepEqual(rig.toDevice.slice(before).map(m => m.t === "CMD" ? m.cmd : m.t), ["STOP", "BYE"]);
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.mock.getStatus().state, "LATCHED");
  assert.equal(rig.mock.getStatus().latchReason, "BYE");
  const count = rig.toDevice.length;
  rig.run(1000);
  assert.equal(rig.toDevice.length, count);
  assert.equal(rig.state(), LINK_STATE.DISCONNECTED);
});

test("connect() again releases the old session (BYE) and starts a new one in STOP", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  const oldSid = rig.link.getStatus(rig.now).session;
  rig.link.connect(rig.now);
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  rig.run(300);
  assert.ok(ESTABLISHED.includes(rig.state()));
  assert.notEqual(rig.link.getStatus(rig.now).session, oldSid);
  assert.ok(rig.mock.getStatus().deadRing.includes(oldSid));
  assert.equal(rig.motor(), "STOP");
});

// ============================ decisions, did and detection time ============================

test("STOP, FORWARD, LEFT and RIGHT all reach the motor", () => {
  const rig = connected();
  for (const command of ["FORWARD", "LEFT", "RIGHT", "STOP", "LEFT"]) {
    rig.decide(command);
    rig.deliver();
    assert.equal(rig.motor(), command);
    rig.run(100);
    assert.ok(rig.motor() === command || rig.motor() === "STOP");
  }
});

test("a new movement decision is sent at once, without waiting for the heartbeat", () => {
  const rig = connected();
  const before = rig.cmds().length;
  rig.decide("FORWARD");
  assert.equal(rig.cmds().length, before + 1);
  assert.equal(rig.cmds().at(-1).cmd, "FORWARD");
});

test("did follows the detection time, not the call count: +1 per newer detection, restarts per session", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 0, R + 0);
  h.decide("FORWARD", R + 0, R + 1);                 // within 1 ms: same detection
  h.decide("FORWARD", R + 120, R + 120);             // newer: did 2
  h.decide("FORWARD", R + 120, R + 120);             // same detection again
  const dids = h.movement().map(m => m.did);
  assert.deepEqual([...new Set(dids)], [1, 2]);
  assert.equal(h.status().did, 2);
  h.link.connect(R + 200);                           // new session
  assert.equal(h.status().did, 0);
});

test("a detection time that goes back by more than 1 ms is EVIDENCE_REGRESSED (STOP); 1 ms back is the same detection", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 300, R + 300);
  assert.equal(h.status().effective.command, "FORWARD");
  h.decide("FORWARD", R + 310, R + 299);             // 1 ms back
  assert.equal(h.status().effective.command, "FORWARD");
  h.decide("FORWARD", R + 320, R + 250);             // 50 ms back
  assert.equal(h.status().effective.command, "STOP");
  assert.equal(h.status().effective.reason, STOP_REASON.EVIDENCE_REGRESSED);
  assert.equal(h.last().cmd, "STOP");
});

test("Q5: a movement decision without a valid detection time is STOP (never stamped at call time)", () => {
  for (const detection of [undefined, null, NaN, Infinity, "5", 1e9]) {
    const h = createAppHarness();
    const R = h.handshake(0, 0);
    h.now = R + 50;
    h.link.setDecision("FORWARD", R + 50, detection);
    assert.equal(h.movement().length, 0, `detection ${String(detection)}`);
    assert.equal(h.status().effective.command, "STOP");
    assert.equal(h.status().effective.reason, STOP_REASON.NO_DETECTION_TIME);
  }
});

test("Q5: a 400 ms-old detection is sent with age 400, not age 0", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 20, R - 380);            // the detection was 400 ms before this call
  assert.equal(h.last().cmd, "FORWARD");
  assert.equal(h.last().age, 400);
  assert.equal(h.last().lease, 300);
});

test("unknown commands are sent as STOP", () => {
  const rig = connected();
  for (const bad of ["JUMP", "", null, undefined, 5, "forward", {}]) {
    rig.decide("FORWARD");
    rig.deliver();
    rig.run(100);
    rig.decide(bad);
    rig.deliver();
    assert.equal(rig.motor(), "STOP", `bad command ${String(bad)}`);
    rig.run(100);
  }
});

test("detectionLatencyMs is added to the claimed age (placeholder default 0)", () => {
  const h = createAppHarness({ detectionLatencyMs: 100 });
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 10, R + 10);
  assert.equal(h.last().age, 100);
  const h0 = createAppHarness();
  const R0 = h0.handshake(0, 0);
  h0.decide("FORWARD", R0 + 10, R0 + 10);
  assert.equal(h0.last().age, 0);
});

// ============================ heartbeat and the 100 ms interval ============================

test("heartbeat in STOP: the command is resent every 200 ms (not faster, not slower)", () => {
  const rig = connected();
  const times = [];
  for (let t = 0; t < 2000; t += STEP) {
    const before = rig.cmds().length;
    rig.step();
    if (rig.cmds().length > before) times.push(rig.now);
  }
  assert.ok(times.length >= 9 && times.length <= 11, `got ${times.length}`);
  for (let i = 1; i < times.length; i++) assert.equal(times[i] - times[i - 1], 200);
});

test("heartbeat while following: never a gap over 200 ms between CMDs", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  const times = [];
  for (let t = 0; t < 2000; t += STEP) {
    const before = rig.cmds().length;
    if (t % 250 === 0) rig.decide("FORWARD");
    rig.step();
    if (rig.cmds().length > before) times.push(rig.now);
  }
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 200);
  assert.equal(rig.motor(), "FORWARD");
});

test("heartbeat keeps the device timers quiet", () => {
  const rig = connected();
  rig.follow("FORWARD", 5000);
  const status = rig.mock.getStatus();
  assert.equal(rig.motor(), "FORWARD");
  assert.equal(status.counters.watchdogLatches, 0);
  assert.equal(status.counters.leaseExpiries, 0);
  assert.equal(status.counters.idleTimeouts, 0);
  assert.equal(status.counters.rateLimited, 0);
});

test("the link never sends two movement CMDs closer than 100 ms; STOP is never delayed", () => {
  const rig = connected();
  rig.decide("FORWARD");
  const first = rig.cmds().length;
  rig.link.setDecision("LEFT", rig.now, rig.now);
  rig.link.setDecision("RIGHT", rig.now, rig.now);
  assert.equal(rig.cmds().length, first, "movement held back inside 100 ms");
  rig.link.setDecision("STOP", rig.now, rig.now);
  assert.equal(rig.cmds().length, first + 1, "STOP sent at once");
  assert.equal(rig.cmds().at(-1).cmd, "STOP");

  rig.run(100);
  rig.decide("LEFT");
  rig.run(1500);
  rig.follow("RIGHT", 1000);
  const moves = rig.sendLog.filter(e => e.message.t === "CMD" && e.message.cmd !== "STOP");
  for (let i = 1; i < moves.length; i++) {
    assert.ok(moves[i].at - moves[i - 1].at >= 100, `gap ${moves[i].at - moves[i - 1].at}`);
  }
  assert.equal(rig.mock.getStatus().counters.rateLimited, 0, "the device never saw RATE_LIMITED");
});

// ============================ gates and freshness (app side) ============================

test("gate boundary: age 450 moves, age 451 is STOP", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R, R - 450);
  assert.equal(h.last().cmd, "FORWARD");
  assert.equal(h.last().age, 450);

  const h2 = createAppHarness();
  const R2 = h2.handshake(0, 0);
  h2.decide("FORWARD", R2, R2 - 451);
  assert.equal(h2.movement().length, 0);
  assert.equal(h2.status().lastEffectiveReason, STOP_REASON.STALE_DECISION);
});

test("stopEntries counts how many times each STOP reason was entered (a change of reason, not every tick)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R, R - 451);                 // stale: STALE_DECISION entered
  h.tick(R + 10);
  h.tick(R + 20);                                  // same reason again: still one entry
  assert.equal(h.status().stopEntries.STALE_DECISION, 1);
  h.decide("FORWARD", R + 30, R + 30);             // fresh: moves
  assert.equal(h.last().cmd, "FORWARD");
  h.decide("FORWARD", R + 600, R + 140);           // stale again (age 460): second entry
  assert.equal(h.status().stopEntries.STALE_DECISION, 2);
  assert.ok(!("FOLLOWING" in h.status().stopEntries), "a movement is not a stop reason");
});

test("gate boundary: proofEst 500 moves, 501 is STOP (token hold + RTT)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);                     // token received at R, rttEst 0
  h.tick(R + 500);
  h.link.setDecision("FORWARD", R + 500, R + 500);
  assert.equal(h.last().cmd, "FORWARD");
  assert.equal(h.status().effective.proofEst, 500);

  const h2 = createAppHarness();
  const R2 = h2.handshake(0, 0);
  h2.now = R2 + 501;
  h2.link.setDecision("FORWARD", R2 + 501, R2 + 501);
  assert.equal(h2.movement().length, 0);
  assert.equal(h2.status().lastEffectiveReason, STOP_REASON.PROOF_EST_STALE);
});

test("gate boundary: remainEst 75 moves, 74 is STOP (700 - age - proofEst)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 175, R + 175 - 450);      // age 450, hold 175 -> remainEst 75
  assert.equal(h.last().cmd, "FORWARD");
  assert.equal(h.status().effective.remainEst, 75);

  const h2 = createAppHarness();
  const R2 = h2.handshake(0, 0);
  h2.decide("FORWARD", R2 + 176, R2 + 176 - 450);   // remainEst 74
  assert.equal(h2.movement().length, 0);
  assert.equal(h2.status().lastEffectiveReason, STOP_REASON.LEASE_TOO_SHORT);
});

test("gate boundary: RTT 300 moves, 301 is STOP", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 300);
  assert.equal(h.status().rttEst, 300);
  h.decide("FORWARD", R, R);
  assert.equal(h.last().cmd, "FORWARD");

  const h2 = createAppHarness();
  const R2 = h2.handshake(0, 301);
  assert.equal(h2.status().rttEst, 301);
  h2.decide("FORWARD", R2, R2);
  assert.equal(h2.movement().length, 0);
  assert.equal(h2.status().lastEffectiveReason, STOP_REASON.RTT_GATE);
});

test("Q19: rttEst is the maximum of the last 3 samples", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 100);                    // samples 100, 100, 100
  assert.equal(h.status().rttEst, 100);
  h.decide("FORWARD", R, R);
  const seq = h.last().seq;
  h.ack(seq, R + 250);                              // one slow round trip: 250
  assert.equal(h.status().rttEst, 250);
});

test("Q19: fail closed with no RTT sample (handshake retried, first STOP not yet answered)", () => {
  const h = createAppHarness();
  h.link.connect(0);
  h.tick(200);                                      // HELLO resent: not a clean sample
  h.challenge(210);
  h.tick(410);                                      // ARM resent
  h.ack(2, 420);
  assert.equal(h.status().state, LINK_STATE.IDLE);
  assert.equal(h.status().rttEst, null);
  h.decide("FORWARD", 430, 430);
  assert.equal(h.movement().length, 0);
  assert.equal(h.status().lastEffectiveReason, STOP_REASON.NO_RTT);
  h.ack(3, 440);                                    // the STOP's ACK gives the first sample
  assert.ok(h.status().rttEst !== null);
});

test("Q19: fail closed when an ARM ACK carries no token", () => {
  const h = createAppHarness();
  h.link.connect(0);
  h.challenge(5);
  h.ack(2, 10, { tok: null });
  assert.equal(h.status().lastResyncReason, "NO_TOKEN");
  assert.notEqual(h.status().state, LINK_STATE.IDLE);
});

test("Q19: fail closed on a regressing or invalid clock", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  assert.equal(h.last().cmd, "FORWARD");
  const sid = h.sid();
  h.tick(R + 90);                                   // the app clock went back
  assert.equal(h.status().counters.clockFaults, 1);
  assert.notEqual(h.sid(), sid, "RESYNC to a new session");
  assert.ok(h.sent.some(m => m.t === "CMD" && m.cmd === "STOP" && m.sid === sid));
  const afterFault = h.movement().length;
  h.link.setDecision("FORWARD", Number.NaN, 5);
  assert.equal(h.movement().length, afterFault);
});

test("Q19: 600 ms without a valid ok:true ACK is a link timeout (600 stays, 601 RESYNCs)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.tick(R + 600);
  assert.ok(ESTABLISHED.includes(h.status().state));
  h.tick(R + 601);
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
  assert.equal(h.status().lastResyncReason, "LINK_TIMEOUT");
  assert.equal(h.status().counters.timeouts, 1);
});

test("after a stale STOP only a newer detection resumes movement", () => {
  const rig = connected();
  rig.decide("FORWARD");
  rig.run(1000);                                    // the same detection goes stale: STOP
  assert.equal(rig.motor(), "STOP");
  rig.decide("FORWARD", 1000);                      // an old detection again: refused
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  rig.decide("LEFT", 0);                            // a newer one
  rig.deliver();
  assert.equal(rig.motor(), "LEFT");
});

test("a stale decision is never sent as movement", () => {
  const rig = connected();
  rig.decide("FORWARD");
  rig.run(3000);
  for (const m of rig.movement()) {
    assert.ok(m.age <= 450);
    assert.ok(m.lease === 700 - m.age);
  }
  assert.equal(rig.cmds().at(-1).cmd, "STOP");
  assert.equal(rig.motor(), "STOP");
});

// ============================ ESTOP ============================

test("emergencyStop sends ESTOP, the device latches LATCHED(ESTOP), and ESTOP repeats until cleared", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  rig.link.emergencyStop(rig.now);
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.mock.getStatus().state, "LATCHED");
  assert.equal(rig.mock.getStatus().latchReason, "ESTOP");
  assert.equal(rig.link.getStatus(rig.now).emergency, true);
  rig.follow("FORWARD", 1000);
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.link.getStatus(rig.now).effective.reason, STOP_REASON.EMERGENCY);
  assert.ok(rig.toDevice.filter(m => m.t === "ESTOP").length >= 4);
  assert.equal(rig.link.getStatus(rig.now).counters.resyncs, 0, "no RESYNC while the emergency lasts");
});

test("clearEmergency starts a new session and does not resume movement by itself", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  const oldSid = rig.link.getStatus(rig.now).session;
  rig.link.emergencyStop(rig.now);
  rig.link.clearEmergency(rig.now);
  rig.run(1000);
  assert.notEqual(rig.link.getStatus(rig.now).session, oldSid);
  assert.ok(ESTABLISHED.includes(rig.state()));
  assert.equal(rig.motor(), "STOP");
  rig.follow("FORWARD", 300);
  assert.equal(rig.motor(), "FORWARD");
});

test("ESTOP is the very next message", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  const before = rig.toDevice.length;
  rig.link.emergencyStop(rig.now);
  assert.equal(rig.toDevice.length, before + 1);
  assert.equal(rig.toDevice.at(-1).t, "ESTOP");
});

test("ESTOP and STOP are never delayed by the 100 ms movement interval", () => {
  const rig = connected();
  rig.decide("FORWARD");
  rig.link.emergencyStop(rig.now);                  // same instant
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  const rig2 = connected();
  rig2.decide("FORWARD");
  rig2.link.setDecision("STOP", rig2.now, rig2.now);
  rig2.deliver();
  assert.equal(rig2.motor(), "STOP");
});

test("emergencyStop before connecting is safe", () => {
  const rig = createRig();
  rig.link.emergencyStop(rig.now);
  rig.link.connect(rig.now);
  rig.deliver();
  rig.follow("FORWARD", 1000);
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.movement().length, 0);
});

// ============================ link timeout, RESYNC and the device's replies ============================

test("link timeout: device goes silent, the link RESYNCs and sends STOP", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  const sid = rig.link.getStatus(rig.now).session;
  rig.dropToApp = true;
  rig.run(1000);
  const status = rig.link.getStatus(rig.now);
  assert.ok(status.counters.timeouts >= 1);
  assert.notEqual(status.session, sid);
  assert.equal(rig.motor(), "STOP");
  assert.ok(rig.toDevice.some(m => m.t === "CMD" && m.cmd === "STOP" && m.sid === sid));
});

test("link timeout: the app sends no movement in the new session even if decisions keep coming", () => {
  const rig = connected();
  const sid = rig.link.getStatus(rig.now).session;
  rig.dropToApp = true;
  rig.follow("FORWARD", 3000);
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.movement().filter(m => m.sid !== sid).length, 0);
});

test("an ok:false ACK never refreshes the established link timeout (Q11)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const seq = h.last().seq;
  const before = h.status().lastOkAckAt;
  h.ack(seq, R + 500, { ok: false, reason: "RATE_LIMITED" });
  assert.equal(h.status().lastOkAckAt, before);
  h.tick(R + 601);
  assert.equal(h.status().lastResyncReason, "LINK_TIMEOUT");
});

test("device replies that end the session RESYNC at once (LATCHED, WRONG_SESSION, DEAD_SESSION, STALE_DID, MALFORMED, INVALID_COMMAND, NO_SESSION, unknown)", () => {
  for (const reason of ["LATCHED", "WRONG_SESSION", "DEAD_SESSION", "STALE_DID", "MALFORMED",
    "INVALID_COMMAND", "NO_SESSION", "SOMETHING_NEW"]) {
    const h = createAppHarness();
    const R = h.handshake(0, 0);
    h.decide("FORWARD", R + 100, R + 100);
    const sid = h.sid();
    h.ack(h.last().seq, R + 110, { ok: false, reason });
    assert.notEqual(h.sid(), sid, reason);
    assert.equal(h.status().state, LINK_STATE.HELLO_SENT, reason);
    assert.equal(h.status().counters.resyncs, 1, reason);
  }
});

test("three consecutive OUT_OF_ORDER or SEQ_JUMP replies RESYNC; two do not; an ok:true ACK resets the count", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  const sid = h.sid();
  const sendHeartbeat = at => { h.tick(at); return h.last().seq; };

  h.ack(sendHeartbeat(R + 200), R + 210, { ok: false, reason: "OUT_OF_ORDER" });
  h.ack(sendHeartbeat(R + 400), R + 410, { ok: false, reason: "SEQ_JUMP" });
  assert.equal(h.sid(), sid, "two rejects: no RESYNC");
  h.ack(sendHeartbeat(R + 600), R + 610, { ok: true });
  h.ack(sendHeartbeat(R + 800), R + 810, { ok: false, reason: "OUT_OF_ORDER" });
  h.ack(sendHeartbeat(R + 1000), R + 1010, { ok: false, reason: "OUT_OF_ORDER" });
  assert.equal(h.sid(), sid, "the count restarted after the ok:true ACK");
  h.ack(sendHeartbeat(R + 1200), R + 1210, { ok: false, reason: "SEQ_JUMP" });
  assert.notEqual(h.sid(), sid, "third consecutive reject RESYNCs");
  assert.equal(h.status().lastResyncReason, "SEQ_JUMP");
});

test("content rejects (BAD_TOKEN, PROOF_STALE, EXPIRED, DETECTION_TOO_OLD) do not RESYNC: STOP, wait for a fresh token and a newer detection", () => {
  for (const reason of ["BAD_TOKEN", "PROOF_STALE", "EXPIRED", "DETECTION_TOO_OLD"]) {
    const h = createAppHarness();
    const R = h.handshake(0, 0);
    h.decide("FORWARD", R + 100, R + 100);
    const sid = h.sid();
    const seq = h.last().seq;
    h.ack(seq, R + 110, { ok: false, reason });
    assert.equal(h.sid(), sid, `${reason}: no RESYNC`);
    assert.equal(h.status().counters.resyncs, 0);
    assert.equal(h.last().cmd, "STOP", `${reason}: a STOP follows at once`);
    const stopSeq = h.last().seq;
    assert.equal(h.status().effective.reason, STOP_REASON.RECOVERING);

    // movement stays blocked until the STOP is acknowledged ok:true
    h.decide("FORWARD", R + 150, R + 150);
    assert.equal(h.movement().length, 1);
    h.ack(stopSeq, R + 160);                         // fresh token
    // the old detection is consumed: only a newer one moves
    h.decide("FORWARD", R + 170, R + 100);
    assert.equal(h.movement().length, 1, `${reason}: old detection stays consumed`);
    h.decide("FORWARD", R + 200, R + 200);
    assert.equal(h.movement().length, 2, `${reason}: newer detection moves`);
    assert.equal(h.last().ackSeq, stopSeq, "cites the token of the recovery STOP");
  }
});

test("Q21: RATE_LIMITED causes no STOP, no retransmit, no RESYNC; the next movement waits 100 ms from the reply", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const sent = h.sent.length;
  const sid = h.sid();
  h.ack(h.last().seq, R + 150, { ok: false, reason: "RATE_LIMITED" });
  assert.equal(h.sent.length, sent, "nothing sent in reaction");
  assert.equal(h.sid(), sid);
  assert.equal(h.status().counters.resyncs, 0);
  assert.equal(h.status().counters.rateLimited, 1);
  assert.equal(h.status().nextMoveAt, R + 250);
  h.decide("FORWARD", R + 200, R + 200);             // before nextMoveAt: held
  assert.equal(h.sent.length, sent);
  h.tick(R + 250);                                    // allowed again
  assert.equal(h.last().cmd, "FORWARD");
});

// ============================ ACK correlation ============================

test("ACK correlation: wrong sid, unknown seq, wrong version and malformed replies change nothing", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const seq = h.last().seq;
  const snapshot = JSON.stringify([h.status().token, h.status().lastOkAckAt, h.status().lastAckSeq, h.status().pending]);

  h.receive({ ...h.ackFor(seq), sid: SID_B }, R + 110);
  h.receive(h.ackFor(seq + 50), R + 110);
  h.receive({ ...h.ackFor(seq), v: 1 }, R + 110);
  h.receive({ ...h.ackFor(seq), v: undefined }, R + 110);
  h.receive({ ...h.ackFor(seq), t: "NOPE" }, R + 110);
  h.receive({ ...h.ackFor(seq), seq: "4" }, R + 110);
  h.receive(null, R + 110);
  h.receive("x", R + 110);
  assert.equal(JSON.stringify([h.status().token, h.status().lastOkAckAt, h.status().lastAckSeq, h.status().pending]), snapshot);
});

test("ACK correlation: a duplicate ACK is dropped and cannot refresh the token or the timeout", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const seq = h.last().seq;
  h.ack(seq, R + 110);
  const token = h.status().token;
  h.ack(seq, R + 400, { tok: 99999 });
  assert.deepEqual(h.status().token, token);
  assert.equal(h.status().lastOkAckAt, R + 110);
});

test("ACK correlation: a reordered older ACK does not roll back the token or refresh the timeout", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.tick(R + 200); const first = h.last().seq;
  h.tick(R + 400); const second = h.last().seq;
  h.ack(second, R + 410);
  const token = h.status().token;
  assert.equal(token.ackSeq, second);
  h.ack(first, R + 500, { tok: 424242 });           // arrives late
  assert.deepEqual(h.status().token, token);
  assert.equal(h.status().lastOkAckAt, R + 410);
  assert.equal(h.status().lastAckSeq, second);
});

test("ACK correlation: an ACK for the ARM request after the session is established is ignored", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  const token = h.status().token;
  h.ack(2, R + 50, { tok: 777777 });                // replayed ARM ACK
  assert.deepEqual(h.status().token, token);
  assert.equal(h.status().state, LINK_STATE.IDLE);
});

test("ACK correlation: ok:true without a usable token is not valid and refreshes nothing", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const before = h.status().lastOkAckAt;
  h.ack(h.last().seq, R + 150, { tok: null });
  assert.equal(h.status().lastOkAckAt, before);
});

test("ACK correlation: a changed epoch RESYNCs; a CHALLENGE outside HELLO_SENT is ignored", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  const armCount = h.sent.filter(m => m.t === "ARM").length;
  h.challenge(R + 10);                               // established: ignored
  assert.equal(h.sent.filter(m => m.t === "ARM").length, armCount);
  const sid = h.sid();
  h.decide("FORWARD", R + 100, R + 100);
  h.ack(h.last().seq, R + 110, { epoch: 99 });
  assert.notEqual(h.sid(), sid);
  assert.equal(h.status().lastResyncReason, "EPOCH_CHANGED");

  const g = createAppHarness();
  g.link.connect(0);
  g.challenge(5, { sid: SID_B });                    // other sid: ignored
  assert.equal(g.status().state, LINK_STATE.HELLO_SENT);
  g.challenge(6);
  g.challenge(7);                                    // duplicate in ARM_SENT: no second ARM
  assert.equal(g.sent.filter(m => m.t === "ARM").length, 1);
});

test("ACK correlation: a reply to a request older than 600 ms is dropped", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  const seq = h.last().seq;
  const before = h.status().lastOkAckAt;
  h.ack(seq, R + 100 + 601);                          // 601 ms after the request
  assert.equal(h.status().lastOkAckAt, before, "an old reply refreshes nothing");
  assert.equal(h.status().token.ackSeq, 3, "and brings no new token");
});

test("the pending table is bounded at 8 requests", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  for (let i = 1; i <= 16; i++) {
    const at = R + i * 50;                           // FORWARD every 100 ms, a STOP in between
    h.decide(i % 2 ? "FORWARD" : "STOP", at, at);
  }
  assert.ok(h.status().pending.length <= 8);
  assert.ok(h.status().counters.dropped >= 1);
});

// ============================ BUSY (Q14, Q8b, Q17) ============================

test("Q14: BUSY retries ARM every 200 ms with the same sid and nonce; no new session is created", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const sid = h.sid();
  h.challenge(0);
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  assert.equal(h.status().busyStart, 10);
  h.tick(199);
  assert.equal(h.sent.filter(m => m.t === "ARM").length, 1);
  h.tick(200);
  const arms = h.sent.filter(m => m.t === "ARM");
  assert.equal(arms.length, 2);
  assert.equal(arms[1].sid, sid);
  assert.equal(arms[1].dn, arms[0].dn);
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1, "no new HELLO, no new sid");
  assert.equal(h.status().lastOkAckAt, null, "BUSY never refreshes the link timeout");
});

test("Q14/Q8b: the BUSY wait ends at 2000 ms after the first BUSY: 1999 still waits, 2000 is DEVICE_BUSY", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const sid = h.sid();
  h.challenge(0);
  h.ack(2, 10, { ok: false, reason: "BUSY" });       // busyStart = 10
  for (let at = 200; at < 2010; at += 200) {
    h.tick(at);
    if (at + 10 < 2010) h.ack(2, at + 10, { ok: false, reason: "BUSY" });
  }
  h.tick(2009);
  assert.equal(h.status().state, LINK_STATE.ARM_SENT, "1999 ms after the first BUSY");
  h.tick(2010);
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  assert.equal(h.status().lastError, "DEVICE_BUSY");
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1, "never a second sid");
  assert.equal(h.sid(), null);
});

test("Q14: BUSY followed by silence for 600 ms ends in DEVICE_BUSY, not in a new sid", () => {
  const h = createAppHarness();
  h.link.connect(0);
  h.challenge(0);
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  h.tick(610);                                        // exactly 600 after the BUSY: still waiting
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(611);
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  assert.equal(h.status().lastError, "DEVICE_BUSY");
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1);
});

test("Q17: after DEVICE_BUSY nothing is retried automatically; connect() starts again with a new sid", () => {
  const h = createAppHarness();
  h.link.connect(0);
  const first = h.sid();
  h.challenge(0);
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  h.tick(2010);
  const count = h.sent.length;
  for (let at = 2100; at < 8000; at += 100) h.tick(at);
  assert.equal(h.sent.length, count, "silent");
  h.link.connect(8000);
  assert.notEqual(h.sid(), first);
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
  assert.equal(h.status().lastError, null);
});

/* Two links (two tabs or a reload) talking to ONE device through a synchronous wire. */
function twoTabs() {
  const w = { now: 0 };
  w.device = () => w.now + 10000;                      // independent device clock
  w.mock = createMockEsp32({
    random32: seededRandom(3).u32,
    reply: m => { w.a.receive(m, w.now); w.b.receive(m, w.now); }
  });
  const transport = () => ({ send: m => w.mock.receive(m, w.device()) });
  w.a = createEsp32Link({ randomValues: seededRandom(1).fill, transport: transport() });
  w.b = createEsp32Link({ randomValues: seededRandom(2).fill, transport: transport() });
  w.advance = (to, { aAlive = true } = {}) => {
    while (w.now < to) {
      w.now += 50;
      if (aAlive) w.a.tick(w.now);
      w.b.tick(w.now);
      w.mock.tick(w.device());
    }
  };
  return w;
}

test("two tabs: the second session gets BUSY while the first is fresh and never takes over", () => {
  const w = twoTabs();
  w.a.connect(w.now);
  assert.ok(ESTABLISHED.includes(w.a.getStatus(w.now).state));
  w.b.connect(w.now);
  assert.equal(w.b.getStatus(w.now).state, LINK_STATE.ARM_SENT, "BUSY: waiting");
  assert.equal(w.b.getStatus(w.now).counters.busy, 1);
  assert.equal(w.mock.getStatus().session, w.a.getStatus(w.now).session, "no takeover");
  w.advance(1500);
  assert.equal(w.mock.getStatus().session, w.a.getStatus(w.now).session);
  assert.equal(w.b.getStatus(w.now).state, LINK_STATE.ARM_SENT);
  assert.equal(w.b.getStatus(w.now).counters.resyncs, 0, "B never made a new session while BUSY");
});

test("two tabs: B gives up with DEVICE_BUSY 2000 ms after its first BUSY if A stays alive", () => {
  const w = twoTabs();
  w.a.connect(w.now);
  w.b.connect(w.now);
  const firstBusy = w.b.getStatus(w.now).busyStart;
  assert.equal(firstBusy, 0);
  w.advance(1950);
  assert.equal(w.b.getStatus(w.now).state, LINK_STATE.ARM_SENT, "1950 ms: still waiting");
  w.advance(2050);
  assert.equal(w.b.getStatus(w.now).state, LINK_STATE.DISCONNECTED);
  assert.equal(w.b.getStatus(w.now).lastError, "DEVICE_BUSY");
  assert.ok(ESTABLISHED.includes(w.a.getStatus(w.now).state), "A is untouched");
  assert.equal(w.mock.getStatus().session, w.a.getStatus(w.now).session);
});

test("page reload without BYE: the new page (new random sid) is BUSY until the old session is stale, then connects", () => {
  const w = twoTabs();
  w.a.connect(w.now);
  const oldSid = w.a.getStatus(w.now).session;
  w.advance(300);
  w.b.connect(w.now);                                  // the old page is gone: A no longer ticks
  assert.notEqual(w.b.getStatus(w.now).session, oldSid);
  assert.equal(w.b.getStatus(w.now).state, LINK_STATE.ARM_SENT, "BUSY first");
  w.advance(w.now + 1000, { aAlive: false });
  assert.ok(ESTABLISHED.includes(w.b.getStatus(w.now).state), w.b.getStatus(w.now).state);
  assert.equal(w.mock.getStatus().session, w.b.getStatus(w.now).session);
  assert.ok(w.mock.getStatus().deadRing.includes(oldSid), "the old session was terminated by IDLE_TIMEOUT");
  assert.equal(w.mock.getStatus().motor, "STOP");
});

test("page reload after BYE (pagehide): no BUSY wait at all", () => {
  const w = twoTabs();
  w.a.connect(w.now);
  w.advance(300);
  w.a.suspend(w.now);                                  // pagehide: STOP then BYE
  w.b.connect(w.now);
  assert.ok(ESTABLISHED.includes(w.b.getStatus(w.now).state), "connected at once");
  assert.equal(w.b.getStatus(w.now).counters.busy, 0);
});

// ============================ gaps and recovery (E2E) ============================

test("Gap A (E2E): after the device latches, only a full re-handshake plus a newer detection moves the motor", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  assert.equal(rig.motor(), "FORWARD");
  const oldSid = rig.link.getStatus(rig.now).session;

  rig.dropToDevice = true;                            // the app can no longer reach the device
  rig.run(900);
  const status = rig.mock.getStatus();
  assert.equal(status.state, "LATCHED");
  assert.equal(rig.motor(), "STOP");
  assert.ok(status.deadRing.includes(oldSid));

  rig.dropToDevice = false;
  rig.run(1500);
  const after = rig.link.getStatus(rig.now);
  assert.ok(ESTABLISHED.includes(after.state));
  assert.notEqual(after.session, oldSid);
  assert.equal(rig.motor(), "STOP", "no movement without a newer detection");
  assert.equal(rig.mock.getStatus().state, "IDLE");
  rig.follow("FORWARD", 300);
  assert.equal(rig.motor(), "FORWARD");
});

test("device replies that end the session RESYNC and recover (device alone latched while the app still talks)", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  const oldSid = rig.link.getStatus(rig.now).session;
  rig.mock.receive({ v: 2, t: "BYE", sid: oldSid, seq: 99 }, rig.deviceNow()); // seq out of window: ignored
  assert.equal(rig.mock.getStatus().state, "MOVING");
  rig.mock.receive({ v: 2, t: "ESTOP", sid: SID_B }, rig.deviceNow());          // a stray ESTOP from another sid
  assert.equal(rig.mock.getStatus().state, "LATCHED");
  rig.run(1500);
  assert.notEqual(rig.link.getStatus(rig.now).session, oldSid, "the app moved to a new session after LATCHED/DEAD_SESSION");
  assert.ok(ESTABLISHED.includes(rig.state()));
  assert.equal(rig.motor(), "STOP");
});

test("reconnect begins in STOP and needs a fresh decision", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  rig.dropToApp = true;
  rig.run(1000);
  assert.equal(rig.motor(), "STOP");
  rig.dropToApp = false;
  rig.run(2500);
  const status = rig.link.getStatus(rig.now);
  assert.ok(ESTABLISHED.includes(status.state));
  assert.equal(status.decision, null);
  assert.equal(rig.motor(), "STOP");
  const firstOfSession = rig.cmds().find(m => m.sid === status.session);
  assert.equal(firstOfSession.cmd, "STOP");
  rig.follow("FORWARD", 300);
  assert.equal(rig.motor(), "FORWARD");
});

test("reconnect after the old decision became stale does not replay it", () => {
  const rig = connected();
  rig.decide("RIGHT");
  rig.dropToApp = true;
  rig.run(900);
  rig.dropToApp = false;
  rig.run(2500);
  assert.ok(ESTABLISHED.includes(rig.state()));
  rig.run(1000);
  assert.equal(rig.motor(), "STOP");
});

test("a detection consumed before a RESYNC cannot move in the new session", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  h.decide("STOP", R + 150, R + 150);                // consumes detection R+100
  h.link.connect(R + 200);
  h.challenge(R + 200);
  h.ack(2, R + 200);
  h.ack(3, R + 200);
  h.decide("FORWARD", R + 250, R + 100);
  assert.equal(h.status().effective.reason, STOP_REASON.DETECTION_CONSUMED);
  h.decide("FORWARD", R + 300, R + 300);
  assert.equal(h.last().cmd, "FORWARD");
});

// ============================ lifecycle: hidden page, resume, reload ============================

test("page hidden: STOP then BYE, no session; resume() needs a new handshake with a new sid", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  const sid = rig.link.getStatus(rig.now).session;
  const before = rig.toDevice.length;
  rig.link.suspend(rig.now);
  assert.deepEqual(rig.toDevice.slice(before).map(m => m.t === "CMD" ? m.cmd : m.t), ["STOP", "BYE"]);
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  assert.equal(rig.mock.getStatus().latchReason, "BYE");
  rig.run(1000);
  assert.equal(rig.state(), LINK_STATE.DISCONNECTED);
  rig.link.resume(rig.now);
  assert.equal(rig.state(), LINK_STATE.HELLO_SENT);
  assert.notEqual(rig.link.getStatus(rig.now).session, sid);
  rig.run(300);
  assert.ok(ESTABLISHED.includes(rig.state()));
  assert.equal(rig.motor(), "STOP", "movement still needs a decision");
});

test("resume() does nothing after an explicit disconnect()", () => {
  const rig = connected();
  rig.link.disconnect(rig.now);
  rig.link.resume(rig.now);
  assert.equal(rig.state(), LINK_STATE.DISCONNECTED);
});

// ============================ device direct (v2 wire) ============================

test("device watchdog latches LATCHED(WATCHDOG) when 600 ms pass after the last accepted movement CMD (601 ms)", () => {
  // the session liveness is lengthened only to show the watchdog on its own
  const d = createDevice({ sessionLivenessMs: 5000 }).armed(100);
  d.cmd("FORWARD", 100, { did: 1 });                 // proofAge 0: remain 700
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(700);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(701);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "LATCHED");
  assert.equal(d.status().latchReason, "WATCHDOG");
  assert.deepEqual(d.status().events.map(e => e.type), ["WATCHDOG"]);
});

test("device lease: remain = min(lease, 700 - age - proofAge); at the expiry the motor stops and the state is IDLE, not latched", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 400, { did: 1 });                 // token 400 ms old: remain 300, expiry 700
  assert.equal(d.last().expIn, 300);
  d.mock.tick(699);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(700);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().latchReason, null);
  assert.deepEqual(d.status().events.map(e => e.type), ["LEASE_EXPIRED"]);
  d.cmd("FORWARD", 800, { did: 1 });                 // the same did cannot resume
  assert.equal(d.last().reason, "EXPIRED");
  d.cmd("FORWARD", 900, { did: 2 });                 // a newer detection can
  assert.equal(d.motor(), "FORWARD");
});

test("device stops and latches when the app vanishes (nothing is sent at all)", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  rig.dropToDevice = true;
  rig.run(1000);
  assert.equal(rig.motor(), "STOP");
  const status = rig.mock.getStatus();
  assert.equal(status.state, "LATCHED");
  assert.ok(["WATCHDOG", "IDLE_TIMEOUT"].includes(status.latchReason));
  const latches = status.events.filter(e => e.type === "WATCHDOG" || e.type === "IDLE_TIMEOUT");
  assert.equal(latches.length, 1, "exactly one latch transition");
});

test("sequence numbers increase by one per message within a session", () => {
  const rig = connected();
  rig.follow("FORWARD", 1500);
  const seqs = rig.toDevice.filter(m => m.sid === rig.toDevice[0].sid && m.t !== "ESTOP").map(m => m.seq);
  assert.ok(seqs.length > 5);
  seqs.forEach((value, i) => assert.equal(value, i + 1));
});

test("device rejects duplicates and older sequence numbers (OUT_OF_ORDER)", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { seq: 5, did: 1 });
  d.cmd("LEFT", 220, { seq: 5, did: 2 });
  d.cmd("RIGHT", 340, { seq: 3, did: 3 });
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.replies.at(-1).reason, "OUT_OF_ORDER");
  assert.equal(d.replies.at(-2).reason, "OUT_OF_ORDER");
  assert.equal(d.status().counters.rejected, 2);
});

test("a late old movement command cannot override a newer STOP", () => {
  const d = createDevice().armed(0);
  d.cmd("STOP", 10, { seq: 4 });
  d.cmd("FORWARD", 120, { seq: 3, did: 1 });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().reason, "OUT_OF_ORDER");
});

test("reordered delivery over the rig: motor ends in the newest command, the old one is OUT_OF_ORDER", () => {
  const rig = connected();
  rig.decide("FORWARD");
  const first = rig.toDevice.at(-1);
  rig.inFlight = [];
  rig.run(100);
  rig.decide("LEFT");
  const second = rig.toDevice.at(-1);
  rig.inFlight = [];
  rig.mock.receive(second, rig.deviceNow());
  rig.mock.receive(first, rig.deviceNow());
  assert.equal(rig.motor(), "LEFT");
  assert.equal(rig.mock.getStatus().lastReject.reason, "OUT_OF_ORDER");
});

test("device rejects an age claim over 450 and goes STOP; exactly 450 is accepted", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1, age: 450 });
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.last().expIn, 150);
  d.cmd("FORWARD", 300, { did: 2, age: 451 });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().reason, "DETECTION_TOO_OLD");
});

test("device rejects missing, negative or invalid age and lease fields (MALFORMED) and goes STOP", () => {
  for (const age of [undefined, null, -1, NaN, Infinity, "10", 1.5, 701]) {
    const d = createDevice().armed(0);
    d.cmd("FORWARD", 100, { did: 1, raw: { age } });
    assert.equal(d.motor(), "STOP", `age ${String(age)}`);
    assert.equal(d.last().reason, "MALFORMED", `age ${String(age)}`);
  }
  for (const lease of [undefined, -5, 701, "3"]) {
    const d = createDevice().armed(0);
    d.cmd("FORWARD", 100, { did: 1, raw: { lease } });
    assert.equal(d.last().reason, "MALFORMED", `lease ${String(lease)}`);
  }
});

test("a STOP is always accepted regardless of the age field", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  d.cmd("STOP", 220, { raw: { age: 99999 } });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().ok, true);
});

test("unknown command is rejected and the motor goes STOP", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  d.cmd("BACKWARD", 220, { did: 2 });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().reason, "INVALID_COMMAND");
});

test("CMD before a session is rejected (LATCHED at boot), motor stays STOP", () => {
  const d = createDevice();
  d.cmd("FORWARD", 0, { did: 1, raw: { tok: 5, ackSeq: 1 } });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().reason, "LATCHED");
  assert.equal(d.status().state, "BOOT_LATCHED");
});

test("v1-style messages never move the motor, and a v1 ARM or HELLO creates no session", () => {
  const d = createDevice().armed(0);
  d.send({ type: "CMD", session: 1, seq: 3, cmd: "FORWARD", ageMs: 0 }, 10);
  d.cmd("FORWARD", 20, { v: 1, did: 1 });
  d.send({ type: "HELLO", session: 2, seq: 1 }, 30);
  d.send({ v: 1, t: "ARM", sid: SID_B, seq: 2, dn: 1 }, 40);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().session, SID_A);
});

test("CMD for another session is rejected (WRONG_SESSION)", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 10, { sid: SID_B, seq: 9, did: 1 });
  assert.equal(d.motor(), "STOP");
  assert.equal(d.last().reason, "WRONG_SESSION");
});

test("malformed messages are ignored and never move the motor or throw", () => {
  const d = createDevice().armed(0);
  const before = frozenState(d.status());
  const replies = d.replies.length;
  for (const bad of [null, undefined, 5, "x", {}, { t: "CMD" }, { t: "CMD", sid: SID_A },
    { v: 2, t: "CMD", sid: SID_A, seq: 0, cmd: "FORWARD" },
    { v: 2, t: "CMD", sid: SID_A, seq: 1.5, cmd: "FORWARD" },
    { v: 2, t: "CMD", sid: "xyz", seq: 3, cmd: "FORWARD" },
    { v: 2, t: "CMD", sid: SID_A.toUpperCase(), seq: 3, cmd: "FORWARD" },
    { v: 2, t: "NOPE", sid: SID_A, seq: 3 }]) {
    assert.doesNotThrow(() => d.send(bad, 10));
  }
  assert.equal(d.motor(), "STOP");
  assert.equal(frozenState(d.status()), before);
  assert.equal(d.replies.length, replies, "no reply to malformed messages");
});

test("an ARM from another sid while the session is fresh gets BUSY and changes nothing (no takeover)", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  const before = frozenState(d.status());
  d.hello(110, { sid: SID_B });
  assert.equal(d.last().t, "CHALLENGE", "HELLO from another sid: challenge only");
  d.arm(120, { sid: SID_B });
  assert.equal(d.last().reason, "BUSY");
  assert.equal(frozenState(d.status()), before);
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.status().session, SID_A);
});

test("dead sessions are rejected: CMD, HELLO and ESTOP from a dead sid change nothing", () => {
  const d = createDevice().armed(0);
  d.bye(50);
  assert.equal(d.status().state, "LATCHED");
  assert.deepEqual(d.status().deadRing, [SID_A]);
  d.cmd("FORWARD", 100, { did: 1, seq: 9 });
  assert.equal(d.last().reason, "DEAD_SESSION");
  d.hello(110);
  assert.equal(d.last().reason, "DEAD_SESSION");
  const events = d.status().events.length;
  d.estop(120);                                       // stale ESTOP: ignored
  assert.equal(d.status().events.length, events);
});

test("the link ignores nothing it should hear: a real session end is heard from the device", () => {
  const rig = connected();
  rig.mock.receive({ v: 2, t: "ESTOP", sid: rig.link.getStatus(rig.now).session }, rig.deviceNow());
  rig.run(300);
  assert.equal(rig.link.getStatus(rig.now).counters.resyncs >= 1, true);
});

test("the link records rejections reported by the device", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  h.ack(h.last().seq, R + 110, { ok: false, reason: "RATE_LIMITED" });
  assert.equal(h.status().lastReject.reason, "RATE_LIMITED");
  assert.equal(h.status().counters.rejected, 1);
});

// ============================ independent clocks, latency, loss, duplicates ============================

test("independent clocks: behaviour is identical for device offsets 0, 10000 and 987654 and with 1000 ppm skew", () => {
  const runScenario = options => {
    const rig = connected({}, {}, options);
    rig.follow("FORWARD", 1000);
    rig.follow("LEFT", 600);
    rig.follow("STOP", 400);
    return rig.mock.getStatus().motorLog.map(e => e.command + ":" + e.reason).join(",");
  };
  const base = runScenario({ deviceOffset: 0 });
  assert.equal(runScenario({ deviceOffset: 10000 }), base);
  assert.equal(runScenario({ deviceOffset: 987654 }), base);
  assert.equal(runScenario({ deviceOffset: 5000, skewPpm: 1000 }), base);
  assert.ok(base.includes("FORWARD") && base.includes("LEFT"));
});

test("with 100 ms latency each way the system still follows and ESTOP still stops", () => {
  const rig = createRig();
  rig.latency = 100;
  rig.link.connect(rig.now);
  rig.run(800);
  assert.ok(ESTABLISHED.includes(rig.state()), rig.state());
  rig.follow("FORWARD", 1500);
  assert.equal(rig.motor(), "FORWARD");
  rig.link.emergencyStop(rig.now);
  rig.run(150);
  assert.equal(rig.motor(), "STOP");
});

test("duplicated delivery of every message in both directions changes nothing visible", () => {
  const rig = createRig();
  rig.duplicate = () => 1;
  rig.link.connect(rig.now);
  rig.deliver();
  rig.run(200);
  rig.follow("FORWARD", 1500);
  assert.equal(rig.motor(), "FORWARD");
  assert.equal(rig.link.getStatus(rig.now).counters.resyncs, 0);
  assert.equal(rig.mock.getStatus().counters.watchdogLatches, 0);
  assert.ok(ESTABLISHED.includes(rig.state()));
});

test("reordered delivery (some messages delayed 120 ms) keeps the link and the motor consistent", () => {
  const rig = createRig();
  let n = 0;
  rig.latencyToApp = () => (n++ % 3 === 0 ? 120 : 0);
  rig.link.connect(rig.now);
  rig.run(600);
  rig.follow("FORWARD", 2000);
  assert.ok(ESTABLISHED.includes(rig.state()));
  assert.equal(rig.link.getStatus(rig.now).counters.resyncs, 0);
  for (const e of rig.mock.getStatus().motorLog) assert.ok(["STOP", "FORWARD"].includes(e.command));
});

test("lost messages: movement resumes after a single drop, stays STOP after a long outage", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  rig.dropToDevice = true;
  rig.follow("FORWARD", 200);
  rig.dropToDevice = false;
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  rig.dropToDevice = true;
  rig.follow("FORWARD", 1000);
  assert.equal(rig.motor(), "STOP");
});

test("lost ACKs: the app fails closed and recovers; every 3rd reply lost never moves the motor unsafely", () => {
  const rig = connected();
  let n = 0;
  rig.dropWhen = (direction) => direction === "app" && (n++ % 3 === 2);
  rig.follow("FORWARD", 3000);
  for (const e of rig.mock.getStatus().motorLog) assert.ok(["STOP", "FORWARD"].includes(e.command));
  const status = rig.mock.getStatus();
  assert.equal(status.counters.watchdogLatches, 0);
});

test("a transport that throws never throws into the caller; a failed STOP is retried at the next tick (Gap G)", () => {
  const h = createAppHarness();
  const R = h.handshake(0, 0);
  h.decide("FORWARD", R + 100, R + 100);
  assert.equal(h.status().lastSentCommand, "FORWARD");
  h.failSend = true;
  assert.doesNotThrow(() => h.link.setDecision("STOP", R + 120, R + 120));
  assert.equal(h.status().lastSentCommand, "FORWARD", "a failed send is not recorded as sent");
  assert.ok(h.status().counters.sendFailures >= 1);
  assert.doesNotThrow(() => h.tick(R + 130));
  assert.doesNotThrow(() => h.link.emergencyStop(R + 140));
  h.failSend = false;
  h.tick(R + 150);
  assert.equal(h.last().t, "ESTOP", "ESTOP retried at the very next tick");
  const g = createAppHarness();
  const R2 = g.handshake(0, 0);
  g.decide("FORWARD", R2 + 100, R2 + 100);
  g.failSend = true;
  g.link.setDecision("STOP", R2 + 120, R2 + 120);
  g.failSend = false;
  g.tick(R2 + 130);
  assert.equal(g.last().cmd, "STOP");
});

// ============================ status, independence, documentation ============================

test("status exposes state, effective command, device motor and the timers", () => {
  const rig = connected();
  rig.follow("FORWARD", 300);
  const link = rig.link.getStatus(rig.now);
  assert.equal(link.state, LINK_STATE.FOLLOWING);
  assert.equal(link.connected, true);
  assert.equal(link.effective.command, "FORWARD");
  assert.equal(link.deviceMotor, "FORWARD");
  assert.equal(link.lastSentCommand, "FORWARD");
  assert.ok(isHex16(link.session));
  assert.ok(link.rttEst !== null);
  const device = rig.mock.getStatus();
  assert.equal(device.motor, "FORWARD");
  assert.equal(device.state, "MOVING");
  assert.equal(device.motorLog.at(-1).command, "FORWARD");
});

test("status objects are copies", () => {
  const rig = connected();
  const s = rig.mock.getStatus();
  s.motor = "FORWARD";
  s.motorLog.push({});
  s.ring.push({});
  s.deadRing.push("x");
  s.events.push({});
  s.counters.accepted = 999;
  const again = rig.mock.getStatus();
  assert.equal(again.motor, "STOP");
  assert.notEqual(again.counters.accepted, 999);
  assert.ok(!again.deadRing.includes("x"));
  const l = rig.link.getStatus(rig.now);
  l.counters.sent = 999;
  l.pending.push({});
  assert.notEqual(rig.link.getStatus(rig.now).counters.sent, 999);
});

test("motor only ever shows the command being followed, STOP, or (briefly) the previous one", () => {
  const rig = connected();
  const plan = [["FORWARD", 600], ["LEFT", 400], ["STOP", 300], ["RIGHT", 400], ["FORWARD", 300]];
  let previous = "STOP";
  for (const [command, ms] of plan) {
    for (let t = 0; t < ms; t += STEP) {
      if (t % 250 === 0) rig.decide(command, 0);
      rig.step();
      const m = rig.motor();
      const allowed = m === command || m === "STOP" || (t < 150 && m === previous);
      assert.ok(allowed, `${m} while following ${command} at +${t}`);
    }
    assert.equal(rig.motor(), command);
    previous = command;
  }
  const status = rig.mock.getStatus();
  assert.equal(status.counters.watchdogLatches, 0);
  assert.equal(status.counters.leaseExpiries, 0);
});

test("the link and the mock have no imports and no transport; the link works with motion-decision output", async () => {
  const { readFile } = await import("node:fs/promises");
  const linkSource = await readFile(new URL("../js/esp32-link.js", import.meta.url), "utf8");
  const mockSource = await readFile(new URL("../js/mock-esp32.js", import.meta.url), "utf8");
  assert.ok(!/^\s*import\s/m.test(linkSource), "esp32-link.js has no imports");
  assert.ok(!/^\s*import\s/m.test(mockSource), "mock-esp32.js has no imports");
  assert.ok(!/WebSocket|fetch\(|XMLHttpRequest|require\(["']net/.test(mockSource), "mock has no transport");

  const { decideMotion } = await import("../js/motion-decision.js");
  const rig = connected();
  const decision = decideMotion({
    cameraLive: true, state: "TRACKING", matched: true,
    box: { originX: 270, originY: 120, width: 100, height: 240 },
    frameWidth: 640, frameHeight: 480, lastSeenMs: rig.now, now: rig.now
  });
  rig.link.setDecision(decision.command, rig.now, rig.now);
  rig.deliver();
  assert.equal(rig.motor(), "FORWARD");
});

test("DOC: headers state the age-claim, placeholder and no-authentication limits (documentation only, no behavior)", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["../js/esp32-link.js", "../js/mock-esp32.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /cannot independently verify/i);
    assert.match(source, /detectionLatencyMs/);
    assert.match(source, /NO hostile-LAN claim/);
  }
});

// ============================ F2: safety actions on an invalid app clock ============================
// Added by the final corrective patch. Updated existing tests: none.

const BAD_CLOCKS = [["regressed", 50], ["NaN", Number.NaN], ["Infinity", Infinity]];

function established(at = 100) {
  const h = createAppHarness();
  h.handshake(0, 0);
  h.tick(at);                                          // the clock baseline is now `at`
  return h;
}

const sentKinds = (h, from) => h.sent.slice(from).map(m => m.t === "CMD" ? "CMD:" + m.cmd : m.t);

test("F2: emergencyStop() latches and sends ESTOP even when the clock is invalid, without resetting the clock baseline", () => {
  for (const [name, bad] of BAD_CLOCKS) {
    const h = established();
    const sid = h.sid();
    const n = h.sent.length;
    const faults = h.status().counters.clockFaults;
    h.link.emergencyStop(bad);
    assert.deepEqual(sentKinds(h, n), ["ESTOP"], name);
    assert.equal(h.sent[n].sid, sid, name);
    assert.equal(h.status().emergency, true, name);
    assert.equal(h.status().counters.clockFaults, faults + 1, `${name}: still counted as a clock fault`);

    // the baseline was not reset to make the clock look valid
    h.tick(90);
    assert.equal(h.status().counters.clockFaults, faults + 2, `${name}: 90 is still behind the baseline 100`);

    // no clock fault can clear the latch or grant movement
    h.link.clearEmergency(bad);
    assert.equal(h.status().emergency, true, `${name}: clearEmergency is fail-closed`);
    assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1, `${name}: no new session`);
    h.link.setDecision("FORWARD", bad, 100);
    assert.equal(h.movement().length, 0, name);
    assert.equal(h.status().effective.command, "STOP", name);
  }
});

test("F2: emergencyStop() on an invalid clock also works before the first tick and with no session", () => {
  const h = createAppHarness();
  h.link.emergencyStop(Number.NaN);                    // no session: only the latch
  assert.equal(h.status().emergency, true);
  assert.equal(h.sent.length, 0);
  h.link.connect(5);
  h.challenge(5);
  h.ack(2, 5);
  h.ack(3, 5);
  h.decide("FORWARD", 10, 10);
  assert.equal(h.movement().length, 0, "the latch survived");
});

test("F2: suspend() sends STOP then BYE and ends the session even when the clock is invalid", () => {
  for (const [name, bad] of BAD_CLOCKS) {
    const h = established();
    const sid = h.sid();
    const n = h.sent.length;
    h.link.suspend(bad);
    assert.deepEqual(sentKinds(h, n), ["CMD:STOP", "BYE"], name);
    assert.ok(h.sent.slice(n).every(m => m.sid === sid), name);
    assert.ok(h.sent[n + 1].seq > h.sent[n].seq, `${name}: BYE after STOP`);
    assert.equal(h.status().state, LINK_STATE.DISCONNECTED, name);
    assert.equal(h.status().session, null, name);
    assert.equal(h.status().lastDisconnectReason, "SUSPENDED", name);

    // resume() needs a valid clock: it stays fail-closed
    h.link.resume(bad);
    assert.equal(h.status().state, LINK_STATE.DISCONNECTED, `${name}: no session on a bad clock`);
    assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1, name);
    h.link.resume(150);
    assert.equal(h.status().state, LINK_STATE.HELLO_SENT, `${name}: resumes with a valid clock`);
    assert.notEqual(h.sid(), sid);
  }
});

test("F2: disconnect() sends STOP then BYE and ends the session even when the clock is invalid; connect() stays fail-closed", () => {
  for (const [name, bad] of BAD_CLOCKS) {
    const h = established();
    const sid = h.sid();
    const n = h.sent.length;
    h.link.disconnect(bad);
    assert.deepEqual(sentKinds(h, n), ["CMD:STOP", "BYE"], name);
    assert.ok(h.sent.slice(n).every(m => m.sid === sid), name);
    assert.equal(h.status().state, LINK_STATE.DISCONNECTED, name);
    assert.equal(h.status().lastDisconnectReason, "DISCONNECTED_BY_APP", name);

    const count = h.sent.length;
    h.link.connect(bad);
    assert.equal(h.sent.length, count, `${name}: connect() creates no session on a bad clock`);
    assert.equal(h.status().state, LINK_STATE.DISCONNECTED, name);
    h.link.resume(150);                                // an explicit disconnect is not resumable
    assert.equal(h.status().state, LINK_STATE.DISCONNECTED, name);
    assert.equal(h.movement().length, 0, name);
  }
});

test("F2: the safety actions also run on a valid clock exactly as before (ESTOP, STOP+BYE ordering)", () => {
  const h = established();
  const n = h.sent.length;
  h.link.emergencyStop(110);
  assert.deepEqual(sentKinds(h, n), ["ESTOP"]);
  const g = established();
  const m = g.sent.length;
  g.link.suspend(110);
  assert.deepEqual(sentKinds(g, m), ["CMD:STOP", "BYE"]);
});

// ============================ F3: duplicate BUSY ============================
// Added by the final corrective patch. Updated existing tests: none.

function busyHandshake() {
  const h = createAppHarness();
  h.link.connect(0);
  h.challenge(0);                                      // ARM transmission #1 at t=0
  return h;
}

test("F3: a duplicate BUSY before the next retry is ignored: no counter, no deadline refresh", () => {
  const h = busyHandshake();
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  assert.equal(h.status().counters.busy, 1);
  assert.equal(h.status().busyStart, 10);
  h.ack(2, 100, { ok: false, reason: "BUSY" });        // duplicate of the same transmission
  h.ack(2, 150, { ok: false, reason: "BUSY" });
  assert.equal(h.status().counters.busy, 1, "not counted");
  h.tick(200);                                         // the retry: a new opportunity
  assert.equal(h.sent.filter(m => m.t === "ARM").length, 2);
  // the duplicates did not refresh the handshake deadline: 600 ms after the FIRST BUSY it ends
  h.tick(610);
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(611);
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  assert.equal(h.status().lastDisconnectReason, "BUSY_NO_REPLY");
  assert.equal(h.status().lastError, "DEVICE_BUSY");
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1, "no new sid");
});

test("F3: a duplicate BUSY after the next retry is ignored; each ARM transmission can be answered by BUSY once", () => {
  const h = busyHandshake();
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  h.tick(200);                                         // transmission #2
  h.ack(2, 210, { ok: false, reason: "BUSY" });        // its one BUSY
  assert.equal(h.status().counters.busy, 2);
  h.ack(2, 220, { ok: false, reason: "BUSY" });        // duplicate of #2, or a late BUSY of #1
  h.ack(2, 230, { ok: false, reason: "BUSY" });
  assert.equal(h.status().counters.busy, 2);
  h.tick(400);                                         // transmission #3, unanswered
  h.tick(810);                                         // 600 after the last ACCEPTED BUSY (210)
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(811);
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  // ARM transmissions: t=0, 200, 400 (each on its 200 ms retry) and one more on the late tick at 810
  assert.equal(h.sent.filter(m => m.t === "ARM").length, 4);
});

test("F3: exact 2000 ms boundary from the first accepted BUSY, with duplicate and delayed BUSY replies that cannot extend it", () => {
  const h = busyHandshake();
  h.ack(2, 10, { ok: false, reason: "BUSY" });         // busyStart = 10
  let answered = 1;
  for (let at = 200; at <= 1800; at += 200) {
    h.tick(at);                                        // ARM retry every 200 ms
    h.ack(2, at + 10, { ok: false, reason: "BUSY" });
    h.ack(2, at + 20, { ok: false, reason: "BUSY" });  // duplicate: ignored
    answered += 1;
  }
  assert.equal(h.status().counters.busy, answered, "exactly one accepted BUSY per transmission");
  assert.equal(h.sent.filter(m => m.t === "ARM").length, answered, "one ARM per 200 ms");
  h.tick(2000);                                        // transmission at 2000 (elapsed 1990)
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(2009);                                        // elapsed 1999: still waiting
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.tick(2010);                                        // elapsed 2000: DEVICE_BUSY
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  assert.equal(h.status().lastError, "DEVICE_BUSY");
  assert.equal(h.status().lastDisconnectReason, "BUSY_TIMEOUT");
  h.ack(2, 2011, { ok: false, reason: "BUSY" });       // a late BUSY changes nothing
  assert.equal(h.status().state, LINK_STATE.DISCONNECTED);
  const count = h.sent.length;
  for (let at = 2100; at < 6000; at += 100) h.tick(at);
  assert.equal(h.sent.length, count, "no automatic retry and no new sid");
  assert.equal(h.sent.filter(m => m.t === "HELLO").length, 1);
  h.link.connect(6000);                                // only an explicit connect() starts again
  assert.equal(h.status().state, LINK_STATE.HELLO_SENT);
});

test("F3: a BUSY whose receipt is exactly 2000 ms after the first one ends the wait at once", () => {
  const h = busyHandshake();
  h.ack(2, 10, { ok: false, reason: "BUSY" });
  for (let at = 200; at <= 2000; at += 200) {
    h.tick(at);
    if (at < 2000) h.ack(2, at + 10, { ok: false, reason: "BUSY" });
  }
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  h.ack(2, 2009, { ok: false, reason: "BUSY" });       // elapsed 1999: accepted, still waiting
  assert.equal(h.status().state, LINK_STATE.ARM_SENT);
  const g = busyHandshake();
  g.ack(2, 10, { ok: false, reason: "BUSY" });
  for (let at = 200; at <= 2000; at += 200) {
    g.tick(at);
    if (at < 2000) g.ack(2, at + 10, { ok: false, reason: "BUSY" });
  }
  g.ack(2, 2010, { ok: false, reason: "BUSY" });       // elapsed 2000
  assert.equal(g.status().state, LINK_STATE.DISCONNECTED);
  assert.equal(g.status().lastError, "DEVICE_BUSY");
});
