/*
 * Web Bluetooth stand-in for a WebSocket. It lets esp32-session.js talk to the ESP32 over
 * Bluetooth LE with NO change to Protocol v2, the link or the safety rules: the session only
 * sees an object with readyState, bufferedAmount, send(), close() and open/message/close/error
 * events, exactly like the browser WebSocket and js/mock-socket.js.
 *
 *   URL:  ble://            (optional tuning: ble://?chunk=100  bytes per write, 20..244)
 *
 * GATT layout = Nordic UART Service, the same one firmware/esp32-follow/ble_server.h exposes:
 *   RX (page -> device, write)   6e400002-b5a3-f393-e0a9-e50e24dcca9e
 *   TX (device -> page, notify)  6e400003-b5a3-f393-e0a9-e50e24dcca9e
 * One JSON message per line ended by "\n"; BLE carries only ~20..244 bytes per write, so a
 * message is cut into chunks on the way out and lines are reassembled on the way in.
 *
 * Browser rules this module has to live with:
 *   - requestDevice() (the device chooser) needs a user gesture. The first connect happens inside
 *     the CONNECT click. The chosen device is then KEPT, so an automatic reconnect (after a drop,
 *     or when the page becomes visible again) reuses it without a gesture. A page reload forgets
 *     it: press CONNECT again.
 *   - Android Chrome (and desktop Chrome/Edge) support Web Bluetooth; Safari/iPhone do not.
 *   - The page must be a secure context (HTTPS or localhost) or the insecure-origins flag.
 *
 * NOT TESTED AGAINST A REAL PHONE OR BOARD. tests/ble-socket.test.mjs runs it against a fake
 * Web Bluetooth device (and the in-page mock ESP32); that proves the framing and the session
 * integration only.
 */

export const BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const BLE_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const BLE_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export const BLE_DEFAULTS = Object.freeze({
  chunkBytes: 20,            // safe at the default MTU 23; raise with ?chunk= once it is known to work
  minChunkBytes: 20,
  maxChunkBytes: 244,
  maxLine: 512,              // same limit as the firmware (ble_framing.h kMaxLine)
  openTimeoutMs: 30000       // the device chooser may stay open for a while
});

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/* Cuts decoded text into lines; a line over maxLine is dropped whole. Empty lines are ignored. */
export class LineAssembler {

  constructor(maxLine = BLE_DEFAULTS.maxLine) {
    this.maxLine = maxLine;
    this.buffer = "";
    this.discarding = false;
    this.overflows = 0;
  }

  feed(text, onLine) {
    for (const ch of text) {
      if (ch === "\n") {
        if (!this.discarding && this.buffer.length > 0) onLine(this.buffer);
        this.buffer = "";
        this.discarding = false;
      } else if (ch === "\r") {
        // ignored
      } else if (!this.discarding) {
        if (this.buffer.length >= this.maxLine) {
          this.discarding = true;
          this.buffer = "";
          this.overflows += 1;
        } else {
          this.buffer += ch;
        }
      }
    }
  }

  reset() {
    this.buffer = "";
    this.discarding = false;
  }
}

export function chunkBytes(bytes, size) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
  }
  return chunks;
}

function parseChunkOption(url, defaults) {
  const match = /[?&]chunk=(\d+)/.exec(String(url));
  if (!match) return defaults.chunkBytes;
  const value = Number(match[1]);
  return Math.max(defaults.minChunkBytes, Math.min(defaults.maxChunkBytes, value));
}

export function isBleSupported(bluetooth = globalThis.navigator?.bluetooth) {
  return Boolean(bluetooth && typeof bluetooth.requestDevice === "function");
}

/*
 * createSocket(url) factory. Inject `bluetooth` (navigator.bluetooth) in tests.
 * The chosen device is remembered by the factory (see the browser rules above).
 */
