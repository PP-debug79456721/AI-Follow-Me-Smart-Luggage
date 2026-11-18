# AI Follow-Me Smart Luggage — handoff notes

Read this first. It records what was built, how the bench is set up and what is still open.
Last updated: 2026-11-15 (bench session). Working branch: **`esp32-link`**.

Goal: a suitcase that recognises its owner with a phone camera and follows them. The web app
detects the owner, decides STOP / FORWARD / LEFT / RIGHT and sends it over WebSocket to an
ESP32 that drives two BTS7960 motor drivers.

Language: the owner works in **Thai**. Answer in Thai unless asked otherwise.

---

## 1. Status (end of 2026-11-15)

| Part | Status |
|---|---|
| Motors, relay, BTS7960 x2 | Working (spun with `quick-spin`) |
| ESP32 firmware `esp32-follow` phase 2 (motor output enabled) | Working on the bench |
| Wi-Fi WebSocket link page <-> ESP32 | Stable after fixes (non-blocking writes, longer link timeout) |
| Person detection (MediaPipe, GPU ~216 ms on the laptop) -> direction -> wheels | Working |
| Phone camera (Android Chrome) | Working via chrome://flags (see 4) |
| Choosing the owner | Tap the person's box; on localhost also automatic (see 6, owner recognition) |
| **Face recognition of the owner** | **First version, localhost only, NOT yet tested on the real camera** |
| Obstacle sensors (2x AB043 / HC-SR04) | NOT wired yet; `kUltrasonicInstalled=false` (true without sensors = NO_ECHO blocks all motion) |
| E-STOP status to the ESP32 (GPIO23) | Not wired (see 3) |
| Right wheel slower than left, even lifted | Compensated in software (`kRightGain`); hardware cause not found |

---

## 2. Repository map (branch `esp32-link`)

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | Web app (served as static files) |
| `js/ai-owner.js` | Camera loop, MediaPipe face + person detection, tracker, motion decision |
| `js/person-tracker.js` | Tap-to-select tracking (TRACKING / SEARCHING / LOST) |
| `js/motion-decision.js` | Pure: target box -> STOP / FORWARD / LEFT / RIGHT |
| `js/motion-smoother.js` | Removes noise STOPs (miss hold, close hysteresis, turn hysteresis) |
| `js/esp32-link.js`, `js/esp32-session.js` | Protocol v2 client (tokens, leases, timeouts, ARM/FOLLOW) |
| `js/mock-esp32.js`, `js/mock-socket.js` | In-page mock device (`mock://device`) |
| `js/app.js` | Wiring + UI. Bench overrides live here (link timeouts, DEMO mode) |
| `firmware/esp32-follow/` | ESP32 firmware (Arduino, no extra libraries) |
| `firmware/esp32-motor-test/` | Older, very strict bench firmware (thresholds unset, ARM refused). Not used now |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs` (329 pass, 7 fail: see 8) |
| `models/` | Face model metadata; the ONNX file is NOT in git |

---

## 3. Hardware

ESP32 Dev Module (NA709 30-pin on CB005 terminal board). Pins (match `firmware/esp32-follow/config.h`):

| Signal | GPIO |
|---|---|
| Physical LEFT wheel BTS7960: RPWM / LPWM / EN (R_EN+L_EN tied, 10k to GND) | 27 / 14 / 33 |
| Physical RIGHT wheel BTS7960: RPWM / LPWM / EN (tied, 10k to GND) | 25 / 26 / 13 |

The wiring diagram calls 25/26/13 "left", but on the bench that board drives the RIGHT wheel
(LEFT commands turned right). config.h is swapped to the physical wheels. Before the swap,
kRightGain was boosting the physical LEFT wheel; the "weak right wheel" findings predate this.
| Relay (BC337 base -> relay coil pin 85) | 32 |
| E-STOP status input (planned) | 23 (not wired) |
| HC-SR04 trig/echo (planned, echo needs 5V->3.3V divider) | 18/34, 19/35 |

BTS7960 VCC = 3V3. Power (as drawn): LiPo 3S 1100 mAh -> 10 A fuse -> main switch -> (a) LM2596 5 V -> ESP32 VIN,
(b) E-STOP switch -> relay coil 86, relay 12 V 40 A 30->87 -> BTS7960 B+ x2.

**The 10 A fuse in the diagram is NOT installed (owner, 2026-11-15).** Advised: inline blade fuse
10-15 A on the battery + lead before the main switch, and keep kDriveDuty <= 0.60 until it is fitted.

**E-STOP is a 2-pin on/off switch (single contact).** It cuts the relay coil (real hardware kill) but
cannot also signal GPIO23. Planned: PC817 optocoupler from relay pin 86 (2.2k) -> D23/GND, so
D23 LOW = running, HIGH = stopped/wire open. Or replace with a 2-pole switch.

Recommended, not confirmed done: flyback diode across the relay coil.

Without the battery the ESP32 still runs on USB and the serial log shows `relay=ON` / `MOVING`,
but nothing turns (relay coil and B+ come from the battery).

---

## 4. Bench network and how to run it

- Wi-Fi hotspot is provided by **another Windows machine** at `192.168.137.1` (SSID/password are in
  `wifi_secrets.h`, which is git-ignored; never commit it). Hotspot band must be **2.4 GHz** and its
  power saving off, or the ESP32 cannot connect.
- Laptop (dev PC, Windows): Wi-Fi IP `192.168.137.158` (DHCP, may change; check `ipconfig`,
  adapter "Wireless LAN adapter Wi-Fi").
- ESP32 IP: DHCP, printed on serial as `WebSocket server: ws://<ip>:81/ws`. `config.h` kUseStaticIp
  (192.168.137.50) works only on the Windows hotspot; it is false now.
