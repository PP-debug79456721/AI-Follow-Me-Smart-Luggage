/*
 * Protocol v2 conformance: the C++ firmware core (firmware/esp32-follow/
 * protocol.h) against the JavaScript mock (js/mock-esp32.js).
 *
 *   node --test tests/firmware-conformance.test.mjs
 *
 * Each scenario is driven through the MOCK (the source of truth). The same
 * messages and times are then replayed through the compiled C++ core, and
 * every reply and the full device state after EVERY step are compared.
 *
 * Needs a host C++ compiler (g++ or clang++). Without one the tests are
 * reported as skipped. No package is installed and nothing is flashed.
 *
 * WHAT THIS PROVES: the C++ port behaves like the JavaScript mock on a host
 * computer. WHAT IT DOES NOT PROVE: anything about a real ESP32, Wi-Fi,
 * real timing, the WebSocket server or any motor. Real-board compatibility
 * is NOT VERIFIED until the same transcripts are replayed against the board.
 *
 * Known, documented deviation: JSON nested deeper than 8 levels is treated
 * as invalid by the firmware (the app never sends nesting at all).
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockEsp32 } from "../js/mock-esp32.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "firmware", "esp32-follow", "host", "conformance_main.cpp");

let workDir = null;
let binary = null;
let compilerNote = null;

before(() => {
  for (const compiler of ["g++", "clang++", "c++"]) {
    const probe = spawnSync(compiler, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    workDir = mkdtempSync(path.join(tmpdir(), "esp32-follow-conf-"));
    binary = path.join(workDir, "conf");
    try {
      // FIRMWARE_SANITIZE=1 builds the harness with AddressSanitizer + UBSan.
      const extra = process.env.FIRMWARE_SANITIZE ? ["-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all"] : [];
      execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-O1", ...extra, "-o", binary, SOURCE], { stdio: "pipe" });
      return;
    } catch (error) {
      compilerNote = `compile failed with ${compiler}: ${error.stderr?.toString() ?? error.message}`;
      binary = null;
      throw new Error(compilerNote);
    }
  }
  compilerNote = "no C++ compiler found";
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const skip = () => (binary ? false : compilerNote ?? "no C++ compiler");

/* ---------- scenario recorder (drives the mock) ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const clone = value => JSON.parse(JSON.stringify(value));

// Which ACK reasons and device events the scenarios actually exercised.
const seenReasons = new Set();
const seenEvents = new Set();

function normalize(status) {
  const out = {
    motor: status.motor,
    state: status.state,
    latchReason: status.latchReason,
    session: status.session,
    lastSeq: status.lastSeq,
    ring: status.ring.map(r => ({ sid: r.sid, ackSeq: r.ackSeq, tok: r.tok, issuedAt: r.issuedAt })),
    deadRing: status.deadRing,
    lastDid: status.lastDid,
    expiryDid: status.expiryDid,
    lastLiveAt: status.lastLiveAt,
    lastMoveAcceptedAt: status.lastMoveAcceptedAt,
    sessionLivenessExpired: status.sessionLivenessExpired,
    lastStopReason: status.lastStopReason,
    lastReject: status.lastReject,
    epoch: status.epoch,
    counters: status.counters,
    motorLog: status.motorLog,
    events: status.events
  };
  return clone(out);
}

class Script {
  constructor(seed = 1) {
    const next = lcg(seed);
    this.rand = Array.from({ length: 6000 }, () => next());
    this.index = 0;
    this.replies = [];
    this.lastReplies = [];
    this.steps = [];
    this.expected = [];
    this.mock = createMockEsp32({
      random32: () => this.rand[this.index++],
      reply: message => this.replies.push(clone(message))
    });
  }

  record(line) {
    this.steps.push(line);
    this.lastReplies = this.replies;
    for (const r of this.replies) if (r.t === "ACK") seenReasons.add(r.reason ?? "OK");
    for (const e of this.mock.getStatus().events) seenEvents.add(e.type);
    this.expected.push({ replies: this.replies, status: normalize(this.mock.getStatus()) });
  }

  rawNow(now) {
    return now === null || now === undefined || Number.isNaN(now) ? "null" : String(now);
  }

  /* A message object. The mock and the C++ core receive the SAME JSON text. */
  rx(now, message) {
    return this.rxRaw(now, JSON.stringify(message));
  }

  rxRaw(now, raw) {
    this.replies = [];
    let parsed;
    let valid = true;
    try { parsed = JSON.parse(raw); } catch { valid = false; }
    if (valid) this.mock.receive(parsed, now === null ? null : now);
    this.record(`RX ${this.rawNow(now)} ${raw}`);
    return this.lastReplies;
  }

  tick(now) {
    this.replies = [];
    this.mock.tick(now === null ? null : now);
    this.record(`TICK ${this.rawNow(now)}`);
  }

  stdin() {
    return [`RAND ${this.rand.join(" ")}`, ...this.steps].join("\n") + "\n";
  }
}

