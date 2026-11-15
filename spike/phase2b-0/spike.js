/*
 * Phase 2B-0 deployment spike: test page logic. THROWAWAY, NOT PRODUCTION.
 *
 * It imports nothing from the production app. The MediaPipe URLs below are
 * copies of js/ai-owner.js (MEDIAPIPE_VERSION and the two URL constants);
 * check them against that file before a formal run. The page loads the
 * runtime and the EfficientDet-Lite0 model into the BROWSER only and records
 * timings; nothing is written to disk.
 *
 * Every test stores raw measurements in R. The verdicts (PASS / FAIL /
 * NOT VERIFIED) are produced later by analyze.mjs, not by this page.
 */

const MEDIAPIPE_VERSION = "0.10.35";
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

const UNRESPONSIVE_AFTER_MS = 600;        // app-level "peer is not answering" threshold

const $ = id => document.getElementById(id);
const video = $("video");
const nowMs = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorInfo = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error) });

const R = {
  schema: "phase2b-0.v1",
  fabricated: false,
  variant: null,
  savedAt: null,
  env: null,
  camera: null,
  endpoints: null,
  models: null,
  ws: null,
  concurrent: null,
  stall: null,
  mixed: null,
  wss: null,
  reconnect: null,
  hidden: null,
  wakeLock: null,
  manual: null
};

const state = { stream: null, busy: false, finishHidden: null };

// ------------------------------------------------------------------ helpers

function log(message) {
  const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
  $("log").textContent += line + "\n";
  $("log").scrollTop = $("log").scrollHeight;
  console.log(message);
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const pick = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  const round = x => Math.round(x * 10) / 10;
  return {
    n: v.length, min: round(v[0]), p50: round(pick(0.5)), p95: round(pick(0.95)),
    p99: round(pick(0.99)), max: round(v[v.length - 1]), mean: round(mean), stdev: round(Math.sqrt(variance))
  };
}

function refreshStatus() {
  const summary = {};
  for (const key of Object.keys(R)) {
    if (["schema", "fabricated", "variant", "savedAt"].includes(key)) continue;   // bookkeeping, not tests
    const value = R[key];
    summary[key] = value && typeof value === "object" && "status" in value ? value.status : (value ? "recorded" : "not run");
  }
  $("status").textContent = JSON.stringify(summary, null, 1);
}

function setResult(key, value) {
  R[key] = value;
  refreshStatus();
}

async function guarded(name, fn) {
  if (state.busy) { log(`busy: wait for the running test before starting ${name}`); return; }
  state.busy = true;
  setButtons(true);
  log(`--- ${name} start`);
  try {
    await fn();
  } catch (error) {
    log(`${name} threw: ${errorInfo(error).message}`);
  } finally {
    state.busy = false;
    setButtons(false);
    log(`--- ${name} end`);
  }
}

function setButtons(disabled) {
  for (const button of document.querySelectorAll("button")) {
    if (button.id === "bSave" || button.id === "bDownload" || button.id === "bFinishHidden") continue;
    button.disabled = disabled;
  }
}

function durationMs() {
  return Math.max(10, Number($("durationSec").value) || 60) * 1000;
}

function wsUrl() {
  return $("wsUrl").value.trim();
}

// ------------------------------------------------------------------ 1 environment

async function envTest() {

  let high = null;
  try {
    high = await navigator.userAgentData?.getHighEntropyValues(["platform", "platformVersion", "model"]);
  } catch { /* not available */ }

  const ua = navigator.userAgent;
  const connection = navigator.connection
    ? {
        type: navigator.connection.type ?? null,
        effectiveType: navigator.connection.effectiveType ?? null,
        downlink: navigator.connection.downlink ?? null,
        rtt: navigator.connection.rtt ?? null,
        saveData: navigator.connection.saveData ?? null
      }
    : null;

  const localNetwork = {};
  for (const name of ["local-network-access", "local-network", "loopback-network"]) {
    try {
      localNetwork[name] = (await navigator.permissions.query({ name })).state;
    } catch (error) {
      localNetwork[name] = `unsupported: ${errorInfo(error).message}`;
    }
  }

  setResult("env", {
    status: "PASS",
    userAgent: ua,
    isAndroid: /Android/i.test(ua),
    chromeVersion: /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? null,
    platform: high?.platform ?? null,
    platformVersion: high?.platformVersion ?? null,
    model: high?.model ?? null,
    isSecureContext: window.isSecureContext,
    protocol: location.protocol,
    host: location.host,
    hostname: location.hostname,
    crossOriginIsolated: window.crossOriginIsolated,
    onLine: navigator.onLine,
    connection,
    hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    hasWakeLock: "wakeLock" in navigator,
    hasRequestVideoFrameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    hasLongTaskObserver: typeof PerformanceObserver !== "undefined" &&
      (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask"),
    localNetworkPermission: localNetwork,
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio }
  });
  log(`env: secure=${window.isSecureContext} protocol=${location.protocol} android=${/Android/i.test(ua)} chrome=${R.env.chromeVersion}`);
}