- Later on 2026-11-15 the bench moved to a phone hotspot (10.139.180.x, laptop 10.139.180.182) because
  the Windows hotspot added ~1 s RTT spikes. Phone page RTT was 300+ ms vs laptop 10-30 ms on the same
  Wi-Fi (phone main thread busy with MediaPipe) -> `?lite=1` (no face detection, 480x360).

### Web app
The page used on the bench is served from **`C:\follow-app`** on the laptop (a copy of `index.html`,
`css/`, `js/`, `models/`), NOT from the Codespace. The Codespace runs in a browser, so `localhost`
forwarding is not available and an `https://*.github.dev` page cannot open `ws://` to the ESP32.

Server (PowerShell **as Administrator**; firewall rule "follow-app 8000" already added):

```powershell
cd C:\follow-app
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:8000/")
$listener.Start()
while ($listener.IsListening) {
  $c = $listener.GetContext(); $p = $c.Request.Url.LocalPath.TrimStart("/")
  if (!$p) { $p = "index.html" }; $f = Join-Path "C:\follow-app" $p
  if (Test-Path $f -PathType Leaf) {
    $b = [IO.File]::ReadAllBytes($f)
    $c.Response.ContentType = switch ([IO.Path]::GetExtension($f)) { ".html" {"text/html; charset=utf-8"} ".js" {"application/javascript"} ".css" {"text/css; charset=utf-8"} ".json" {"application/json"} default {"application/octet-stream"} }
    $c.Response.Headers.Add("Cache-Control", "no-store"); $c.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $c.Response.StatusCode = 404 }
  $c.Response.Close()
}
```
Clicking inside that PowerShell window pauses it ("Select" mode) and the page stops loading: press Esc.

After changing web files in the repo, copy them to `C:\follow-app\js\` (only ai-owner.js, app.js and
motion-smoother.js differ from the original copy). Note: `C:\follow-app\js\app.js` keeps one local line
that differs from the repo (`status.lastEvent === "DEVICE_BUSY"` for the DEVICE BUSY label).

- Laptop: `http://localhost:8000`
- Phone (Android Chrome, on the same hotspot, mobile data off): `http://192.168.137.158:8000`
  needs `chrome://flags` -> "Insecure origins treated as secure" = `http://192.168.137.158:8000`,
  Enabled, Relaunch. iPhone is not supported (needs HTTPS, which blocks `ws://`).
