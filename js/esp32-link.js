/*
 * ESP32 link layer (Phase 2A.1, protocol v2): app side.
 *
 * Transport-independent and pure: no DOM, no timers, no sockets. The caller
 * gives it a transport ({ send(message) }) and drives it with explicit
 * timestamps from the APP's own monotonic clock (for example
 * performance.now()):
 *
 *   link.connect(now)                          start a session (HELLO)
 *   link.setDecision(cmd, now, detectionTime)  latest motion command
 *   link.tick(now)                             call often (e.g. every 50 ms)
 *   link.receive(message, now)                 feed every message from the device
 *   link.emergencyStop(now) / clearEmergency(now)
 *   link.suspend(now) / resume(now)            page hidden / visible
 *   link.disconnect(now)
 *
 * The caller passes the ORIGINAL detection time of a movement decision
 * (same clock as `now`). The link never stamps it at call time. A movement
 * decision without a valid detection time is sent as STOP.
 *
 * SECURITY SCOPE: prototype protocol 1A makes NO hostile-LAN claim. There
 * is no authentication, no shared secret and no HMAC. The random sid and the
 * device-issued tokens protect against replay and stale or cross-session
 * packets only; anyone on the same network can forge messages.
 *
 * AGE CLAIM: `age` in a CMD is the app's CLAIM of how old the detection is.
 * The device cannot independently verify it; it range-checks it (<= 450)
 * and measures the token's age on its own clock (proofAge). detectionLatencyMs
 * (default 0) is a PLACEHOLDER for the camera-to-decision delay and MUST be
 * measured on the real phone before it is relied on.
 *
 * Wire messages: see js/mock-esp32.js. v is always 2. sid is 16 lowercase hex
 * characters (64 random bits from crypto.getRandomValues, or an injected
 * source; there is no Math.random fallback).
 *
 * App states: DISCONNECTED, HELLO_SENT, ARM_SENT, IDLE, FOLLOWING. A RESYNC
 * is a transition, not a resting state: STOP (if established), drop the
 * decision and tokens, new sid, HELLO.
 *
 * Movement is sent only when ALL gates pass (otherwise STOP):
 *   age <= 450, rttEst <= 300, proofEst <= 500, remainEst >= 75,
 *   a token and an RTT sample exist, a valid ok:true ACK arrived within
 *   600 ms, the clock is sane, the detection is newer than the last STOP,
 *   not emergency, not recovering from a content reject.
 * where (all on the app clock, no synchronized clocks)
 *   age       = ceil(sendNow - detectionTime + detectionLatencyMs)
 *   hold      = sendNow - receive time of the token's ACK
 *   rttEst    = max of the last 3 measured request/ACK round trips
 *   proofEst  = hold + rttEst            (an ESTIMATE; the device's own
 *                                         proofAge is the authority)
 *   remainEst = 700 - age - proofEst
 *
 * Detection time and did: did increases by 1 when the detection time moves
 * forward by more than 1 ms. It going back by more than 1 ms is
 * EVIDENCE_REGRESSED (STOP). Sending any STOP consumes the current
 * detection: movement needs a detection more than 1 ms newer. This also
 * holds across a RESYNC.
 *
 * Timeouts (all "greater than"): handshake 600 ms without a valid reply
 * (a valid CHALLENGE refreshes it); established link 600 ms without a
 * newer valid ok:true ACK. An ok:false ACK never refreshes the link timeout.
 *
 * BUSY: a correlated BUSY (reply to ARM) means another session is fresh.
 * The first BUSY starts a 2000 ms wait measured on the app clock; ARM is
 * retried every 200 ms with the same nonce. Each BUSY refreshes only the
 * handshake deadline. At elapsed >= 2000 ms (or 600 ms of silence after a
 * BUSY) the link goes DISCONNECTED with lastError "DEVICE_BUSY". It never
 * creates a new sid by itself while BUSY and never retries automatically:
 * the caller must call connect() again.
 *
 * RATE_LIMITED from the device: not retransmitted, no STOP, no RESYNC; the
 * next movement CMD waits at least 100 ms from the reply.
 */

