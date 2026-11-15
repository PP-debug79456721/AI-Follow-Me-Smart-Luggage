// wheel-test: check wheel mapping, direction and balance for 2x BTS7960 (IBT-2).
// USB serial only (115200), no Wi-Fi. Pins/gains match esp32-follow config.h after
// the 2026-11-15 swap: 27/14/33 = physical LEFT wheel, 25/26/13 = physical RIGHT wheel.
//
// LIFT THE WHEELS for t / 1-6. The E-STOP switch in the relay coil is the hard kill.
// Any key while a step runs = STOP at once.
//
// Commands (type + Enter):
//   t   full test: runs steps 1..6 in order, prints what you MUST see at each step
//   1   LEFT wheel forward only          4   both forward (FORWARD)
//   2   RIGHT wheel forward only         5   turn LEFT  (right wheel faster)
//   3   both reverse                     6   turn RIGHT (left wheel faster)
//   f   drive straight forward for fwdMs on the floor (balance check), + / - = fwdMs +-250 ms
//   d   duty +5 %   D duty -5 %          s   stop
//
// What to fix if a step is wrong:
//   step 1 moves the RIGHT wheel  -> swap LEFT_* and RIGHT_* pins below (and in config.h)
//   a wheel turns BACKWARDS on 1/2 -> set LEFT_INVERT / RIGHT_INVERT = true (same in config.h)
//   'f' drifts right (right wheel slow) -> raise RIGHT_GAIN; drifts left -> lower it

#include <Arduino.h>

// ---- pins (physical wheels)
const int PIN_RELAY = 32;
const int LEFT_RPWM = 27, LEFT_LPWM = 14, LEFT_EN = 33;
const int RIGHT_RPWM = 25, RIGHT_LPWM = 26, RIGHT_EN = 13;

// ---- direction and balance (copy the final values into esp32-follow config.h)
const bool LEFT_INVERT = false;           // true: forward = LPWM
const bool RIGHT_INVERT = false;
const float LEFT_GAIN = 1.00f;
const float RIGHT_GAIN = 1.10f;

// ---- test settings
int dutyPct = 30;                         // d / D change it, 10..60
const int TURN_INNER_PCT = 60;            // inner wheel = duty * 60 % (as config.h kTurnInnerFraction)
const uint32_t STEP_MS = 2000;
const uint32_t PAUSE_MS = 1200;
const uint32_t RAMP_MS = 400;
const uint32_t RELAY_SETTLE_MS = 300;
uint32_t fwdMs = 2500;

const int PWM_PINS[4] = {LEFT_RPWM, LEFT_LPWM, RIGHT_RPWM, RIGHT_LPWM};

int counts(float pct) {                   // percent -> 0..255, never above 60 %
  if (pct < 0) pct = 0;
  if (pct > 60) pct = 60;
  return (int)(pct * 255.0f / 100.0f + 0.5f);
}

void allOff() {
  for (int i = 0; i < 4; i++) ledcWrite(PWM_PINS[i], 0);
  digitalWrite(LEFT_EN, LOW);
  digitalWrite(RIGHT_EN, LOW);
  digitalWrite(PIN_RELAY, LOW);
}

bool keyPressed() {
  if (Serial.available() > 0) {
    while (Serial.available() > 0) Serial.read();
    return true;
  }
  return false;
}

bool waitOrStop(uint32_t ms) {
  const uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    if (keyPressed()) return false;
    delay(5);
  }
  return true;
}

// signed percent per wheel: + forward, - reverse, 0 off
void writeWheel(bool left, float pct) {
  const bool invert = left ? LEFT_INVERT : RIGHT_INVERT;
  const int rpwm = left ? LEFT_RPWM : RIGHT_RPWM;
  const int lpwm = left ? LEFT_LPWM : RIGHT_LPWM;
  const float gain = left ? LEFT_GAIN : RIGHT_GAIN;
  const bool forward = pct >= 0;
  const int c = counts((pct < 0 ? -pct : pct) * gain);
  const int fwdPin = invert ? lpwm : rpwm;
  const int revPin = invert ? rpwm : lpwm;
  ledcWrite(forward ? revPin : fwdPin, 0);          // the other pin first, always 0
  ledcWrite(forward ? fwdPin : revPin, c);
}

// Runs one step with a soft start; returns false if a key stopped it.
bool runStep(const char* title, const char* expect, float leftPct, float rightPct, uint32_t ms) {
  Serial.printf("\n>>> %s\n    MUST SEE: %s\n", title, expect);
  Serial.printf("    duty L=%.0f%% R=%.0f%% (before gain)\n", leftPct, rightPct);
  digitalWrite(PIN_RELAY, HIGH);
  if (!waitOrStop(RELAY_SETTLE_MS)) { allOff(); return false; }
  digitalWrite(LEFT_EN, leftPct != 0 ? HIGH : LOW);
  digitalWrite(RIGHT_EN, rightPct != 0 ? HIGH : LOW);
  const int steps = 10;
  for (int i = 1; i <= steps; i++) {
    writeWheel(true, leftPct * i / steps);
    writeWheel(false, rightPct * i / steps);
    if (!waitOrStop(RAMP_MS / steps)) { allOff(); return false; }
  }
  const bool ok = waitOrStop(ms);
  allOff();
  Serial.println(ok ? "    done" : "    STOPPED");
  return ok;
}