export function createBleSocketFactory({
  bluetooth = globalThis.navigator?.bluetooth,
  options = {}
} = {}) {

  const defaults = { ...BLE_DEFAULTS, ...options };
  const remembered = { device: null };

  class BleSocket {

    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.bufferedAmount = 0;
      this.openTimeoutMs = defaults.openTimeoutMs;   // read by esp32-session.js
      this.lastError = null;

      this._listeners = { open: [], message: [], close: [], error: [] };
      this._chunkSize = parseChunkOption(url, defaults);
      this._decoder = new TextDecoder("utf-8");
      this._encoder = new TextEncoder();
      this._lines = new LineAssembler(defaults.maxLine);
      this._queue = [];
      this._writing = false;
      this._closed = false;
      this._device = null;
      this._rx = null;
      this._tx = null;
      this._onValue = null;
      this._onGattDisconnected = null;

      this._start();
    }

    addEventListener(type, fn) { this._listeners[type]?.push(fn); }
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter(item => item !== fn);
    }

    _emit(type, event) {
      for (const fn of [...(this._listeners[type] ?? [])]) {
        try { fn(event); } catch (error) { console.error("BLE socket listener failed:", error); }
      }
    }

    async _start() {
      // A WebSocket never raises an event inside its constructor: wait one tick so the caller
      // can attach its listeners first (otherwise an immediate failure would be lost).
      await null;
      try {
        if (!isBleSupported(bluetooth)) {
          const error = new Error("Web Bluetooth is not available in this browser");
          error.name = "NotSupportedError";
          throw error;
        }

        let device = remembered.device;
        if (!device) {
          // Needs a user gesture: the first connect runs inside the CONNECT click.
          device = await bluetooth.requestDevice({
            filters: [{ services: [BLE_SERVICE_UUID] }],
            optionalServices: [BLE_SERVICE_UUID]
          });
          remembered.device = device;
        }
        if (this._closed) return;

        this._device = device;
        this._onGattDisconnected = () => this._lost("GATT_DISCONNECTED");
        device.addEventListener("gattserverdisconnected", this._onGattDisconnected);

        const server = await device.gatt.connect();
        if (this._closed) { this._release(); return; }

        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        this._rx = await service.getCharacteristic(BLE_RX_UUID);
        this._tx = await service.getCharacteristic(BLE_TX_UUID);
        if (this._closed) { this._release(); return; }

        this._onValue = event => this._receive(event?.target?.value);
        this._tx.addEventListener("characteristicvaluechanged", this._onValue);
        await this._tx.startNotifications();
        if (this._closed) { this._release(); return; }

        this.readyState = OPEN;
        this._emit("open", {});
      } catch (error) {
        this._fail(error);
      }
    }

    _receive(view) {
      if (!view || this.readyState !== OPEN) return;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = this._decoder.decode(bytes, { stream: true });
      this._lines.feed(text, line => this._emit("message", { data: line }));
    }

    send(data) {
      if (this.readyState !== OPEN) throw new Error("BLE socket is not open");
      const bytes = this._encoder.encode(`${data}\n`);
      for (const chunk of chunkBytes(bytes, this._chunkSize)) this._queue.push(chunk);
      this.bufferedAmount += bytes.length;
      this._drain();
    }

    async _drain() {
      if (this._writing) return;
      this._writing = true;
      try {
        while (this._queue.length > 0 && this.readyState === OPEN) {
          const chunk = this._queue.shift();
          if (typeof this._rx.writeValueWithoutResponse === "function") {
            await this._rx.writeValueWithoutResponse(chunk);
          } else {
            await this._rx.writeValue(chunk);
          }
          this.bufferedAmount = Math.max(0, this.bufferedAmount - chunk.length);
        }
      } catch (error) {
        this._fail(error);
      } finally {
        this._writing = false;
      }
    }

    /* Removes our listeners; the remembered device stays for the next reconnect. */
    _release() {
      try {
        if (this._tx && this._onValue) this._tx.removeEventListener("characteristicvaluechanged", this._onValue);
      } catch { /* ignore */ }
      try {
        if (this._device && this._onGattDisconnected) {
          this._device.removeEventListener("gattserverdisconnected", this._onGattDisconnected);
        }
      } catch { /* ignore */ }
      try {
        if (this._device?.gatt?.connected) this._device.gatt.disconnect();
      } catch { /* ignore */ }
      this._queue = [];
      this.bufferedAmount = 0;
    }

    _fail(error) {
      if (this._closed || this.readyState === CLOSED) return;
      this._closed = true;
      this.readyState = CLOSED;
      this.lastError = error?.name || "ERROR";
      this._release();
      this._emit("error", { message: error?.message ?? String(error), name: this.lastError });
      this._emit("close", { code: 1006, wasClean: false });
    }

    _lost() {
      if (this._closed || this.readyState === CLOSED) return;
      this._closed = true;
      this.readyState = CLOSED;
      this._release();
      this._emit("close", { code: 1006, wasClean: false });
    }

    close() {
      if (this.readyState === CLOSED) return;
      this._closed = true;
      this.readyState = CLOSED;
      this._release();
      queueMicrotask(() => this._emit("close", { code: 1000, wasClean: true }));
    }
  }

  return {
    createSocket(url) { return new BleSocket(url); },
    /* Forget the chosen device: the next connect shows the chooser again. */
    forget() { remembered.device = null; },
    isSupported: () => isBleSupported(bluetooth)
  };
}
