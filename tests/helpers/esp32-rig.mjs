/*
 * Shared test rig for the ESP32 link and mock (protocol v2).
 * Everything is in memory with simulated clocks: no timers, no network.
 *
 *   createRig()     app link <-> simulated wire <-> mock device. The app and
 *                   the device have INDEPENDENT monotonic clocks: the device
 *                   clock is the app clock plus an offset (default 10000) and
 *                   an optional skew, so a test that wrongly compared the two
 *                   would fail. Latency, loss, duplication and reordering are
 *                   controllable per direction.
 *   connected()     a rig that has finished HELLO/CHALLENGE/ARM and the first STOP
 *   createDevice()  the mock alone: hand-built v2 messages that carry the
 *                   latest device-issued token automatically. Times passed to
 *                   it are DEVICE time.
 *
 * Random sources are seeded so every run is identical.
 */

import assert from "node:assert/strict";

import { createEsp32Link, LINK_STATE } from "../../js/esp32-link.js";
import { createMockEsp32 } from "../../js/mock-esp32.js";

export const STEP = 50;
export const DEVICE_OFFSET = 10000;

export const SID_A = "a1b2c3d4e5f60718";
export const SID_B = "0f1e2d3c4b5a6978";
export const SID_C = "1111222233334444";
export const SID_D = "deadbeefcafef00d";

/* A small seeded generator (LCG). */
export function seededRandom(seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return {
    u32: next,
    fill(bytes) {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = next() >>> 24;
      return bytes;
    }
  };
}

export function isHex16(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/* The parts of the device state that an invalid STOP or RATE_LIMITED must never change. */
export function frozenState(status) {
  return JSON.stringify({
    state: status.state,
    latchReason: status.latchReason,
    session: status.session,
    lastSeq: status.lastSeq,
    ring: status.ring,
    deadRing: status.deadRing,
    lastDid: status.lastDid,
    lastLiveAt: status.lastLiveAt,
    lastMoveAcceptedAt: status.lastMoveAcceptedAt
  });
}

/*
 * A simulated wire between the link and the mock, with controllable latency,
 * loss, duplication and a log of everything sent.
 */
export function createRig(linkOptions = {}, mockOptions = {}, rigOptions = {}) {

  const appRandom = seededRandom(rigOptions.appSeed ?? 11);
  const deviceRandom = seededRandom(rigOptions.deviceSeed ?? 22);

  const rig = {
    now: 0,                                   // app clock
    deviceOffset: rigOptions.deviceOffset ?? DEVICE_OFFSET,
    skewPpm: rigOptions.skewPpm ?? 0,         // device clock rate error
    latency: 0,                               // both directions
    latencyToDevice: undefined,               // number or (message) => ms
    latencyToApp: undefined,
    dropToDevice: false,
    dropToApp: false,
    dropWhen: null,                           // (direction, message) => boolean
    duplicate: null,                          // (direction, message) => extra copies
    toDevice: [],                             // every message the app sent
    sendLog: [],                              // { at (app clock), message } for each
    toApp: [],                                // every message the device sent
    inFlight: [],
    order: 0
  };

  rig.deviceNow = () => Math.round(rig.deviceOffset + rig.now * (1 + rig.skewPpm / 1e6));

  function delayFor(direction, message) {
    const spec = direction === "device" ? rig.latencyToDevice : rig.latencyToApp;
    if (typeof spec === "function") return spec(message);
    return spec ?? rig.latency;
  }

  function enqueue(direction, message) {
    const log = direction === "device" ? rig.toDevice : rig.toApp;
    log.push(message);
    if (direction === "device") rig.sendLog.push({ at: rig.now, message });
    const dropped = (direction === "device" ? rig.dropToDevice : rig.dropToApp) ||
      (rig.dropWhen && rig.dropWhen(direction, message));
    if (dropped) return;
    const copies = 1 + (rig.duplicate ? rig.duplicate(direction, message) : 0);
    for (let i = 0; i < copies; i += 1) {
      rig.inFlight.push({
        to: direction, at: rig.now + delayFor(direction, message),
        message: { ...message }, order: rig.order++
      });
    }
  }

  rig.mock = createMockEsp32({
    random32: deviceRandom.u32,
    ...mockOptions,
    reply: message => enqueue("app", message)
  });

  rig.link = createEsp32Link({
    randomValues: appRandom.fill,
    ...linkOptions,
    transport: { send: message => enqueue("device", message) }
  });

  function deliverDue() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = rig.inFlight
        .filter(item => item.at <= rig.now)
        .sort((a, b) => a.at - b.at || a.order - b.order);
      rig.inFlight = rig.inFlight.filter(item => item.at > rig.now);
      for (const item of due) {
        progressed = true;
        if (item.to === "device") rig.mock.receive(item.message, rig.deviceNow());
        else rig.link.receive(item.message, rig.now);
      }
    }
  }

  rig.step = () => {
    rig.now += STEP;
    deliverDue();
    rig.link.tick(rig.now);
    deliverDue();
    rig.mock.tick(rig.deviceNow());
  };

  rig.run = ms => {
    for (let t = 0; t < ms; t += STEP) rig.step();
  };

  /* A decision whose detection happened `ageMs` ago (on the app clock). */
  rig.decide = (command, ageMs = 0) => {
    rig.link.setDecision(command, rig.now, rig.now - ageMs);
  };

  /* Like run(), with a fresh detection every 250 ms (as the camera would give). */
  rig.follow = (command, ms) => {
    for (let t = 0; t < ms; t += STEP) {
      if (t % 250 === 0) rig.decide(command, 0);
      rig.step();
    }
  };

  rig.deliver = deliverDue;
  rig.motor = () => rig.mock.getStatus().motor;
  rig.cmds = () => rig.toDevice.filter(m => m.t === "CMD");
  rig.movement = () => rig.toDevice.filter(m => m.t === "CMD" && m.cmd !== "STOP");
  rig.state = () => rig.link.getStatus(rig.now).state;

  return rig;
}