// ------------------------------------------------------------------ 2 camera

async function startCamera() {

  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error(`navigator.mediaDevices.getUserMedia is unavailable (isSecureContext=${window.isSecureContext})`);
    error.name = "NoMediaDevices";
    throw error;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  });

  video.srcObject = stream;
  await video.play();
  state.stream = stream;
  return stream;
}

function stopCamera() {
  if (state.stream) for (const track of state.stream.getTracks()) track.stop();
  state.stream = null;
  video.srcObject = null;
}

function countFrames(ms) {
  return new Promise(resolve => {
    const gaps = [];
    let last = null;
    let frames = 0;
    const startQuality = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
    const end = nowMs() + ms;
    const done = () => {
      const endQuality = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
      resolve({ frames, gaps, qualityFrames: startQuality !== null && endQuality !== null ? endQuality - startQuality : null });
    };
    if ("requestVideoFrameCallback" in video) {
      const tick = () => {
        const t = nowMs();
        if (last !== null) gaps.push(t - last);
        last = t;
        frames += 1;
        if (t < end) video.requestVideoFrameCallback(tick); else done();
      };
      video.requestVideoFrameCallback(tick);
    } else {
      setTimeout(done, ms);
    }
  });
}

async function cameraTest({ keep = false } = {}) {

  const out = { ran: true, status: "FAIL", secureContext: window.isSecureContext, error: null };

  try {
    const t0 = nowMs();
    await startCamera();
    out.startMs = Math.round(nowMs() - t0);
    const track = state.stream.getVideoTracks()[0];
    out.label = track.label;
    out.settings = track.getSettings();
    const counted = await countFrames(5000);
    out.frames = counted.frames;
    out.qualityFrames = counted.qualityFrames;
    out.fps = Math.round((counted.frames / 5) * 10) / 10;
    out.frameGapMs = stats(counted.gaps);
    out.trackReadyState = track.readyState;
    out.status = counted.frames > 0 || (counted.qualityFrames ?? 0) > 0 ? "PASS" : "FAIL";
  } catch (error) {
    out.error = errorInfo(error);
    // An insecure origin is a limitation of that hosting variant, not a camera defect.
    out.status = !window.isSecureContext && !navigator.mediaDevices?.getUserMedia
      ? "LIMITATION_INSECURE_CONTEXT"
      : "FAIL";
  }

  if (!keep) stopCamera();
  setResult("camera", out);
  log(`camera: ${out.status}${out.error ? " " + out.error.message : ` fps=${out.fps}`}`);
  return out;
}

// ------------------------------------------------------------------ 3 application endpoints

async function timedFetch(url, options = {}) {
  const t0 = nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, ...options });
    return { url, ok: true, status: response.status, type: response.type, ms: Math.round(nowMs() - t0) };
  } catch (error) {
    return { url, ok: false, error: errorInfo(error), ms: Math.round(nowMs() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

async function endpointsTest() {
  // APPLICATION endpoint tests only. They do not reproduce Android's own
  // connectivity check, which runs in the OS against fixed hostnames.
  const out = {
    ran: true,
    status: "PASS",
    note: "Application endpoint test; does NOT reproduce the Android OS connectivity check.",
    sameOrigin204: await timedFetch("/generate_204"),
    sameOriginPing: await timedFetch("/ping"),
    otherOrigin204: null,
    otherOriginPing: null
  };
  const other = $("otherHost").value.trim();
  if (other) {
    out.otherOrigin204 = await timedFetch(`${location.protocol}//${other}/generate_204`, { mode: "cors" });
    out.otherOriginPing = await timedFetch(`${location.protocol}//${other}/ping`, { mode: "cors" });
  }
  out.status = out.sameOrigin204.ok && out.sameOrigin204.status === 204 ? "PASS" : "FAIL";
  setResult("endpoints", out);
  log(`endpoints: ${out.status}`);
}

// ------------------------------------------------------------------ 4 models

function loadResourceTimings() {
  return performance.getEntriesByType("resource")
    .filter(entry => /jsdelivr\.net|googleapis\.com/.test(entry.name))
    .map(entry => ({
      name: entry.name.replace(/\?.*$/, ""),
      durationMs: Math.round(entry.duration),
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize
    }));
}

async function loadModels() {
  const timings = {};
  let t0 = nowMs();
  const tasks = await import(BUNDLE_URL);
  timings.bundleMs = Math.round(nowMs() - t0);

  t0 = nowMs();
  const fileset = await tasks.FilesetResolver.forVisionTasks(WASM_URL);
  timings.wasmMs = Math.round(nowMs() - t0);

  t0 = nowMs();
  const detector = await tasks.ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    runningMode: "VIDEO",
    scoreThreshold: 0.3,
    maxResults: 5
  });
  timings.createMs = Math.round(nowMs() - t0);

  return { detector, timings };
}

function makeCanvasSource() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 640, 480);
  gradient.addColorStop(0, "#335");
  gradient.addColorStop(1, "#cc9");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 640, 480);
  return canvas;
}