- DEMO mode: add `?mode=demo` (label shows "· DEMO"), see 6.
- Only ONE page may be connected to the ESP32 at a time; a second one causes DEVICE BUSY and jerky motion.
- Convenience (app.js): the URL is remembered (localStorage); after CONNECT the page reconnects by itself
  (also on reload and after DEVICE BUSY) until DISCONNECT. FOLLOW is never re-armed automatically.
  Screen Wake Lock keeps the phone screen on while FOLLOW is on. busyMaxMs 4000.

Flow: START CAMERA -> stand 2-3 m away -> tap the owner's box (TRACKING) -> URL `ws://<esp32-ip>:81/ws`
-> CONNECT -> `CONNECTED (STOP)` -> ARM / FOLLOW.

### Firmware upload (Arduino IDE 2.3.10, board "ESP32 Dev Module", Arduino-ESP32 core 3.x)
Sketch folder on the laptop: `C:\Users\pawar\Documents\ESP32-Firmware\esp32-follow`.
**Arduino IDE auto-saves its open buffers and has overwritten externally edited files several times.**
Before editing files outside the IDE, close the IDE; after editing, reopen the sketch (File -> Open)
before Upload. Small changes are safer made inside the IDE.

`quick-spin` (separate sketch, USB serial, no Wi-Fi): `l/L r/R b/B` spin, `f` drive straight for fwdMs,
`+/-` adjust fwdMs, `s` stop, any key stops a run. Used to check motors without the follow stack.

---

## 5. Firmware `esp32-follow` phase 2 (what changed from the locked phase 1)

- `bts_motor_hal.h` (new): the only pin writer for motors, called only by `SafetyKernel`.
  STOP = duty 0 + EN low at once; movement = relay on, 250 ms settle, EN high, soft-start ramp.
  Relay stays on 5 s after the last movement. LEDC write failure latches everything off.
- `config.h`: real pins, one EN per side, `kDriveDuty 0.60` (<= 0.60 until the 10 A fuse is fitted), `kDutyMax 0.80` (static_assert),
  `kRampPerSecond 2.5`, `kTurnInnerFraction 0.60`, `kLeftGain 1.00`, `kRightGain 1.10`,
  `kUltrasonicInstalled false` (2x AB043 = HC-SR04 planned: trig 18/19, echo 34/35 via 1k/2k; true without the
  sensors wired = NO_ECHO blocks all motion), `kStopDistanceMm 500`.
  Serial adds `sonar=<mm|clear|NO_ECHO>/<...>` when the sonar is on.
- **Transports (2026-11-17)**: `kEnableWifi` / `kEnableBle` in `config.h`, both true by default. Wi-Fi WebSocket
  and Bluetooth LE feed the SAME protocol + safety kernel through `transport_router.h` (replies go back to the
  channel that sent the message; ANY channel closing stops the motors). BLE = `ble_server.h`, Nordic UART service
  (`6E400001-...` service, `6E400002` RX write, `6E400003` TX notify), one JSON message per line ended by `\n`,
  `ble_framing.h` (portable, host-tested). BLE callbacks only queue lines; `loop()` delivers them.
  **BLE glue is NOT compiled against the real ESP32 toolchain and never ran on a board.** Needs Tools -> Partition
  Scheme -> "Huge APP (3MB No OTA/1MB SPIFFS)". The notify descriptor (CCCD 2902) must be added by hand (`BLE2902`); without it phones say "no CCCD". Web side: `js/ble-socket.js` (URL `ble://`, optional `ble://?chunk=100`) makes Web Bluetooth look like a WebSocket, so the
  session/link/protocol are unchanged; tests/ble-socket.test.mjs uses a FAKE Bluetooth device. **Never tried on a real phone/board.**
  The chooser needs a user gesture (the CONNECT click); the chosen device is kept for reconnects, a page reload forgets it.
  Android Chrome only (no iPhone). Also testable with nRF Connect.
  Serial status adds `wifi=<status code>` and `ble=<connected>/<connects> blereq=<n> bledrop=<in>/<out>`.
  **BLE RTT (2026-11-18)**: measured 100-300 ms, 60-291 ms with Wi-Fi off. Camera on/off and `?chunk=` made no difference.
  Firmware now asks the phone for a 15-30 ms connection interval right after connecting (`kBleMinInterval/kBleMaxInterval/
  kBleLatency/kBleSupervisionTimeout`, `blereq` counts requests; the phone may refuse) and `kEnableWifi` defaults to false
  (its endless scanning shares the radio). The link's RTT gate (`rttGateMs` 300, max of the last 3 samples, esp32-link.js)
  was NOT changed: BLE peaks near 300 ms can trigger `RTT_GATE` STOPs. Not yet measured after the connection-interval change.
