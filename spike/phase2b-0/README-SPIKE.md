# Phase 2B-0 deployment spike (throwaway)

This directory is **not production code**. It exists only to answer, on the real
Android phone, whether the camera, the AI model runtime and a WebSocket can work
together under a given hosting arrangement. It does not talk to an ESP32, does not
speak protocol v2, drives no motor and contains no firmware.

| File | Purpose |
|---|---|
| `server.mjs` | Dependency-free Node stand-in server: serves the page, a WebSocket echo endpoint with test modes, `/ping`, `/generate_204`, and `POST /result` |
| `spike.html`, `spike.js` | The test page (does not import any production file) |
| `analyze.mjs` | Turns saved results into PASS / FAIL / NOT VERIFIED per requirement |
| `make-cert.sh` | Makes a self-signed certificate for the https/wss variants |
| `results/` | Created when you press Save |

## What this spike can and cannot show

- **Real ESP32 AP behavior is NOT VERIFIED.** No firmware exists and none is written here.
- **A laptop hotspot, router or any other stand-in does not prove ESP32 AP compatibility.**
  It only shows how Android and Chrome behave on *a* network with no internet.
- **`/generate_204` on the stand-in server is an application endpoint test only.** Android
  decides whether a Wi-Fi "has internet" in the OS, against its own fixed hostnames. Fetching
  `/generate_204` from the page does **not** reproduce or influence that check. What the OS
  does on a no-internet Wi-Fi is recorded only through the **manual observations** form.
- **WebSocket OPEN is not responsiveness.** The stall test records the browser's `readyState`
  and the time until the *application* sees no replies, separately from any browser close
  event (test 7).
- **Camera, model and WebSocket are tested together** (test 6, "Concurrent"), on the actual
  phone, because they compete for the same CPU and network.
- **L2 (`http://<LAN IP>`) camera results are an insecure-context limitation**, not a camera
  defect. Chrome does not offer `getUserMedia` on that origin. The WebSocket on L2 is tested
  separately.
- The model test loads the MediaPipe runtime and the EfficientDet-Lite0 model from the same
  CDN URLs as `js/ai-owner.js` into the **phone's browser only** (check `MEDIAPIPE_VERSION` in
  `spike.js` against `js/ai-owner.js`). Nothing is stored in the repository.

## Variants

| ID | Page served from | WebSocket | Network | Notes |
|---|---|---|---|---|
| H1 | Codespaces forwarded port (https) | `wss://` same host | Phone on normal internet | Keep the port **private**. Results land in the Codespace. |
| L1 | `http://localhost:8080` via `adb reverse` | `ws://<laptop LAN IP>:8080/ws` | Phone and laptop on one Wi-Fi | Camera should work (localhost is a secure context). |
| L2 | `http://<laptop LAN IP>:8080` | `ws://` same host | same | Camera limited (insecure context); test WebSocket only. |
| L3 | `https://<laptop LAN IP>:8443` (self-signed) | `wss://` same host | same | Accept the certificate warning first. |
| L4 | `https://` page | `ws://<laptop LAN IP>:8080/ws` | same | Mixed-content check; enter the insecure host in the field. |
| N1 | L1 or L3 | as chosen | Phone on a no-internet Wi-Fi, mobile data **on** | Fill in the manual observations. |
| N2 | L1 or L3 | as chosen | No-internet Wi-Fi, mobile data **off** | Model loading is expected to fail without internet. |

You do not have to run every variant. The analyzer reports NOT VERIFIED for any that were not run.

## Before you start

1. A laptop with **Node 18 or newer**. Copy this whole `spike/phase2b-0/` directory to it.
2. Android Chrome on the target phone. For L1: USB debugging on, `adb` installed.
3. For L3/L4: `./make-cert.sh <laptop LAN IP>`, then start the server with
   `CERT_FILE=certs/cert.pem KEY_FILE=certs/key.pem node server.mjs`. Never commit `key.pem`.
4. The stand-in server has **no authentication**. Run it only on a private Codespaces port or a
   network you trust.

## Procedure

