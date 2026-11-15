/*
 * Deterministic device-side fault tests for protocol v2: the K1 two-timer
 * rules, the K2 STOP / did-invalidation rules, lease and token proof,
 * handshake, ESTOP/BYE, replay, delay, session and sequence boundaries.
 * In-memory, simulated clocks, no timers, no network.
 *   node --test tests/esp32-faults.test.mjs
 * Shared rig: tests/helpers/esp32-rig.mjs. All times given to createDevice()
 * helpers are DEVICE time.
 *
 * ---- Migration ledger: the 37 tests of the previous version of this file ----
 * K = kept, U = updated, R = replaced.
 *  F01 K1-1 MOVING then STOP ............... U  "K1-1 ..."
 *  F02 K1-2a session liveness expiry ....... U  "K1-2a ..."
 *  F03 K1-2b watchdog, session ARMED ....... R  "K1-2b watchdog expiry latches LATCHED(WATCHDOG) ..." (Q1, Gap A)
 *  F04 K1-2c both timers at 600 ms ......... R  "C-5 ..."
 *  F05 K1-2d CMD after timers ran out ...... U  "K1-2d ..."
 *  F06 K1-3 STOP no watchdog renewal ....... U  "K1-3 ..."
 *  F07 K1-3b movement after STOP ........... U  "K1-3b ..."
 *  F08 K1-4 STOP renews liveness only ...... U  "K1-4 ..."
 *  F09 K1-4b STOP keepalives ............... K  "K1-4b ..."
 *  F10 K1-5 liveness never grants .......... U  "K1-5 ..."
 *  F11 K1-6 invalid renew neither .......... U  "K1-6 ..."
 *  F12 K1-6b rejected cannot keep alive .... U  "K1-6b ..."
 *  F13 K2-1 every STOP stops ............... U  "K2-1 ..."
 *  F14 K2-2/6 same did never resumes ....... U  "K2-2/6 ..."
 *  F15 K2-7 new did resumes ................ U  "K2-7 ..."
 *  F16 K2-5 invalid / malformed STOP ....... U  "K2-5 ..." (adds C-10 / Q15 forms)
 *  F17 K2-5b invalid STOP renews neither ... U  "K2-5b ..."
 *  F18 K2-8 STOP cannot clear LATCHED ...... U  "K2-8 ..."
 *  F19 K2-9 STOP cannot create a session ... U  "K2-9 ..."
 *  F20 K2-10 expiryDid fuzz ................ R  "K2-10 property ..." (stronger invariants)
 *  F21 K2-10b repeat never extends ......... U  "K2-10b ..." (Q7)
 *  F22 delayed CMD after newer STOP ........ U  "delayed movement CMD ..."
 *  F23 delayed CMD, nearly expired claim ... R  "delayed packets shrink the lease ..." (proofAge)
 *  F24 exact replay ........................ U  "an exact replay ..."
 *  F25 repeated token is REPLAY ............ R  "tokens are device-issued and bound ..." (Q3)
 *  F26 rejected in-window consumes seq ..... U  "a rejected in-window movement CMD consumes its seq ..."
 *  F27 token ring last 8 ................... R  "token ring of 8 ..."
 *  F28 sequence window ..................... U  "sequence window ..."
 *  F29 minimum CMD interval ................ U  "CMD minimum interval ..." (Q13, Q21)
 *  F30 session boundary .................... R  "session boundary ..."
 *  F31 ARM from an older session ........... R  "handshake nonce ..."
 *  F32 ARM bad version / no token .......... R  "malformed HELLO and ARM ..."
 *  F33 E2E STOP then new did ............... U  "E2E: an app STOP decision ..."
 *  F34 E2E stray STOP ...................... R  "E2E: a stray STOP ..." (exact assertions)
 *  F35 E2E STOP heartbeats keep session .... U  "E2E: STOP heartbeats ..."
 *  F36 E2E silent app latches .............. U  "E2E: if the app goes silent ..."
 *  F37 E2E emergency stop .................. R  "E2E: ESTOP ..."
 * New tests: Q9, Q10, Q14-Q16, Q20, boundaries 450/500/50/700, ring and dead
 * ring bounds, clock clamp, and the delay/duplicate/reorder lease property.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SID_A, SID_B, SID_C, SID_D, connected, createDevice, createRig, frozenState, seededRandom
} from "./helpers/esp32-rig.mjs";

/* What an invalid STOP must never change. The state may go MOVING -> IDLE. */
function sessionFields(status) {
  return JSON.stringify({
    latchReason: status.latchReason,
    session: status.session,
    lastSeq: status.lastSeq,
    ring: status.ring,
    deadRing: status.deadRing,
    lastLiveAt: status.lastLiveAt,
    lastMoveAcceptedAt: status.lastMoveAcceptedAt,
    lastDid: status.lastDid
  });
}

const types = status => status.events.map(e => e.type);

// ====================== K1: two independent timers ======================

test("K1-1 MOVING followed by STOP: the motor stops, the state is IDLE, permission is cleared", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.status().state, "MOVING");
  assert.equal(d.last().expIn, 600);                  // 700 - age 0 - proofAge 100
  d.stop(150);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "IDLE");
  d.cmd("FORWARD", 300, { did: 1 });                  // the same did: gone
  assert.equal(d.last().reason, "EXPIRED");
  d.mock.tick(900);
  assert.equal(d.motor(), "STOP");
});

test("K1-2a session liveness expires on its own: LATCHED(IDLE_TIMEOUT) and the sid is dead-ringed (Q10)", () => {
  const d = createDevice().armed(0);
  d.mock.tick(600);
  assert.equal(d.status().state, "IDLE");
  d.mock.tick(601);
  assert.equal(d.status().state, "LATCHED");
  assert.equal(d.status().latchReason, "IDLE_TIMEOUT");
  assert.deepEqual(d.status().deadRing, [SID_A]);
  assert.deepEqual(types(d.status()), ["IDLE_TIMEOUT"]);
  assert.equal(d.status().counters.watchdogLatches, 0);

  // a shorter liveness timer ends a moving session without touching the watchdog
  const e = createDevice({ sessionLivenessMs: 300 }).armed(0);
  e.cmd("FORWARD", 100, { did: 1 });
  e.mock.tick(400);
  assert.equal(e.motor(), "FORWARD");
  e.mock.tick(401);
  assert.equal(e.motor(), "STOP");
  assert.equal(e.status().latchReason, "IDLE_TIMEOUT");
  assert.deepEqual(types(e.status()), ["IDLE_TIMEOUT"]);
  assert.equal(e.status().counters.watchdogLatches, 0);
});

