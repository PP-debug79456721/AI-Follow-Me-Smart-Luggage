/*
 * ESP32 session controller (M0): glue between the pure protocol link
 * (esp32-link.js) and a WebSocket-like transport. It owns NO protocol rules.
 * Every safety rule (STOP, ESTOP, leases, tokens, sessions, the 450 ms age
 * gate, both device-side 600 ms timers' app counterparts) stays in
 * esp32-link.js and is not changed or duplicated here.
 *
 * What this module adds:
 *   - a transport adapter: link.send(message) -> socket.send(JSON text).
 *     It THROWS when the socket is not open (the link counts that as a send
 *     failure) and never buffers. STOP, ESTOP and BYE are always attempted;
 *     a movement CMD is refused while the socket has a send backlog.
 *   - a tick timer that calls link.tick(now) (default every 50 ms).
 *   - a socket generation counter: a message or event from any socket other
 *     than the current one is dropped before it reaches the link.
 *   - reconnect: any socket loss calls link.suspend(now) (STOP, BYE, session
 *     dropped) and, after a backoff, opens a NEW socket and calls
 *     link.connect(now): a new sid, HELLO/CHALLENGE/ARM and a first STOP.
 *   - hidden page: link.suspend, socket closed. Visible: a new socket and a
 *     new session. Nothing resumes by itself.
 *   - an explicit FOLLOW gate. The link always starts in STOP; this gate
 *     keeps movement disabled until the user arms it, and it switches itself
 *     OFF whenever the link leaves the established state, on ESTOP, on a
 *     hidden page and on any socket loss. After a reconnect the user must
 *     arm FOLLOW again, on top of the protocol's own fresh authorization.
 *
 * It does not enable any motor. The only thing it can ask the device for is
 * what the existing decision layer asked, and only through the link.
 *
 * Values marked PROPOSAL are not measured requirements.
 */

import { createEsp32Link, LINK_STATE } from "./esp32-link.js";

export const SESSION_DEFAULTS = Object.freeze({
  tickMs: 50,
  openTimeoutMs: 3000,                          // PROPOSAL
  reconnectBackoffMs: [200, 400, 800, 1600, 2000],   // PROPOSAL
  maxBufferedBytes: 1024,                       // PROPOSAL: movement CMD refused above this
  maxHandshakeFailures: 3                       // PROPOSAL: then the socket is recycled
});

const SOCKET_OPEN = 1;
const SOCKET_NAMES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: id => globalThis.clearInterval(id)
  };
}