export const LINK_COMMAND = Object.freeze({
  STOP: "STOP",
  FORWARD: "FORWARD",
  LEFT: "LEFT",
  RIGHT: "RIGHT"
});

export const LINK_STATE = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  HELLO_SENT: "HELLO_SENT",
  ARM_SENT: "ARM_SENT",
  IDLE: "IDLE",
  FOLLOWING: "FOLLOWING"
});

export const STOP_REASON = Object.freeze({
  EMERGENCY: "EMERGENCY",
  NOT_CONNECTED: "NOT_CONNECTED",
  CLOCK_FAULT: "CLOCK_FAULT",
  RECOVERING: "RECOVERING",
  NO_DECISION: "NO_DECISION",
  DECISION_STOP: "DECISION_STOP",
  NO_DETECTION_TIME: "NO_DETECTION_TIME",
  EVIDENCE_REGRESSED: "EVIDENCE_REGRESSED",
  DETECTION_CONSUMED: "DETECTION_CONSUMED",
  STALE_DECISION: "STALE_DECISION",
  NO_TOKEN: "NO_TOKEN",
  NO_RTT: "NO_RTT",
  RTT_GATE: "RTT_GATE",
  PROOF_EST_STALE: "PROOF_EST_STALE",
  LEASE_TOO_SHORT: "LEASE_TOO_SHORT",
  LINK_STALE: "LINK_STALE",
  FOLLOWING: "FOLLOWING" // not a stop: the decision is being sent
});

export const PROTOCOL_VERSION = 2;

export const LINK_DEFAULTS = Object.freeze({
  heartbeatMs: 200,          // resend the current command at least this often
  helloRetryMs: 200,
  busyRetryMs: 200,
  busyMaxMs: 2000,
  handshakeTimeoutMs: 600,
  linkTimeoutMs: 600,
  minMoveIntervalMs: 100,    // minimum gap between movement CMDs
  ageClaimMaxMs: 450,
  rttGateMs: 300,
  proofEstMaxMs: 500,
  remainEstMinMs: 75,
  evidenceMaxMs: 700,
  pendingMax: 8,
  pendingTtlMs: 600,
  seqRejectLimit: 3,
  detectionLatencyMs: 0      // PLACEHOLDER: measure on the real phone
});

const COMMANDS = new Set(Object.values(LINK_COMMAND));

// Content rejects: send STOP, wait for a fresh token and a newer detection.
const CONTENT_REJECT = new Set(["BAD_TOKEN", "PROOF_STALE", "EXPIRED", "DETECTION_TOO_OLD"]);
// (LATCHED, WRONG_SESSION, DEAD_SESSION, STALE_DID, MALFORMED,
// INVALID_COMMAND, NO_SESSION and any unknown reason all RESYNC at once.)
const SEQ_REJECT = new Set(["OUT_OF_ORDER", "SEQ_JUMP"]);

const isUint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF;

function defaultRandomValues() {
  const c = globalThis.crypto;
  return c && typeof c.getRandomValues === "function"
    ? array => c.getRandomValues(array)
    : null;
}