**Start the server** (`node server.mjs`). It prints the URLs. Defaults: HTTP 8080, HTTPS 8443
when a certificate is given. Results go to `results/`.

**H1 (Codespaces):** in the Codespace run `node spike/phase2b-0/server.mjs`. In the Ports tab check
that port 8080 is **Private**. On the phone, open the printed Codespaces URL (you must be signed in
to GitHub). The WebSocket URL field fills in `wss://<same host>/ws`.

**L1:** on the laptop run `adb reverse tcp:8080 tcp:8080`, open `http://localhost:8080/spike.html` on the
phone, set the WebSocket URL to `ws://<laptop LAN IP>:8080/ws`. Variant `L1`.

**L2:** open `http://<laptop LAN IP>:8080/spike.html`. Variant `L2`.

**L3:** on the phone first open `https://<laptop LAN IP>:8443/ping` and accept the warning. Then open
`https://<laptop LAN IP>:8443/spike.html`. Variant `L3`. Enter `<laptop LAN IP>:8443` in the wss field
and set "certificate exception already accepted" to `yes`. To record the *before* case, run test 9 once
before accepting the warning (`no`) and once after (`yes`).

**L4:** open the https page (L3 or H1) and enter `<laptop LAN IP>:8080` in the insecure ws:// field,
then run test 8. Variant `L4`.

**N1/N2:** put the laptop on a hotspot or router with **no internet**, join it with the phone, and
open the page as in L1 or L3. Set mobile data on (N1) or off (N2). Note any Android prompt and the
Wi-Fi icon, and fill in the manual observations.

**On every page**
1. Pick the variant, check the WebSocket URL.
2. Press **Run all**. It runs environment, camera (5 s), endpoints, WebSocket (duration field), models,
   **concurrent** (camera + detector + WebSocket), and stall/drop. Use `300` seconds for a formal
   round-trip result; a shorter run is reported as informational only.
3. Run the manual probes separately:
   - **10 Reconnect probe:** when the log says so, stop the stand-in server (or toggle Wi-Fi) and start
     it again. Choose the cause in the form.
   - **11 Hidden page:** press it, then lock the screen or switch app for 10 to 20 seconds, come back,
     press **Finish hidden test**.
4. Fill in the manual observations, then **Save results to server**. If saving fails use
   **Download JSON**.

## Analyze

```
node analyze.mjs                      # reads ./results
node analyze.mjs path/to/results --md report.md
```

Copy `results/*.json` into this directory (or paste them to the reviewer) and run the analyzer.
Files with `"fabricated": true` are ignored unless `--include-fabricated` is given; that option is
for the self-test only and the report is then headed SELF-TEST ONLY.

## Requirements reported

R1 camera per variant (L2 as a limitation, R1-L2) - R2 model runtime per variant - R3 concurrent camera +
model + WebSocket on the phone (R3b: round trip within the 300 ms protocol gate) - R4 `ws://` from localhost
(R4b: from the L2 page) - R5 mixed content outcome - R6 self-signed `wss://` - R7 round trip and jitter at 5
messages per second - R8 reconnect - R9a/b/c OPEN versus responsiveness, backlog, drop detection - R10 hidden
page - R11 Android OS behavior on a no-internet Wi-Fi (manual observations only) - R12 application endpoint
test (not the OS check) - R13 local-network permission - R14 Wake Lock - R15 real ESP32 AP (always NOT
VERIFIED) - R16 stand-in network as proof (always NOT VERIFIED).

## Known limitations

- A desktop or headless browser cannot stand in for the phone: the analyzer only gives PASS for the
  phone-dependent requirements when the result's user agent contains `Android`.
- The page cannot see which network (Wi-Fi or mobile data) a request used; that is why N1 and N2 are
  compared by outcome and by your manual notes.
- Browsers expose no WebSocket ping/pong, so peer responsiveness is measured with application messages.
- The spike duplicates the MediaPipe URLs from `js/ai-owner.js`; they can drift if that file changes.
- `results/` and any `certs/` directory are untracked files; do not commit private keys.