- `sonar_sources.h` (new): HC-SR04 source and a "no sensor" source (no obstacle protection).
- `ws_server.h`: all writes are non-blocking (`send(MSG_DONTWAIT)`). The core's `WiFiClient::write`
  can block ~10 s and caused loop stalls, link timeouts and a task-watchdog reset.
- `esp32-follow.ino`: `ProtocolConfig` movementWatchdogMs/sessionLivenessMs 1200, ageClaimMaxMs 1200,
  evidenceMaxMs 1500 (upper limits; the page decides what it sends). Wi-Fi reconnect via
  autoReconnect + `WiFi.reconnect()` every 10 s (the old disconnect+begin every 2 s never reconnected).
  Loop watchdog on. Serial status line once per second:
  `state motor(effective) interlock relay dutyL dutyR output stop acc rej rate latch lastrej wd drop maxgap`.
  `maxgap` = longest loop gap in ms (healthy ~12). `drop` = WebSocket frames not sent.
- Phase-1 originals are in `backup-phase1/` in the sketch folder on the laptop.

---

## 6. Web app bench changes (this session)

- `ai-owner.js`: person detection every 200 ms (was 500, which made every decision stale against
  the link's 450 ms age limit -> wheels only pulsed). Person detector uses GPU, CPU fallback. Face
  detection every 500 ms. The PERSON DETECTION card shows `N PERSON(S) · <gap> ms · GPU|CPU`
  (needs to stay below ~300 ms for smooth motion).
- `app.js`: `linkOptions` linkTimeoutMs / handshakeTimeoutMs / pendingTtlMs 1200 (phone Wi-Fi stalls
  dropped ARM at 600). Protocol defaults, the mock and their tests stay at 600 on purpose.
- `motion-smoother.js` (+ tests): one missed detection repeats the last movement for <= 400 ms
  (DEMO 1000 ms) with its ORIGINAL detection time; after a "close enough" STOP (box height >= 80 %)
  resume only below 70 %; turn hysteresis. Lost target, stale data, camera loss, ESTOP, link loss
  stay immediate STOPs.
- DEMO mode `?mode=demo`: holdMs 1000, ageClaimMaxMs 1200, evidenceMaxMs 1500 (normal 450 / 700).
- Stop height: bench default 0.95 (BENCH_STOP_HEIGHT in ai-owner.js; motion-decision default stays 0.80),
  `?stop=0.80` overrides. Resume 0.08 below it (95 % / 87 %; 0.05 stop-went). MOTOR COMMAND shows the box height %.

- **Owner recognition (localhost only, not in lite mode)** — `js/owner-recognizer.js` (pure, 15 tests) +
  owner section in `ai-owner.js` + buttons ENROL OWNER FACE / FIND OWNER / FORGET OWNER (index.html, app.js).
  Face: SFace via model-policy (needs `http://localhost:8000/?modelMode=development`), 5 samples stored as
  128-D vectors in localStorage `owner.face.v1` (no images), cosine >= 0.363, 3 of 5 rounds, margin 0.05,
  at most 2 faces per 0.7 s. Back view: clothing colour signature (torso + legs hue/sat histograms) of the
  followed box, refreshed every 0.5 s only while it overlaps nobody, Bhattacharyya >= 0.80, margin 0.06,
  3 of 5 rounds. Method A (clothing) works without the face model and also in lite mode: REMEMBER CLOTHES
  starts a new clothing ALBUM (up to 8 views: back/front/side/light; `learnIntoAlbum` in owner-recognizer.js)
  stored in localStorage `owner.cloth.v2` (histograms only). ADD VIEW adds the current view manually; while
  TRACKING alone, crops >= 0.88 blend into a view, 0.55-0.88 become a new view (max 1 per 2 s), < 0.55 skipped;
  OWNER line shows `เสื้อผ้าตรง <score>` while following and the best candidate score while LOST.
  **Re-ID (OSNet x0.25 MSMT17, chosen 2026-11-15, see models/MODEL_METADATA.md "reid")**: code ready
  (`reid-model-config.js`, Re-ID album `owner.reid.v1` up to 12 x 512-D, learn while TRACKING alone 1/s,
  re-acquire every 0.5 s on <= 3 boxes, cosine >= 0.65 margin 0.05, 3 of 5; when loaded it decides instead
  of clothing). Converted 2026-11-15 (`tools/convert-osnet-to-onnx.py`, 891,011 bytes, SHA-256 53e392a3...);
  manifest `reid` is DEVELOPMENT_ONLY, file only in `C:\follow-app\models\person-reid\person-reid.onnx`.
  Loads only with `http://localhost:8000/?modelMode=development`. Not yet tested on the real camera.
  Auto-select only while NOT_SELECTED/LOST, never after CLEAR SELECTION until a tap or
  FIND OWNER; ambiguous -> nobody. Thresholds are starting values, not tuned on the real camera.
  tests/e2e/phase-c expects the face model row "OFF" on localhost and will need updating.

Safety rules the owner agreed to keep: no "never stop" mode. ESTOP, link loss, lost owner, camera loss
always stop. The hardware E-STOP switch is the independent kill.

---

## 7. Open work (priority order)

1. **Face recognition of the owner** (original goal): first version done (localhost), needs real-camera
   testing and threshold tuning; phone (IP host) needs a model-policy decision. Pieces: SFace ONNX model
   (`models/face/face_recognition_sface_2021dec.onnx`, only on the owner's machines / `C:\follow-app\models`),
   `js/embedding/*`, `js/embedding/model-policy.js` (dev models only with `?modelMode=development` on
   localhost / Codespaces). `LOAD_RECOGNITION_MODELS = false` in `ai-owner.js`. Missing: owner enrolment,
   face-to-person-box matching, auto-select the owner's box, then keep following by body tracking when
   the owner turns away (the luggage behind the owner sees the back, not the face).
   Note: with the phone at `http://192.168.137.158:8000`, `?modelMode=development` is NOT allowed by
   model-policy.js (host check) — needs a decision.
2. Right wheel weaker: swap motor leads between drivers to tell motor/gearbox from driver/wiring; tune
   `kRightGain`.
3. E-STOP status to GPIO23 (PC817 or 2-pole switch).
4. HC-SR04 obstacle sensors (`kUltrasonicInstalled = true`, echo divider, set `kStopDistanceMm`).
5. Static IPs for the ESP32 (firmware) and the laptop, so URLs stop changing.
6. Rewrite the phase-1 lock tests (see 8).
7. Battery voltage monitoring (none on this firmware; LiPo must not go below ~9.9 V).

---

## 8. Known failing tests (expected)

`tests/firmware-host.test.mjs` F2-F6 and `tests/motor-test-host.test.mjs` MT7-MT8 assert the
PHASE-1 "motor output locked" state and a byte-identical fixture of the old firmware. They fail by
design since phase 2 enabled the motors and need rewriting for phase 2. Everything else passes.

---

## 9. Diagnostics cheat sheet

| Symptom | Look at | Usual cause |
|---|---|---|
| Wheels pulse, `LEASE_EXPIRED` on serial | PERSON DETECTION ms | detection too slow (> ~300 ms) |
| ARM drops, `LINK_TIMEOUT` / `HANDSHAKE_TIMEOUT` | serial `maxgap`, `drop` | Wi-Fi stall, ESP32 loop stall, 2 pages connected |
| `DEVICE BUSY` | other tabs/devices | another page is connected to the ESP32 |
| `sending: STOP (DECISION_STOP)` | MOTOR COMMAND, distance | person too close (box > 80 %), not TRACKING |
| serial `wifi:sta is connecting, cannot set config` | hotspot | hotspot off / 5 GHz / wrong credentials |
| `task_wdt` reset | serial | loop blocked (should be fixed by non-blocking writes) |
| `relay=ON` but nothing turns | battery, main switch, E-STOP switch | no motor power |
| Page shows old behaviour | `http://.../js/ai-owner.js` contains `FACE_INTERVAL`? | stale copy in `C:\follow-app` or cache |