export function createEsp32Session({
  createSocket,
  now = () => performance.now(),
  timers = defaultTimers(),
  randomValues,
  linkOptions = {},
  onChange = null,
  ...options
} = {}) {

  if (typeof createSocket !== "function") {
    throw new TypeError("createSocket(url) is required");
  }

  const config = { ...SESSION_DEFAULTS, ...options };

  let socket = null;
  let generation = 0;
  let url = null;
  let desired = false;          // the user pressed CONNECT and not DISCONNECT
  let hidden = false;
  let follow = false;
  let disposed = false;
  let tickTimer = null;
  let reconnectTimer = null;
  let openTimer = null;
  let backoffIndex = 0;
  let handshakeFailures = 0;
  let lastTimeouts = 0;
  let lastEvent = null;

  const stats = {
    socketsOpened: 0,
    socketsLost: 0,
    reconnects: 0,
    staleMessagesDropped: 0,
    badFrames: 0,
    sendRefused: 0
  };

  /* ---------- transport adapter ---------- */

  const transport = {
    send(message) {
      const current = socket;
      if (!current || current.readyState !== SOCKET_OPEN) {
        stats.sendRefused += 1;
        throw new Error("socket is not open");
      }
      const movement = message && message.t === "CMD" && message.cmd !== "STOP";
      if (
        movement && typeof current.bufferedAmount === "number" &&
        current.bufferedAmount > config.maxBufferedBytes
      ) {
        stats.sendRefused += 1;
        throw new Error("socket has a send backlog");
      }
      current.send(JSON.stringify(message));
    }
  };

  const link = createEsp32Link({ transport, randomValues, ...linkOptions });

  /* ---------- helpers ---------- */

  function emit(event) {
    lastEvent = event;
    if (!onChange) return;
    try { onChange(api.getStatus(), event); } catch { /* a failing UI must not touch the link */ }
  }

  function clearTimer(id) {
    if (id !== null) timers.clearTimeout(id);
    return null;
  }

  function emergencyLatched() {
    return link.getStatus(now()).emergency;
  }

  /* FOLLOW is only ever ON while the link is established and no ESTOP is latched. */
  function enforceFollow() {
    if (!follow) return;
    const status = link.getStatus(now());
    if (!status.connected || status.emergency || hidden || !desired) {
      follow = false;
      emit("FOLLOW_OFF");
    }
  }

  function closeSocket() {
    generation += 1;                  // events of the old socket are ignored from now on
    const old = socket;
    socket = null;
    openTimer = clearTimer(openTimer);
    if (old) {
      try { old.close(1000, "app"); } catch { /* already closed */ }
    }
  }

  function scheduleReconnect() {
    if (disposed || !desired || hidden || reconnectTimer !== null) return;
    const list = config.reconnectBackoffMs;
    const delay = list[Math.min(backoffIndex, list.length - 1)];
    backoffIndex += 1;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      stats.reconnects += 1;
      openSocket();
    }, delay);
  }

  /* STOP/BYE first (best effort), then drop the socket, then try again later. */
  function onSocketLost(reason) {
    const t = now();
    link.suspend(t);
    closeSocket();
    stats.socketsLost += 1;
    follow = false;
    emit(`SOCKET_LOST:${reason}`);
    scheduleReconnect();
  }

  function startLink() {
    // A latched ESTOP is never released by a reconnect.
    if (emergencyLatched()) {
      emit("ESTOP_LATCHED_NO_SESSION");
      return;
    }
    link.connect(now());
    emit("LINK_CONNECT");
  }

  function afterLinkActivity() {
    const status = link.getStatus(now());

    if (status.connected) {
      backoffIndex = 0;
      handshakeFailures = 0;
      lastTimeouts = status.counters.timeouts;
    } else if (status.counters.timeouts > lastTimeouts) {
      handshakeFailures += status.counters.timeouts - lastTimeouts;
      lastTimeouts = status.counters.timeouts;
      if (desired && handshakeFailures >= config.maxHandshakeFailures) {
        handshakeFailures = 0;
        onSocketLost("HANDSHAKE_FAILURES");
        return;
      }
    }

    if (status.lastError === "DEVICE_BUSY" && status.state === LINK_STATE.DISCONNECTED && desired) {
      // Another session is fresh. Never retry by itself: the user must press CONNECT again.
      desired = false;
      follow = false;
      closeSocket();
      clearReconnect();
      emit("DEVICE_BUSY");
      return;
    }

    enforceFollow();
  }

  function clearReconnect() {
    reconnectTimer = clearTimer(reconnectTimer);
  }

  /* ---------- sockets ---------- */

  function openSocket() {

    if (disposed || !desired || hidden) return;

    closeSocket();
    clearReconnect();

    const mine = (generation += 1);
    let created;

    try {
      created = createSocket(url);
    } catch (error) {
      emit("SOCKET_CREATE_FAILED");
      scheduleReconnect();
      return;
    }

    socket = created;
    stats.socketsOpened += 1;

    created.addEventListener("open", () => {
      if (mine !== generation) return;
      openTimer = clearTimer(openTimer);
      startLink();
    });

    created.addEventListener("message", event => {
      if (mine !== generation) {
        stats.staleMessagesDropped += 1;      // a message from a socket that is no longer current
        return;
      }
      onFrame(event?.data);
    });

    created.addEventListener("close", () => {
      if (mine !== generation) return;
      onSocketLost("CLOSE");
    });

    created.addEventListener("error", () => {
      if (mine !== generation) return;
      onSocketLost("ERROR");
    });

    // A transport may need longer than a WebSocket to open (Bluetooth: device chooser).
    const openTimeoutMs =
      typeof created.openTimeoutMs === "number" ? created.openTimeoutMs : config.openTimeoutMs;

    openTimer = timers.setTimeout(() => {
      openTimer = null;
      if (mine === generation && created.readyState !== SOCKET_OPEN) onSocketLost("OPEN_TIMEOUT");
    }, openTimeoutMs);
  }

  function onFrame(data) {

    if (typeof data !== "string") {
      stats.badFrames += 1;
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      stats.badFrames += 1;
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      stats.badFrames += 1;
      return;
    }

    // Everything else (wrong sid, unknown seq, stale, duplicate) is the link's job.
    link.receive(message, now());
    afterLinkActivity();
  }

  function startTicking() {
    if (tickTimer !== null) return;
    tickTimer = timers.setInterval(() => {
      link.tick(now());
      afterLinkActivity();
    }, config.tickMs);
  }

  /* ---------- public API ---------- */

  const api = {

    /* CONNECT. Always starts in STOP with FOLLOW off. */
    connect(address) {
      if (disposed) return;
      if (typeof address === "string" && address.trim() !== "") url = address.trim();
      if (!url) {
        emit("NO_URL");
        return;
      }
      desired = true;
      follow = false;
      backoffIndex = 0;
      handshakeFailures = 0;
      lastTimeouts = 0;
      clearReconnect();
      startTicking();
      if (!hidden) openSocket();
      emit("CONNECT_REQUESTED");
    },

    /* DISCONNECT: final STOP and BYE while the socket is still open, then close it. */
    disconnect() {
      desired = false;
      follow = false;
      clearReconnect();
      link.disconnect(now());
      closeSocket();
      emit("DISCONNECTED_BY_USER");
    },

    /*
     * ARM / FOLLOW. Only possible while the link is established, no ESTOP is
     * latched and the page is visible. It enables the decision feed; it
     * does not create authorization by itself (the link still needs a fresh
     * detection and a fresh token for every movement).
     */
    setFollow(on) {
      if (!on) {
        follow = false;
        if (!disposed) link.setDecision("STOP", now());
        emit("FOLLOW_OFF");
        return true;
      }
      const status = link.getStatus(now());
      if (disposed || hidden || !desired || !status.connected || status.emergency) {
        emit("FOLLOW_REFUSED");
        return false;
      }
      follow = true;
      emit("FOLLOW_ON");
      return true;
    },

    /*
     * Latest motion decision. While FOLLOW is off, hidden or disconnected the
     * link only ever receives STOP.
     */
    setDecision(command, detectionTime) {
      if (disposed) return;
      const allowed = follow && !hidden && desired;
      link.setDecision(allowed ? command : "STOP", now(), detectionTime);
    },

    emergencyStop() {
      follow = false;
      link.emergencyStop(now());
      emit("ESTOP");
    },

    /* Releases the app-side latch and starts a new session. It never resumes movement. */
    clearEmergency() {
      follow = false;
      link.clearEmergency(now());
      const status = link.getStatus(now());
      if (
        desired && !hidden && status.state === LINK_STATE.DISCONNECTED &&
        socket && socket.readyState === SOCKET_OPEN
      ) {
        startLink();
      }
      emit("ESTOP_CLEARED");
    },

    /* Page hidden (visibilitychange, pagehide): STOP, BYE, no session, no socket. */
    hide() {
      if (hidden || disposed) return;
      hidden = true;
      follow = false;
      link.suspend(now());
      clearReconnect();
      closeSocket();
      emit("HIDDEN");
    },

    /* Page visible again: a brand new socket and session. No movement resumes. */
    show() {
      if (!hidden || disposed) return;
      hidden = false;
      emit("VISIBLE");
      if (desired) {
        backoffIndex = 0;
        openSocket();
      }
    },

    getStatus() {
      const at = now();
      const linkStatus = link.getStatus(at);
      return {
        url,
        desired,
        hidden,
        follow,
        emergency: linkStatus.emergency,
        socket: socket ? SOCKET_NAMES[socket.readyState] ?? "UNKNOWN" : "NONE",
        buffered: socket && typeof socket.bufferedAmount === "number" ? socket.bufferedAmount : null,
        backoffIndex,
        handshakeFailures,
        lastEvent,
        stats: { ...stats },
        link: linkStatus
      };
    },

    dispose() {
      if (disposed) return;
      api.disconnect();
      disposed = true;
      if (tickTimer !== null) timers.clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  return api;
}
