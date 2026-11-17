/*
 * Tests for js/ble-socket.js: the Web Bluetooth stand-in for a WebSocket.
 *
 * Everything runs against a FAKE Web Bluetooth device written in this file (and, in the last
 * tests, the in-page mock ESP32). Passing proves the framing, chunking, reconnect behavior and
 * the session integration only. It proves NOTHING about a real phone, a real browser Bluetooth
 * stack, a real ESP32 or the firmware's BLE glue.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BLE_DEFAULTS,
  BLE_RX_UUID,
  BLE_SERVICE_UUID,
  BLE_TX_UUID,
  LineAssembler,
  chunkBytes,
  createBleSocketFactory
} from "../js/ble-socket.js";
import { createEsp32Session } from "../js/esp32-session.js";
import { createMockDeviceNetwork } from "../js/mock-socket.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

/* ---------- a fake Web Bluetooth peripheral ---------- */

function createFakeBluetooth({ writeLimit = 20, notifyChunk = 20, onLine = () => {}, failRequest = null } = {}) {
  const state = {
    requests: 0,
    connects: 0,
    writes: [],                 // every chunk written by the page
    gattConnected: false,
    startedNotifications: false
  };
  const gattListeners = [];
  const valueListeners = [];
  let pending = [];
  const decoder = new TextDecoder();

  const rx = {
    async writeValueWithoutResponse(chunk) {
      if (!state.gattConnected) throw new Error("not connected");
      if (chunk.length > writeLimit) throw new Error(`write of ${chunk.length} bytes exceeds ${writeLimit}`);
      state.writes.push(chunk.length);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          onLine(decoder.decode(Uint8Array.from(pending)));
          pending = [];
        } else {
          pending.push(byte);
        }
      }
    }
  };

  const tx = {
    addEventListener(type, fn) { if (type === "characteristicvaluechanged") valueListeners.push(fn); },
    removeEventListener(type, fn) {
      const at = valueListeners.indexOf(fn);
      if (at >= 0) valueListeners.splice(at, 1);
    },
    async startNotifications() { state.startedNotifications = true; }
  };

  const service = {
    async getCharacteristic(uuid) {
      if (uuid === BLE_RX_UUID) return rx;
      if (uuid === BLE_TX_UUID) return tx;
      throw new Error(`unknown characteristic ${uuid}`);
    }
  };

  const gatt = {
    get connected() { return state.gattConnected; },
    async connect() {
      state.connects += 1;
      state.gattConnected = true;
      return {
        async getPrimaryService(uuid) {
          if (uuid !== BLE_SERVICE_UUID) throw new Error("unknown service");
          return service;
        }
      };
    },
    disconnect() { state.gattConnected = false; }
  };

  const device = {
    gatt,
    addEventListener(type, fn) { if (type === "gattserverdisconnected") gattListeners.push(fn); },
    removeEventListener(type, fn) {
      const at = gattListeners.indexOf(fn);
      if (at >= 0) gattListeners.splice(at, 1);
    }
  };

  const bluetooth = {
    async requestDevice(options) {
      state.requests += 1;
      state.lastRequest = options;
      if (failRequest) throw failRequest;
      return device;
    }
  };

  return {
    bluetooth,
    state,
    gattListenerCount: () => gattListeners.length,
    valueListenerCount: () => valueListeners.length,
    /* The device sends text to the page, cut into notifications. */
    notify(text, size = notifyChunk) {
      const bytes = new TextEncoder().encode(text);
      for (const part of chunkBytes(bytes, size)) {
        const copy = Uint8Array.from(part);
        const view = new DataView(copy.buffer);
        for (const fn of [...valueListeners]) fn({ target: { value: view } });
      }
    },
    /* The device or the radio drops the link. */
    dropLink() {
      state.gattConnected = false;
      for (const fn of [...gattListeners]) fn({});
    }
  };
}

async function open(fake, url = "ble://", options) {
  const factory = createBleSocketFactory({ bluetooth: fake.bluetooth, options });
  const socket = factory.createSocket(url);
  const events = [];
  for (const type of ["open", "message", "close", "error"]) {
    socket.addEventListener(type, event => events.push({ type, event }));
  }
  await until(() => socket.readyState !== 0, "socket leaves CONNECTING");
  return { factory, socket, events };
}

/* ---------- LineAssembler / chunkBytes ---------- */