function runCpp(script) {
  const result = spawnSync(binary, [], { input: script.stdin(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, `harness failed: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, script.steps.length, "one output line per step");
  return lines;
}

/* Compares every step; returns the C++ output for scenario-specific assertions. */
function conform(script, label) {
  const actual = runCpp(script);
  for (let i = 0; i < actual.length; i += 1) {
    const want = script.expected[i];
    const got = actual[i];
    assert.equal(got.rngExhausted, false, `${label}: random source exhausted at step ${i}`);
    try {
      assert.deepStrictEqual(got.replies, want.replies);
      assert.deepStrictEqual(got.status, want.status);
    } catch (error) {
      error.message = `${label}: step ${i} diverged (${script.steps[i].slice(0, 160)})\n${error.message}`;
      throw error;
    }
  }
  return actual;
}

/* ---------- scripted building blocks ---------- */

const SID_A = "a1b2c3d4e5f60718";
const SID_B = "0f1e2d3c4b5a6978";

function open(script, sid, t, { first = false } = {}) {
  script.rx(t, { v: 2, t: "HELLO", sid, seq: 1 });
  const challenge = script.lastReplies.find(r => r.t === "CHALLENGE");
  script.rx(t + 10, { v: 2, t: "ARM", sid, seq: 2, dn: challenge.dn });
  const ack = script.lastReplies[0];
  const session = { sid, seq: 2, ackSeq: 2, tok: ack.tok };
  if (first) stop(script, session, t + 20);
  return session;
}

function absorb(session, ack) {
  if (ack && ack.ok && ack.tok !== null && ack.tok !== undefined) {
    session.ackSeq = ack.seq;
    session.tok = ack.tok;
  }
}

function stop(script, session, t) {
  session.seq += 1;
  script.rx(t, { v: 2, t: "CMD", sid: session.sid, seq: session.seq, cmd: "STOP" });
  absorb(session, script.lastReplies.at(-1));
}

function move(script, session, t, cmd, did, { age = 30, lease = 600 } = {}) {
  session.seq += 1;
  script.rx(t, {
    v: 2, t: "CMD", sid: session.sid, seq: session.seq, cmd, did, age, lease,
    tok: session.tok, ackSeq: session.ackSeq
  });
  const ack = script.lastReplies.at(-1);
  absorb(session, ack);
  return ack;
}

const status = (lines) => lines.at(-1).status;

/* ---------- scripted scenarios ---------- */

test("C1 handshake, first STOP, movement, STOP", { skip: skip() }, () => {
  const s = new Script(11);
  const a = open(s, SID_A, 1000, { first: true });
  move(s, a, 1100, "FORWARD", 1);
  move(s, a, 1220, "LEFT", 2);
  stop(s, a, 1300);
  s.tick(1400);
  const out = conform(s, "C1");
  assert.equal(status(out).motor, "STOP");
  assert.equal(status(out).state, "IDLE");
});

test("C2 handshake rules: DUP_ARM, BAD_NONCE, BUSY, challenge TTL and table eviction, DEAD_SESSION", { skip: skip() }, () => {
  const s = new Script(12);
  const a = open(s, SID_A, 1000, { first: true });
  s.rx(1050, { v: 2, t: "ARM", sid: SID_A, seq: 2, dn: 5 });                       // DUP_ARM
  s.rx(1060, { v: 2, t: "HELLO", sid: SID_B, seq: 1 });
  s.rx(1070, { v: 2, t: "ARM", sid: SID_B, seq: 2, dn: 1 });                       // BUSY
  s.rx(1080, { v: 2, t: "HELLO", sid: "1111222233334444", seq: 1 });
  s.rx(1085, { v: 2, t: "HELLO", sid: "1111222233334444", seq: 1 });                // idempotent nonce
  for (let i = 0; i < 12; i += 1) s.rx(1100 + i, { v: 2, t: "HELLO", sid: `00000000000000${(16 + i).toString(16)}`, seq: 1 });
  s.rx(1200, { v: 2, t: "ARM", sid: "1111222233334444", seq: 2, dn: 1 });          // evicted: BAD_NONCE
  s.rx(1210, { v: 2, t: "ARM", sid: "ffffffffffffffff", seq: 2, dn: 1 });          // unknown sid
  s.rx(1220, { v: 2, t: "BYE", sid: SID_A, seq: a.seq + 1 });                       // LATCHED(BYE), dead ring
  s.rx(1230, { v: 2, t: "HELLO", sid: SID_A, seq: 1 });                             // DEAD_SESSION
  s.rx(1240, { v: 2, t: "ARM", sid: SID_A, seq: 2, dn: 1 });                        // DEAD_SESSION
  s.rx(1250, { v: 2, t: "HELLO", sid: SID_B, seq: 1 });
  s.rx(1260 + 2100, { v: 2, t: "ARM", sid: SID_B, seq: 2, dn: 1 });                 // TTL expired
  const out = conform(s, "C2");
  assert.equal(status(out).state, "LATCHED");
});

test("C3 every CMD rejection reason, in the fixed order", { skip: skip() }, () => {
  const s = new Script(13);
  const a = open(s, SID_A, 1000, { first: true });
  const t0 = 1100;
  move(s, a, t0, "FORWARD", 1);
  move(s, a, t0 + 50, "FORWARD", 2);                                  // RATE_LIMITED
  a.seq -= 0;
  s.rx(t0 + 200, { v: 2, t: "CMD", sid: SID_A, seq: a.seq, cmd: "FORWARD", did: 3, age: 10, lease: 500, tok: a.tok, ackSeq: a.ackSeq }); // OUT_OF_ORDER
  s.rx(t0 + 210, { v: 2, t: "CMD", sid: SID_A, seq: a.seq + 40, cmd: "FORWARD", did: 3, age: 10, lease: 500, tok: a.tok, ackSeq: a.ackSeq }); // SEQ_JUMP
  s.rx(t0 + 220, { v: 2, t: "CMD", sid: SID_B, seq: a.seq + 1, cmd: "FORWARD", did: 3, age: 10, lease: 500, tok: a.tok, ackSeq: a.ackSeq }); // WRONG_SESSION
  move(s, { ...a, tok: 12345 }, t0 + 230, "FORWARD", 3);              // BAD_TOKEN (tok)
  a.seq += 1;
  s.rx(t0 + 240, { v: 2, t: "CMD", sid: SID_A, seq: a.seq, cmd: "FORWARD", did: 3, age: 10, lease: 500, tok: a.tok, ackSeq: a.seq }); // ackSeq not earlier
  move(s, a, t0 + 250, "FORWARD", 3, { age: 451 });                   // DETECTION_TOO_OLD
  move(s, a, t0 + 260, "FORWARD", 1);                                 // STALE_DID
  move(s, a, t0 + 270, "SPIN", 3);                                    // INVALID_COMMAND
  move(s, a, t0 + 280, "FORWARD", 3, { lease: 701 });                 // MALFORMED
  move(s, a, t0 + 290, "FORWARD", 3, { age: -1 });                    // MALFORMED
  move(s, a, t0 + 300, "FORWARD", 3, { age: 450.5 });                 // MALFORMED (not integer)
  s.tick(t0 + 900);                                                   // token now older than 500 ms
  move(s, a, t0 + 901, "FORWARD", 4);                                 // PROOF_STALE or latched, whichever the mock says
  s.rx(t0 + 910, { v: 3, t: "CMD", sid: SID_A, seq: a.seq + 1, cmd: "STOP" });
  s.rx(t0 + 920, { v: 2, t: "CMD", sid: SID_A, seq: "9", cmd: "FORWARD" });
  conform(s, "C3");

  // PROOF_STALE: an old (still ringed) token cited more than 500 ms after it was issued.
  const p = new Script(26);
  const b = open(p, SID_A, 1000, { first: true });
  const old = { ackSeq: b.ackSeq, tok: b.tok };
  stop(p, b, 1250);
  stop(p, b, 1500);
  stop(p, b, 1700);
  p.rx(1720, { v: 2, t: "CMD", sid: SID_A, seq: b.seq + 1, cmd: "FORWARD", did: 1, age: 10, lease: 500, tok: old.tok, ackSeq: old.ackSeq });
  const out = conform(p, "C3b");
  assert.equal(p.lastReplies.at(-1).reason, "PROOF_STALE");
  assert.equal(status(out).state, "IDLE");
});

test("C4 age 450 is accepted, 451 is not; did equal to the last needs an unexpired lease (EXPIRED)", { skip: skip() }, () => {
  const s = new Script(14);
  const a = open(s, SID_A, 1000, { first: true });
  assert.equal(move(s, a, 1060, "FORWARD", 1, { age: 451, lease: 700 })?.reason, "DETECTION_TOO_OLD");
  assert.equal(move(s, a, 1100, "FORWARD", 1, { age: 450, lease: 700 })?.ok, true);
  assert.equal(move(s, a, 1220, "FORWARD", 1, { age: 20, lease: 700 })?.ok, true);     // same did, lease still valid
  for (let t = 1400; t <= 2000; t += 200) stop(s, a, t);                                // keepalives while the lease runs out
  assert.equal(move(s, a, 2120, "FORWARD", 1)?.reason, "EXPIRED");                     // same did, lease over
  assert.equal(move(s, a, 2240, "FORWARD", 2)?.ok, true);
  assert.equal(move(s, a, 2400, "FORWARD", 5)?.ok, true);
  assert.equal(move(s, a, 2520, "FORWARD", 3)?.reason, "STALE_DID");
  conform(s, "C4");
});

test("C5 movement watchdog and session liveness are independent: each latches by itself", { skip: skip() }, () => {
  // W1: MOVING, then silence. The watchdog (600 ms) expires first and latches WATCHDOG.
  const w1 = new Script(15);
  const a = open(w1, SID_A, 1000, { first: true });
  move(w1, a, 1030, "FORWARD", 1, { age: 0, lease: 700 });   // remain 690 ms: the lease outlives the watchdog
  for (let t = 1080; t <= 1750; t += 50) w1.tick(t);
  const o1 = conform(w1, "C5-W1");
  assert.equal(status(o1).state, "LATCHED");
  assert.equal(status(o1).latchReason, "WATCHDOG");
  assert.equal(status(o1).events.some(e => e.type === "IDLE_TIMEOUT"), false, "no second latch for the same instant");

  // W2: IDLE with only STOP keepalives: liveness stays alive, the watchdog never arms.
  const w2 = new Script(16);
  const b = open(w2, SID_A, 1000, { first: true });
  for (let t = 1200; t <= 3000; t += 200) stop(w2, b, t);
  const o2a = conform(w2, "C5-W2a");
  assert.equal(status(o2a).state, "IDLE", "STOP keepalives keep the session but never arm or renew the watchdog");
  assert.equal(status(o2a).events.length, 0);

  // W3: the keepalives stop: session liveness latches IDLE_TIMEOUT (no watchdog involved).
  const w3 = new Script(17);
  const c = open(w3, SID_A, 1000, { first: true });
  stop(w3, c, 1200);
  for (let t = 1250; t <= 1900; t += 50) w3.tick(t);
  const o3 = conform(w3, "C5-W3");
  assert.equal(status(o3).latchReason, "IDLE_TIMEOUT");
  assert.equal(status(o3).counters.watchdogLatches, 0);

  // W4: a movement CMD renews BOTH timers; STOP renews only liveness.
  const w4 = new Script(18);
  const d = open(w4, SID_A, 1000, { first: true });
  move(w4, d, 1030, "FORWARD", 1, { age: 0, lease: 700 });
  stop(w4, d, 1500);                                  // renews liveness, not the (now disarmed) watchdog
  move(w4, d, 1520, "FORWARD", 2, { age: 0, lease: 700 });   // arms the watchdog again
  for (let t = 1570; t <= 2250; t += 50) w4.tick(t);
  const o4 = conform(w4, "C5-W4");
  assert.equal(status(o4).state, "LATCHED");
  assert.equal(status(o4).latchReason, "WATCHDOG");
});

test("C6 lease expiry stops the motor, returns to IDLE and does NOT latch; a newer did is required", { skip: skip() }, () => {
  const s = new Script(19);
  const a = open(s, SID_A, 1000, { first: true });
  move(s, a, 1100, "FORWARD", 1, { age: 100, lease: 150 });
  s.tick(1200);
  s.tick(1300);
  stop(s, a, 1310);
  move(s, a, 1430, "FORWARD", 1);                      // same did after STOP: EXPIRED
  move(s, a, 1550, "FORWARD", 2);
  const out = conform(s, "C6");
  assert.equal(status(out).state, "MOVING");
  assert.equal(status(out).counters.leaseExpiries, 1);
  assert.equal(status(out).counters.idleTimeouts, 0);
});

test("C7 ESTOP: latch, stale ESTOP ignored, malformed ESTOP latches without a session, only a new ARM releases", { skip: skip() }, () => {
  const s = new Script(20);
  const a = open(s, SID_A, 1000, { first: true });
  move(s, a, 1100, "FORWARD", 1);
  s.rx(1150, { v: 2, t: "ESTOP", sid: SID_A });
  s.rx(1160, { v: 2, t: "ESTOP", sid: SID_A });                              // dead sid: ignored
  s.rx(1170, { v: 2, t: "CMD", sid: SID_A, seq: a.seq + 1, cmd: "FORWARD" });  // LATCHED/DEAD_SESSION
  const b = open(s, SID_B, 1200);
  move(s, b, 1300, "RIGHT", 1);
  s.rx(1350, { v: 2, t: "ESTOP", sid: "nonsense" });                           // malformed: latch, no session change
  s.rx(1360, { v: 1, t: "ESTOP", sid: SID_B });                                // malformed (v)
  s.rx(1370, { t: "ESTOP" });
  open(s, "9999888877776666", 1500);
  const out = conform(s, "C7");
  assert.equal(status(out).state, "IDLE", "a new valid ARM leaves the latch");
});

test("C8 STOP semantics: any recognizable STOP stops the motor first; carried by another message type it is only that safety action", { skip: skip() }, () => {
  const s = new Script(21);
  const a = open(s, SID_A, 1000, { first: true });
  move(s, a, 1100, "FORWARD", 1);
  s.rx(1150, { v: 9, t: "HELLO", sid: "bad", seq: 7, cmd: "STOP" });             // F1: stops, no reply
  move(s, a, 1300, "FORWARD", 2);
  s.rx(1350, { t: "CMD", cmd: "STOP" });                                         // malformed STOP: applied, no reply
  move(s, a, 1500, "FORWARD", 3);
  s.rx(1550, { v: 2, t: "ARM", sid: SID_B, seq: 2, dn: 1, cmd: "STOP" });         // cannot arm
  s.rx(1560, { v: 2, t: "BYE", sid: SID_A, seq: a.seq + 1, cmd: "STOP" });        // cannot latch BYE
  s.rx(1570, { v: 2, t: "ESTOP", sid: SID_A, cmd: "STOP" });                      // cannot ESTOP
  s.rx(1580, { v: 2, t: "CMD", sid: SID_B, seq: 5, cmd: "STOP" });                // wrong session STOP: applied, rejected
  const out = conform(s, "C8");
  assert.equal(status(out).state, "IDLE");
  assert.equal(status(out).session, SID_A, "none of the carried STOPs created, armed or ended a session");
});

test("C9 BYE: valid, wrong session, seq window", { skip: skip() }, () => {
  const s = new Script(22);
  const a = open(s, SID_A, 1000, { first: true });
  s.rx(1100, { v: 2, t: "BYE", sid: SID_B, seq: a.seq + 1 });
  s.rx(1110, { v: 2, t: "BYE", sid: SID_A, seq: a.seq });                         // OUT_OF_ORDER
  s.rx(1120, { v: 2, t: "BYE", sid: SID_A, seq: a.seq + 99 });                    // SEQ_JUMP
  s.rx(1130, { v: 2, t: "BYE", sid: SID_A, seq: 0 });                              // ignored (not a seq)
  s.rx(1140, { v: 2, t: "BYE", sid: SID_A, seq: a.seq + 1 });
  s.rx(1150, { v: 2, t: "BYE", sid: SID_A, seq: a.seq + 2 });                     // DEAD_SESSION
  conform(s, "C9");
});

test("C10 token ring holds 8: an evicted token is BAD_TOKEN; dead ring holds 8", { skip: skip() }, () => {
  const s = new Script(23);
  const a = open(s, SID_A, 1000, { first: true });
  const first = { ackSeq: a.ackSeq, tok: a.tok };
  for (let i = 0; i < 12; i += 1) stop(s, a, 1100 + i * 10);
  s.rx(1300, { v: 2, t: "CMD", sid: SID_A, seq: a.seq + 1, cmd: "FORWARD", did: 1, age: 10, lease: 500, tok: first.tok, ackSeq: first.ackSeq });
  for (let i = 0; i < 12; i += 1) {
    const sid = `abcdef01234567${(16 + i).toString(16)}`;
    open(s, sid, 2000 + i * 100);
    s.rx(2050 + i * 100, { v: 2, t: "ESTOP", sid });
  }
  s.rx(4000, { v: 2, t: "HELLO", sid: "abcdef0123456710", seq: 1 });              // oldest dead sid was evicted (8-entry ring)
  conform(s, "C10");
});

test("C11 clock rules: null and NaN ignored, time never goes backwards", { skip: skip() }, () => {
  const s = new Script(24);
  const a = open(s, SID_A, 1000, { first: true });
  s.tick(null);
  s.rx(null, { v: 2, t: "CMD", sid: SID_A, seq: a.seq + 1, cmd: "STOP" });
  s.tick(900);                                                                    // backwards: clamped
  s.rx(500, { v: 2, t: "CMD", sid: SID_A, seq: a.seq + 1, cmd: "STOP" });
  s.tick(5000);
  const out = conform(s, "C11");
  assert.equal(status(out).state, "LATCHED");
});

test("C12 JSON handling: escapes, duplicate keys, nesting, invalid text, non-object values", { skip: skip() }, () => {
  const s = new Script(25);
  s.rxRaw(100, '{"v":2,"t":"HELLO","sid":"\\u0061\\u0031b2c3d4e5f60718","seq":1}');       // escaped sid
  s.rxRaw(110, '{"v":2,"t":"HELLO","sid":"a1b2c3d4e5f60718","sid":"0f1e2d3c4b5a6978","seq":1}'); // last key wins
  s.rxRaw(120, '{"v":2,"t":"HELLO","sid":"a1b2c3d4e5f60718","seq":1,"extra":{"a":[1,2,{"b":null}],"c":"x"}}');
  s.rxRaw(130, '{"v":2.0,"t":"HELLO","sid":"a1b2c3d4e5f60718","seq":1e0}');                 // integers in other notation
  s.rxRaw(140, '{"v":"2","t":"HELLO","sid":"a1b2c3d4e5f60718","seq":1}');                   // wrong type
  s.rxRaw(150, '{"v":2,"t":"HELLO","sid":"A1B2C3D4E5F60718","seq":1}');                     // uppercase is not hex16
  s.rxRaw(160, "not json");
  s.rxRaw(170, '{"v":2,"t":"HELLO"');                                                      // truncated
  s.rxRaw(180, "null");
  s.rxRaw(190, "42");
  s.rxRaw(200, '"text"');
  s.rxRaw(210, "true");
  s.rxRaw(220, "[1,2,3]");                                                                 // array: clock and timers still run
  s.rxRaw(230, "{}");
  s.rxRaw(240, '{"v":2,"t":"HELLO","sid":"a1b2c3d4e5f60718","seq":1} trailing');
  s.rxRaw(250, '  {"v":2,"t":"HELLO","sid":"a1b2c3d4e5f60718","seq":1}  ');
  conform(s, "C12");
});

/* ---------- seeded fuzz ---------- */

function fuzz(seed, steps) {
  const s = new Script(seed);
  const next = lcg(seed * 7919 + 13);
  const pick = list => list[next() % list.length];
  const chance = percent => next() % 100 < percent;

  const sids = [
    SID_A, SID_B, "1111222233334444", "2222333344445555", "deadbeefcafef00d", "0123456789abcdef",
    "fedcba9876543210", "a0a0a0a0a0a0a0a0", "b1b1b1b1b1b1b1b1", "c2c2c2c2c2c2c2c2",
    "d3d3d3d3d3d3d3d3", "e4e4e4e4e4e4e4e4", "bad", "ZZZZZZZZZZZZZZZZ"
  ];
  const cmds = ["STOP", "FORWARD", "LEFT", "RIGHT", "FORWARD", "FORWARD", "SPIN", "stop"];

  const challenges = new Map();
  let activeSid = SID_A;
  let seq = 2;
  let tok = 0;
  let ackSeq = 2;
  let did = 0;
  let t = 1000;

  const noteReply = replies => {
    for (const r of replies) {
      if (r.t === "CHALLENGE") challenges.set(r.sid, r.dn);
      if (r.t === "ACK" && r.ok && r.tok !== null) {
        if (r.sid === activeSid) { tok = r.tok; ackSeq = r.seq; }
        if (r.seq === 2) { activeSid = r.sid; seq = 2; did = 0; }
      }
    }
  };

  for (let i = 0; i < steps; i += 1) {
    const dt = pick([0, 5, 10, 25, 50, 100, 120, 200, 300, 450, 650, 900, 2500]);
    t += chance(3) ? -dt : dt + (chance(10) ? 0.5 : 0);
    const roll = next() % 100;

    if (roll < 8) {
      s.tick(chance(5) ? null : t);
    } else if (roll < 18) {
      s.rx(t, { v: 2, t: "HELLO", sid: pick(sids), seq: chance(90) ? 1 : 2 });
      noteReply(s.lastReplies);
    } else if (roll < 28) {
      const sid = pick(sids);
      s.rx(t, { v: 2, t: "ARM", sid, seq: 2, dn: chance(80) && challenges.has(sid) ? challenges.get(sid) : next() % 1000 });
      noteReply(s.lastReplies);
    } else if (roll < 45) {
      seq += pick([1, 1, 1, 1, 2, 0, -1, 40]);
      s.rx(t, { v: 2, t: "CMD", sid: chance(92) ? activeSid : pick(sids), seq, cmd: "STOP" });
      noteReply(s.lastReplies);
    } else if (roll < 80) {
      seq += pick([1, 1, 1, 1, 1, 2, 0, 40]);
      did += pick([0, 1, 1, 1, 2, -1]);
      const body = {
        v: 2, t: "CMD", sid: chance(95) ? activeSid : pick(sids), seq, cmd: pick(cmds),
        did: Math.max(1, did), age: pick([0, 10, 30, 100, 449, 450, 451, 700, 701, -1, 20.5]),
        lease: pick([0, 40, 60, 150, 300, 600, 700, 701]),
        tok: chance(88) ? tok : next() % 100000,
        ackSeq: chance(90) ? ackSeq : pick([1, 2, 3, seq, seq + 1])
      };
      if (chance(5)) delete body[pick(["did", "age", "lease", "tok", "ackSeq", "cmd"])];
      s.rx(t, body);
      noteReply(s.lastReplies);
    } else if (roll < 86) {
      s.rx(t, chance(70) ? { v: 2, t: "ESTOP", sid: chance(80) ? activeSid : pick(sids) } : { t: "ESTOP" });
    } else if (roll < 92) {
      seq += pick([1, 1, 2, 0, 50]);
      s.rx(t, { v: 2, t: "BYE", sid: chance(85) ? activeSid : pick(sids), seq });
    } else if (roll < 96) {
      s.rx(t, { v: pick([1, 2, 3, "2"]), t: pick(["HELLO", "ARM", "CMD", "BYE", "ESTOP", "NOPE"]), sid: pick(sids), seq: pick([1, 2, 3]), cmd: "STOP" });
    } else {
      s.rxRaw(t, pick(["null", "[]", "{}", "garbage", "7", '{"cmd":"STOP"}', '{"t":"CMD","cmd":"STOP","sid":"x"}']));
    }
  }
  return s;
}

test("C13 seeded fuzz: 60 random sequences x 250 steps, every reply and every state equal", { skip: skip() }, () => {
  let steps = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    const script = fuzz(seed, 250);
    steps += script.steps.length;
    conform(script, `fuzz seed ${seed}`);
  }
  assert.equal(steps, 15000);
});

test("C14 coverage: every ACK reason and device event of the mock was exercised and matched", { skip: skip() }, () => {
  const reasons = [
    "OK", "DUP_ARM", "BAD_NONCE", "BUSY", "DEAD_SESSION", "WRONG_SESSION", "LATCHED",
    "OUT_OF_ORDER", "SEQ_JUMP", "RATE_LIMITED", "INVALID_COMMAND", "MALFORMED", "BAD_TOKEN",
    "PROOF_STALE", "DETECTION_TOO_OLD", "STALE_DID", "EXPIRED"
  ];
  for (const reason of reasons) assert.ok(seenReasons.has(reason), `reason ${reason} was never exercised`);
  for (const type of ["WATCHDOG", "LEASE_EXPIRED", "IDLE_TIMEOUT", "ESTOP", "BYE"]) {
    assert.ok(seenEvents.has(type), `event ${type} was never exercised`);
  }
});