async function modelsTest() {

  const out = { ran: true, status: "FAIL", error: null, urls: { bundle: BUNDLE_URL, wasm: WASM_URL, model: MODEL_URL } };
  let detector = null;

  try {
    const loaded = await loadModels();
    detector = loaded.detector;
    Object.assign(out, loaded.timings);

    const useVideo = Boolean(state.stream) && video.readyState >= 2;
    const source = useVideo ? video : makeCanvasSource();
    out.inferenceInput = useVideo ? "video" : "canvas";

    const times = [];
    let detections = 0;
    for (let i = 0; i < 30; i += 1) {
      const t0 = nowMs();
      const result = detector.detectForVideo(source, nowMs());
      times.push(nowMs() - t0);
      detections += result?.detections?.length ?? 0;
      await sleep(30);
    }
    out.inferMs = stats(times);
    out.detectionsSeen = detections;
    out.status = "PASS";
  } catch (error) {
    out.error = errorInfo(error);
  } finally {
    try { detector?.close(); } catch { /* ignore */ }
  }

  out.resourceTimings = loadResourceTimings();
  setResult("models", out);
  log(`models: ${out.status}${out.error ? " " + out.error.message : ` create=${out.createMs}ms infer p50=${out.inferMs?.p50}ms`}`);
}

// ------------------------------------------------------------------ WebSocket helpers

/* Opens a socket and reports exactly what happened. Never throws. */
function tryOpen(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const t0 = nowMs();
    const events = [];
    let ws;
    let settled = false;
    const finish = (outcome, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, url, ms: Math.round(nowMs() - t0), events, ws: outcome === "OPENED" ? ws : null, ...extra });
    };
    const timer = setTimeout(() => { try { ws?.close(); } catch { /* ignore */ } finish("TIMEOUT"); }, timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (error) {
      finish("THROWN", { error: errorInfo(error) });
      return;
    }

    ws.addEventListener("open", () => { events.push({ e: "open", ms: Math.round(nowMs() - t0) }); finish("OPENED"); });
    ws.addEventListener("error", () => { events.push({ e: "error", ms: Math.round(nowMs() - t0) }); });
    ws.addEventListener("close", event => {
      events.push({ e: "close", code: event.code, wasClean: event.wasClean, reason: event.reason, ms: Math.round(nowMs() - t0) });
      finish("ERROR", { closeCode: event.code });
    });
  });
}

/* Sends numbered ECHO messages and records round trips, duplicates and ordering. */
class EchoSession {

  constructor(ws) {
    this.ws = ws;
    this.sentAt = new Map();
    this.seen = new Set();
    this.rtts = [];
    this.events = [];
    this.n = 0;
    this.received = 0;
    this.duplicates = 0;
    this.outOfOrder = 0;
    this.maxSeq = -1;
    this.sendErrors = 0;
    this.lastReplyAt = null;
    this.timer = null;
    this.waiters = [];
    this.closedAt = null;

    ws.addEventListener("message", event => this.onMessage(event));
    ws.addEventListener("close", event => {
      this.closedAt = nowMs();
      this.events.push({ e: "close", code: event.code, wasClean: event.wasClean, at: this.closedAt });
    });
    ws.addEventListener("error", () => this.events.push({ e: "error", at: nowMs() }));
  }

  onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.t === "ECHO") {
      const t0 = this.sentAt.get(msg.n);
      if (t0 === undefined) return;
      if (this.seen.has(msg.n)) { this.duplicates += 1; return; }
      this.seen.add(msg.n);
      this.rtts.push({ n: msg.n, at: nowMs(), rtt: nowMs() - t0 });
      if (msg.n < this.maxSeq) this.outOfOrder += 1;
      this.maxSeq = Math.max(this.maxSeq, msg.n);
      this.received += 1;
      this.lastReplyAt = nowMs();
    } else if (msg.t === "CTL_OK") {
      const waiter = this.waiters.shift();
      if (waiter) waiter(nowMs());
    }
  }

  sendOne() {
    const n = this.n++;
    const ts = nowMs();
    this.sentAt.set(n, ts);
    try { this.ws.send(JSON.stringify({ t: "ECHO", n, ts })); } catch { this.sendErrors += 1; }
  }

  start(intervalMs) {
    this.stop();
    this.timer = setInterval(() => this.sendOne(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* Returns the time the CTL_OK arrived, or null after 3 s. */
  ctl(mode, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000);
      this.waiters.push(at => { clearTimeout(timer); resolve(at); });
      try { this.ws.send(JSON.stringify({ t: "CTL", mode, ms })); } catch { resolve(null); }
    });
  }

  summary() {
    const cutoff = nowMs() - 1000;                      // ignore the last second (replies still in flight)
    const eligible = [...this.sentAt.entries()].filter(([, t]) => t < cutoff);
    const answered = eligible.filter(([n]) => this.seen.has(n)).length;
    return {
      sent: this.n,
      received: this.received,
      lossPct: eligible.length ? Math.round(((eligible.length - answered) / eligible.length) * 1000) / 10 : null,
      rtt: stats(this.rtts.map(r => r.rtt)),
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder,
      sendErrors: this.sendErrors,
      events: this.events
    };
  }
}

// ------------------------------------------------------------------ 5 WebSocket

async function wsTest() {

  const url = wsUrl();
  const out = { ran: true, status: "FAIL", url, error: null };
  const opened = await tryOpen(url);
  out.open = { outcome: opened.outcome, ms: opened.ms, events: opened.events, error: opened.error ?? null };

  if (opened.outcome !== "OPENED") {
    setResult("ws", out);
    log(`ws: could not open: ${opened.outcome} ${opened.error?.message ?? ""}`);
    return;
  }

  const session = new EchoSession(opened.ws);
  const total = durationMs();
  out.durationSec = Math.round(total / 1000);

  log(`ws: 5 Hz echo for ${out.durationSec} s`);
  session.start(200);
  await sleep(total);
  session.stop();
  await sleep(1200);
  out.phase5Hz = session.summary();
  out.readyStateAfter5Hz = opened.ws.readyState;

  const burst = new EchoSession(opened.ws);
  burst.start(100);
  await sleep(10000);
  burst.stop();
  await sleep(1200);
  out.burst100ms = { ...burst.summary(), durationSec: 10 };

  opened.ws.close(1000, "spike done");
  out.status = "PASS";
  setResult("ws", out);
  log(`ws: p50=${out.phase5Hz.rtt.p50}ms p95=${out.phase5Hz.rtt.p95}ms max=${out.phase5Hz.rtt.max}ms loss=${out.phase5Hz.lossPct}%`);
}

// ------------------------------------------------------------------ 6 camera + models + WebSocket together

