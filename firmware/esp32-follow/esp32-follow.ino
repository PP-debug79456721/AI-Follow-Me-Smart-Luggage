// ESP32 Follow-Me firmware: PHASE 2 (MOTOR OUTPUT ENABLED).
//
// Protocol v2 (a port of js/mock-esp32.js), the safety kernel, the obstacle interlock and a
// WebSocket server, now driving two BTS7960 boards and the motor-power relay through
// BtsMotorHal (bts_motor_hal.h). The SafetyKernel is still the ONLY writer of motor output.
//
// Stops: app STOP/ESTOP, 600 ms movement watchdog, 600 ms session liveness, lost socket,
// lost Wi-Fi, obstacle interlock (only if kUltrasonicInstalled), loop-task watchdog reset.
// Hardware kill independent of this code: the E-STOP switch in the relay coil circuit.
//
// Settings (duty, turn ratio, direction, ultrasonic on/off) are in config.h.
//
// Needs no extra library: board "ESP32 Dev Module" with the Arduino-ESP32 core.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_timer.h>

#include "config.h"
#include "motor_hal.h"
#include "protocol.h"
#include "safety.h"
#include "ultrasonic.h"
#include "bts_motor_hal.h"
#include "sonar_sources.h"
#include "ws_server.h"

#if !__has_include("wifi_secrets.h")
#error "Copy wifi_secrets.example.h to wifi_secrets.h and fill in your 2.4 GHz network."
#endif
#include "wifi_secrets.h"

using namespace follow;

namespace {

struct EspRandom : Random32 {
  // esp_random() is a true random source only while Wi-Fi is active; the protocol objects are
  // therefore built in setup() after WiFi.begin().
  uint32_t next() override { return esp_random(); }
};

struct WsSink : ReplySink {
  WsServer* server = nullptr;
  void send(const char* json, size_t length) override {
    if (server) server->sendText(json, length);
  }
};

struct App;

EspRandom rng;
WsSink sink;
BtsMotorHal hal;                    // real BTS7960 + relay driver (written only by the kernel)
InterlockConfig interlockConfig() {
  InterlockConfig c;
  c.stopDistanceMm = kStopDistanceMm;
  return c;
}
Interlock interlock(interlockConfig());
HcSr04Source hcsr04;
NoSensorClearSource noSensor;
UltrasonicSource& sonar = kUltrasonicInstalled ? static_cast<UltrasonicSource&>(hcsr04)
                                               : static_cast<UltrasonicSource&>(noSensor);
Protocol* protocol = nullptr;
SafetyKernel* kernel = nullptr;
WsServer* wsServer = nullptr;

double nowMs() { return static_cast<double>(esp_timer_get_time()) / 1000.0; }

struct App : WsServer::Handler {
  void onText(const char* text, size_t length, double now) override {
    if (kernel) kernel->onMessage(text, length, now);
  }
  void onClosed(double now) override {
    if (kernel) kernel->onTransportClosed(now);
  }
};
App app;

bool wasUp = false;
bool serverStarted = false;
double lastWifiTry = -10000;
double lastReport = 0;

void wifiMaintain(double now) {
  const bool up = WiFi.status() == WL_CONNECTED;
  if (wasUp && !up) {
    if (kernel) kernel->onTransportClosed(now);                 // Wi-Fi lost: stop at once
    Serial.println("Wi-Fi lost: motors stopped, reconnecting");
    lastWifiTry = now;
  }
  // The driver reconnects by itself (autoReconnect). Only nudge it every 10 s.
  // The old code called disconnect()+begin() every 2 s, which aborted each attempt
  // half-way ("wifi:sta is connecting, cannot set config") so it never got back on.
  if (!up && now - lastWifiTry >= 10000) {
    WiFi.reconnect();
    lastWifiTry = now;
  }
  if (up && !serverStarted && wsServer) {
    wsServer->begin();
    serverStarted = true;
  }
  if (up && !wasUp) {
    Serial.print("WebSocket server: ws://");
    Serial.print(WiFi.localIP());
    Serial.print(":");
    Serial.print(kWsPort);
    Serial.println(kWsPath);
  }
  wasUp = up;
}

}  // namespace

