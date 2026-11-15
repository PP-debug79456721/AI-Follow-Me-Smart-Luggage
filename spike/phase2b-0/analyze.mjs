#!/usr/bin/env node
/*
 * Phase 2B-0 deployment spike: result analyzer. THROWAWAY, NOT PRODUCTION.
 *
 *   node analyze.mjs [resultsDir] [--include-fabricated] [--md report.md]
 *
 * Reads the JSON files saved by the spike page and prints one verdict per
 * deployment requirement: PASS, FAIL, NOT VERIFIED, or LIMITATION (used only
 * for the camera on an insecure origin, which is a property of that hosting
 * variant and not a camera defect).
 *
 * Rules that cannot be relaxed:
 *   - A result with "fabricated": true is IGNORED unless --include-fabricated
 *     is given (self-test only; the report is then headed SELF-TEST ONLY).
 *   - "Actual Android phone" requirements accept only results whose
 *     userAgent contains Android.
 *   - Real ESP32 AP behavior is always NOT VERIFIED here: no firmware exists
 *     and a laptop hotspot or other stand-in does not prove ESP32 AP behavior.
 *   - Android's OS connectivity check is separate from the application
 *     endpoint test (/generate_204 fetch); the latter does not reproduce it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const includeFabricated = args.includes("--include-fabricated");
const mdIndex = args.indexOf("--md");
const mdPath = mdIndex >= 0 ? args[mdIndex + 1] : null;
const mdValueIndex = mdIndex >= 0 ? mdIndex + 1 : -1;
const dir = args.find((a, i) => !a.startsWith("--") && i !== mdValueIndex) ?? path.join(HERE, "results");

const RTT_GATE_MS = 300;            // app RTT gate of protocol v2
const MAX_LOSS_PCT = 1;
const FORMAL_SECONDS = 300;
const RECONNECT_OK_MS = 10000;
const VARIANTS = ["H1", "L1", "L2", "L3", "L4", "N1", "N2"];

// ------------------------------------------------------------------ load

let files = [];
try {
  files = fs.readdirSync(dir).filter(name => name.endsWith(".json")).sort();
} catch {
  console.error(`cannot read results directory: ${dir}`);
  process.exit(2);
}

const all = [];
for (const name of files) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    all.push({ ...data, _file: name });
  } catch {
    console.error(`skipping unreadable file: ${name}`);
  }
}

const fabricated = all.filter(r => r.fabricated === true);
const results = all
  .filter(r => includeFabricated || r.fabricated !== true)
  .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));

const isAndroid = r => r.env?.isAndroid === true;
const forVariant = v => results.filter(r => r.variant === v);
const files_ = list => list.map(r => r._file).join(", ") || "none";
const rows = [];
const add = (id, requirement, verdict, detail, evidence = "") => rows.push({ id, requirement, verdict, detail, evidence });

/* Latest result of `list` that has `section` defined (and ran). */
const latestWith = (list, section) => [...list].reverse().find(r => r[section] && r[section].ran !== false);

// ------------------------------------------------------------------ requirements

// R1 camera
{
  const perVariant = [];
  let pass = false;
  let anyRan = false;
  for (const v of VARIANTS) {
    const r = latestWith(forVariant(v), "camera");
    if (!r) { perVariant.push(`${v}: not run`); continue; }
    anyRan = true;
    const status = r.camera.status;
    const android = isAndroid(r) ? "Android" : "NON-ANDROID";
    if (status === "LIMITATION_INSECURE_CONTEXT") perVariant.push(`${v}: LIMITATION (insecure context, getUserMedia unavailable; ${android})`);
    else perVariant.push(`${v}: ${status} (${android}${r.camera.fps !== undefined ? `, ${r.camera.fps} fps` : ""}${r.camera.error ? ", " + r.camera.error.name : ""})`);
    if (status === "PASS" && isAndroid(r) && ["H1", "L1", "L3", "N1", "N2"].includes(v)) pass = true;
  }
  const verdict = pass ? "PASS" : (anyRan ? "FAIL" : "NOT VERIFIED");
  add("R1", "Camera works on Android Chrome (secure-context variants); L2 reported separately as an insecure-context limitation",
    verdict, perVariant.join(" | "), files_(results.filter(r => r.camera)));
}