test("K1-2b movement watchdog expiry latches LATCHED(WATCHDOG) and the session is dead: a new did alone cannot resume (Q1, Gap A)", () => {
  const d = createDevice({ sessionLivenessMs: 5000 }).armed(100);   // liveness lengthened to show the watchdog alone
  d.cmd("FORWARD", 100, { did: 1 });                  // proofAge 0: remain 700
  d.mock.tick(700);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(701);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "LATCHED");
  assert.equal(d.status().latchReason, "WATCHDOG");
  assert.deepEqual(types(d.status()), ["WATCHDOG"]);
  assert.equal(d.status().sessionLivenessExpired, false);
  assert.deepEqual(d.status().deadRing, [SID_A]);
  assert.equal(d.status().lastDid, 0);
  assert.equal(d.status().expiryDid, null);
  assert.equal(d.status().ring.length, 0);

  d.cmd("FORWARD", 800, { did: 2 });                  // newer did, higher seq, fresh token: still nothing
  assert.equal(d.last().reason, "DEAD_SESSION");
  assert.equal(d.motor(), "STOP");

  // the exact recovery: new random sid, HELLO, CHALLENGE, ARM, first STOP, a newer did
  d.armed(900, { sid: SID_B });
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().session, SID_B);
  d.stop(910);
  assert.equal(d.last().ok, true);
  d.cmd("FORWARD", 1020, { did: 1 });
  assert.equal(d.motor(), "FORWARD");
});

test("C-5 watchdog and session expire at the same instant: WATCHDOG first, LATCHED(WATCHDOG), no IDLE_TIMEOUT, sid dead-ringed once", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });                  // watchdog and liveness both renewed at 100
  d.mock.tick(700);
  assert.equal(d.status().state, "MOVING");
  d.mock.tick(701);                                   // both are 601 ms old
  const status = d.status();
  assert.equal(status.state, "LATCHED");
  assert.equal(status.latchReason, "WATCHDOG");
  assert.deepEqual(types(status), ["WATCHDOG"], "no second latch transition, no IDLE_TIMEOUT");
  assert.equal(status.counters.idleTimeouts, 0);
  assert.equal(status.counters.watchdogLatches, 1);
  assert.equal(status.sessionLivenessExpired, true, "session expiry applied idempotently");
  assert.deepEqual(status.deadRing, [SID_A], "the sid appears once");
  assert.equal(status.motorLog.at(-1).reason, "WATCHDOG");
  assert.equal(status.lastDid, 0);
  d.mock.tick(5000);                                  // nothing changes afterwards
  assert.deepEqual(types(d.status()), ["WATCHDOG"]);
  assert.deepEqual(d.status().deadRing, [SID_A]);
});

test("K1-2d a CMD that arrives after the timers ran out finds the expiry applied first", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });
  d.cmd("FORWARD", 900, { did: 2 });                  // no tick in between
  assert.equal(d.last().reason, "DEAD_SESSION");
  assert.equal(d.status().latchReason, "WATCHDOG");
  assert.deepEqual(types(d.status()), ["WATCHDOG"]);
});

test("K1-3 STOP does not renew the movement watchdog", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });
  d.stop(400);
  assert.equal(d.status().lastMoveAcceptedAt, 100);
  assert.equal(d.status().lastLiveAt, 400);
  d.stop(500);
  assert.equal(d.status().lastMoveAcceptedAt, 100);
});

test("K1-3b movement after STOP needs a new did, restarts the watchdog and arms it again (only while MOVING)", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });
  d.stop(440);                                        // fresh token issued at 440
  d.cmd("FORWARD", 450, { did: 1 });
  assert.equal(d.last().reason, "EXPIRED");
  d.cmd("FORWARD", 450, { did: 2 });
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.status().lastMoveAcceptedAt, 450);
  d.mock.tick(1050);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(1051);
  assert.equal(d.status().latchReason, "WATCHDOG");
});

test("K1-4 a valid STOP from the active session renews only session liveness", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });
  d.stop(500);
  const status = d.status();
  assert.equal(status.lastLiveAt, 500);
  assert.equal(status.lastMoveAcceptedAt, 100);
  assert.equal(status.state, "IDLE");
  assert.equal(d.last().ok, true);
  d.mock.tick(1100);
  assert.equal(d.status().state, "IDLE", "liveness runs from the STOP at 500");
  d.mock.tick(1101);
  assert.equal(d.status().latchReason, "IDLE_TIMEOUT");
});

test("K1-4b STOP keepalives hold the session but never move the motor and never latch (watchdog is armed only while MOVING)", () => {
  const d = createDevice().armed(0);
  for (let t = 200; t <= 5000; t += 200) {
    d.stop(t);
    d.mock.tick(t);
    assert.equal(d.motor(), "STOP");
    assert.equal(d.status().state, "IDLE");
  }
  assert.equal(d.status().lastMoveAcceptedAt, null);
  assert.equal(d.status().counters.watchdogLatches, 0);
});

test("K1-5 session liveness never grants movement permission", () => {
  const d = createDevice().armed(0);
  d.stop(100);
  d.cmd("FORWARD", 200, { did: 1, age: 451 });
  assert.equal(d.last().reason, "DETECTION_TOO_OLD");
  d.cmd("FORWARD", 300, { did: 0 });
  assert.equal(d.last().reason, "MALFORMED");
  d.cmd("JUMP", 400, { did: 1 });
  assert.equal(d.last().reason, "INVALID_COMMAND");
  d.mock.tick(450);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().lastMoveAcceptedAt, null);
  assert.equal(d.status().counters.watchdogLatches, 0);
});

test("K1-6 invalid, expired, duplicate and out-of-order packets renew neither timer", () => {
  // [name, time, attack]; the first movement CMD (did 1, seq 3, ARM token) is accepted at t=100
  const cases = [
    ["unknown sid", 550, (d) => d.cmd("FORWARD", 550, { sid: SID_B, seq: 5, did: 2 })],
    ["duplicate seq", 550, (d) => d.cmd("FORWARD", 550, { seq: 3, did: 2 })],
    ["older seq", 550, (d) => d.cmd("FORWARD", 550, { seq: 2, did: 2 })],
    ["seq beyond window", 550, (d) => d.cmd("FORWARD", 550, { seq: 3 + 33, did: 2 })],
    ["age claim too old", 550, (d) => d.cmd("FORWARD", 550, { did: 2, age: 451 })],
    ["unknown command", 550, (d) => d.cmd("BACKWARD", 550, { did: 2 })],
    ["rate limited", 150, (d) => d.cmd("FORWARD", 150, { did: 2 })],
    ["wrong version", 550, (d) => d.cmd("FORWARD", 550, { v: 1, did: 2 })],
    ["missing token", 550, (d) => d.cmd("FORWARD", 550, { did: 2, raw: { tok: undefined } })],
    ["bad token", 550, (d) => d.cmd("FORWARD", 550, { did: 2, tok: 12345 })],
    ["stale proof (old token)", 550, (d) => d.cmd("FORWARD", 550, { did: 2, tok: d.armToken.tok, ackSeq: d.armToken.ackSeq })],
    ["bad did", 550, (d) => d.cmd("FORWARD", 550, { did: -1 })],
    ["old did", 550, (d) => { d.cmd("FORWARD", 300, { did: 3 }); d.cmd("FORWARD", 450, { did: 2 }); }]
  ];

  for (const [name, , attack] of cases) {
    const d = createDevice().armed(0);
    d.armToken = { ...d.token };
    d.cmd("FORWARD", 100, { did: 1, tok: d.armToken.tok, ackSeq: d.armToken.ackSeq });
    assert.equal(d.motor(), "FORWARD", name);
    if (name === "old did") d.cmd("FORWARD", 300, { did: 3 });
    const before = d.status();
    const replies = d.replies.length;
    if (name === "old did") d.cmd("FORWARD", 450, { did: 2 });
    else attack(d);
    const after = d.status();
    assert.equal(after.lastLiveAt, before.lastLiveAt, `${name}: liveness untouched`);
    assert.equal(after.lastMoveAcceptedAt, before.lastMoveAcceptedAt, `${name}: watchdog untouched`);
    if (d.replies.length > replies) assert.equal(d.last().ok, false, `${name}: rejected`);
  }
});