test("L1 LineAssembler: lines split across feeds, CRLF and empty lines, overlong line dropped", () => {
  const a = new LineAssembler(10);
  const lines = [];
  a.feed("ab", l => lines.push(l));
  a.feed("c\r\n\n\nde\nf", l => lines.push(l));
  assert.deepEqual(lines, ["abc", "de"]);
  a.feed("\n", l => lines.push(l));
  assert.deepEqual(lines, ["abc", "de", "f"]);
  a.feed(`${"x".repeat(25)}\nok\n`, l => lines.push(l));
  assert.deepEqual(lines.slice(3), ["ok"]);
  assert.equal(a.overflows, 1);
  a.feed("half", l => lines.push(l));
  a.reset();
  a.feed("new\n", l => lines.push(l));
  assert.equal(lines.at(-1), "new");
});

test("L2 chunkBytes: sizes, order and total", () => {
  const bytes = Uint8Array.from({ length: 45 }, (_, i) => i);
  const chunks = chunkBytes(bytes, 20);
  assert.deepEqual(chunks.map(c => c.length), [20, 20, 5]);
  assert.deepEqual([...chunks.flatMap(c => [...c])], [...bytes]);
});

/* ---------- the socket against a fake device ---------- */

test("B1 opens through the chooser with the service filter and starts notifications", async () => {
  const fake = createFakeBluetooth();
  const { socket, events } = await open(fake);
  assert.equal(socket.readyState, 1);
  assert.equal(fake.state.requests, 1);
  assert.deepEqual(fake.state.lastRequest.filters, [{ services: [BLE_SERVICE_UUID] }]);
  assert.equal(fake.state.startedNotifications, true);
  assert.deepEqual(events.map(e => e.type), ["open"]);
  assert.equal(socket.openTimeoutMs, BLE_DEFAULTS.openTimeoutMs);
});

test("B2 send cuts one message into writes of at most 20 bytes and ends it with a newline", async () => {
  const received = [];
  const fake = createFakeBluetooth({ writeLimit: 20, onLine: line => received.push(line) });
  const { socket } = await open(fake);
  const message = JSON.stringify({ v: 2, t: "HELLO", sid: "a1b2c3d4e5f60718", seq: 1, extra: "x".repeat(40) });
  socket.send(message);
  await until(() => received.length === 1, "device got the line");
  assert.equal(received[0], message);
  assert.ok(fake.state.writes.length >= Math.ceil((message.length + 1) / 20));
  assert.ok(fake.state.writes.every(n => n <= 20));
  assert.equal(socket.bufferedAmount, 0);
});

test("B3 notifications cut in the middle of a UTF-8 character still give one exact message", async () => {
  const fake = createFakeBluetooth();
  const { socket, events } = await open(fake);
  const text = JSON.stringify({ t: "ACK", note: "ทดสอบภาษาไทย" });
  fake.notify(`${text}\n`, 7);
  const messages = events.filter(e => e.type === "message");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event.data, text);
  assert.equal(socket.readyState, 1);
});