// R2 models, per variant
for (const v of VARIANTS) {
  const r = latestWith(forVariant(v), "models");
  if (!r) continue;
  const m = r.models;
  const android = isAndroid(r);
  const verdict = m.status === "PASS" ? (android ? "PASS" : "NOT VERIFIED") : "FAIL";
  add(`R2-${v}`, `MediaPipe runtime and EfficientDet-Lite0 load and run (${v})`, verdict,
    m.status === "PASS"
      ? `bundle ${m.bundleMs} ms, wasm ${m.wasmMs} ms, create ${m.createMs} ms, infer p50 ${m.inferMs?.p50} ms (input: ${m.inferenceInput})${android ? "" : "; NON-ANDROID evidence only"}`
      : `error: ${m.error?.name}: ${m.error?.message}`,
    r._file);
}
if (!rows.some(r => r.id.startsWith("R2-"))) {
  add("R2", "MediaPipe runtime and EfficientDet-Lite0 load and run", "NOT VERIFIED", "no model test result", "none");
}

// R3 camera + models + WebSocket concurrently on the Android phone
{
  let any = false;
  for (const v of VARIANTS) {
    const r = latestWith(forVariant(v), "concurrent");
    if (!r) continue;
    any = true;
    const c = r.concurrent;
    const live = c.camera?.trackReadyState === "live";
    const parts = c.status === "PASS"
      ? `camera ${c.camera?.fps} fps (track ${c.camera?.trackReadyState}), detection ${c.detection?.fps} fps, infer p50 ${c.detection?.inferMs?.p50} ms, ` +
        `WS p50 ${c.ws?.rtt?.p50} ms p95 ${c.ws?.rtt?.p95} ms max ${c.ws?.rtt?.max} ms loss ${c.ws?.lossPct}%, ` +
        `main-thread max lag ${c.mainThread?.maxLagMs} ms, long tasks ${c.mainThread?.longTasks}, duration ${c.durationSec} s`
      : `errors: ${(c.errors ?? []).map(e => e.message).join("; ")}`;
    let verdict = "FAIL";
    if (c.status === "PASS" && live && c.detection?.frames > 0 && c.ws?.received > 0) verdict = isAndroid(r) ? "PASS" : "NOT VERIFIED";
    add(`R3-${v}`, `Camera, model and WebSocket connectivity run CONCURRENTLY on the Android phone (${v})`, verdict,
      parts + (isAndroid(r) ? "" : " | NON-ANDROID evidence only"), r._file);

    if (c.status === "PASS") {
      const rttOk = c.ws.rtt.p95 <= RTT_GATE_MS && c.ws.lossPct !== null && c.ws.lossPct <= MAX_LOSS_PCT;
      add(`R3b-${v}`, `Concurrent WebSocket round trip within the protocol RTT gate (p95 <= ${RTT_GATE_MS} ms, loss <= ${MAX_LOSS_PCT}%) (${v})`,
        isAndroid(r) ? (rttOk ? "PASS" : "FAIL") : "NOT VERIFIED",
        `p95 ${c.ws.rtt.p95} ms, max ${c.ws.rtt.max} ms, loss ${c.ws.lossPct}%`, r._file);
    }
  }
  if (!any) add("R3", "Camera, model and WebSocket connectivity run CONCURRENTLY on the Android phone", "NOT VERIFIED", "no concurrent test result", "none");
}