test("K1-6b rejected packets cannot keep a session or a movement alive", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });                  // seq 3
  for (let t = 150; t <= 650; t += 50) d.cmd("FORWARD", t, { did: 1, seq: 3 });   // replays
  d.mock.tick(701);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "LATCHED");
});

// ====================== K2: STOP and did invalidation ======================

test("K2-1 every effective STOP stops at once and sets expiryDid = min(expiryDid, now); a later STOP never raises it", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  assert.equal(d.status().expiryDid, 700);
  d.stop(200);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().expiryDid, 200);
  assert.equal(d.status().state, "IDLE");
  d.stop(300);
  assert.equal(d.status().expiryDid, 200);
});

test("K2-2/6 the same did never resumes movement, even with a new token and seq", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  d.stop(200);
  for (const t of [300, 350, 400, 440]) {
    d.cmd("FORWARD", t, { did: 1 });                  // a fresh token and seq every time
    assert.equal(d.motor(), "STOP", `did 1 at ${t}`);
    assert.equal(d.last().reason, "EXPIRED");
  }
  assert.equal(d.status().lastMoveAcceptedAt, 100);
});

test("K2-7 a new did resumes after STOP; did stays monotonic; a content reject never extends the original budget", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 3 });
  d.stop(200);
  d.cmd("FORWARD", 300, { did: 4 });
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.status().lastDid, 4);
  assert.equal(d.status().expiryDid, 900);
  d.cmd("FORWARD", 420, { did: 3 });                  // an older did: STALE_DID and fail closed
  assert.equal(d.last().reason, "STALE_DID");
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().lastDid, 4, "did never decreased");
  d.cmd("FORWARD", 540, { did: 4 });                  // a content reject does not invalidate the did ...
  assert.equal(d.motor(), "FORWARD");
  assert.ok(d.status().expiryDid <= 900, "... but never extends it");
  d.cmd("FORWARD", 660, { did: 5 });
  assert.equal(d.status().lastDid, 5);
});

test("K2-5 / C-10 / Q15: a STOP with an unknown sid, a bad seq or a malformed field still stops and invalidates; nothing else changes; malformed gets no ACK", () => {
  // [name, malformed (no ACK expected), how to send the STOP at t=150]
  const attacks = [
    ["unknown sid", false, d => d.stop(150, { sid: SID_B, seq: 7 })],
    ["duplicate seq", false, d => d.stop(150, { seq: 3 })],
    ["older seq", false, d => d.stop(150, { seq: 1 })],
    ["seq beyond window", false, d => d.stop(150, { seq: 3 + 33 })],
    ["malformed sid", true, d => d.stop(150, { raw: { sid: "zz" } })],
    ["uppercase sid", true, d => d.stop(150, { raw: { sid: SID_A.toUpperCase() } })],
    ["missing sid", true, d => d.stop(150, { raw: { sid: undefined } })],
    ["seq zero", true, d => d.stop(150, { raw: { seq: 0 } })],
    ["seq not an integer", true, d => d.stop(150, { raw: { seq: 4.5 } })],
    ["seq as a string", true, d => d.stop(150, { raw: { seq: "4" } })],
    ["missing seq", true, d => d.stop(150, { raw: { seq: undefined } })],
    ["wrong version", true, d => d.stop(150, { v: 1 })],
    ["missing version", true, d => d.stop(150, { raw: { v: undefined } })],
    ["bare object", true, d => d.send({ cmd: "STOP" }, 150)]
  ];

  for (const [name, malformed, attack] of attacks) {
    const d = createDevice().armed(0);
    d.cmd("FORWARD", 100, { did: 1 });
    assert.equal(d.motor(), "FORWARD");
    const before = sessionFields(d.status());
    const replies = d.replies.length;

    attack(d);

    assert.equal(d.motor(), "STOP", `${name}: motor stopped`);
    assert.ok(d.status().expiryDid <= 150, `${name}: expiryDid <= now`);
    assert.equal(sessionFields(d.status()), before, `${name}: session, lastSeq, ring, dead ring, timers unchanged`);
    assert.equal(d.status().state, "IDLE", `${name}: no latch, no new session`);
    if (malformed) assert.equal(d.replies.length, replies, `${name}: no ACK`);
    else assert.equal(d.last().ok, false, `${name}: ok:false`);

    d.cmd("FORWARD", 260, { did: 1 });
    assert.equal(d.motor(), "STOP", `${name}: the same did stays dead`);
    d.cmd("FORWARD", 380, { did: 2 });
    assert.equal(d.motor(), "FORWARD", `${name}: a new did resumes`);
  }
});

test("K2-5b an invalid STOP renews neither watchdog nor session liveness", () => {
  const d = createDevice().armed(0);
  d.stop(500, { sid: SID_B, seq: 3 });
  d.stop(590, { seq: 1 });
  d.stop(595, { raw: { sid: "zz" } });
  d.mock.tick(601);
  assert.equal(d.status().latchReason, "IDLE_TIMEOUT", "liveness ran from the ARM at 0");
});

test("K2-8 STOP cannot clear LATCHED, create a session or change the dead ring", () => {
  const d = createDevice().armed(0);
  d.mock.tick(601);
  assert.equal(d.status().state, "LATCHED");
  const before = frozenState(d.status());
  d.stop(700);                                        // looks valid
  assert.equal(d.last().reason, "DEAD_SESSION");
  d.stop(710, { sid: SID_B, seq: 1 });
  assert.equal(d.last().reason, "LATCHED");
  d.stop(720, { raw: { sid: "zz" } });
  assert.equal(d.status().state, "LATCHED");
  assert.equal(d.status().latchReason, "IDLE_TIMEOUT");
  assert.equal(frozenState(d.status()), before);
  d.cmd("FORWARD", 800, { did: 1, raw: { tok: 1, ackSeq: 1 } });
  assert.equal(d.last().reason, "DEAD_SESSION");
  d.hello(900);                                       // the dead sid cannot be revived
  assert.equal(d.last().reason, "DEAD_SESSION");
  d.armed(910, { sid: SID_B });                       // only a nonce-checked ARM of a new sid
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().latchReason, null);
  assert.equal(d.status().lastDid, 0);
});

test("K2-9 STOP cannot create or replace a session", () => {
  const idle = createDevice();
  idle.stop(10, { sid: SID_B, seq: 1 });
  assert.equal(idle.status().state, "BOOT_LATCHED");
  assert.equal(idle.status().session, null);
  assert.equal(idle.status().lastSeq, 0);
  assert.equal(idle.motor(), "STOP");
  assert.equal(idle.last().reason, "LATCHED");

  const d = createDevice().armed(0);
  const before = frozenState(d.status());
  d.stop(10, { sid: SID_B, seq: 1 });
  d.stop(20, { sid: SID_C, seq: 40 });
  assert.equal(frozenState(d.status()), before);
  assert.equal(d.status().session, SID_A);
});