bool step(int n) {
  const float d = dutyPct;
  const float inner = d * TURN_INNER_PCT / 100.0f;
  switch (n) {
    case 1: return runStep("1 LEFT wheel forward", "only the LEFT wheel turns, rolling FORWARD", d, 0, STEP_MS);
    case 2: return runStep("2 RIGHT wheel forward", "only the RIGHT wheel turns, rolling FORWARD", 0, d, STEP_MS);
    case 3: return runStep("3 both reverse", "both wheels roll BACKWARD", -d, -d, STEP_MS);
    case 4: return runStep("4 FORWARD", "both wheels roll FORWARD at about the same speed", d, d, STEP_MS);
    case 5: return runStep("5 turn LEFT", "RIGHT wheel faster than LEFT (luggage would turn LEFT)", inner, d, STEP_MS);
    case 6: return runStep("6 turn RIGHT", "LEFT wheel faster than RIGHT (luggage would turn RIGHT)", d, inner, STEP_MS);
  }
  return true;
}

void fullTest() {
  Serial.println("\n=== FULL WHEEL TEST (wheels lifted). Any key = STOP ===");
  for (int n = 1; n <= 6; n++) {
    if (!step(n)) { Serial.println("=== test stopped ==="); return; }
    if (!waitOrStop(PAUSE_MS)) { Serial.println("=== test stopped ==="); return; }
  }
  Serial.println("\n=== done. If every MUST SEE matched, copy pins/INVERT/GAIN into config.h ===");
}

void printHelp() {
  Serial.println("wheel-test: t=full test  1..6=single step  f=straight on floor  +/-=f time");
  Serial.println("            d/D=duty +-5%  s=stop. LIFT THE WHEELS for t and 1..6.");
  Serial.printf("duty=%d%%  fwdMs=%lu  gains L=%.2f R=%.2f  invert L=%d R=%d\n",
                dutyPct, (unsigned long)fwdMs, LEFT_GAIN, RIGHT_GAIN, LEFT_INVERT, RIGHT_INVERT);
}

void setup() {
  const int outs[3] = {PIN_RELAY, LEFT_EN, RIGHT_EN};
  for (int i = 0; i < 3; i++) { digitalWrite(outs[i], LOW); pinMode(outs[i], OUTPUT); digitalWrite(outs[i], LOW); }
  for (int i = 0; i < 4; i++) { digitalWrite(PWM_PINS[i], LOW); pinMode(PWM_PINS[i], OUTPUT); digitalWrite(PWM_PINS[i], LOW); }

  Serial.begin(115200);
  delay(300);

  bool ok = true;
  for (int i = 0; i < 4; i++) {
    ok = ledcAttach(PWM_PINS[i], 5000, 8) && ok;
    ok = ledcWrite(PWM_PINS[i], 0) && ok;
  }
  allOff();
  if (!ok) {
    Serial.println("PWM setup FAILED. Outputs off. Halting.");
    while (true) delay(1000);
  }
  printHelp();
}

void loop() {
  if (Serial.available() <= 0) { delay(5); return; }
  const char c = Serial.read();
  delay(20);
  while (Serial.available() > 0) Serial.read();

  switch (c) {
    case 't': fullTest(); break;
    case '1': case '2': case '3': case '4': case '5': case '6': step(c - '0'); break;
    case 'f': {
      Serial.printf("\n>>> STRAIGHT on the floor for %lu ms. Watch which way it drifts.\n", (unsigned long)fwdMs);
      runStep("f straight", "drives straight; drift right = raise RIGHT_GAIN, drift left = lower it",
              dutyPct, dutyPct, fwdMs);
      break;
    }
    case '+': fwdMs += 250; Serial.printf("fwdMs=%lu\n", (unsigned long)fwdMs); break;
    case '-': if (fwdMs > 250) fwdMs -= 250; Serial.printf("fwdMs=%lu\n", (unsigned long)fwdMs); break;
    case 'd': if (dutyPct < 60) dutyPct += 5; Serial.printf("duty=%d%%\n", dutyPct); break;
    case 'D': if (dutyPct > 10) dutyPct -= 5; Serial.printf("duty=%d%%\n", dutyPct); break;
    case 's': allOff(); Serial.println("STOP"); break;
    case 'h': case '?': printHelp(); break;
    default: break;
  }
}