export function createEsp32Link({ transport, randomValues, ...options } = {}) {

  if (!transport || typeof transport.send !== "function") {
    throw new TypeError("transport.send(message) is required");
  }

  const fill = typeof randomValues === "function" ? randomValues : defaultRandomValues();
  if (!fill) {
    // Fail closed: no Math.random fallback for the session id.
    throw new TypeError("a secure random source is required (crypto.getRandomValues)");
  }

  const config = { ...LINK_DEFAULTS, ...options };

  let state = LINK_STATE.DISCONNECTED;
  let wanted = false;           // connect() called and not disconnected
  let resumable = false;        // suspended while wanted
  let session = null;           // 16 hex characters
  let lastSession = null;
  let seq = 0;

  // handshake
  let challengeDn = null;
  let deviceEpoch = null;
  let helloFirstAt = null;
  let helloLastAt = null;
  let helloSends = 0;
  let armLastAt = null;
  let armSends = 0;
  let handshakeRefreshAt = null;
  let busyStart = null;

  // established session
  let pending = [];             // { type, seq, sentAt, cmd, sends }
  let lastAckSeq = 0;
  let token = null;             // { ackSeq, tok, rxAt }
  let lastOkAckAt = null;
  let rtts = [];                // last 3 round trips (ms)
  let seqRejects = 0;
  let recoveryFromSeq = null;   // STOP seq that starts a content-reject recovery

  // decision and evidence
  let decision = null;          // { command, detectionTime, did, invalid }
  let didCounter = 0;
  let lastDetection = null;
  let consumedDetection = null; // a detection <= this (+1 ms) can never move
  let emergency = false;
  let lastEstopAt = null;

  // sending
  let lastSentAt = null;
  let lastSentCommand = null;
  let lastSentDid = 0;
  let lastMoveSentAt = null;
  let nextMoveAt = null;

  let lastNow = null;
  let clockFault = false;
  let lastDeviceMotor = null;
  let lastReject = null;
  let lastError = null;
  let lastDisconnectReason = null;
  let lastResyncReason = null;
  let lastStopReason = null;
  let lastEffectiveReason = null;     // why the last evaluation sent or held what it did

  const counters = {
    sent: 0, received: 0, rejected: 0, resyncs: 0, timeouts: 0, busy: 0,
    rateLimited: 0, clockFaults: 0, sendFailures: 0, dropped: 0
  };

  // How many times each STOP reason was ENTERED while the link was established (a change of the reason,
  // not every evaluation). Diagnostics only: shows which gate makes the luggage stop-and-go.
  const stopEntries = {};

  const established = () => state === LINK_STATE.IDLE || state === LINK_STATE.FOLLOWING;

  function newSid() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const bytes = new Uint8Array(8);
      fill(bytes);
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      if (hex !== lastSession && hex !== "0000000000000000") return hex;
    }
    throw new Error("secure random source returned a repeated or empty session id");
  }

  function rttEst() {
    return rtts.length ? Math.max(...rtts) : null;
  }

  function addRtt(sample) {
    if (!Number.isFinite(sample) || sample < 0) return;
    rtts.push(sample);
    if (rtts.length > 3) rtts.shift();
  }

  function prunePending(now) {
    pending = pending.filter(entry => now - entry.sentAt <= config.pendingTtlMs);
  }

  function addPending(entry, now) {
    prunePending(now);
    pending.push(entry);
    while (pending.length > config.pendingMax) {
      pending.shift();
      counters.dropped += 1;
    }
  }

  /* Returns true only if the transport accepted the message (Gap G). */
  function post(message) {
    try {
      transport.send(message);
      counters.sent += 1;
      return true;
    } catch (error) {
      // A failing transport must never throw into the caller; nothing is
      // recorded as sent, so the next tick tries again.
      counters.sendFailures += 1;
      lastReject = { reason: "TRANSPORT_ERROR", seq: message.seq };
      return false;
    }
  }

  function clock(now) {
    if (!Number.isFinite(now) || (lastNow !== null && now < lastNow)) {
      counters.clockFaults += 1;
      clockFault = true;
      return false;
    }
    lastNow = now;
    return true;
  }

  /*
   * F2: time for the safety actions (ESTOP, STOP+BYE on suspend/disconnect)
   * that must still run when the supplied clock is invalid. An invalid reading
   * is still counted as a clock fault and never becomes the new baseline; the
   * last good time is used for local bookkeeping only.
   */
  function safetyTime(now) {
    return clock(now) ? now : (lastNow ?? 0);
  }

  /*
   * The request is registered BEFORE it is posted, so a transport that
   * answers synchronously (as the tests' two-tab wire does) is correlated.
   * A failed send removes the entry again.
   */
  function postRequest(message, entry, now) {
    addPending(entry, now);
    if (post(message)) return true;
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    return false;
  }

  /* ---------- sending ---------- */

  function sendStop(now, reason) {

    seq += 1;
    const entry = { type: "CMD", seq, sentAt: now, cmd: "STOP", sends: 1 };
    const ok = postRequest({ v: PROTOCOL_VERSION, t: "CMD", sid: session, seq, cmd: "STOP" }, entry, now);
    if (!ok) return false;

    lastStopReason = reason ?? null;
    lastSentAt = now;
    lastSentCommand = "STOP";
    lastSentDid = didCounter;

    // Sending any STOP consumes the current detection.
    if (lastDetection !== null) consumedDetection = lastDetection;
    if (recoveryFromSeq !== null && recoveryFromSeq === 0) recoveryFromSeq = seq;
    if (state === LINK_STATE.FOLLOWING) state = LINK_STATE.IDLE;
    return true;
  }

  function sendBye(now) {
    seq += 1;
    post({ v: PROTOCOL_VERSION, t: "BYE", sid: session, seq });
  }

  function sendMovement(eff, now) {

    seq += 1;
    const entry = { type: "CMD", seq, sentAt: now, cmd: eff.command, sends: 1 };
    const ok = postRequest({
      v: PROTOCOL_VERSION,
      t: "CMD",
      sid: session,
      seq,
      cmd: eff.command,
      did: eff.did,
      age: eff.age,
      lease: eff.lease,
      tok: eff.tok,
      ackSeq: eff.ackSeq
    }, entry, now);
    if (!ok) return false;

    lastSentAt = now;
    lastSentCommand = eff.command;
    lastSentDid = eff.did;
    lastMoveSentAt = now;
    if (state === LINK_STATE.IDLE) state = LINK_STATE.FOLLOWING;
    return true;
  }

  function sendHello(now) {
    const first = helloSends === 0;
    helloSends += 1;
    if (first) helloFirstAt = now;
    const message = { v: PROTOCOL_VERSION, t: "HELLO", sid: session, seq: 1 };
    const sent = first
      ? postRequest(message, { type: "HELLO", seq: 1, sentAt: now, cmd: null, sends: 1 }, now)
      : post(message);
    if (sent) helloLastAt = now;
  }

  function sendArm(now) {
    armSends += 1;
    seq = 2;                                    // HELLO is seq 1, ARM is seq 2
    const message = { v: PROTOCOL_VERSION, t: "ARM", sid: session, seq: 2, dn: challengeDn };
    armLastAt = now;
    // F3: every ARM transmission registers exactly one outstanding request, so
    // at most one reply (one BUSY) can be accepted per transmission. A
    // duplicate or delayed reply finds no entry and is dropped.
    pending = pending.filter(entry => entry.type !== "ARM");
    postRequest(message, { type: "ARM", seq: 2, sentAt: now, cmd: null, sends: armSends }, now);
  }

  /* ---------- sessions ---------- */

  function dropSession() {
    decision = null;
    token = null;
    pending = [];
    lastAckSeq = 0;
    lastOkAckAt = null;
    seqRejects = 0;
    recoveryFromSeq = null;
    didCounter = 0;
    lastDetection = null;
    lastSentAt = null;
    lastSentCommand = null;
    lastSentDid = 0;
    lastMoveSentAt = null;
    nextMoveAt = null;
    challengeDn = null;
    busyStart = null;
    helloSends = 0;
    armSends = 0;
  }

  function startHandshake(now) {
    session = newSid();
    lastSession = session;
    seq = 1;
    state = LINK_STATE.HELLO_SENT;
    handshakeRefreshAt = now;
    sendHello(now);
  }

  function resync(reason, now) {
    counters.resyncs += 1;
    lastResyncReason = reason;
    if (established() && session !== null) sendStop(now, "RESYNC");
    dropSession();
    if (wanted && !emergency) {
      startHandshake(now);
    } else {
      state = LINK_STATE.DISCONNECTED;
    }
  }

  function deviceBusy(reason) {
    lastError = "DEVICE_BUSY";
    lastDisconnectReason = reason;
    wanted = false;
    resumable = false;
    dropSession();
    session = null;
    state = LINK_STATE.DISCONNECTED;
  }

  function release(now) {
    // Tell the device we are leaving: STOP (if established), then BYE.
    if (session !== null && state !== LINK_STATE.DISCONNECTED) {
      if (established()) sendStop(now, "RELEASE");
      if (state !== LINK_STATE.HELLO_SENT) sendBye(now);
    }
  }

  /* ---------- eligibility ---------- */

  function effective(now) {

    const stop = (reason) => ({ command: "STOP", reason });

    if (emergency) return stop(STOP_REASON.EMERGENCY);
    if (!established()) return stop(STOP_REASON.NOT_CONNECTED);
    if (clockFault) return stop(STOP_REASON.CLOCK_FAULT);
    if (recoveryFromSeq !== null) return stop(STOP_REASON.RECOVERING);
    if (!decision) return stop(STOP_REASON.NO_DECISION);
    if (decision.invalid) return stop(decision.invalid);
    if (decision.command === LINK_COMMAND.STOP) return stop(STOP_REASON.DECISION_STOP);

    if (consumedDetection !== null && decision.detectionTime <= consumedDetection + 1) {
      return stop(STOP_REASON.DETECTION_CONSUMED);
    }

    const age = Math.ceil(now - decision.detectionTime + config.detectionLatencyMs);
    if (!Number.isFinite(age) || age < 0 || age > config.ageClaimMaxMs) {
      return stop(STOP_REASON.STALE_DECISION);
    }

    if (!token || token.rxAt === null) return stop(STOP_REASON.NO_TOKEN);

    const rtt = rttEst();
    if (rtt === null) return stop(STOP_REASON.NO_RTT);
    if (rtt > config.rttGateMs) return stop(STOP_REASON.RTT_GATE);

    const hold = now - token.rxAt;
    if (!Number.isFinite(hold) || hold < 0) return stop(STOP_REASON.CLOCK_FAULT);

    const proofEst = hold + rtt;
    if (proofEst > config.proofEstMaxMs) return stop(STOP_REASON.PROOF_EST_STALE);

    const remainEst = config.evidenceMaxMs - age - proofEst;
    if (remainEst < config.remainEstMinMs) return stop(STOP_REASON.LEASE_TOO_SHORT);

    if (lastOkAckAt === null || now - lastOkAckAt > config.linkTimeoutMs) {
      return stop(STOP_REASON.LINK_STALE);
    }

    return {
      command: decision.command,
      reason: STOP_REASON.FOLLOWING,
      did: decision.did,
      age,
      lease: Math.max(0, Math.floor(config.evidenceMaxMs - age)),
      tok: token.tok,
      ackSeq: token.ackSeq,
      proofEst,
      remainEst
    };
  }

  function movementThrottled(now) {
    return (lastMoveSentAt !== null && now - lastMoveSentAt < config.minMoveIntervalMs) ||
      (nextMoveAt !== null && now < nextMoveAt);
  }

  /* Sends what is due. STOP is never delayed; movement waits for the interval. */
  function pump(now) {

    if (!established() || emergency) return;

    const eff = effective(now);
    if (eff.reason !== lastEffectiveReason && eff.command === "STOP") {
      stopEntries[eff.reason] = (stopEntries[eff.reason] ?? 0) + 1;
    }
    lastEffectiveReason = eff.reason;
    const heartbeatDue = lastSentAt === null || now - lastSentAt >= config.heartbeatMs;

    if (eff.command === "STOP") {
      if (lastSentCommand !== "STOP" || heartbeatDue) sendStop(now, eff.reason);
      return;
    }

    const due = lastSentCommand !== eff.command || eff.did !== lastSentDid || heartbeatDue;
    if (due && !movementThrottled(now)) sendMovement(eff, now);
  }

  /* ---------- clock failure ---------- */

  function failClosed() {
    // Fail closed: stop, then start over once time makes sense again.
    clockFault = false;
    if (established() && session !== null) {
      const at = lastNow ?? 0;
      sendStop(at);
      resync("CLOCK_FAULT", at);
    }
  }

  /* ---------- replies ---------- */

  function handleChallenge(message, now) {

    if (state !== LINK_STATE.HELLO_SENT || message.sid !== session) return;
    if (!isUint32(message.dn) || !isUint32(message.epoch)) return;

    const hello = pending.find(entry => entry.type === "HELLO");
    if (hello && helloSends === 1) addRtt(now - hello.sentAt);   // clean sample only
    pending = pending.filter(entry => entry.type !== "HELLO");

    challengeDn = message.dn;
    deviceEpoch = message.epoch;
    handshakeRefreshAt = now;               // a valid CHALLENGE refreshes the handshake
    state = LINK_STATE.ARM_SENT;
    armSends = 0;
    sendArm(now);
  }

  function handleAck(message, now) {

    if (message.sid !== session || session === null) return;
    if (!Number.isInteger(message.seq)) return;

    const index = pending.findIndex(entry => entry.seq === message.seq);
    if (index < 0) return;                       // not an outstanding request
    const entry = pending[index];

    const stateFits =
      (entry.type === "HELLO" && state === LINK_STATE.HELLO_SENT) ||
      (entry.type === "ARM" && state === LINK_STATE.ARM_SENT) ||
      (entry.type === "CMD" && established());
    if (!stateFits) return;

    const ok = message.ok === true;
    // ARM retries all carry seq 2, so an ARM reply is matched by its pending
    // entry alone; every other reply must also be newer than the last one.
    const isNew = entry.type === "ARM" || message.seq > lastAckSeq;

    // RTT sample from a first-time reply to a request sent exactly once.
    // A reordered older reply may still add its sample (it can only raise
    // the maximum, which is conservative).
    if (ok && entry.sends === 1 && (entry.type !== "ARM" || armSends === 1)) {
      addRtt(now - entry.sentAt);
    }
    pending.splice(index, 1);                    // answered: a duplicate is dropped

    if (entry.type === "HELLO") {
      // The only ACK to a HELLO is a rejection (DEAD_SESSION).
      if (!ok) resync(message.reason ?? "UNKNOWN", now);
      return;
    }

    if (!isNew) return;                          // older than one already applied

    if (
      isUint32(message.epoch) && deviceEpoch !== null && message.epoch !== deviceEpoch
    ) {
      resync("EPOCH_CHANGED", now);
      return;
    }

    counters.received += 1;
    if (entry.type !== "ARM" || ok) lastAckSeq = message.seq;

    if (entry.type === "ARM") {
      handleArmAck(message, ok, now);
      return;
    }

    if (ok) {
      if (!isUint32(message.tok)) return;        // no usable token: not a valid ok:true
      token = { ackSeq: message.seq, tok: message.tok, rxAt: now };
      lastOkAckAt = now;                         // only a newer valid ok:true refreshes
      lastDeviceMotor = message.motor ?? null;
      seqRejects = 0;
      if (recoveryFromSeq !== null && entry.cmd === "STOP" && message.seq >= recoveryFromSeq) {
        recoveryFromSeq = null;                  // fresh token after the recovery STOP
      }
      return;
    }

    counters.rejected += 1;
    lastReject = { reason: message.reason ?? "UNKNOWN", seq: message.seq };
    const reason = message.reason;

    if (SEQ_REJECT.has(reason)) {
      seqRejects += 1;
      if (seqRejects >= config.seqRejectLimit) resync(reason, now);
      return;
    }

    if (reason === "RATE_LIMITED") {
      counters.rateLimited += 1;
      nextMoveAt = Math.max(nextMoveAt ?? 0, now + config.minMoveIntervalMs);
      return;                                    // no STOP, no resync, no retransmit
    }

    if (CONTENT_REJECT.has(reason)) {
      // No RESYNC. STOP now, then wait for the STOP's ok:true ACK (a fresh
      // token) and a newer detection.
      recoveryFromSeq = 0;
      sendStop(now, "CONTENT_REJECT");
      return;
    }

    resync(reason ?? "UNKNOWN", now);
  }

  function handleArmAck(message, ok, now) {

    if (ok) {
      if (!isUint32(message.tok)) {
        resync("NO_TOKEN", now);
        return;
      }
      state = LINK_STATE.IDLE;
      token = { ackSeq: message.seq, tok: message.tok, rxAt: now };
      lastOkAckAt = now;
      lastDeviceMotor = message.motor ?? null;
      busyStart = null;
      sendStop(now, "FIRST_STOP");                // the first CMD of a session is STOP
      return;
    }

    counters.rejected += 1;
    lastReject = { reason: message.reason ?? "UNKNOWN", seq: message.seq };

    if (message.reason === "BUSY") {
      counters.busy += 1;
      if (busyStart === null) busyStart = now;
      if (now - busyStart >= config.busyMaxMs) {
        deviceBusy("BUSY_TIMEOUT");
        return;
      }
      // Refreshes the handshake deadline only, never the link timeout. The
      // matching pending entry was consumed, so this transmission cannot be
      // answered by BUSY again; the next retry registers a new one (F3).
      handshakeRefreshAt = now;
      return;
    }

    if (message.reason === "BAD_NONCE") {
      state = LINK_STATE.HELLO_SENT;
      helloSends = 1;                            // not a clean RTT sample any more
      challengeDn = null;
      pending = pending.filter(entry => entry.type !== "ARM");
      sendHello(now);
      pending.push({ type: "HELLO", seq: 1, sentAt: now, cmd: null, sends: 2 });
      return;
    }

    resync(message.reason ?? "UNKNOWN", now);
  }

  /* ---------- public API ---------- */

  const api = {

    /* Starts a session. Always begins in STOP. */
    connect(now) {
      if (!clock(now)) return;
      wanted = true;
      resumable = false;
      lastError = null;
      lastDisconnectReason = null;
      release(now);                              // leave a previous session cleanly
      dropSession();
      startHandshake(now);
    },

    /* Final STOP and BYE, then quiet. Runs even if the clock is invalid (F2). */
    disconnect(now) {
      const at = safetyTime(now);
      release(at);
      wanted = false;
      resumable = false;
      dropSession();
      session = null;
      state = LINK_STATE.DISCONNECTED;
      lastDisconnectReason = "DISCONNECTED_BY_APP";
    },

    /* Page hidden: STOP, BYE, no session. */
    suspend(now) {
      const at = safetyTime(now);                // F2: STOP, then BYE, whatever the clock says
      const wasWanted = wanted;
      release(at);
      dropSession();
      session = null;
      state = LINK_STATE.DISCONNECTED;
      wanted = false;
      resumable = wasWanted;
      lastDisconnectReason = "SUSPENDED";
    },

    /* Page visible again: a brand new handshake with a new sid. */
    resume(now) {
      if (resumable) api.connect(now);
    },

    /*
     * Latest motion command from the decision layer. `detectionTime` is the
     * ORIGINAL time of the detection behind a movement decision, on the same
     * clock as `now`. A movement decision without a valid detection time is
     * STOP. Anything other than the four known commands is STOP.
     */
    setDecision(command, now, detectionTime) {

      if (!clock(now)) return;

      const known = COMMANDS.has(command) ? command : LINK_COMMAND.STOP;

      if (known === LINK_COMMAND.STOP) {
        decision = { command: LINK_COMMAND.STOP, detectionTime: null, did: didCounter, invalid: null };
      } else if (!Number.isFinite(detectionTime) || detectionTime > now) {
        decision = {
          command: LINK_COMMAND.STOP, detectionTime: null, did: didCounter,
          invalid: STOP_REASON.NO_DETECTION_TIME
        };
      } else if (lastDetection !== null && detectionTime < lastDetection - 1) {
        decision = {
          command: LINK_COMMAND.STOP, detectionTime: null, did: didCounter,
          invalid: STOP_REASON.EVIDENCE_REGRESSED
        };
      } else {
        if (lastDetection === null || detectionTime > lastDetection + 1) {
          didCounter += 1;
          lastDetection = detectionTime;
        }
        decision = { command: known, detectionTime: lastDetection, did: didCounter, invalid: null };
      }

      if (established() && !emergency) pump(now);
    },

    /* ESTOP now. Repeated every heartbeat until clearEmergency(). */
    emergencyStop(now) {
      const at = safetyTime(now);                // F2: the latch and ESTOP never wait for a valid clock
      emergency = true;
      decision = null;
      if (session !== null && state !== LINK_STATE.DISCONNECTED) {
        if (post({ v: PROTOCOL_VERSION, t: "ESTOP", sid: session })) lastEstopAt = at;
      }
    },

    /* Releases the overlay and starts over with a new session; no resume by itself. */
    clearEmergency(now) {
      if (!clock(now)) return;
      emergency = false;
      decision = null;
      if (session !== null && state !== LINK_STATE.DISCONNECTED) resync("EMERGENCY_CLEARED", now);
    },

    /* Call often. Timeouts, heartbeats, retries. */
    tick(now) {

      if (!clock(now)) {
        failClosed();
        return;
      }

      if (state === LINK_STATE.DISCONNECTED) return;

      if (emergency) {
        if (session !== null && (lastEstopAt === null || now - lastEstopAt >= config.heartbeatMs)) {
          if (post({ v: PROTOCOL_VERSION, t: "ESTOP", sid: session })) lastEstopAt = now;
        }
        return;
      }

      prunePending(now);

      if (state === LINK_STATE.HELLO_SENT) {
        if (now - handshakeRefreshAt > config.handshakeTimeoutMs) {
          counters.timeouts += 1;
          resync("HANDSHAKE_TIMEOUT", now);
        } else if (now - helloLastAt >= config.helloRetryMs) {
          sendHello(now);                          // same sid
        }
        return;
      }

      if (state === LINK_STATE.ARM_SENT) {

        if (busyStart !== null) {
          if (now - busyStart >= config.busyMaxMs) {
            deviceBusy("BUSY_TIMEOUT");
          } else if (now - handshakeRefreshAt > config.handshakeTimeoutMs) {
            deviceBusy("BUSY_NO_REPLY");           // never a silent new sid during BUSY
          } else if (now - armLastAt >= config.busyRetryMs) {
            sendArm(now);                          // same nonce, same sid
          }
          return;
        }

        if (now - handshakeRefreshAt > config.handshakeTimeoutMs) {
          counters.timeouts += 1;
          resync("HANDSHAKE_TIMEOUT", now);
        } else if (now - armLastAt >= config.helloRetryMs) {
          sendArm(now);
        }
        return;
      }

      if (lastOkAckAt === null || now - lastOkAckAt > config.linkTimeoutMs) {
        counters.timeouts += 1;
        lastDisconnectReason = "LINK_TIMEOUT";
        resync("LINK_TIMEOUT", now);
        return;
      }

      pump(now);
    },

    /* Feed every message that arrives from the device. */
    receive(message, now) {

      if (!message || typeof message !== "object") return;
      if (!clock(now)) {
        failClosed();
        return;
      }
      if (message.v !== PROTOCOL_VERSION || emergency) return;

      prunePending(now);                         // a reply to an old request is dropped

      if (message.t === "CHALLENGE") handleChallenge(message, now);
      else if (message.t === "ACK") handleAck(message, now);
    },

    getStatus(now) {
      const at = now ?? lastNow ?? 0;
      const eff = effective(at);
      return {
        state,
        connected: established(),
        session,
        seq,
        did: didCounter,
        emergency,
        decision: decision ? decision.command : null,
        effective: eff,
        lastSentCommand,
        lastSentAt,
        lastOkAckAt,
        lastAckSeq,
        deviceMotor: lastDeviceMotor,
        rttEst: rttEst(),
        token: token ? { ...token } : null,
        pending: pending.map(entry => ({ ...entry })),
        busyStart,
        consumedDetection,
        nextMoveAt,
        lastReject,
        lastError,
        lastDisconnectReason,
        lastResyncReason,
        lastStopReason,
        lastEffectiveReason,
        counters: { ...counters },
        stopEntries: { ...stopEntries }
      };
    }
  };

  return api;
}