test("K2-10 property (seeded, 4000 events): a stopped did never moves again, expiryDid never rises within a did, did never decreases, the motor only moves before expiryDid", () => {
  const rnd = seededRandom(12345);
  const rand = () => rnd.u32() / 0x100000000;
  const sidGen = seededRandom(99);
  const nextSid = () => Array.from(sidGen.fill(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");

  const d = createDevice();
  let now = 100;
  d.armed(now, { sid: nextSid() });
  let stoppedDid = 0;
  let previous = null;
  const seen = { moved: 0, stops: 0, latched: 0 };

  for (let i = 0; i < 4000; i++) {
    now += Math.floor(rand() * 160);
    const status = d.status();
    d.seq = status.lastSeq;                           // the next automatic seq is always in window
    const roll = rand();

    if (roll < 0.28) d.cmd("FORWARD", now, { did: status.lastDid || 1, age: Math.floor(rand() * 451) });
    else if (roll < 0.40) d.cmd("FORWARD", now, { did: status.lastDid + 1, age: Math.floor(rand() * 451) });
    else if (roll < 0.52) { d.stop(now); stoppedDid = Math.max(stoppedDid, status.lastDid); seen.stops++; }
    else if (roll < 0.58) { d.stop(now, { sid: SID_D, seq: 5 }); stoppedDid = Math.max(stoppedDid, status.lastDid); seen.stops++; }
    else if (roll < 0.63) { d.stop(now, { raw: { sid: "zz" } }); stoppedDid = Math.max(stoppedDid, status.lastDid); seen.stops++; }
    else if (roll < 0.71) d.cmd("FORWARD", now, { did: Math.max(1, status.lastDid - 1) });
    else if (roll < 0.77) d.cmd("FORWARD", now, { did: status.lastDid + 1, tok: 1 });
    else d.mock.tick(now);

    const after = d.status();

    if (after.state === "LATCHED") {                  // a latch ends the session: start a fresh one
      seen.latched++;
      d.armed(now, { sid: nextSid() });
      stoppedDid = 0;
      previous = null;
      continue;
    }

    if (after.motor !== "STOP") {
      seen.moved++;
      assert.equal(after.state, "MOVING");
      assert.ok(after.lastDid > stoppedDid, `did ${after.lastDid} moved after a STOP stopped did ${stoppedDid}`);
      assert.ok(now < after.expiryDid, "moving past expiryDid");
    }

    if (previous && previous.session === after.session) {
      assert.ok(after.lastDid >= previous.lastDid, "did decreased");
      if (previous.lastDid === after.lastDid && previous.expiryDid !== null && after.expiryDid !== null) {
        assert.ok(after.expiryDid <= previous.expiryDid, `expiryDid rose ${previous.expiryDid} -> ${after.expiryDid}`);
      }
    }
    assert.ok(after.ring.length <= 8);
    previous = after;
  }

  assert.ok(seen.moved > 100 && seen.stops > 100, JSON.stringify(seen));
});

test("K2-10b / Q7 a heartbeat of a live did may keep or shorten the expiry, never extend it", () => {
  const d = createDevice().armed(0);
  const expiries = [];
  const heartbeat = (t, age) => { d.cmd("FORWARD", t, { did: 1, age }); expiries.push(d.status().expiryDid); };
  d.cmd("FORWARD", 100, { did: 1, age: 0 });
  expiries.push(d.status().expiryDid);               // 700
  heartbeat(200, 0);                                   // claims age 0 again
  heartbeat(300, 0);
  heartbeat(400, 400);                                 // older evidence: shortens
  heartbeat(500, 0);                                   // age 0 again: must not come back up
  assert.deepEqual(expiries, [700, 700, 700, 600, 600]);
  d.mock.tick(600);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().lastStopReason, "LEASE_EXPIRED");
  d.cmd("FORWARD", 700, { did: 1 });
  assert.equal(d.last().reason, "EXPIRED");
});

// ====================== delayed CMD, tokens, replay ======================

test("delayed movement CMD arriving after a newer STOP is out of order and cannot revive the did", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1, seq: 3 });
  d.stop(200, { seq: 5 });                            // seq 4 is still in flight
  d.cmd("FORWARD", 210, { did: 1, seq: 4 });
  assert.equal(d.last().reason, "OUT_OF_ORDER");
  assert.equal(d.motor(), "STOP");
  d.cmd("FORWARD", 320, { did: 1, seq: 6 });          // in order, but the did is dead
  assert.equal(d.last().reason, "EXPIRED");
  assert.equal(d.motor(), "STOP");
});

test("delayed packets shrink the lease: remain = min(lease, 700 - age - proofAge)", () => {
  // a token 400 ms old at arrival, evidence 150 ms old: remain 150
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 400, { did: 1, age: 150 });
  assert.equal(d.last().expIn, 150);
  assert.equal(d.status().expiryDid, 550);
  // arriving later is still accepted while remain >= 50, then too late
  const e = createDevice().armed(0);
  e.cmd("FORWARD", 500, { did: 1, age: 150 });         // proofAge 500, remain 50
  assert.equal(e.last().expIn, 50);
  const f = createDevice().armed(0);
  f.cmd("FORWARD", 501, { did: 1, age: 150 });
  assert.equal(f.last().reason, "PROOF_STALE");
  // the lease field can only shorten
  const g = createDevice().armed(0);
  g.cmd("FORWARD", 100, { did: 1, age: 0, lease: 80 });
  assert.equal(g.last().expIn, 80);
});

test("an exact replay of an accepted CMD is rejected and changes nothing", () => {
  const d = createDevice().armed(0);
  const t0 = { ...d.token };
  d.cmd("FORWARD", 100, { did: 1, seq: 3, tok: t0.tok, ackSeq: t0.ackSeq });
  const before = frozenState(d.status());
  d.cmd("FORWARD", 220, { did: 1, seq: 3, tok: t0.tok, ackSeq: t0.ackSeq });
  assert.equal(d.last().reason, "OUT_OF_ORDER");
  assert.equal(frozenState(d.status()), before);
});

test("tokens are device-issued and bound to sid, ackSeq and tok (Q3): reuse with a new seq is fine and only shrinks the lease; wrong binding is BAD_TOKEN", () => {
  const d = createDevice().armed(0);
  const t0 = { ...d.token };
  d.cmd("FORWARD", 100, { did: 1, tok: t0.tok, ackSeq: t0.ackSeq });
  assert.equal(d.last().expIn, 600);
  d.cmd("FORWARD", 200, { did: 1, tok: t0.tok, ackSeq: t0.ackSeq });      // the same token again
  assert.equal(d.last().ok, true);
  assert.equal(d.last().expIn, 500, "older token proof: shorter, never longer");

  const bad = (name, fields) => {
    const e = createDevice().armed(0);
    e.cmd("FORWARD", 100, { did: 1, ...fields(e.token) });
    assert.equal(e.last().reason, "BAD_TOKEN", name);
    assert.equal(e.motor(), "STOP", name);
  };
  bad("right tok, wrong ackSeq", t => ({ tok: t.tok, ackSeq: t.ackSeq + 1 }));
  bad("right ackSeq, wrong tok", t => ({ tok: (t.tok + 1) >>> 0, ackSeq: t.ackSeq }));
  bad("never issued", () => ({ tok: 4242, ackSeq: 2 }));

  // cross-session: a token of session A cited in session B
  const x = createDevice().armed(0);
  const tokenA = { ...x.token };
  x.bye(50);
  x.armed(60, { sid: SID_B });
  x.cmd("FORWARD", 100, { did: 1, tok: tokenA.tok, ackSeq: tokenA.ackSeq });
  assert.equal(x.last().reason, "BAD_TOKEN");
});