void setup() {
  hal.latchOutputsLow();              // FIRST: relay, EN and PWM pins LOW before anything else
  Serial.begin(115200);
  Serial.println();
  Serial.println("esp32-follow PHASE 2: MOTOR OUTPUT ENABLED");
  if (!hal.begin()) Serial.println("PWM setup FAILED: motor output stays OFF");
  if (kUltrasonicInstalled) {
    hcsr04.begin();
    Serial.println("obstacle check: HC-SR04 x2");
  } else {
    Serial.println("obstacle check: OFF (kUltrasonicInstalled = false)");
  }
  enableLoopWDT();                    // a stuck loop resets the chip (EN pull-downs -> drivers off)

  WiFi.mode(WIFI_STA);
  if (kUseStaticIp) {
    const IPAddress ip(kStaticIp[0], kStaticIp[1], kStaticIp[2], kStaticIp[3]);
    const IPAddress gw(kGatewayIp[0], kGatewayIp[1], kGatewayIp[2], kGatewayIp[3]);
    const IPAddress mask(kSubnetMask[0], kSubnetMask[1], kSubnetMask[2], kSubnetMask[3]);
    if (!WiFi.config(ip, gw, mask, gw)) Serial.println("static IP config FAILED: using DHCP");
  }
  WiFi.setSleep(false);               // PROPOSAL: lower, steadier latency
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTry = nowMs();

  // Bench (phone on Wi-Fi): the connection may be silent up to 1200 ms before the
  // session latches (was 600). Motion still stops by the lease (evidenceMaxMs 700)
  // when no fresh command arrives. MUST match linkOptions in js/app.js.
  ProtocolConfig protocolConfig;
  protocolConfig.movementWatchdogMs = 1200;
  protocolConfig.sessionLivenessMs = 1200;
  // Upper limits only: the page decides how old a detection may be. Normal mode
  // still sends at most 450 ms / 700 ms; DEMO mode (?mode=demo) up to 1200 / 1500.
  protocolConfig.ageClaimMaxMs = 1200;
  protocolConfig.evidenceMaxMs = 1500;
  protocol = new Protocol(&rng, &sink, nullptr, protocolConfig);   // BOOT_LATCHED
  kernel = new SafetyKernel(*protocol, hal, interlock);
  wsServer = new WsServer(kWsPort, kWsPath, app);
  sink.server = wsServer;

  kernel->init(nowMs());
}

double lastLoopAt = 0;
double maxLoopGapMs = 0;

void loop() {
  const double now = nowMs();
  if (lastLoopAt > 0 && now - lastLoopAt > maxLoopGapMs) maxLoopGapMs = now - lastLoopAt;
  lastLoopAt = now;

  wifiMaintain(now);

  if (wsServer) wsServer->poll(now);

  // Sensor source (null in this phase): feeds the interlock when a measurement completes.
  for (int i = 0; i < Interlock::kSensors; i += 1) {
    Reading reading;
    if (sonar.poll(i, now, reading) && kernel) kernel->onReading(i, reading, now);
  }

  if (kernel) kernel->tick(now);      // protocol timers, then the interlock, then the single output write
  hal.service();                      // relay sequencing and soft-start ramp of the last kernel command

  if (now - lastReport >= 1000) {
    lastReport = now;
    Serial.print("state=");
    Serial.print(protocol ? stateName(protocol->state()) : "?");
    Serial.print(" motor(effective)=");
    Serial.print(kernel ? motorName(kernel->effectiveMotor()) : "?");
    Serial.print(" interlock=");
    Serial.print(blockReasonName(interlock.reason()));
    Serial.print(" relay=");
    Serial.print(hal.relayOn() ? "ON" : "OFF");
    Serial.print(" dutyL=");
    Serial.print(hal.dutyLeft(), 2);
    Serial.print(" dutyR=");
    Serial.print(hal.dutyRight(), 2);
    Serial.print(hal.fault() ? " output=FAULT" : " output=LIVE");
    if (protocol) {
      const Counters& c = protocol->counters();
      Serial.print(" stop=");
      Serial.print(protocol->lastStopReason() ? protocol->lastStopReason() : "-");
      Serial.print(" acc=");
      Serial.print(c.accepted);
      Serial.print(" rej=");
      Serial.print(c.rejected);
      Serial.print(" rate=");
      Serial.print(c.rateLimited);
      Serial.print(" latch=");
      Serial.print(protocol->latchReason() ? protocol->latchReason() : "-");
      Serial.print(" lastrej=");
      Serial.print(protocol->lastRejectReason() ? protocol->lastRejectReason() : "-");
      Serial.print(" wd=");
      Serial.print(c.watchdogLatches);
      Serial.print(" drop=");
      Serial.print(wsServer ? wsServer->droppedFrames() : 0);
      Serial.print(" wsclose=");
      Serial.print(wsServer ? wsServer->closes() : 0);
      Serial.print("/");
      Serial.print(wsServer ? wsServer->lastCloseReason() : "-");
      Serial.print(" rssi=");
      Serial.print(WiFi.RSSI());
    }
    Serial.print(" maxgap=");
    Serial.print(static_cast<int>(maxLoopGapMs));
    maxLoopGapMs = 0;
    Serial.println();
  }

  delay(1);
}