async function concurrentTest() {

  const out = { ran: true, status: "FAIL", errors: [], url: wsUrl() };
  let detector = null;
  let session = null;
  let ws = null;
  let observer = null;
  let lagTimer = null;
  let active = false;

  try {
    // 1) camera
    await startCamera();
    out.cameraStarted = true;

    // 2) models, with the camera already running
    const loaded = await loadModels();
    detector = loaded.detector;
    out.modelTimings = loaded.timings;

    // 3) WebSocket
    const opened = await tryOpen(out.url);
    out.wsOpen = { outcome: opened.outcome, ms: opened.ms, error: opened.error ?? null };
    if (opened.outcome !== "OPENED") throw new Error(`WebSocket did not open: ${opened.outcome}`);
    ws = opened.ws;
    session = new EchoSession(ws);

    // 4) all three at the same time
    const total = durationMs();
    out.durationSec = Math.round(total / 1000);
    const inference = [];
    const lags = [];
    const longTasks = [];
    let detections = 0;
    let frames = 0;
    const q0 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;

    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch { out.longTaskObserver = "unsupported"; }

    let lastTick = nowMs();
    lagTimer = setInterval(() => { const t = nowMs(); lags.push(t - lastTick - 25); lastTick = t; }, 25);

    active = true;
    const loop = () => {
      if (!active) return;
      if (video.readyState >= 2) {
        const t0 = nowMs();
        try {
          const result = detector.detectForVideo(video, nowMs());
          inference.push(nowMs() - t0);
          detections += result?.detections?.length ?? 0;
          frames += 1;
        } catch (error) {
          out.errors.push(errorInfo(error));
          active = false;
          return;
        }
      }
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    };
    loop();

    log(`concurrent: camera + detector + 5 Hz echo for ${out.durationSec} s`);
    session.start(200);
    await sleep(total);
    session.stop();
    active = false;
    await sleep(1200);

    const q1 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
    const track = state.stream?.getVideoTracks()[0];
    out.camera = {
      trackReadyState: track?.readyState ?? null,
      fps: q0 !== null && q1 !== null ? Math.round(((q1 - q0) / (total / 1000)) * 10) / 10 : null
    };
    out.detection = { frames, detections, inferMs: stats(inference), fps: Math.round((frames / (total / 1000)) * 10) / 10 };
    out.ws = { readyState: ws.readyState, ...session.summary() };
    out.mainThread = {
      maxLagMs: Math.round(Math.max(0, ...lags)),
      lagOver100ms: lags.filter(x => x > 100).length,
      longTasks: longTasks.length,
      maxLongTaskMs: Math.round(Math.max(0, ...longTasks))
    };
    out.status = out.errors.length === 0 ? "PASS" : "FAIL";
  } catch (error) {
    out.errors.push(errorInfo(error));
  } finally {
    active = false;
    session?.stop();
    if (lagTimer) clearInterval(lagTimer);
    try { observer?.disconnect(); } catch { /* ignore */ }
    try { ws?.close(1000, "spike done"); } catch { /* ignore */ }
    try { detector?.close(); } catch { /* ignore */ }
    stopCamera();
  }

  out.resourceTimings = loadResourceTimings();
  setResult("concurrent", out);
  log(`concurrent: ${out.status} ${out.errors[0]?.message ?? ""}`);
}

// ------------------------------------------------------------------ 7 stall / drop (OPEN is not responsiveness)

async function stallTest() {

  const out = { ran: true, status: "FAIL", url: wsUrl(), error: null, silent: null, pause: null, drop: null };

  try {
    const opened = await tryOpen(out.url);
    if (opened.outcome !== "OPENED") throw new Error(`WebSocket did not open: ${opened.outcome}`);
    const ws = opened.ws;
    const session = new EchoSession(ws);
    session.start(200);
    await sleep(1500);
    out.baselineReplies = session.received;

    // ---- silent: the socket stays OPEN, the peer stops answering
    log("stall: silent mode (socket stays open, no replies) for 15 s");
    const silentAck = await session.ctl("silent");
    const stallStart = nowMs();
    const repliesAtStart = session.received;
    let unresponsiveAfterMs = null;
    let unresponsiveAfterLastReplyMs = null;
    const states = [];
    for (let i = 0; i < 150; i += 1) {
      await sleep(100);
      if (unresponsiveAfterMs === null && nowMs() - session.lastReplyAt > UNRESPONSIVE_AFTER_MS) {
        unresponsiveAfterMs = Math.round(nowMs() - stallStart);                         // from the CTL acknowledgement
        unresponsiveAfterLastReplyMs = Math.round(nowMs() - session.lastReplyAt);       // from the last real reply
      }
      if (i % 10 === 0) states.push(ws.readyState);
    }
    out.silent = {
      controlAcknowledged: silentAck !== null,
      observedSec: 15,
      repliesDuringStall: session.received - repliesAtStart,
      readyStateSamples: states,
      readyStateStayedOpen: states.every(s => s === 1),
      browserCloseFiredDuringStall: session.closedAt !== null,
      appLevelUnresponsiveAfterMs: unresponsiveAfterMs,
      appLevelUnresponsiveAfterLastReplyMs: unresponsiveAfterLastReplyMs,
      unresponsiveThresholdMs: UNRESPONSIVE_AFTER_MS
    };
    const echoAt = await session.ctl("echo");
    const recoverFrom = nowMs();
    const before = session.received;
    for (let i = 0; i < 50 && session.received === before; i += 1) await sleep(100);
    out.silent.recoveredAfterEchoCtlMs = session.received > before ? Math.round(nowMs() - recoverFrom) : null;
    out.silent.echoCtlAcknowledged = echoAt !== null;

    // ---- pause: the peer stops READING; messages pile up and arrive late
    log("stall: pause mode (peer stops reading for 8 s), then a stale backlog arrives");
    const pauseAck = await session.ctl("pause", 8000);
    const pauseStart = nowMs();
    const repliesBeforePause = session.received;
    let maxBuffered = 0;
    const pauseStates = [];
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      maxBuffered = Math.max(maxBuffered, ws.bufferedAmount);
      if (i % 10 === 0) pauseStates.push(ws.readyState);
    }
    const repliesDuringPause = session.received - repliesBeforePause;
    await sleep(5000);
    const late = session.rtts.filter(r => r.at > pauseStart + 8000 && r.rtt > 2000);
    out.pause = {
      controlAcknowledged: pauseAck !== null,
      pauseSec: 8,
      maxBufferedAmountBytes: maxBuffered,
      readyStateSamples: pauseStates,
      repliesDuringPause,
      staleRepliesAfterResume: late.length,
      maxStaleRttMs: late.length ? Math.round(Math.max(...late.map(r => r.rtt))) : null
    };

    // ---- drop: TCP is destroyed with no close frame
    log("stall: drop mode (peer destroys the connection with no close frame)");
    const dropAck = await session.ctl("drop");
    const dropStart = nowMs();
    let closeMs = null;
    for (let i = 0; i < 300 && closeMs === null; i += 1) {
      await sleep(100);
      if (session.closedAt !== null) closeMs = Math.round(session.closedAt - dropStart);
    }
    session.stop();
    const closeEvent = session.events.find(e => e.e === "close");
    out.drop = {
      controlAcknowledged: dropAck !== null,
      browserCloseEventAfterMs: closeMs,
      closeCode: closeEvent?.code ?? null,
      wasClean: closeEvent?.wasClean ?? null,
      observedSec: 30
    };

    // ---- reopen after the drop
    const t0 = nowMs();
    const again = await tryOpen(out.url, 8000);
    out.drop.reopenOutcome = again.outcome;
    out.drop.reopenMs = Math.round(nowMs() - t0);
    try { again.ws?.close(1000, "spike done"); } catch { /* ignore */ }

    out.status = "PASS";
  } catch (error) {
    out.error = errorInfo(error);
  }

  setResult("stall", out);
  log(`stall: ${out.status} ${out.error?.message ?? ""}`);
}