test("a rejected in-window movement CMD consumes its seq and issues no token; RATE_LIMITED consumes nothing", () => {
  const d = createDevice().armed(0);
  const ring = d.status().ring.length;
  d.cmd("FORWARD", 100, { did: 1, age: 451, seq: 3 });
  assert.equal(d.last().reason, "DETECTION_TOO_OLD");
  assert.equal(d.status().lastSeq, 3);
  assert.equal(d.status().ring.length, ring, "no token for a rejected CMD");
  d.cmd("FORWARD", 220, { did: 1, age: 0, seq: 3 });
  assert.equal(d.last().reason, "OUT_OF_ORDER");
  d.cmd("FORWARD", 240, { did: 1, age: 0, seq: 4 });
  assert.equal(d.motor(), "FORWARD");
});

test("token ring of 8: the oldest entries are evicted; an evicted token is BAD_TOKEN even when it would also be stale", () => {
  const d = createDevice().armed(0);
  for (let i = 1; i <= 10; i++) d.stop(i * 10);       // ARM token + 10 STOP tokens: 11 issued
  const issued = d.replies.filter(r => r.t === "ACK" && r.ok && Number.isInteger(r.tok))
    .map(r => ({ tok: r.tok, ackSeq: r.seq }));
  assert.equal(issued.length, 11);
  assert.equal(d.status().ring.length, 8);
  assert.deepEqual(d.status().ring.map(e => e.ackSeq), issued.slice(3).map(e => e.ackSeq));

  d.cmd("FORWARD", 120, { did: 1, tok: issued[0].tok, ackSeq: issued[0].ackSeq });
  assert.equal(d.last().reason, "BAD_TOKEN", "evicted");

  // still in the ring but older than 500 ms: PROOF_STALE, and BAD_TOKEN takes precedence for the evicted one
  d.cmd("FORWARD", 600, { did: 1, tok: issued[3].tok, ackSeq: issued[3].ackSeq });
  assert.equal(d.last().reason, "PROOF_STALE");
  d.cmd("FORWARD", 610, { did: 1, tok: issued[0].tok, ackSeq: issued[0].ackSeq });
  assert.equal(d.last().reason, "BAD_TOKEN");
});

test("sequence window: lastSeq+32 is accepted, lastSeq+33 is SEQ_JUMP and does not move lastSeq", () => {
  const d = createDevice().armed(0);                  // lastSeq 2
  d.stop(10, { seq: 35 });
  assert.equal(d.last().reason, "SEQ_JUMP");
  assert.equal(d.status().lastSeq, 2);
  d.stop(20, { seq: 34 });
  assert.equal(d.last().ok, true);
  assert.equal(d.status().lastSeq, 34);
  d.stop(30, { seq: 34 + 32 });
  assert.equal(d.last().ok, true);
  d.stop(40, { seq: 34 + 32 });
  assert.equal(d.last().reason, "OUT_OF_ORDER");
  d.stop(50, { seq: 66 + 33 });
  assert.equal(d.last().reason, "SEQ_JUMP");
  assert.equal(d.status().lastSeq, 66);
});

test("CMD minimum interval: 99 ms is RATE_LIMITED, 100 ms is accepted; STOP is exempt; RATE_LIMITED mutates nothing (Q13, Q21)", () => {
  const d = createDevice().armed(100);
  d.cmd("FORWARD", 100, { did: 1 });
  const before = frozenState(d.status());
  const ring = d.status().ring.length;
  d.cmd("FORWARD", 199, { did: 2, seq: 4 });
  assert.equal(d.last().reason, "RATE_LIMITED");
  assert.equal(frozenState(d.status()), before, "session, seq, ring, permission, timers: all unchanged");
  assert.equal(d.status().ring.length, ring, "no token issued");
  assert.equal(d.motor(), "FORWARD");
  assert.equal(d.status().expiryDid, 800);
  assert.deepEqual(Object.keys(d.last()).sort(),
    ["epoch", "expIn", "motor", "ok", "reason", "seq", "sid", "st", "t", "tok", "v"], "no wait hint");
  assert.equal(d.last().tok, null);
  d.cmd("FORWARD", 200, { did: 2, seq: 4 });          // the same seq is still unused
  assert.equal(d.last().ok, true);
  assert.equal(d.status().lastDid, 2);

  const e = createDevice().armed(100);
  e.cmd("FORWARD", 100, { did: 1 });
  e.stop(101);                                        // never rate limited
  assert.equal(e.last().ok, true);
  assert.equal(e.motor(), "STOP");
});

test("session boundary: after a session ends, CMDs of the dead sid are DEAD_SESSION and no token crosses to the new session", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  d.bye(150);
  assert.equal(d.status().latchReason, "BYE");
  d.armed(200, { sid: SID_B });
  assert.equal(d.status().session, SID_B);
  d.cmd("FORWARD", 300, { sid: SID_A, seq: 9, did: 1 });
  assert.equal(d.last().reason, "DEAD_SESSION");
  d.cmd("FORWARD", 320, { did: 1 });                  // session B with its own token
  assert.equal(d.motor(), "FORWARD");
});

// ====================== handshake, nonce, ESTOP, BYE ======================

test("handshake nonce: idempotent inside the 2000 ms TTL, new after it; ARM needs the right, unexpired nonce", () => {
  const d = createDevice();
  d.hello(0);
  const dn = d.last().dn;
  d.hello(1000);
  assert.equal(d.last().dn, dn, "same sid, same nonce");
  d.hello(2000);
  assert.equal(d.last().dn, dn, "exactly at the TTL: still the same challenge");
  d.arm(10, { dn: dn + 1 });
  assert.equal(d.last().reason, "BAD_NONCE");
  assert.equal(d.status().state, "BOOT_LATCHED");
  d.arm(2000, { dn });                                 // exactly 2000 ms after the challenge: accepted
  assert.equal(d.status().state, "IDLE");

  const e = createDevice();
  e.hello(0);
  const old = e.last().dn;
  e.arm(2001, { dn: old });                            // 2001 ms: expired
  assert.equal(e.last().reason, "BAD_NONCE");
  e.hello(2002);
  assert.notEqual(e.last().dn, old, "a new challenge after the TTL");
  e.arm(2003, { dn: old });
  assert.equal(e.last().reason, "BAD_NONCE");
  e.arm(2004);
  assert.equal(e.status().state, "IDLE");

  const f = createDevice();
  f.arm(0, { dn: 5 });                                 // ARM without HELLO
  assert.equal(f.last().reason, "BAD_NONCE");
});

