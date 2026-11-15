/*
 * Mock ESP32 (Phase 2A.1, protocol v2): an in-memory stand-in for the
 * real device. It drives no hardware and opens no network connection;
 * "motor" is just a value you can inspect. It is separate from any real
 * transport: the caller feeds it messages and a timestamp.
 *
 *   mock.receive(message, now)   a message arrived from the app
 *   mock.tick(now)               call often; runs the timers
 *   mock.getStatus()             copy of the device state
 *
 * Replies go to reply(message). `now` is the DEVICE's own monotonic clock
 * in ms. It is clamped so it can never go backwards (nowD). The device
 * never compares its clock with the app's clock.
 *
 * SECURITY SCOPE: prototype protocol 1A makes NO hostile-LAN claim. There
 * is no authentication, no shared secret and no HMAC. The random sid, the
 * device-issued tokens and the challenge nonce give REPLAY and STALE-PACKET
 * protection only. Anyone on the same network can read them and forge
 * messages, including ESTOP.
 *
 * AGE CLAIM: the device CANNOT independently verify how old a detection
 * really was. `age` is a claim made by the app. The device range-checks it
 * (age <= 450) and measures, on its own clock, how old the device-issued
 * token is when the CMD arrives (proofAge). The movement lease is
 *   remain = min(lease, 700 - age - proofAge)
 * proofAge covers the token's return trip, the time the app held it and the
 * CMD's trip to the device, so it is never smaller than the CMD's network
 * transit. Delayed packets therefore shrink the lease instead of extending
 * it. detectionLatencyMs in the app is a placeholder (0); camera and
 * inference latency are NOT included until measured on the real phone.
 *
 * Wire messages (v must be 2; there is no v1 movement compatibility):
 *   HELLO     { v, t:"HELLO", sid, seq:1 }
 *   ARM       { v, t:"ARM", sid, seq:2, dn }
 *   CMD       { v, t:"CMD", sid, seq, cmd, did, age, lease, tok, ackSeq }
 *             (cmd:"STOP" needs only v, t, sid, seq, cmd)
 *   ESTOP     { v, t:"ESTOP", sid }
 *   BYE       { v, t:"BYE", sid, seq }
 *   CHALLENGE { v, t:"CHALLENGE", sid, dn, epoch }
 *   ACK       { v, t:"ACK", sid, seq, ok, reason, st, motor, tok, epoch, expIn }
 * sid is 16 lowercase hex characters (64 bits, random, chosen by the app).
 * An ACK echoes the request seq; the token it carries is bound to
 * (sid, ackSeq = that seq, tok) and is cited by the next CMD.
 *
 * States: BOOT_LATCHED -> IDLE <-> MOVING -> LATCHED. Only a valid ARM
 * (challenge nonce) leaves a latched state. A second session gets BUSY
 * while the active one is fresh; there is no takeover.
 *
 * Timers (K1, all on the device clock, boundaries are "greater than"):
 *   - Movement watchdog 600 ms. Armed ONLY while MOVING. Renewed ONLY by an
 *     accepted movement CMD. STOP never renews it. Expiry latches
 *     LATCHED(WATCHDOG).
 *   - Movement lease. nowD >= expiry while MOVING: motor STOP, back to
 *     IDLE, did invalidated, NO latch; a newer detection (new did) is
 *     required.
 *   - Session liveness 600 ms. Renewed ONLY by a successful ARM and by a
 *     valid in-window STOP or accepted movement CMD of the active session.
 *     Expiry latches LATCHED(IDLE_TIMEOUT) and the sid goes to the dead ring.
 *   - Order at every message and tick: watchdog, then lease, then session.
 *     When watchdog and session expire at the same instant the watchdog
 *     latches (reason WATCHDOG) and the session expiry is then idempotent:
 *     no second latch transition and no IDLE_TIMEOUT event.
 *
 * STOP and did (K2):
 *   - Any object whose cmd is exactly "STOP" stops the motor at once and
 *     sets expiryDid = min(expiryDid, nowD), whatever its v, sid or seq. It
 *     changes nothing else (session, lastSeq, token ring, timers, latch)
 *     unless it is a valid in-window STOP of the active session, which also
 *     renews session liveness, consumes its seq and issues a token. A
 *     malformed STOP gets no ACK; a well-formed STOP that fails the checks
 *     gets ok:false.
 *   - The same did never resumes after a STOP (expiryDid <= nowD). Movement
 *     needs a new, higher did and a valid CMD.
 *
 * ESTOP / BYE:
 *   - A valid ESTOP (v 2, sid hex16, sid not dead) stops and latches
 *     LATCHED(ESTOP) and dead-rings the active sid. A stale ESTOP (dead
 *     sid) is ignored. A MALFORMED ESTOP is fail-safe: it stops and latches
 *     LATCHED(ESTOP) but creates or changes no session (the active sid is
 *     not dead-ringed). ESTOP gets no reply.
 *   - BYE is honoured only from the ACTIVE sid with an in-window seq
 *     (LATCHED(BYE), ACK ok). A malformed BYE is ignored.
 *
 * RATE_LIMITED: a movement CMD less than minMoveIntervalMs after the last
 * accepted movement CMD is rejected with no state change at all (no seq, no
 * token, no timer, no permission) and no hint.
 */