// R4 ws:// from http://localhost to a LAN server
{
  const r = latestWith(forVariant("L1"), "ws");
  if (!r) add("R4", "ws:// from an http://localhost page to the LAN stand-in server (L1)", "NOT VERIFIED", "no L1 WebSocket result", "none");
  else add("R4", "ws:// from an http://localhost page to the LAN stand-in server (L1)",
    r.ws.open?.outcome === "OPENED" ? (isAndroid(r) ? "PASS" : "NOT VERIFIED") : "FAIL",
    `open outcome ${r.ws.open?.outcome} in ${r.ws.open?.ms} ms${r.ws.open?.error ? ", " + r.ws.open.error.message : ""}${isAndroid(r) ? "" : " | NON-ANDROID"}`, r._file);
}

// R1-L2 / R4b: the plain-http LAN page. Camera is an insecure-context limitation; WebSocket is tested separately.
{
  const c = latestWith(forVariant("L2"), "camera");
  if (!c) add("R1-L2", "Camera on http://<LAN IP> (L2): insecure-context limitation, reported separately", "NOT VERIFIED", "no L2 camera result", "none");
  else if (c.camera.status === "LIMITATION_INSECURE_CONTEXT") {
    add("R1-L2", "Camera on http://<LAN IP> (L2): insecure-context limitation, reported separately", "LIMITATION",
      `getUserMedia unavailable on this origin (isSecureContext=${c.camera.secureContext}); ${c.camera.error?.message}`, c._file);
  } else {
    add("R1-L2", "Camera on http://<LAN IP> (L2): insecure-context limitation, reported separately",
      c.camera.status === "PASS" ? (isAndroid(c) ? "PASS" : "NOT VERIFIED") : "FAIL",
      `camera ${c.camera.status}${c.camera.error ? ": " + c.camera.error.message : ""} (secure context: ${c.camera.secureContext})`, c._file);
  }
  const w = latestWith(forVariant("L2"), "ws");
  if (!w) add("R4b", "ws:// from an http://<LAN IP> page (L2), tested separately from its camera", "NOT VERIFIED", "no L2 WebSocket result", "none");
  else add("R4b", "ws:// from an http://<LAN IP> page (L2), tested separately from its camera",
    w.ws.open?.outcome === "OPENED" ? (isAndroid(w) ? "PASS" : "NOT VERIFIED") : "FAIL",
    `open outcome ${w.ws.open?.outcome} in ${w.ws.open?.ms} ms${w.ws.open?.error ? ", " + w.ws.open.error.message : ""}${isAndroid(w) ? "" : " | NON-ANDROID"}`, w._file);
}

// R5 mixed content
{
  const r = latestWith(forVariant("L4"), "mixed") ?? latestWith(forVariant("H1"), "mixed");
  if (!r || r.mixed.status === "SKIPPED") add("R5", "ws:// from an https:// page (mixed content) outcome recorded", "NOT VERIFIED", "no mixed-content result", "none");
  else if (r.mixed.status === "NOT_APPLICABLE") add("R5", "ws:// from an https:// page (mixed content) outcome recorded", "NOT VERIFIED", "result came from a non-https page", r._file);
  else add("R5", "ws:// from an https:// page (mixed content) outcome recorded", isAndroid(r) ? "PASS" : "NOT VERIFIED",
    `measured outcome: ${r.mixed.ws?.outcome}${r.mixed.ws?.error ? " (" + r.mixed.ws.error.name + ": " + r.mixed.ws.error.message + ")" : ""}; http fetch ok=${r.mixed.httpFetch?.ok}`, r._file);
}

// R6 wss self-signed
{
  const attempts = results.filter(r => r.wss && r.wss.url);
  if (!attempts.length) add("R6", "wss:// to a self-signed server works after a certificate exception (L3)", "NOT VERIFIED", "no wss result", "none");
  else {
    const opened = attempts.find(r => r.wss.outcome === "OPENED" && isAndroid(r));
    add("R6", "wss:// to a self-signed server works after a certificate exception (L3)",
      opened ? "PASS" : (attempts.some(r => isAndroid(r)) ? "FAIL" : "NOT VERIFIED"),
      attempts.map(r => `${r._file}: ${r.wss.outcome} (exception claimed: ${r.wss.exceptionAcceptedClaimed})`).join(" | "),
      files_(attempts));
  }
}