test("a duplicate ARM of the active sid repeats the ARM token and renews and changes nothing (DUP_ARM)", () => {
  const d = createDevice().armed(0);
  const armToken = { ...d.token };
  d.stop(300);
  const before = frozenState(d.status());
  d.arm(400);
  assert.equal(d.last().reason, "DUP_ARM");
  assert.equal(d.last().ok, true);
  assert.equal(d.last().tok, armToken.tok);
  assert.equal(frozenState(d.status()), before);
});

test("malformed HELLO and ARM are ignored: no reply, no state change", () => {
  const d = createDevice();
  const bad = [
    { v: 1, t: "HELLO", sid: SID_A, seq: 1 },
    { t: "HELLO", sid: SID_A, seq: 1 },
    { v: 2, t: "HELLO", sid: SID_A, seq: 2 },
    { v: 2, t: "HELLO", sid: SID_A.toUpperCase(), seq: 1 },
    { v: 2, t: "HELLO", sid: "abc", seq: 1 },
    { v: 1, t: "ARM", sid: SID_A, seq: 2, dn: 1 },
    { v: 2, t: "ARM", sid: SID_A, seq: 2 },
    { v: 2, t: "ARM", sid: SID_A, seq: 2, dn: 1.5 },
    { v: 2, t: "ARM", sid: SID_A, seq: 3, dn: 1 },
    { v: 2, t: "ARM", sid: SID_A, seq: 2, dn: -1 }
  ];
  for (const message of bad) d.send(message, 10);
  assert.equal(d.replies.length, 0);
  assert.equal(d.status().state, "BOOT_LATCHED");
  assert.equal(d.status().session, null);
});

test("Q16 ESTOP: a valid ESTOP latches LATCHED(ESTOP) and dead-rings the active sid; a stale ESTOP is ignored; there is no reply", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  const replies = d.replies.length;
  d.estop(150);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "LATCHED");
  assert.equal(d.status().latchReason, "ESTOP");
  assert.deepEqual(d.status().deadRing, [SID_A]);
  assert.equal(d.replies.length, replies, "no reply to ESTOP");
  const events = d.status().events.length;
  d.estop(200);                                        // stale: the sid is dead now
  assert.equal(d.status().events.length, events);

  const e = createDevice().armed(0);                   // from another, unknown sid: still latches (no authentication, 1A)
  e.estop(50, { sid: SID_B });
  assert.equal(e.status().latchReason, "ESTOP");
  assert.deepEqual(e.status().deadRing, [SID_A]);
});

test("Q16 malformed ESTOP is fail-safe: it stops and latches LATCHED(ESTOP) but creates or changes no session", () => {
  const forms = [
    { raw: { sid: undefined } },
    { raw: { sid: "zz" } },
    { raw: { sid: SID_A.toUpperCase() } },
    { v: 1 },
    { raw: { v: undefined } }
  ];
  for (const form of forms) {
    const d = createDevice().armed(0);
    d.cmd("FORWARD", 100, { did: 1 });
    const before = JSON.stringify({ session: d.status().session, lastSeq: d.status().lastSeq, ring: d.status().ring, deadRing: d.status().deadRing });
    const replies = d.replies.length;
    d.estop(150, form);
    assert.equal(d.motor(), "STOP", JSON.stringify(form));
    assert.equal(d.status().state, "LATCHED");
    assert.equal(d.status().latchReason, "ESTOP");
    assert.equal(JSON.stringify({ session: d.status().session, lastSeq: d.status().lastSeq, ring: d.status().ring, deadRing: d.status().deadRing }), before,
      "session, lastSeq, ring and dead ring untouched");
    assert.equal(d.replies.length, replies);
    d.cmd("FORWARD", 300, { did: 2 });
    assert.equal(d.motor(), "STOP");
  }
  // from boot: stays latched, still no session
  const boot = createDevice();
  boot.estop(10, { raw: { sid: "zz" } });
  assert.equal(boot.status().session, null);
  assert.equal(boot.status().state, "BOOT_LATCHED");
});

test("Q16 BYE: only a valid BYE from the active sid in the seq window latches LATCHED(BYE); a malformed BYE is ignored", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  const before = frozenState(d.status());
  const replies = d.replies.length;
  for (const bad of [
    { v: 2, t: "BYE", sid: "zz", seq: 4 },
    { v: 2, t: "BYE", sid: SID_A },
    { v: 2, t: "BYE", sid: SID_A, seq: 0 },
    { v: 1, t: "BYE", sid: SID_A, seq: 4 },
    { t: "BYE", sid: SID_A, seq: 4 }
  ]) d.send(bad, 120);
  assert.equal(frozenState(d.status()), before, "malformed BYE: nothing changes");
  assert.equal(d.replies.length, replies, "and no reply");
  assert.equal(d.motor(), "FORWARD");

  d.send({ v: 2, t: "BYE", sid: SID_B, seq: 4 }, 130);          // another sid
  assert.equal(d.last().reason, "WRONG_SESSION");
  d.send({ v: 2, t: "BYE", sid: SID_A, seq: 3 }, 140);          // duplicate seq
  assert.equal(d.last().reason, "OUT_OF_ORDER");
  d.send({ v: 2, t: "BYE", sid: SID_A, seq: 99 }, 150);         // outside the window
  assert.equal(d.last().reason, "SEQ_JUMP");
  assert.equal(d.status().state, "MOVING");

  d.send({ v: 2, t: "BYE", sid: SID_A, seq: 4 }, 160);
  assert.equal(d.last().ok, true);
  assert.equal(d.last().st, "LATCHED");
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().latchReason, "BYE");
  assert.deepEqual(d.status().deadRing, [SID_A]);
});

test("Q9: the watchdog is armed only while MOVING; a lease that ends first goes to IDLE without a latch", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 300, { did: 1, lease: 100 });       // lease 100: expiry 400
  d.mock.tick(399);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(400);
  assert.equal(d.motor(), "STOP");
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().latchReason, null);
  assert.equal(d.status().expiryDid, 400);
  assert.deepEqual(types(d.status()), ["LEASE_EXPIRED"]);
  d.mock.tick(900);                                    // 600 after the last accepted CMD: no WATCHDOG while IDLE
  assert.deepEqual(types(d.status()), ["LEASE_EXPIRED"]);
  d.mock.tick(901);                                    // the session, not the watchdog, ends it
  assert.deepEqual(types(d.status()), ["LEASE_EXPIRED", "IDLE_TIMEOUT"]);
  assert.equal(d.status().latchReason, "IDLE_TIMEOUT");
  assert.equal(d.status().counters.watchdogLatches, 0);
});

