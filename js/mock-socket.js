/*
 * In-memory WebSocket stand-in wired to the existing Mock ESP32
 * (js/mock-esp32.js). It exists for M0: the page and the tests can run the
 * whole Protocol v2 loop without hardware. IT IS NOT A REAL DEVICE. Passing
 * against it proves nothing about a real ESP32, a real network or a motor.
 *
 *   const net = createMockDeviceNetwork({ timers, now });
 *   const socket = net.createSocket("mock://device");
 *
 * One mock device is shared by every socket (like one real board): a new
 * socket talks to the same device state, so reconnect behavior is real
 * protocol behavior. The device clock is app time plus an offset, so the two
 * clocks are independent and a bug that compared them would show.
 *
 * Test controls on `net`: latencyMs, blackhole (drop both directions while
 * sockets stay open: a silent peer), holdReplies / releaseHeld (delayed
 * and stale replies), neverOpen, closeFromDevice(), and `log`.
 */

import { createMockEsp32 } from "./mock-esp32.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: id => globalThis.clearInterval(id)
  };
}

export function createMockDeviceNetwork({
  timers = defaultTimers(),
  now = () => performance.now(),
  deviceOffsetMs = 10000,
  latencyMs = 0,
  deviceTickMs = 10,
  random32,
  mockOptions = {}
} = {}) {

  const net = {
    latencyMs,
    blackhole: false,
    holdReplies: false,
    neverOpen: false,
    log: [],
    sockets: [],
    held: []
  };

  const deviceNow = () => now() + deviceOffsetMs;
  let current = null;                 // the socket whose request the device is processing

  function deliverToApp(socket, payload) {
    if (net.blackhole) return;
    timers.setTimeout(() => socket._receive(payload), net.latencyMs);
  }

  const device = createMockEsp32({
    random32,
    ...mockOptions,
    reply(message) {
      net.log.push({ dir: "device->app", message });
      if (!current) return;
      const payload = JSON.stringify(message);
      if (net.holdReplies) {
        net.held.push({ socket: current, payload });
        return;
      }
      deliverToApp(current, payload);
    }
  });

  const tickTimer = timers.setInterval(() => device.tick(deviceNow()), deviceTickMs);

  class MockSocket {

    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.bufferedAmount = 0;
      this._listeners = { open: [], message: [], close: [], error: [] };
      net.sockets.push(this);
      if (!net.neverOpen) {
        timers.setTimeout(() => {
          if (this.readyState !== CONNECTING) return;
          this.readyState = OPEN;
          this._emit("open", {});
        }, net.latencyMs);
      }
    }

    addEventListener(type, fn) { this._listeners[type]?.push(fn); }
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter(item => item !== fn);
    }

    _emit(type, event) {
      for (const fn of [...(this._listeners[type] ?? [])]) fn(event);
    }

    /* Delivery to the app. Listeners stay attached after close on purpose, so a
     * test can prove the app drops a late message from a dead socket. */
    _receive(payload) {
      this._emit("message", { data: payload });
    }

    send(data) {
      if (this.readyState !== OPEN) throw new Error("mock socket is not open");
      let message;
      try { message = JSON.parse(data); } catch { return; }
      net.log.push({ dir: "app->device", message });
      if (net.blackhole) return;
      timers.setTimeout(() => {
        // A browser flushes what was sent before close(); only a connection the
        // device or the network dropped loses messages that were still in flight.
        if (this._droppedByDevice) return;
        current = this;
        try { device.receive(message, deviceNow()); } finally { current = null; }
      }, net.latencyMs);
    }

    close() {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      timers.setTimeout(() => this._emit("close", { code: 1000, wasClean: true }), 0);
    }
  }

  return Object.assign(net, {

    device,
    deviceNow,

    createSocket(url) {
      return new MockSocket(url);
    },

    /* Every open socket closes as if the device or the Wi-Fi dropped it (1006). */
    closeFromDevice() {
      for (const socket of net.sockets) {
        if (socket.readyState === CLOSED) continue;
        socket.readyState = CLOSED;
        socket._droppedByDevice = true;
        socket._emit("close", { code: 1006, wasClean: false });
      }
    },

    /* Delivers replies held by holdReplies. */
    releaseHeld() {
      const held = net.held.splice(0);
      for (const { socket, payload } of held) deliverToApp(socket, payload);
      return held.length;
    },

    dispose() {
      timers.clearInterval(tickTimer);
    }
  });
}