test("B4 two lines in one notification and one line over several; empty lines ignored", async () => {
  const fake = createFakeBluetooth();
  const { events } = await open(fake);
  fake.notify('{"a":1}\n\n{"b":2}\n{"c"', 100);
  fake.notify(":3}\n", 3);
  const data = events.filter(e => e.type === "message").map(e => e.event.data);
  assert.deepEqual(data, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("B5 a line longer than the limit is dropped whole and the next one is delivered", async () => {
  const fake = createFakeBluetooth();
  const { events } = await open(fake);
  fake.notify(`${"z".repeat(BLE_DEFAULTS.maxLine + 30)}\n{"ok":true}\n`, 100);
  const data = events.filter(e => e.type === "message").map(e => e.event.data);
  assert.deepEqual(data, ['{"ok":true}']);
});

test("B6 a dropped link closes the socket once, then send throws", async () => {
  const fake = createFakeBluetooth();
  const { socket, events } = await open(fake);
  fake.dropLink();
  fake.dropLink();
  assert.equal(socket.readyState, 3);
  assert.equal(events.filter(e => e.type === "close").length, 1);
  assert.throws(() => socket.send("{}"), /not open/);
  assert.equal(fake.valueListenerCount(), 0);
  assert.equal(fake.gattListenerCount(), 0);
});

test("B7 a reconnect reuses the chosen device without the chooser; forget() asks again", async () => {
  const fake = createFakeBluetooth();
  const factory = createBleSocketFactory({ bluetooth: fake.bluetooth });
  const first = factory.createSocket("ble://");
  await until(() => first.readyState === 1, "first open");
  first.close();
  await tick();
  assert.equal(fake.state.gattConnected, false);
  const second = factory.createSocket("ble://");
  await until(() => second.readyState === 1, "second open");
  assert.equal(fake.state.requests, 1);
  assert.equal(fake.state.connects, 2);
  second.close();
  factory.forget();
  const third = factory.createSocket("ble://");
  await until(() => third.readyState === 1, "third open");
  assert.equal(fake.state.requests, 2);
  third.close();
});

test("B8 the user cancelling the chooser gives error + close, not an open socket", async () => {
  const cancelled = Object.assign(new Error("User cancelled"), { name: "NotFoundError" });
  const fake = createFakeBluetooth({ failRequest: cancelled });
  const { socket, events } = await open(fake);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.lastError, "NotFoundError");
  assert.deepEqual(events.map(e => e.type), ["error", "close"]);
});

test("B9 without Web Bluetooth the socket fails with NotSupportedError", async () => {
  const factory = createBleSocketFactory({ bluetooth: undefined });
  const socket = factory.createSocket("ble://");
  const events = [];
  socket.addEventListener("error", e => events.push(e));
  await until(() => socket.readyState === 3, "failure");
  assert.equal(socket.lastError, "NotSupportedError");
  assert.equal(events.length, 1);
  assert.equal(factory.isSupported(), false);
});

test("B10 the chunk option is honored and clamped to 20..244", async () => {
  const big = createFakeBluetooth({ writeLimit: 100 });
  const { socket } = await open(big, "ble://?chunk=100");
  socket.send("y".repeat(250));
  await until(() => big.state.writes.length >= 3, "writes");
  assert.ok(Math.max(...big.state.writes) === 100);

  const low = createFakeBluetooth({ writeLimit: 20 });
  const { socket: s2 } = await open(low, "ble://?chunk=5");
  s2.send("y".repeat(60));
  await until(() => low.state.writes.length >= 4, "writes");
  assert.ok(Math.max(...low.state.writes) === 20);

  const huge = createFakeBluetooth({ writeLimit: 244 });
  const { socket: s3 } = await open(huge, "ble://?chunk=9999");
  s3.send("y".repeat(600));
  await until(() => huge.state.writes.length >= 3, "writes");
  assert.ok(Math.max(...huge.state.writes) === 244);
});

test("B11 a write that fails closes the socket with an error", async () => {
  const fake = createFakeBluetooth({ writeLimit: 10 });       // smaller than the 20-byte chunks
  const { socket, events } = await open(fake);
  socket.send("a".repeat(50));
  await until(() => socket.readyState === 3, "failure after the write error");
  assert.deepEqual(events.map(e => e.type).slice(-2), ["error", "close"]);
});

/* ---------- through the real session and the mock ESP32 ---------- */

test("B12 the session reaches CONNECTED over Bluetooth (chunked lines both ways) and disconnects cleanly", async () => {
  const net = createMockDeviceNetwork();
  const mockSocket = net.createSocket("mock://device");
  mockSocket.addEventListener("message", event => fake.notify(`${event.data}\n`));
  await until(() => mockSocket.readyState === 1, "mock device socket");

  const fake = createFakeBluetooth({
    writeLimit: 20,
    notifyChunk: 20,
    onLine: line => mockSocket.send(line)
  });
  const factory = createBleSocketFactory({ bluetooth: fake.bluetooth });
  const session = createEsp32Session({ createSocket: url => factory.createSocket(url) });

  try {
    session.connect("ble://");
    await until(() => session.getStatus().link.connected, "link connected over BLE", 5000);
    assert.equal(fake.state.requests, 1);
    assert.ok(fake.state.writes.every(n => n <= 20));
    assert.equal(session.getStatus().follow, false);          // a connect never arms FOLLOW
  } finally {
    session.disconnect();
    session.dispose();
    net.dispose();
  }
});

test("B13 the session honors a socket's own open timeout (Bluetooth chooser can take long)", async () => {
  // A socket that never opens but asks for a long timeout must NOT be recycled after 3 s.
  const timers = [];
  const fakeTimers = {
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  };
  const slow = {
    readyState: 0, bufferedAmount: 0, openTimeoutMs: 30000,
    addEventListener() {}, close() {}, send() {}
  };
  const session = createEsp32Session({ createSocket: () => slow, timers: fakeTimers });
  session.connect("ble://");
  assert.ok(timers.includes(30000));
  assert.ok(!timers.includes(3000));
  session.dispose();
});