test("Q10 dead ring of 8: FIFO, idempotent; an evicted sid can start again", () => {
  const gen = seededRandom(31);
  const sids = Array.from({ length: 10 }, () => Array.from(gen.fill(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join(""));
  const d = createDevice();
  let now = 0;
  for (const sid of sids) {
    d.armed(now, { sid });
    d.bye(now + 10);
    now += 100;
  }
  assert.equal(d.status().deadRing.length, 8);
  assert.deepEqual(d.status().deadRing, sids.slice(2));
  d.hello(now, { sid: sids[0] });                      // evicted: not dead any more
  assert.equal(d.last().t, "CHALLENGE");
  d.hello(now + 1, { sid: sids[9] });
  assert.equal(d.last().reason, "DEAD_SESSION");
});

test("the challenge table is bounded at 8: the oldest challenge is evicted", () => {
  const gen = seededRandom(77);
  const sids = Array.from({ length: 9 }, () => Array.from(gen.fill(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join(""));
  const d = createDevice();
  const dns = new Map();
  for (const sid of sids) { d.hello(0, { sid }); dns.set(sid, d.last().dn); }
  d.arm(1, { sid: sids[0], dn: dns.get(sids[0]) });
  assert.equal(d.last().reason, "BAD_NONCE", "evicted");
  d.arm(2, { sid: sids[8], dn: dns.get(sids[8]) });
  assert.equal(d.status().state, "IDLE");
});

test("the device clock is clamped: a clock that goes backwards never extends a timer or a lease", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 500, { did: 1, age: 0 });           // proofAge 500: remain 200, expiry 700
  d.mock.tick(100);                                    // the clock steps back
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(699);
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(300);                                    // back again: still evaluated at 699
  assert.equal(d.motor(), "FORWARD");
  d.mock.tick(700);
  assert.equal(d.motor(), "STOP");
  d.stop(50);                                          // an earlier timestamp cannot lower expiryDid below the clamp
  assert.ok(d.status().expiryDid <= 700);
});

// ====================== boundaries 450, 500, 50, 700 ======================

test("boundary: age 450 is accepted, 451 is DETECTION_TOO_OLD (device range check, not a verification)", () => {
  const a = createDevice().armed(0);
  a.cmd("FORWARD", 100, { did: 1, age: 450 });
  assert.equal(a.motor(), "FORWARD");
  const b = createDevice().armed(0);
  b.cmd("FORWARD", 100, { did: 1, age: 451 });
  assert.equal(b.last().reason, "DETECTION_TOO_OLD");
  assert.equal(b.motor(), "STOP");
});

test("boundary: proofAge 500 is accepted, 501 is PROOF_STALE (age <= 150 so that remain stays >= 50)", () => {
  const a = createDevice().armed(0);
  a.cmd("FORWARD", 500, { did: 1, age: 150 });
  assert.equal(a.motor(), "FORWARD");
  assert.equal(a.last().expIn, 50);
  const b = createDevice().armed(0);
  b.cmd("FORWARD", 501, { did: 1, age: 150 });
  assert.equal(b.last().reason, "PROOF_STALE");
});

test("boundary: remain 50 is accepted, 49 is EXPIRED (age 450, proofAge 200 versus 201)", () => {
  const a = createDevice().armed(0);
  a.cmd("FORWARD", 200, { did: 1, age: 450 });
  assert.equal(a.motor(), "FORWARD");
  assert.equal(a.last().expIn, 50);
  const b = createDevice().armed(0);
  b.cmd("FORWARD", 201, { did: 1, age: 450 });
  assert.equal(b.last().reason, "EXPIRED");
  assert.equal(b.motor(), "STOP");
});

test("boundary: the movement expiry never exceeds 700 ms after the receipt (age 0, proofAge 0 gives exactly 700)", () => {
  const a = createDevice().armed(100);
  a.cmd("FORWARD", 100, { did: 1, age: 0 });
  assert.equal(a.last().expIn, 700);
  assert.equal(a.status().expiryDid, 800);
  // no combination of fields exceeds it
  for (const age of [0, 100, 450]) {
    for (const lease of [0, 700, 300]) {
      const d = createDevice().armed(0);
      d.cmd("FORWARD", 40, { did: 1, age, lease });
      if (d.last().ok) assert.ok(d.last().expIn <= 700 - age - 40 && d.last().expIn <= lease, `age ${age} lease ${lease}`);
    }
  }
  // lease boundary: moving at expiry - 1, stopped at expiry (nowD >= expiry)
  const b = createDevice().armed(100);
  b.cmd("FORWARD", 100, { did: 1, lease: 300 });
  b.mock.tick(399);
  assert.equal(b.motor(), "FORWARD");
  b.mock.tick(400);
  assert.equal(b.motor(), "STOP");
});

test("lease property over a lossy, delaying, duplicating, reordering wire: every accepted movement expires within 700 ms of the true detection time", () => {
  const rnd = seededRandom(2024);
  const rand = () => rnd.u32() / 0x100000000;
  const rig = connected({}, {}, { deviceOffset: 123456 });
  rig.latencyToDevice = () => Math.floor(rand() * 151);
  rig.latencyToApp = () => Math.floor(rand() * 151);
  rig.duplicate = () => (rand() < 0.2 ? 1 : 0);
  rig.dropWhen = () => rand() < 0.03;

  const original = rig.mock.receive;
  let checked = 0;
  rig.mock.receive = (message, now) => {
    original(message, now);
    if (message.t !== "CMD" || message.cmd === "STOP") return;
    const reply = rig.toApp.at(-1);
    if (!reply || reply.t !== "ACK" || reply.seq !== message.seq || reply.sid !== message.sid || !reply.ok) return;
    const sent = rig.sendLog.find(e => e.message.sid === message.sid && e.message.seq === message.seq);
    const detection = sent.at - message.age + rig.deviceOffset;      // true detection time on the device clock
    assert.ok(rig.mock.getStatus().expiryDid <= detection + 700,
      `expiry ${rig.mock.getStatus().expiryDid} beyond ${detection + 700}`);
    checked += 1;
  };

  rig.follow("FORWARD", 20000);
  assert.ok(checked > 20, `only ${checked} accepted movement CMDs were checked`);
});

// ====================== end to end through the link ======================

test("E2E: an app STOP decision then a newer detection resumes with a new did", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  const didBefore = rig.mock.getStatus().lastDid;
  rig.link.setDecision("STOP", rig.now, rig.now);
  rig.deliver();
  assert.equal(rig.motor(), "STOP");
  rig.run(100);
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  assert.ok(rig.mock.getStatus().lastDid > didBefore);
  assert.equal(rig.mock.getStatus().counters.watchdogLatches, 0);
});

test("E2E: a stray STOP from an unknown sid stops the motor, changes no session; the app recovers without RESYNC and moves again only with a new did", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  assert.equal(rig.motor(), "FORWARD");
  const before = sessionFields(rig.mock.getStatus());
  const stoppedDid = rig.mock.getStatus().lastDid;

  rig.mock.receive({ v: 2, t: "CMD", sid: SID_B, seq: 1, cmd: "STOP" }, rig.deviceNow());
  assert.equal(rig.motor(), "STOP");
  assert.equal(sessionFields(rig.mock.getStatus()), before);

  const rejects = [];
  const original = rig.link.receive;
  rig.link.receive = (message, now) => {
    if (message.t === "ACK" && !message.ok && message.sid === rig.link.getStatus(now).session) rejects.push(message.reason);
    original(message, now);
  };
  let resumed = null;
  for (let t = 0; t < 1000; t += 50) {
    if (t % 250 === 0) rig.decide("FORWARD", 0);
    rig.step();
    if (rig.motor() === "FORWARD") { resumed = t; break; }
  }
  assert.notEqual(resumed, null, "the motor resumes");
  assert.ok(rig.mock.getStatus().lastDid > stoppedDid, "only on a new did");
  assert.equal(rig.link.getStatus(rig.now).counters.resyncs, 0, "a content reject is not a RESYNC");
  assert.equal(rig.mock.getStatus().session, rig.link.getStatus(rig.now).session);
  assert.ok(rejects.every(r => r === "EXPIRED"), rejects.join(","));
});