// R7 round trip at 5 Hz, formal duration
{
  const list = results.filter(r => r.ws?.phase5Hz);
  if (!list.length) add("R7", `WebSocket round trip and jitter at 5 messages/s for >= ${FORMAL_SECONDS} s`, "NOT VERIFIED", "no WebSocket timing result", "none");
  for (const [index, r] of list.entries()) {
    const p = r.ws.phase5Hz;
    const formal = r.ws.durationSec >= FORMAL_SECONDS;
    const ok = p.rtt.p95 <= RTT_GATE_MS && (p.lossPct ?? 100) <= MAX_LOSS_PCT;
    add(`R7-${r.variant}-${index + 1}`, `WebSocket round trip and jitter at 5 messages/s for >= ${FORMAL_SECONDS} s (${r.variant}, ${isAndroid(r) ? "Android" : "non-Android"} result ${r._file})`,
      !isAndroid(r) || !formal ? "NOT VERIFIED" : (ok ? "PASS" : "FAIL"),
      `duration ${r.ws.durationSec} s; p50 ${p.rtt.p50} p95 ${p.rtt.p95} p99 ${p.rtt.p99} max ${p.rtt.max} ms; stdev ${p.rtt.stdev}; loss ${p.lossPct}%; ` +
      `dup ${p.duplicates}, out-of-order ${p.outOfOrder}` +
      `${formal ? "" : " | SHORT RUN, informational only"}${isAndroid(r) ? "" : " | NON-ANDROID"}`, r._file);
  }
}

// R8 reconnect
{
  const r = [...results].reverse().find(x => x.reconnect && x.reconnect.status !== "NOT_TRIGGERED");
  if (!r) add("R8", `Reconnect after a server restart or Wi-Fi toggle completes within ${RECONNECT_OK_MS / 1000} s`, "NOT VERIFIED", "reconnect probe not run or never triggered", "none");
  else {
    const c = r.reconnect;
    add("R8", `Reconnect after a server restart or Wi-Fi toggle completes within ${RECONNECT_OK_MS / 1000} s`,
      !isAndroid(r) ? "NOT VERIFIED" : (c.status === "PASS" && c.reconnectMs <= RECONNECT_OK_MS ? "PASS" : "FAIL"),
      `cause: ${c.cause}; down detected by "${c.downDetectedBy}" after ${c.downDetectedAfterMs} ms; reconnect ${c.reconnectMs} ms in ${c.attempts} attempts${c.error ? "; " + c.error.message : ""}${isAndroid(r) ? "" : " | NON-ANDROID"}`, r._file);
  }
}

