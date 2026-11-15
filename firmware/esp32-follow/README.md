# esp32-follow: firmware (PHASE 2, motor output enabled)

> **Motor output is ENABLED** through `BtsMotorHal` (`bts_motor_hal.h`): 2x BTS7960 + relay on GPIO32.
> Pins in `config.h` match the wiring diagram and were spun with `quick-spin`.
> **Obstacle check is OFF** until HC-SR04 sensors are wired and `kUltrasonicInstalled = true`.
> The phase-1 originals are kept in `backup-phase1/`.

## Phase 2 changes

| File | Change |
|---|---|
| `config.h` | Real pins (L 25/26/13, R 27/14/33, relay 32), one EN per side, drive duty 0.25, turn ratio, ramp, direction flags, ultrasonic switch |
| `bts_motor_hal.h` | NEW. Real driver. STOP = duty 0 + EN low at once; movement = relay on, settle 250 ms, EN high, soft-start ramp. LEDC write failure latches everything off |
| `sonar_sources.h` | NEW. `HcSr04Source` (two sensors, alternating) and `NoSensorClearSource` (no protection, used when sensors are absent) |
| `esp32-follow.ino` | Uses `BtsMotorHal`, calls `hal.service()` after each kernel tick, loop watchdog on, status line shows relay and duty |

Unchanged: `protocol.h`, `safety.h` (still the ONLY writer of motor output), `ultrasonic.h`, WebSocket files.
Stops: STOP/ESTOP from the app, 600 ms movement watchdog, 600 ms session liveness, socket closed,
Wi-Fi lost, obstacle (if enabled), loop watchdog reset. Hardware kill: E-STOP switch in the relay coil.

---

## Phase 1 notes (historical)

## What exists

| File | Purpose | Status |
|---|---|---|
| `protocol.h`, `json_lite.h` | Protocol v2 device core, a port of `js/mock-esp32.js` | Matches the mock on a host (conformance tests). Never run on a board. |
| `safety.h` | Safety kernel: the ONE writer of motor output. `output = protocol motor AND NOT interlock` | Host tested |
| `motor_hal.h` | HAL interface, `LockedMotorHal` (no GPIO code), pure BTS7960 `planFor()` | Host tested. **No real driver exists.** |
| `ultrasonic.h` | Obstacle interlock logic and the `UltrasonicSource` interface | Host tested. No sensor is read; the null source keeps the interlock blocked. |
| `ws_frame.h`, `ws_handshake.h` | RFC 6455 frames, SHA-1, Base64, handshake | Host tested (RFC vectors) |
| `ws_server.h`, `esp32-follow.ino` | Wi-Fi STA + single-client WebSocket server on the Arduino-ESP32 core (no extra library) | **Syntax-checked against host stubs only** |
| `config.h` | Pins (proposals, `kPinsVerified = false`), port, kernel period | UNVERIFIED |

## The hardware output lock

- `LockedMotorHal` is the only `MotorHal`. It has no GPIO, PWM or pin code; no file in this
  directory calls any pin API (`tests/firmware-host.test.mjs` F3 scans for that).
- There is no build flag, runtime option or message that unlocks it. An app command can only
  reach `Protocol`, and the protocol core does not know the HAL exists.
- `planFor()` defaults to a duty cap of 0, so even a future real driver outputs nothing until
  a cap is chosen from measurements.
- A real driver would be a new class in a later, separately approved phase.

## Protocol v2 (unchanged)

STOP and ESTOP semantics, BOOT_LATCHED, both independent 600 ms timers (movement watchdog,
session liveness), lease, token, session, seq, age and proof checks, and the fixed check order
are ported as they are in `js/mock-esp32.js`. Local extension (not on the wire): `deviceStop()`,
used for the obstacle interlock and a lost socket. It follows the existing lease-expiry path:
motor STOP, MOVING to IDLE, did invalidated, no latch. Nothing resumes by itself.

## Tests (run from the repository root; no installs)

```bash
node --test tests/firmware-conformance.test.mjs   # C++ core vs the JavaScript mock, step by step
node --test tests/firmware-host.test.mjs          # kernel, interlock, WebSocket, lock checks
```

They need a host `g++`/`clang++` and are skipped without one. **They prove the C++ port matches
the mock on a computer. They do not prove anything about a real ESP32, Wi-Fi, timing or motors.**

## Before any motor phase (not done)

1. Match every pin to the NA709 / CB005 by continuity; measure boot-state levels.
2. Check the NA105 BTS7960 input threshold against 3.3 V; add a level shifter if needed.
3. Build with the real toolchain; fix whatever the stubs hid.
4. Replay the conformance transcripts against the real board (LEDs, no motor power).
5. Move the kernel tick to an independent timer, add a task watchdog, and prove the outputs
   go low when the kernel task is stopped on purpose.
6. Echo divider, stall current, fuse, battery and wiring checks.

## Building (on your own computer, later)

Board "ESP32 Dev Module", Arduino-ESP32 core, no extra libraries. Copy
`wifi_secrets.example.h` to `wifi_secrets.h` (git-ignored). Not done or verified here.