test("E2E: STOP heartbeats alone keep the session IDLE forever with the motor STOP", () => {
  const rig = connected();
  rig.run(5000);
  const status = rig.mock.getStatus();
  assert.equal(status.state, "IDLE");
  assert.equal(status.motor, "STOP");
  assert.equal(status.lastMoveAcceptedAt, null);
  assert.equal(status.counters.idleTimeouts, 0);
  assert.equal(status.counters.watchdogLatches, 0);
});

test("E2E: if the app goes silent the device latches and a new session and a newer detection are needed", () => {
  const rig = connected();
  rig.follow("FORWARD", 400);
  const oldSid = rig.link.getStatus(rig.now).session;
  rig.dropToDevice = true;
  rig.run(1000);
  assert.equal(rig.mock.getStatus().state, "LATCHED");
  assert.equal(rig.motor(), "STOP");
  rig.dropToDevice = false;
  rig.follow("FORWARD", 2500);
  assert.equal(rig.mock.getStatus().state, "MOVING");
  assert.notEqual(rig.mock.getStatus().session, oldSid);
  assert.equal(rig.motor(), "FORWARD");
});

test("E2E: ESTOP wins over any decision and the session stays dead", () => {
  const rig = connected();
  rig.follow("FORWARD", 500);
  const sid = rig.link.getStatus(rig.now).session;
  rig.link.emergencyStop(rig.now);
  rig.run(1000);
  assert.equal(rig.mock.getStatus().latchReason, "ESTOP");
  assert.ok(rig.mock.getStatus().deadRing.includes(sid));
  rig.follow("FORWARD", 1000);
  assert.equal(rig.motor(), "STOP");
  assert.deepEqual(types(rig.mock.getStatus()).filter(t => t === "ESTOP").length > 0, true);
});

// ====================== F1: STOP carried by a non-CMD message type ======================
// Added by the final corrective patch. Updated existing tests: none.

test("F1: a valid ARM carrying cmd:STOP only stops and invalidates; it cannot create a session or get a reply", () => {
  // from boot: the nonce is valid, the ARM would have created a session
  const d = createDevice();
  d.hello(0, { sid: SID_B });
  const dn = d.dn;
  const replies = d.replies.length;
  d.send({ v: 2, t: "ARM", sid: SID_B, seq: 2, dn, cmd: "STOP" }, 10);
  assert.equal(d.status().state, "BOOT_LATCHED");
  assert.equal(d.status().session, null);
  assert.equal(d.status().ring.length, 0);
  assert.equal(d.replies.length, replies, "not dispatched: no ACK");
  d.arm(20, { sid: SID_B });                          // the real ARM still works: the nonce was not consumed
  assert.equal(d.status().state, "IDLE");

  // while another session is moving: it stops, the did is invalidated, nothing else changes
  for (const sid of [SID_B, SID_A]) {
    const e = createDevice().armed(0);
    e.cmd("FORWARD", 100, { did: 1 });
    e.hello(110, { sid: SID_B });
    const before = sessionFields(e.status());
    const count = e.replies.length;
    e.send({ v: 2, t: "ARM", sid, seq: 2, dn: e.dn, cmd: "STOP" }, 150);
    assert.equal(e.motor(), "STOP", sid);
    assert.ok(e.status().expiryDid <= 150, sid);
    assert.equal(sessionFields(e.status()), before, sid);
    assert.equal(e.status().session, SID_A);
    assert.equal(e.replies.length, count, "no BUSY or DUP_ARM reply");
  }
});

test("F1: a valid BYE carrying cmd:STOP only stops and invalidates; it cannot latch BYE or end the session", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  const before = sessionFields(d.status());
  const replies = d.replies.length;
  d.send({ v: 2, t: "BYE", sid: SID_A, seq: 4, cmd: "STOP" }, 120);
  assert.equal(d.motor(), "STOP");
  assert.ok(d.status().expiryDid <= 120);
  assert.equal(d.status().state, "IDLE");
  assert.equal(d.status().latchReason, null);
  assert.deepEqual(d.status().deadRing, []);
  assert.equal(d.status().session, SID_A);
  assert.equal(sessionFields(d.status()), before);
  assert.equal(d.replies.length, replies);
  d.cmd("FORWARD", 240, { did: 1 });                  // the same did stays dead ...
  assert.equal(d.last().reason, "EXPIRED");
  d.cmd("FORWARD", 360, { did: 2 });                  // ... a new did resumes: the session is alive
  assert.equal(d.motor(), "FORWARD");
  d.send({ v: 2, t: "BYE", sid: SID_A, seq: d.status().lastSeq + 1 }, 400);   // a real BYE still latches
  assert.equal(d.status().latchReason, "BYE");
});

test("F1: an ESTOP, HELLO or unknown-type message carrying cmd:STOP only stops and invalidates", () => {
  for (const message of [
    { v: 2, t: "ESTOP", sid: SID_A, cmd: "STOP" },
    { v: 2, t: "HELLO", sid: SID_B, seq: 1, cmd: "STOP" },
    { v: 2, t: "NOPE", sid: SID_A, seq: 4, cmd: "STOP" },
    { v: 2, sid: SID_A, seq: 4, cmd: "STOP" },
    { cmd: "STOP" }
  ]) {
    const d = createDevice().armed(0);
    d.cmd("FORWARD", 100, { did: 1 });
    const before = sessionFields(d.status());
    const replies = d.replies.length;
    const events = d.status().events.length;
    d.send(message, 150);
    assert.equal(d.motor(), "STOP", JSON.stringify(message));
    assert.ok(d.status().expiryDid <= 150);
    assert.equal(d.status().state, "IDLE", "no latch");
    assert.equal(sessionFields(d.status()), before);
    assert.equal(d.replies.length, replies, "no reply, no CHALLENGE");
    assert.equal(d.status().events.length, events, "no ESTOP event");
  }
});

test("F1: an ordinary valid CMD STOP still renews liveness only, consumes its seq and issues a token", () => {
  const d = createDevice().armed(0);
  d.cmd("FORWARD", 100, { did: 1 });
  const ring = d.status().ring.length;
  d.stop(300);
  const status = d.status();
  assert.equal(d.last().ok, true);
  assert.ok(Number.isInteger(d.last().tok));
  assert.equal(status.lastSeq, 4);
  assert.equal(status.ring.length, ring + 1);
  assert.equal(status.lastLiveAt, 300);
  assert.equal(status.lastMoveAcceptedAt, 100);
  assert.equal(status.state, "IDLE");
  assert.ok(status.expiryDid <= 300);
});