// R9 OPEN versus responsiveness (three separate findings)
{
  const r = [...results].reverse().find(x => x.stall && x.stall.status === "PASS");
  if (!r) {
    add("R9a", "OPEN state versus peer responsiveness: silent peer, socket stays OPEN, detection time", "NOT VERIFIED", "no stall result", "none");
    add("R9b", "Backlog behavior: stale replies after a peer stops reading", "NOT VERIFIED", "no stall result", "none");
    add("R9c", "Browser detection of a dropped connection and reopen time", "NOT VERIFIED", "no stall result", "none");
  } else {
    const s = r.stall;
    const note = isAndroid(r) ? "" : " | NON-ANDROID";
    const verdictFor = ok => (!isAndroid(r) ? "NOT VERIFIED" : (ok ? "PASS" : "FAIL"));
    add("R9a", "OPEN state versus peer responsiveness: silent peer, socket stays OPEN, detection time",
      verdictFor(s.silent?.appLevelUnresponsiveAfterMs !== null && s.silent?.controlAcknowledged),
      `readyState stayed OPEN: ${s.silent.readyStateStayedOpen}; browser close fired within ${s.silent.observedSec} s: ${s.silent.browserCloseFiredDuringStall}; ` +
      `app-level "no reply for ${s.silent.unresponsiveThresholdMs} ms" detected ${s.silent.appLevelUnresponsiveAfterLastReplyMs ?? "?"} ms after the last reply (${s.silent.appLevelUnresponsiveAfterMs} ms after the stall command was acknowledged); ` +
      `replies during stall ${s.silent.repliesDuringStall}${note}`, r._file);
    add("R9b", "Backlog behavior: stale replies after a peer stops reading",
      verdictFor(s.pause?.controlAcknowledged),
      `peer paused ${s.pause.pauseSec} s; readyState samples ${JSON.stringify(s.pause.readyStateSamples)}; ` +
      `max bufferedAmount ${s.pause.maxBufferedAmountBytes} B; replies during pause ${s.pause.repliesDuringPause}; ` +
      `stale replies after resume ${s.pause.staleRepliesAfterResume} (max RTT ${s.pause.maxStaleRttMs} ms)${note}`, r._file);
    add("R9c", "Browser detection of a dropped connection and reopen time",
      verdictFor(s.drop?.controlAcknowledged && s.drop?.browserCloseEventAfterMs !== null),
      `close event after ${s.drop.browserCloseEventAfterMs} ms (code ${s.drop.closeCode}, wasClean ${s.drop.wasClean}); reopen ${s.drop.reopenOutcome} in ${s.drop.reopenMs} ms${note}`, r._file);
  }
}

// R10 hidden page
{
  const r = [...results].reverse().find(x => x.hidden && x.hidden.hiddenIntervals?.length);
  if (!r) add("R10", "Hidden page: timers, WebSocket and camera behavior and recovery", "NOT VERIFIED", "hidden-page test not run or never hidden", "none");
  else {
    const h = r.hidden;
    add("R10", "Hidden page: timers, WebSocket and camera behavior and recovery", isAndroid(r) ? "PASS" : "NOT VERIFIED",
      h.hiddenIntervals.map(i => `hidden ${i.hiddenMs} ms: timer max gap ${i.timerMaxGapMs} ms, echoes sent ${i.echoSentWhileHidden} / replied ${i.echoRepliesWhileHidden}, ` +
        `readyState on return ${i.readyStateOnReturn}, close events ${i.closeEvents}, camera track ${i.trackReadyStateOnReturn}, first reply after return ${i.firstReplyAfterReturnMs} ms`).join(" || ") +
      (isAndroid(r) ? "" : " | NON-ANDROID"), r._file);
  }
}

// R11 Android OS behavior on a no-internet Wi-Fi: manual observations only
{
  const list = results.filter(r => ["N1", "N2"].includes(r.variant) && r.manual && r.manual.wifi);
  if (!list.length) add("R11", "Android OS behavior on a no-internet Wi-Fi (prompt, default network, LAN reachability)", "NOT VERIFIED", "no N1/N2 result with manual observations", "none");
  else add("R11", "Android OS behavior on a no-internet Wi-Fi (prompt, default network, LAN reachability)", "PASS",
    "MANUAL OBSERVATIONS (not measurements): " + list.map(r => `${r.variant} via "${r.manual.wifi}", mobile data ${r.manual.mobileData}, prompt ${r.manual.noInternetPromptSeen}, ` +
      `no-internet icon ${r.manual.wifiIconNoInternet}, phone kept Wi-Fi for the page ${r.manual.phoneKeptWifiForPage}; page loaded from ${r.env?.host}; ` +
      `models ${r.models?.status ?? "not run"}`).join(" | "), files_(list));
}