export function connected(linkOptions, mockOptions, rigOptions) {
  const rig = createRig(linkOptions, mockOptions, rigOptions);
  rig.link.connect(rig.now);
  rig.deliver();
  rig.run(100);
  assert.ok(
    [LINK_STATE.IDLE, LINK_STATE.FOLLOWING].includes(rig.state()),
    `expected an established link, got ${rig.state()}`
  );
  return rig;
}

/*
 * The mock on its own. Builds well-formed v2 messages with the latest
 * device-issued token and increasing seq numbers; every field can be
 * overridden to build a bad message. An explicit seq does not move the
 * automatic counter. All times are DEVICE time.
 */
export function createDevice(mockOptions = {}) {

  const random = seededRandom(mockOptions.seed ?? 7);

  const device = {
    replies: [], sid: SID_A, seq: 0, token: null, dn: null
  };

  device.mock = createMockEsp32({
    random32: random.u32,
    ...mockOptions,
    reply: message => {
      device.replies.push(message);
      if (message.t === "CHALLENGE") device.dn = message.dn;
      if (message.t === "ACK" && message.ok && Number.isInteger(message.tok)) {
        device.token = { tok: message.tok, ackSeq: message.seq };
      }
    }
  });

  device.send = (message, now) => device.mock.receive(message, now);

  device.hello = (now, o = {}) => {
    const sid = o.sid ?? device.sid;
    device.send({ v: 2, t: "HELLO", sid, seq: o.seq ?? 1 }, now);
  };

  device.arm = (now, o = {}) => {
    const sid = o.sid ?? device.sid;
    if (o.sid !== undefined) device.sid = sid;
    device.send({ v: 2, t: "ARM", sid, seq: o.seq ?? 2, dn: o.dn ?? device.dn }, now);
    if (device.last()?.t === "ACK" && device.last().ok && device.last().sid === sid) device.seq = 2;
  };

  /* HELLO then ARM at the same device time: an IDLE session with a first token. */
  device.armed = (now = 0, o = {}) => {
    if (o.sid !== undefined) device.sid = o.sid;
    device.hello(now);
    device.arm(now);
    return device;
  };

  device.cmd = (cmd, now, o = {}) => {
    const seq = o.seq ?? ++device.seq;
    const message = { v: o.v ?? 2, t: "CMD", sid: o.sid ?? device.sid, seq, cmd };
    if (cmd !== "STOP") {
      const age = o.age ?? 0;
      message.did = o.did ?? 1;
      message.age = age;
      message.lease = o.lease ?? Math.max(0, 700 - age);
      message.tok = o.tok ?? device.token?.tok;
      message.ackSeq = o.ackSeq ?? device.token?.ackSeq;
    }
    device.send({ ...message, ...(o.raw ?? {}) }, now);
  };

  device.stop = (now, o = {}) => device.cmd("STOP", now, o);
  device.estop = (now, o = {}) => device.send({ v: o.v ?? 2, t: "ESTOP", sid: o.sid ?? device.sid, ...(o.raw ?? {}) }, now);
  device.bye = (now, o = {}) => device.send({ v: 2, t: "BYE", sid: o.sid ?? device.sid, seq: o.seq ?? ++device.seq }, now);

  device.last = () => device.replies.at(-1);
  device.status = () => device.mock.getStatus();
  device.motor = () => device.mock.getStatus().motor;

  return device;
}