export const MOCK_COMMANDS = Object.freeze(["STOP", "FORWARD", "LEFT", "RIGHT"]);

const MOVES = new Set(["FORWARD", "LEFT", "RIGHT"]);
const SEQ_MAX = 0xFFFFFFFF;

export const MOCK_DEFAULTS = Object.freeze({
  protocolVersion: 2,
  movementWatchdogMs: 600,
  sessionLivenessMs: 600,
  ageClaimMaxMs: 450,
  proofMaxMs: 500,
  minRemainMs: 50,
  evidenceMaxMs: 700,
  challengeTtlMs: 2000,
  tokenRingSize: 8,
  deadRingSize: 8,
  challengeTableSize: 8,
  seqWindow: 32,
  minMoveIntervalMs: 100
});

export const DEVICE_STATE = Object.freeze({
  BOOT_LATCHED: "BOOT_LATCHED",
  IDLE: "IDLE",
  MOVING: "MOVING",
  LATCHED: "LATCHED"
});

function defaultRandom32() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("a secure random source is required (crypto.getRandomValues)");
  }
  return c.getRandomValues(new Uint32Array(1))[0];
}

const isHex16 = value => typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
const isUint32 = value => Number.isInteger(value) && value >= 0 && value <= SEQ_MAX;
const isSeq = value => Number.isInteger(value) && value >= 1 && value <= SEQ_MAX;