// R12 application endpoint test (NOT the OS connectivity check)
{
  const r = [...results].reverse().find(x => x.endpoints);
  if (!r) add("R12", "Application endpoint test: fetch of /generate_204 (this is NOT Android's OS connectivity check)", "NOT VERIFIED", "no endpoint result", "none");
  else add("R12", "Application endpoint test: fetch of /generate_204 (this is NOT Android's OS connectivity check)",
    r.endpoints.sameOrigin204?.ok && r.endpoints.sameOrigin204.status === 204 ? (isAndroid(r) ? "PASS" : "NOT VERIFIED") : "FAIL",
    `same origin: ${JSON.stringify(r.endpoints.sameOrigin204)}; other origin: ${JSON.stringify(r.endpoints.otherOrigin204)}`, r._file);
}

// R13 local-network permission
{
  const r = [...results].reverse().find(x => x.env);
  if (!r) add("R13", "Chrome local-network permission state and prompt observed", "NOT VERIFIED", "no environment result", "none");
  else add("R13", "Chrome local-network permission state and prompt observed", isAndroid(r) ? "PASS" : "NOT VERIFIED",
    `permission API: ${JSON.stringify(r.env.localNetworkPermission)}; prompt seen (manual): ${r.manual?.localNetworkPromptSeen ?? "unknown"}`, r._file);
}

// R14 wake lock
{
  const r = [...results].reverse().find(x => x.wakeLock);
  if (!r) add("R14", "Screen Wake Lock available and granted", "NOT VERIFIED", "no wake-lock result", "none");
  else add("R14", "Screen Wake Lock available and granted",
    !isAndroid(r) ? "NOT VERIFIED" : (r.wakeLock.status === "PASS" ? "PASS" : "FAIL"),
    `status ${r.wakeLock.status}${r.wakeLock.error ? ", " + r.wakeLock.error.message : ""}`, r._file);
}

// R15 / R16: fixed statements
add("R15", "Real ESP32 Wi-Fi access point behavior (DHCP, connectivity check, power save, client limits)", "NOT VERIFIED",
  "No ESP32 firmware exists and none was written. Nothing in this spike measures a real ESP32 AP.", "n/a");
add("R16", "A laptop hotspot or router stands in for the ESP32 AP", "NOT VERIFIED",
  "By design: a stand-in network does not prove ESP32 AP compatibility.", "n/a");

// ------------------------------------------------------------------ output

const out = [];
out.push(includeFabricated && fabricated.length
  ? "*** SELF-TEST ONLY: this report INCLUDES FABRICATED DATA and proves nothing about a phone ***"
  : "Phase 2B-0 spike result report");
out.push(`results directory: ${dir}`);
out.push(`result files used: ${results.length}; fabricated files ${includeFabricated ? "INCLUDED" : "ignored"}: ${fabricated.length}`);
out.push("verdicts: PASS, FAIL, NOT VERIFIED, LIMITATION (insecure-context camera only)");
out.push("");

for (const row of rows) {
  out.push(`${row.id}  [${row.verdict}]  ${row.requirement}`);
  out.push(`      ${row.detail}`);
  if (row.evidence) out.push(`      evidence: ${row.evidence}`);
}

const counts = {};
for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
out.push("");
out.push(`totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);

console.log(out.join("\n"));

if (mdPath) {
  const md = [
    `# ${out[0]}`, "", ...out.slice(1, 5).map(l => `- ${l}`), "",
    "| ID | Verdict | Requirement | Detail |", "|---|---|---|---|",
    ...rows.map(r => `| ${r.id} | ${r.verdict} | ${r.requirement} | ${String(r.detail).replace(/\|/g, "/")} |`), ""
  ].join("\n");
  fs.mkdirSync(path.dirname(path.resolve(mdPath)), { recursive: true });
  fs.writeFileSync(mdPath, md);
  console.log(`markdown written: ${mdPath}`);
}