/*
 * The link on its own, with hand-built device replies and explicit app-clock
 * times. Used for gate boundaries, ACK correlation, BUSY and timeouts where
 * the exact instant of every packet matters.
 */
export function createAppHarness(linkOptions = {}) {

  const random = seededRandom(linkOptions.seed ?? 5);

  const h = { sent: [], now: 0, epoch: 7, dn: 111, tokenCount: 1000, failSend: false };

  h.link = createEsp32Link({
    randomValues: random.fill,
    ...linkOptions,
    transport: {
      send(message) {
        if (h.failSend) throw new Error("socket closed");
        h.sent.push({ ...message });
      }
    }
  });

  h.status = () => h.link.getStatus(h.now);
  h.sid = () => h.status().session;
  h.cmds = () => h.sent.filter(m => m.t === "CMD");
  h.movement = () => h.sent.filter(m => m.t === "CMD" && m.cmd !== "STOP");
  h.last = () => h.sent.at(-1);

  h.ackFor = (seq, o = {}) => {
    const ok = o.ok ?? true;
    return {
      v: 2, t: "ACK", sid: o.sid ?? h.sid(), seq, ok, reason: o.reason ?? null,
      st: o.st ?? "IDLE", motor: o.motor ?? "STOP",
      tok: o.tok === undefined ? (ok ? ++h.tokenCount : null) : o.tok,
      epoch: o.epoch ?? h.epoch, expIn: 0
    };
  };

  h.receive = (message, now) => { h.now = now; h.link.receive(message, now); };
  h.ack = (seq, now, o) => h.receive(h.ackFor(seq, o), now);
  h.challenge = (now, o = {}) => h.receive({
    v: 2, t: "CHALLENGE", sid: o.sid ?? h.sid(), dn: o.dn ?? h.dn, epoch: o.epoch ?? h.epoch
  }, now);
  h.tick = now => { h.now = now; h.link.tick(now); };
  h.decide = (command, now, detectionTime) => {
    h.now = now;
    h.link.setDecision(command, now, detectionTime === undefined ? now : detectionTime);
  };

  /*
   * connect() at `at`; the device answers with a round trip of `rtt` ms for
   * each of HELLO, ARM and the first STOP. Returns the time of the last reply.
   */
  h.handshake = (at = 0, rtt = 0) => {
    h.now = at;
    h.link.connect(at);
    h.challenge(at + rtt);
    h.ack(2, at + 2 * rtt);
    h.ack(3, at + 3 * rtt);
    return at + 3 * rtt;
  };

  return h;
}