// ------------------------------------------------------------------ 8 / 9 mixed content and wss

async function mixedTest() {

  const out = { ran: true, status: "NOT_APPLICABLE", pageProtocol: location.protocol, ws: null, httpFetch: null };

  if (location.protocol !== "https:") {
    out.note = "Page is not https: mixed content does not apply.";
    setResult("mixed", out);
    log("mixed: not applicable (page is not https)");
    return;
  }

  const host = $("insecureHost").value.trim();
  if (!host) {
    out.status = "SKIPPED";
    out.note = "Enter an insecure ws:// host:port.";
    setResult("mixed", out);
    return;
  }

  out.ws = await tryOpen(`ws://${host}/ws`, 6000);
  try { out.ws.ws?.close(); } catch { /* ignore */ }
  delete out.ws.ws;
  out.httpFetch = await timedFetch(`http://${host}/ping`, { mode: "cors" });
  out.status = "PASS";                                    // the outcome is the measurement
  setResult("mixed", out);
  log(`mixed: ws:// from https -> ${out.ws.outcome} ${out.ws.error?.message ?? ""}; http fetch ok=${out.httpFetch.ok}`);
}

async function wssTest() {

  const host = $("secureHost").value.trim();
  const out = {
    ran: true,
    status: "SKIPPED",
    exceptionAcceptedClaimed: $("mCert").value === "yes",
    pageProtocol: location.protocol
  };

  if (!host) {
    out.note = "Enter a wss:// host:port.";
    setResult("wss", out);
    return;
  }

  out.url = `wss://${host}/ws`;
  const opened = await tryOpen(out.url, 10000);
  out.outcome = opened.outcome;
  out.openMs = opened.ms;
  out.events = opened.events;
  out.error = opened.error ?? null;

  if (opened.outcome === "OPENED") {
    const session = new EchoSession(opened.ws);
    session.start(200);
    await sleep(3000);
    session.stop();
    out.echo = session.summary();
    try { opened.ws.close(1000, "spike done"); } catch { /* ignore */ }
  }

  out.status = "PASS";                                    // the outcome is the measurement
  setResult("wss", out);
  log(`wss: ${out.outcome} (exception accepted claimed: ${out.exceptionAcceptedClaimed})`);
}

// ------------------------------------------------------------------ 10 reconnect probe

