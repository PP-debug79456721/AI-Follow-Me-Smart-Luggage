# esp32-motor-test (M3: authored only)

> **NEVER COMPILED, NEVER FLASHED, NEVER RUN. Every GPIO is UNVERIFIED. Every threshold is UNSET.**
> **No motor power, no relay power and no hardware has been connected to this code.**

A bench tool to test **one motor at a time** over **USB serial only**. No Wi-Fi, no WebSocket, no
Follow/protocol code. It shares nothing with `firmware/esp32-follow/` (the Demo stays motor-locked).

## Files

| File | Role |
|---|---|
| `motor_test_config.h` | Pins, limits, thresholds (M1-M2, pure) |
| `bench_interlock.h`, `bench_session.h` | Interlock and state machine (M1-M2, pure, host tested) |
| `bench_driver.h` | **The only file that touches hardware** (M3) |
| `esp32-motor-test.ino` | Sequencing only (M3) |
| `host/motor_test_host.cpp` | Host tests of the pure logic |

## Commands

`arm`, `disarm`, `l <1-20>`, `r <1-20>`, `s`, `status`. `b` is always rejected. Duty is a percent, cap 20.
A rejected command while RUNNING forces all motor outputs safe. The Reset button (GPIO22) only clears a
recoverable FAULT and never arms.

## Startup and watchdog order

1. `setup()`: every output (relay, both EN, both LPWM, both RPWM) latched LOW, then set to OUTPUT.
2. Serial, then watchdog: `esp_task_wdt_reconfigure()`; only on `ESP_ERR_INVALID_STATE` fall back to
   `esp_task_wdt_init()`; any other error is a startup failure. `trigger_panic = true`.
3. LEDC on the two **RPWM** pins only. `ledcAttach()` requests PWM at 5000 Hz, 8-bit (`kPwmFreqHz`,
   `kPwmResolutionBits`) on both pins, then `ledcWrite(pin, 0)` sets duty to 0 on both. Startup checks the
   result of the two attaches and the two writes **only**; every return value is checked. The actual
   frequency is **not verified by readback** (no readback API is used; the Core's readback returns 0 at
   duty 0). LPWM is never attached and never driven.
   Serial prints one line per step (`pwm step1..4 ... PASS/FAIL`), then
   `pwm requested=5000Hz/8bit FREQUENCY NOT VERIFIED (no readback at duty 0)` and
   `pwm failure code=N` (0 none, 1 attach left, 2 attach right, 3 write left, 4 write right).
   The first failing step stops startup (INERT, `startup error=2`).
4. Only if 2 and 3 succeeded: create and begin the session.
5. `loop()`: subscribe the loop task (`esp_task_wdt_add`) on the first iteration, then each iteration
   reads inputs, handles one serial line, ticks the session, checks output health, and feeds the
   watchdog (`esp_task_wdt_reset`) **last**, only if everything succeeded.

**Startup failure = INERT:** relay off, EN low, no session, no commands read, ARM impossible.
**Output failure at run time = STARVED:** forced safe, watchdog deliberately not fed.

No `ledcDetach`, `ledcChangeFrequency`, frequency readback, tone, note, fade, invert or channel API is used.

**The watchdog is a software containment layer. It is not a hardware motor kill.** The independent kill is
the E-stop contact in the relay coil circuit. LEDC keeps running during a CPU stall until a reset.

## Not verified (do not assume)

- Compiles with Arduino-ESP32 3.3.12 (never compiled). `analogSetPinAttenuation`, `ADC_11db`,
  `analogReadMilliVolts` and the LEDC calls are used as read from source on the web, not built.
- The shipped classic-ESP32 `sdkconfig`, the exact ESP-IDF patch, and `esp_task_wdt_*` in the libs.
- Pad levels during reset, brownout and a watchdog reset; GPIO glitches on `ledcAttach`.
- The real PWM frequency: startup does not read it back, so it is unconfirmed until measured externally
  (scope or frequency counter, duty above 0, in the separately approved bench step).
- `kPwmFreqHz` (5000), `kPwmResolutionBits` (8), `kWdtTimeoutMs` (1000), `kWdtIdleCoreMask` (core 0):
  proposals, unmeasured.
- Thresholds: all UNSET in `makeThresholds()`, so ARM is refused until measured values are filled in (M4).

## Windows build machine must check before trusting this

Core folder and `platform.txt`/`package.json` = 3.3.12; libs `versions.txt` (ESP-IDF patch) and classic
`sdkconfig` (`CONFIG_ESP_TASK_WDT_*`, `CONFIG_ESP_SYSTEM_PANIC*`, brownout, `CONFIG_ARDUINO_RUNNING_CORE`);
the real `esp_task_wdt.h` and `soc_caps.h`; a warnings-on compile; the serial line that names the watchdog
branch; then scope captures (loop stall, watchdog reset, brownout, USB plug/unplug, flashing).
