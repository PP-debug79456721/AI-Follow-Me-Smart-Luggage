/*
 * Tests for js/person-worker-client.js with a FAKE worker and fake timers. They prove the message protocol,
 * the one-in-flight rule, the failure handling and the fallback signal. They do NOT prove that MediaPipe runs
 * in a real worker: that needs a browser (see js/person-worker.js).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createPersonWorkerClient } from "../js/person-worker-client.js";

function createTimers() {
  let t = 0;
  let counter = 0;
  const entries = new Map();
  return {
    timers: {
      setTimeout(fn, ms) { counter += 1; entries.set(counter, { fn, due: t + ms }); return counter; },
      clearTimeout(id) { entries.delete(id); }
    },
    now: () => t,
    advance(ms) {
      t += ms;
      for (const [id, entry] of [...entries]) {
        if (entry.due <= t) { entries.delete(id); entry.fn(); }
      }
    },
    pending: () => entries.size
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function createFakeWorker(initial = {}) {
  const config = { answerInit: "ready", delegate: "GPU", answerDetect: "result", inferMs: 123, ...initial };
  const worker = {
    config,
    sent: [],
    transfers: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      worker.sent.push(message);
      worker.transfers.push(transfer ?? []);
      queueMicrotask(() => {
        if (message.type === "init") {
          if (config.answerInit === "ready") worker.onmessage?.({ data: { type: "ready", delegate: config.delegate } });
          if (config.answerInit === "error") worker.onmessage?.({ data: { type: "error", message: "model missing" } });
        }
        if (message.type === "detect") {
          if (config.answerDetect === "result") {
            worker.onmessage?.({ data: { type: "result", id: message.id, timestamp: message.timestamp,
              detections: [{ boundingBox: { originX: 1, originY: 2, width: 3, height: 4 },
                categories: [{ categoryName: "person", score: 0.9 }] }], inferMs: config.inferMs } });
          }
          if (config.answerDetect === "error") {
            worker.onmessage?.({ data: { type: "detectError", id: message.id, message: "boom" } });
          }
        }
      });
    },
    terminate() { worker.terminated = true; },
    reply(data) { worker.onmessage?.({ data }); }
  };
  return worker;
}

function setup(workerOptions, clientOptions = {}) {
  const clock = createTimers();
  const worker = createFakeWorker(workerOptions);
  const failures = [];
  const bitmaps = [];
  const client = createPersonWorkerClient({
    createWorker: () => worker,
    createBitmap: async source => { const bitmap = { source, closed: false, close() { this.closed = true; } }; bitmaps.push(bitmap); return bitmap; },
    onFailure: reason => failures.push(reason),
    timers: clock.timers,
    now: clock.now,
    ...clientOptions
  });
  return { clock, worker, failures, bitmaps, client };
}

const OPTIONS = { bundleUrl: "b.mjs", wasmUrl: "w", modelUrl: "m.tflite", delegates: ["GPU", "CPU"] };

test("W1 start sends init with the options and resolves with the delegate", async () => {
  const { client, worker } = setup({ delegate: "CPU" });
  const result = await client.start(OPTIONS);
  assert.equal(result.delegate, "CPU");
  assert.equal(client.isReady(), true);
  assert.deepEqual(worker.sent[0], { type: "init", ...OPTIONS });
});

test("W2 detect transfers a bitmap of the frame and returns detections with the FRAME's timestamp", async () => {
  const { client, worker, bitmaps } = setup({ inferMs: 187 });
  await client.start(OPTIONS);
  const video = { name: "video" };
  const result = await client.detect(video, 4242);
  assert.equal(result.timestamp, 4242);
  assert.equal(result.inferMs, 187);
  assert.equal(result.detections[0].categories[0].categoryName, "person");
  assert.equal(bitmaps[0].source, video);
  const detectMessage = worker.sent.find(m => m.type === "detect");
  assert.equal(detectMessage.bitmap, bitmaps[0]);
  assert.deepEqual(worker.transfers[worker.sent.indexOf(detectMessage)], [bitmaps[0]]);   // transferred, not copied
  assert.equal(client.getStats().results, 1);
});

test("W3 only one detection in flight: a second frame is skipped (null) until the first answers", async () => {
  const { client } = setup({ answerDetect: "none" });
  await client.start(OPTIONS);
  const first = client.detect({}, 1);
  assert.ok(first instanceof Promise);
  assert.equal(client.busy(), true);
  assert.equal(client.detect({}, 2), null);
  assert.equal(client.getStats().busySkips, 1);
});

test("W4 after a result the worker can take the next frame", async () => {
  const { client } = setup();
  await client.start(OPTIONS);
  await client.detect({}, 1);
  assert.equal(client.busy(), false);
  const second = await client.detect({}, 2);
  assert.equal(second.timestamp, 2);
});

test("W5 an init error rejects start, calls onFailure once and terminates the worker", async () => {
  const { client, worker, failures } = setup({ answerInit: "error" });
  await assert.rejects(() => client.start(OPTIONS), /model missing/);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /init: model missing/);
  assert.equal(worker.terminated, true);
  assert.equal(client.detect({}, 1), null);
});

test("W6 an init that never answers times out", async () => {
  const { client, clock, failures } = setup({ answerInit: "none" }, { initTimeoutMs: 5000 });
  const started = client.start(OPTIONS);
  clock.advance(5001);
  await assert.rejects(() => started, /timed out/);
  assert.equal(failures.length, 1);
});

test("W7 a detection that never answers fails the client (fallback signal), later frames are refused", async () => {
  const { client, clock, failures, worker } = setup({ answerDetect: "none" }, { detectTimeoutMs: 3000 });
  await client.start(OPTIONS);
  const pendingResult = client.detect({}, 1);
  await flush();
  clock.advance(3001);
  await assert.rejects(() => pendingResult, /failed/);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not answered/);
  assert.equal(worker.terminated, true);
  assert.equal(client.detect({}, 2), null);
  assert.equal(client.hasFailed(), true);
});

test("W8 detectError rejects that frame; five in a row fail the client, a success resets the count", async () => {
  const { client, failures, worker } = setup({ answerDetect: "error" });
  await client.start(OPTIONS);
  for (let i = 0; i < 4; i += 1) await assert.rejects(() => client.detect({}, i), /boom/);
  assert.equal(failures.length, 0);

  worker.config.answerDetect = "result";                            // one good frame resets the counter
  await client.detect({}, 10);

  worker.config.answerDetect = "error";
  for (let i = 0; i < 4; i += 1) await assert.rejects(() => client.detect({}, 20 + i), /boom/);
  assert.equal(failures.length, 0);
  await assert.rejects(() => client.detect({}, 30), /boom/);        // the 5th in a row
  assert.equal(failures.length, 1);
  assert.match(failures[0], /too many failed detections/);
});

test("W9 a frame that cannot become a bitmap is a skipped frame, not a failure, until it keeps happening", async () => {
  const { client, failures } = setup({}, { createBitmap: async () => { throw new Error("video not ready"); } });
  await client.start(OPTIONS);
  for (let i = 0; i < 4; i += 1) await assert.rejects(() => client.detect({}, i), /video not ready/);
  assert.equal(failures.length, 0);
  assert.equal(client.busy(), false);
  await assert.rejects(() => client.detect({}, 5), /video not ready/);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /too many frames/);
});

test("W10 a late result for an old id is ignored", async () => {
  const { client, worker } = setup({ answerDetect: "none" });
  await client.start(OPTIONS);
  const pendingResult = client.detect({}, 7);
  await flush();
  const id = worker.sent.find(m => m.type === "detect").id;
  worker.reply({ type: "result", id: id + 99, detections: [], inferMs: 1 });         // wrong id
  assert.equal(client.busy(), true);
  worker.reply({ type: "result", id, detections: [], inferMs: 5 });
  const result = await pendingResult;
  assert.equal(result.inferMs, 5);
});

test("W11 a worker error event fails the client", async () => {
  const { client, worker, failures } = setup();
  await client.start(OPTIONS);
  worker.onerror({ message: "script error" });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /script error/);
  assert.equal(client.isReady(), false);
});

test("W12 stop() asks the worker to close, terminates it and is not reported as a failure", async () => {
  const { client, worker, failures } = setup();
  await client.start(OPTIONS);
  client.stop();
  assert.equal(worker.sent.at(-1).type, "close");
  assert.equal(worker.terminated, true);
  assert.equal(failures.length, 0);
  assert.equal(client.detect({}, 1), null);
});

test("W13 createWorker throwing (no Worker support) rejects start", async () => {
  const client = createPersonWorkerClient({ createWorker: () => { throw new Error("Worker is not defined"); } });
  await assert.rejects(() => client.start(OPTIONS), /Worker is not defined/);
  assert.equal(client.detect({}, 1), null);
});

test("W14 a bitmap that arrives after the client failed is closed, not sent", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client, worker } = setup({ answerDetect: "none" }, {
    createBitmap: async () => { await gate; return { closed: false, close() { this.closed = true; } }; }
  });
  await client.start(OPTIONS);
  const result = client.detect({}, 1);
  result.catch(() => {});
  worker.onerror({ message: "died" });
  release();
  await flush();
  assert.equal(worker.sent.filter(m => m.type === "detect").length, 0);
});