async function reconnectProbe() {

  const out = { ran: true, status: "FAIL", url: wsUrl(), cause: $("mReconnectCause").value, error: null };

  try {
    let opened = await tryOpen(out.url);
    if (opened.outcome !== "OPENED") throw new Error(`WebSocket did not open: ${opened.outcome}`);
    let session = new EchoSession(opened.ws);
    session.start(200);
    await sleep(1500);
    log("RECONNECT PROBE: now stop the stand-in server (or toggle Wi-Fi), then start it again. Waiting up to 120 s.");

    const begin = nowMs();
    let downAt = null;
    while (nowMs() - begin < 120000 && downAt === null) {
      await sleep(100);
      const closed = opened.ws.readyState !== 1;
      const silent = session.lastReplyAt !== null && nowMs() - session.lastReplyAt > UNRESPONSIVE_AFTER_MS;
      if (closed || silent) {
        downAt = nowMs();
        out.downDetectedBy = closed ? "socket not OPEN" : "no reply for 600 ms";
        out.downDetectedAfterMs = Math.round(downAt - begin);
      }
    }

    if (downAt === null) {
      out.status = "NOT_TRIGGERED";
      session.stop();
      try { opened.ws.close(); } catch { /* ignore */ }
    } else {
      session.stop();
      try { opened.ws.close(); } catch { /* ignore */ }
      let attempts = 0;
      let reopened = null;
      while (nowMs() - downAt < 120000 && !reopened) {
        attempts += 1;
        const attempt = await tryOpen(out.url, 2000);
        if (attempt.outcome === "OPENED") reopened = attempt; else await sleep(500);
      }
      out.attempts = attempts;
      if (reopened) {
        out.reconnectMs = Math.round(nowMs() - downAt);
        const probe = new EchoSession(reopened.ws);
        probe.start(200);
        await sleep(1500);
        probe.stop();
        out.repliesAfterReconnect = probe.received;
        try { reopened.ws.close(1000, "spike done"); } catch { /* ignore */ }
        out.status = "PASS";
      } else {
        out.status = "FAIL";
        out.error = { name: "NoReconnect", message: "no connection within 120 s after the drop" };
      }
    }
  } catch (error) {
    out.error = errorInfo(error);
  }

  setResult("reconnect", out);
  log(`reconnect: ${out.status} ${out.reconnectMs !== undefined ? out.reconnectMs + " ms" : ""}`);
}

// ------------------------------------------------------------------ 11 hidden page