export function createMockEsp32({ reply, random32, ...options } = {}) {

  const config = { ...MOCK_DEFAULTS, ...options };
  const send = typeof reply === "function" ? reply : () => {};
  const rand = typeof random32 === "function" ? random32 : defaultRandom32;
  const epoch = rand();

  let lastNow = -Infinity;       // device monotonic clock, clamped
  let motor = "STOP";
  let state = DEVICE_STATE.BOOT_LATCHED;
  let latchReason = "BOOT";
  let sid = null;                // active session id
  let lastSeq = 0;
  let ring = [];                 // issued tokens { sid, ackSeq, tok, issuedAt }
  let deadRing = [];             // terminated session ids
  const challenges = new Map();  // sid -> { dn, issuedAt }
  let lastLiveAt = null;         // session liveness timer
  let lastMoveAcceptedAt = null; // movement watchdog timer / rate limit base
  let lastDid = 0;
  let expiryDid = null;          // device time until which lastDid may move
  let sessionLivenessExpired = false;
  let lastStopReason = "BOOT";
  let lastReject = null;

  const counters = {
    accepted: 0, rejected: 0, stops: 0, watchdogLatches: 0, leaseExpiries: 0,
    idleTimeouts: 0, rateLimited: 0, estops: 0, byes: 0
  };
  const motorLog = [];           // every motor change: { at, command, reason }
  const events = [];             // WATCHDOG, LEASE_EXPIRED, IDLE_TIMEOUT, ...

  function setMotor(command, nowD, reason) {
    if (motor !== command) {
      motor = command;
      motorLog.push({ at: nowD, command, reason });
      if (command === "STOP") lastStopReason = reason;
    }
  }

  function event(type, nowD, extra = {}) {
    events.push({ at: nowD, type, ...extra });
  }

  function stateName() {
    if (state === DEVICE_STATE.MOVING) return "MOVING";
    if (state === DEVICE_STATE.IDLE) return "IDLE";
    return "LATCHED";
  }

  function addDead(value) {
    if (!value || deadRing.includes(value)) return;   // idempotent
    deadRing.push(value);
    if (deadRing.length > config.deadRingSize) deadRing.shift();
  }

  function invalidateDid(nowD) {
    if (expiryDid !== null) expiryDid = Math.min(expiryDid, nowD);
  }

  /* Terminates the active session; only a new ARM can leave LATCHED. */
  function latch(reason, nowD) {
    setMotor("STOP", nowD, reason);
    state = DEVICE_STATE.LATCHED;
    latchReason = reason;
    addDead(sid);
    sid = null;
    ring = [];
    lastDid = 0;
    expiryDid = null;
    lastSeq = 0;
    lastLiveAt = null;
    lastMoveAcceptedAt = null;
  }

  function answer(message, ok, reason, extra = {}) {

    if (!ok) {
      counters.rejected += 1;
      lastReject = { reason, seq: message.seq };
    }

    send({
      v: config.protocolVersion,
      t: "ACK",
      sid: message.sid,
      seq: message.seq,
      ok,
      reason: reason ?? null,
      st: stateName(),
      motor,
      tok: extra.tok ?? null,
      epoch,
      expIn: extra.expIn ?? 0
    });
  }

  function issueToken(nowD, ackSeq) {
    const tok = rand();
    ring.push({ sid, ackSeq, tok, issuedAt: nowD });
    if (ring.length > config.tokenRingSize) ring.shift();
    return tok;
  }

  /*
   * Both timers and the lease, in the approved order: watchdog, lease,
   * session liveness. Called before every message and from tick().
   */
  function housekeeping(nowD) {

    const sessionActive = state === DEVICE_STATE.IDLE || state === DEVICE_STATE.MOVING;
    const liveExpired = sessionActive && nowD - lastLiveAt > config.sessionLivenessMs;
    let watchdogLatched = false;

    if (state === DEVICE_STATE.MOVING) {

      if (nowD - lastMoveAcceptedAt > config.movementWatchdogMs) {
        event("WATCHDOG", nowD);
        counters.watchdogLatches += 1;
        latch("WATCHDOG", nowD);
        watchdogLatched = true;
        // Session expiry at the same instant is idempotent: the latch above
        // already terminated the session and dead-ringed the sid once.
        if (liveExpired) sessionLivenessExpired = true;
      } else if (expiryDid !== null && nowD >= expiryDid) {
        // Lease expiry: stop, back to IDLE, did invalidated, no latch.
        event("LEASE_EXPIRED", nowD);
        counters.leaseExpiries += 1;
        setMotor("STOP", nowD, "LEASE_EXPIRED");
        state = DEVICE_STATE.IDLE;
        invalidateDid(nowD);
      }
    }

    if (!watchdogLatched && liveExpired) {
      event("IDLE_TIMEOUT", nowD);
      counters.idleTimeouts += 1;
      latch("IDLE_TIMEOUT", nowD);
    }
  }

  /* An ordinary STOP: stop and invalidate the did, nothing else. */
  function applyStop(nowD) {
    counters.stops += 1;
    setMotor("STOP", nowD, "STOP");
    if (state === DEVICE_STATE.MOVING) state = DEVICE_STATE.IDLE;
    invalidateDid(nowD);
  }

  function handleHello(message, nowD) {

    if (message.v !== config.protocolVersion || !isHex16(message.sid) || message.seq !== 1) return;

    if (deadRing.includes(message.sid)) {
      answer(message, false, "DEAD_SESSION");
      return;
    }

    let entry = challenges.get(message.sid);

    if (!entry || nowD - entry.issuedAt > config.challengeTtlMs) {
      entry = { dn: rand(), issuedAt: nowD };
      challenges.delete(message.sid);
      challenges.set(message.sid, entry);
      while (challenges.size > config.challengeTableSize) {
        challenges.delete(challenges.keys().next().value);
      }
    }

    // Idempotent: the same sid inside the TTL always gets the same nonce.
    send({
      v: config.protocolVersion,
      t: "CHALLENGE",
      sid: message.sid,
      dn: entry.dn,
      epoch
    });
  }

  function handleArm(message, nowD) {

    if (
      message.v !== config.protocolVersion || !isHex16(message.sid) ||
      message.seq !== 2 || !isUint32(message.dn)
    ) return;

    if (deadRing.includes(message.sid)) {
      answer(message, false, "DEAD_SESSION");
      return;
    }

    const active = state === DEVICE_STATE.IDLE || state === DEVICE_STATE.MOVING;

    if (active && message.sid === sid) {
      // Duplicate ARM: repeat the ARM token; renews nothing, changes nothing.
      const entry = ring.find(item => item.ackSeq === 2);
      answer(message, true, "DUP_ARM", { tok: entry ? entry.tok : null });
      return;
    }

    if (active) {
      // The active session is fresh (housekeeping already latched a stale
      // one): no takeover.
      answer(message, false, "BUSY");
      return;
    }

    const entry = challenges.get(message.sid);
    if (!entry || nowD - entry.issuedAt > config.challengeTtlMs || entry.dn !== message.dn) {
      answer(message, false, "BAD_NONCE");
      return;
    }

    challenges.delete(message.sid);

    sid = message.sid;
    state = DEVICE_STATE.IDLE;
    latchReason = null;
    lastSeq = 2;
    ring = [];
    lastLiveAt = nowD;
    lastMoveAcceptedAt = null;
    lastDid = 0;
    expiryDid = null;
    sessionLivenessExpired = false;
    counters.accepted += 1;
    setMotor("STOP", nowD, "SESSION_START");
    answer(message, true, null, { tok: issueToken(nowD, 2) });
  }

  function handleEstop(message, nowD) {

    const wellFormed = message.v === config.protocolVersion && isHex16(message.sid);

    if (wellFormed && deadRing.includes(message.sid)) return;   // stale ESTOP

    counters.estops += 1;
    event("ESTOP", nowD, { malformed: !wellFormed });

    if (state === DEVICE_STATE.LATCHED || state === DEVICE_STATE.BOOT_LATCHED) {
      setMotor("STOP", nowD, "ESTOP");
      return;
    }

    if (wellFormed) {
      latch("ESTOP", nowD);
      return;
    }

    // Malformed: stop and latch, but create or change no session.
    setMotor("STOP", nowD, "ESTOP");
    invalidateDid(nowD);
    state = DEVICE_STATE.LATCHED;
    latchReason = "ESTOP";
  }

  function handleBye(message, nowD) {

    if (message.v !== config.protocolVersion || !isHex16(message.sid) || !isSeq(message.seq)) return;

    const active = state === DEVICE_STATE.IDLE || state === DEVICE_STATE.MOVING;

    if (!active || message.sid !== sid) {
      answer(message, false, deadRing.includes(message.sid) ? "DEAD_SESSION" : "WRONG_SESSION");
      return;
    }

    const d = (message.seq - lastSeq) >>> 0;
    if (d < 1 || d > config.seqWindow) {
      answer(message, false, d === 0 || d > 0x80000000 ? "OUT_OF_ORDER" : "SEQ_JUMP");
      return;
    }

    counters.byes += 1;
    event("BYE", nowD);
    latch("BYE", nowD);
    answer(message, true, null);
  }

  /* The approved fixed CMD validation order (steps 2 to 15, plus the rate limit). */
  function handleCmd(message, nowD, isStop) {

    // Step 2: schema. A malformed STOP was already applied and gets no reply.
    if (
      message.v !== config.protocolVersion || !isHex16(message.sid) ||
      !isSeq(message.seq) || typeof message.cmd !== "string"
    ) return;

    // Step 3: session.
    const active = state === DEVICE_STATE.IDLE || state === DEVICE_STATE.MOVING;
    if (!active) {
      answer(message, false, deadRing.includes(message.sid) ? "DEAD_SESSION" : "LATCHED");
      return;
    }
    if (message.sid !== sid) {
      answer(message, false, deadRing.includes(message.sid) ? "DEAD_SESSION" : "WRONG_SESSION");
      return;
    }

    // Step 4: sequence window.
    const d = (message.seq - lastSeq) >>> 0;
    if (d < 1 || d > config.seqWindow) {
      answer(message, false, d === 0 || d > 0x80000000 ? "OUT_OF_ORDER" : "SEQ_JUMP");
      return;
    }

    // Step 4b: movement CMD rate limit. Mutates nothing.
    if (
      MOVES.has(message.cmd) && lastMoveAcceptedAt !== null &&
      nowD - lastMoveAcceptedAt < config.minMoveIntervalMs
    ) {
      counters.rateLimited += 1;
      answer(message, false, "RATE_LIMITED");
      return;
    }

    // Step 5: consume the sequence number.
    const previousSeq = lastSeq;
    lastSeq = message.seq;

    // Step 6: a valid STOP renews session liveness only and issues a token.
    if (isStop) {
      lastLiveAt = nowD;
      counters.accepted += 1;
      answer(message, true, null, { tok: issueToken(nowD, message.seq) });
      return;
    }

    const reject = reason => {
      setMotor("STOP", nowD, reason);
      if (state === DEVICE_STATE.MOVING) state = DEVICE_STATE.IDLE;
      answer(message, false, reason);
    };

    // Step 7.
    if (!MOVES.has(message.cmd)) return reject("INVALID_COMMAND");

    // Step 8.
    if (
      !isSeq(message.did) || !isSeq(message.ackSeq) || !isUint32(message.tok) ||
      !Number.isInteger(message.age) || message.age < 0 || message.age > config.evidenceMaxMs ||
      !Number.isInteger(message.lease) || message.lease < 0 || message.lease > config.evidenceMaxMs
    ) return reject("MALFORMED");

    // Steps 9 and 10: the token must exist (not evicted) and be bound to
    // this sid, ackSeq and tok, and to an earlier sequence number.
    const entry = ring.find(item =>
      item.sid === message.sid && item.ackSeq === message.ackSeq && item.tok === message.tok);
    if (!entry || !(message.ackSeq < message.seq) || !(message.ackSeq <= previousSeq)) {
      return reject("BAD_TOKEN");
    }

    // Step 11: proof age on the device clock.
    const proofAge = nowD - entry.issuedAt;
    if (proofAge > config.proofMaxMs) return reject("PROOF_STALE");

    // Step 12: range check of the claimed age (not a verification).
    if (message.age > config.ageClaimMaxMs) return reject("DETECTION_TOO_OLD");

    // Step 13: did.
    if (message.did < lastDid) return reject("STALE_DID");
    if (message.did === lastDid && (expiryDid === null || nowD >= expiryDid)) {
      return reject("EXPIRED");
    }

    // Step 14: lease.
    let remain = Math.min(message.lease, config.evidenceMaxMs - message.age - proofAge);
    if (message.did === lastDid) remain = Math.min(remain, expiryDid - nowD);
    if (remain < config.minRemainMs) return reject("EXPIRED");

    // Step 15: accept.
    lastDid = message.did;
    expiryDid = nowD + remain;               // never above the previous cap
    lastMoveAcceptedAt = nowD;               // movement watchdog
    lastLiveAt = nowD;                       // session liveness
    state = DEVICE_STATE.MOVING;
    counters.accepted += 1;
    setMotor(message.cmd, nowD, "COMMAND");
    answer(message, true, null, { tok: issueToken(nowD, message.seq), expIn: remain });
  }

  function clock(now) {
    if (!Number.isFinite(now)) return null;
    lastNow = Math.max(lastNow, now);        // never goes backwards
    return lastNow;
  }

  return {

    receive(message, now) {

      if (!message || typeof message !== "object") return;

      const nowD = clock(now);
      if (nowD === null) return;

      housekeeping(nowD);

      // A recognizable ordinary STOP is applied first, whatever else is
      // wrong with it (K2 / Q15).
      const isStop = message.cmd === "STOP";
      if (isStop) {
        applyStop(nowD);
        // F1: a STOP carried by any other message type is only that safety
        // action. It is never dispatched, so it cannot arm, latch BYE or ESTOP,
        // create a session or get a reply.
        if (message.t !== "CMD") return;
      }

      switch (message.t) {
        case "HELLO": handleHello(message, nowD); break;
        case "ARM": handleArm(message, nowD); break;
        case "ESTOP": handleEstop(message, nowD); break;
        case "BYE": handleBye(message, nowD); break;
        case "CMD": handleCmd(message, nowD, isStop); break;
        default: break;
      }
    },

    tick(now) {
      const nowD = clock(now);
      if (nowD !== null) housekeeping(nowD);
    },

    getStatus() {
      return {
        motor,
        state,
        latchReason,
        session: sid,
        lastSeq,
        ring: ring.map(entry => ({ ...entry })),
        deadRing: [...deadRing],
        lastDid,
        expiryDid,
        lastLiveAt,
        lastMoveAcceptedAt,
        sessionLivenessExpired,
        lastStopReason,
        lastReject,
        epoch,
        counters: { ...counters },
        motorLog: motorLog.map(entry => ({ ...entry })),
        events: events.map(entry => ({ ...entry }))
      };
    }
  };
}