async function hiddenTest() {

  const out = {
    ran: true, status: "FAIL", url: wsUrl(), error: null, events: [], hiddenIntervals: []
  };

  let opened = null;
  let session = null;
  let lagTimer = null;
  const lags = [];

  try {
    opened = await tryOpen(out.url);
    if (opened.outcome !== "OPENED") throw new Error(`WebSocket did not open: ${opened.outcome}`);
    session = new EchoSession(opened.ws);
    session.start(200);

    let withCamera = false;
    try { await startCamera(); withCamera = true; } catch { /* camera optional here */ }
    out.cameraRunning = withCamera;

    let hiddenAt = null;
    let hiddenRepliesStart = 0;
    let hiddenSentStart = 0;
    const onVisibility = () => {
      const t = nowMs();
      out.events.push({ state: document.visibilityState, at: Math.round(t) });
      if (document.visibilityState === "hidden") {
        hiddenAt = t;
        hiddenRepliesStart = session.received;
        hiddenSentStart = session.n;
      } else if (hiddenAt !== null) {
        const interval = {
          hiddenMs: Math.round(t - hiddenAt),
          timerMaxGapMs: Math.round(Math.max(0, ...lags.filter(l => l.at >= hiddenAt).map(l => l.gap))),
          echoSentWhileHidden: session.n - hiddenSentStart,
          echoRepliesWhileHidden: session.received - hiddenRepliesStart,
          readyStateOnReturn: opened.ws.readyState,
          closeEvents: session.events.filter(e => e.e === "close").length,
          trackReadyStateOnReturn: state.stream?.getVideoTracks()[0]?.readyState ?? null,
          firstReplyAfterReturnMs: null
        };
        const marker = session.received;
        const returnedAt = t;
        const watch = setInterval(() => {
          if (session.received > marker && interval.firstReplyAfterReturnMs === null) {
            interval.firstReplyAfterReturnMs = Math.round(nowMs() - returnedAt);
            clearInterval(watch);
          }
        }, 50);
        setTimeout(() => clearInterval(watch), 10000);
        out.hiddenIntervals.push(interval);
        hiddenAt = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    let last = nowMs();
    lagTimer = setInterval(() => {
      const t = nowMs();
      lags.push({ at: t, gap: t - last });
      last = t;
    }, 100);

    $("bFinishHidden").disabled = false;
    log("HIDDEN TEST: lock the screen or switch to another app for 10-20 s, come back, then press 'Finish hidden test'.");
    await new Promise(resolve => { state.finishHidden = resolve; setTimeout(resolve, 180000); });
    $("bFinishHidden").disabled = true;
    document.removeEventListener("visibilitychange", onVisibility);
    await sleep(2000);

    out.overallTimerMaxGapMs = Math.round(Math.max(0, ...lags.map(l => l.gap)));
    out.echo = session.summary();
    out.finalReadyState = opened.ws.readyState;
    out.status = out.hiddenIntervals.length > 0 ? "PASS" : "NOT_TRIGGERED";
  } catch (error) {
    out.error = errorInfo(error);
  } finally {
    session?.stop();
    if (lagTimer) clearInterval(lagTimer);
    try { opened?.ws?.close(1000, "spike done"); } catch { /* ignore */ }
    stopCamera();
  }

  setResult("hidden", out);
  log(`hidden: ${out.status} intervals=${out.hiddenIntervals.length}`);
}

// ------------------------------------------------------------------ 12 wake lock

async function wakeLockTest() {

  const out = { ran: true, status: "FAIL", available: "wakeLock" in navigator, error: null };

  if (!out.available) {
    out.status = "UNAVAILABLE";
  } else {
    try {
      const lock = await navigator.wakeLock.request("screen");
      out.granted = true;
      out.releasedEvent = false;
      lock.addEventListener("release", () => { out.releasedEvent = true; });
      await sleep(1000);
      await lock.release();
      out.status = "PASS";
    } catch (error) {
      out.error = errorInfo(error);
    }
  }

  setResult("wakeLock", out);
  log(`wake lock: ${out.status}`);
}

// ------------------------------------------------------------------ results

function collectManual() {
  R.manual = {
    phone: $("mPhone").value,
    android: $("mAndroid").value,
    wifi: $("mWifi").value,
    mobileData: $("mData").value,
    noInternetPromptSeen: $("mPrompt").value,
    wifiIconNoInternet: $("mIcon").value,
    phoneKeptWifiForPage: $("mDefault").value,
    localNetworkPromptSeen: $("mPrompt2").value,
    reconnectCause: $("mReconnectCause").value,
    certificateExceptionAccepted: $("mCert").value,
    notes: $("mNotes").value
  };
}

function finalize() {
  R.variant = $("variant").value;
  R.savedAt = new Date().toISOString();
  R.fabricated = false;
  collectManual();
  return R;
}

async function saveResults() {
  const body = JSON.stringify(finalize());
  try {
    const response = await fetch("/result", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const json = await response.json();
    log(`saved: ${json.saved ?? JSON.stringify(json)}`);
  } catch (error) {
    log(`SAVE FAILED (${errorInfo(error).message}). Use "Download JSON" instead.`);
  }
}

function downloadResults() {
  const blob = new Blob([JSON.stringify(finalize(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${R.variant}-${R.savedAt.replace(/[:.]/g, "-")}.json`;
  link.click();
}

async function runAll() {
  await envTest();
  await cameraTest();
  await endpointsTest();
  await wsTest();
  await modelsTest();
  await concurrentTest();
  await stallTest();
  if ($("insecureHost").value.trim() && location.protocol === "https:") await mixedTest();
  if ($("secureHost").value.trim()) await wssTest();
  await wakeLockTest();
  log("run all finished. Hidden-page and reconnect probes are manual: run them separately, then Save.");
}

// ------------------------------------------------------------------ wiring

$("wsUrl").value = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
$("variant").value = location.hostname === "localhost" ? "L1" : (location.protocol === "https:" ? "H1" : "L2");

const wire = (id, name, fn) => $(id).addEventListener("click", () => guarded(name, fn));
wire("bRunAll", "run all", runAll);
wire("bEnv", "environment", envTest);
wire("bCamera", "camera", () => cameraTest());
wire("bEndpoints", "endpoints", endpointsTest);
wire("bModels", "models", modelsTest);
wire("bWs", "websocket", wsTest);
wire("bConcurrent", "concurrent", concurrentTest);
wire("bStall", "stall", stallTest);
wire("bMixed", "mixed content", mixedTest);
wire("bWss", "wss", wssTest);
wire("bReconnect", "reconnect probe", reconnectProbe);
wire("bHidden", "hidden page", hiddenTest);
wire("bWake", "wake lock", wakeLockTest);
$("bFinishHidden").addEventListener("click", () => state.finishHidden?.());
$("bSave").addEventListener("click", saveResults);
$("bDownload").addEventListener("click", downloadResults);

refreshStatus();
log("ready. Pick the variant, check the WebSocket URL, then press Run all.");
