// ESP32 Follow-Me firmware: PHASE 1 SKELETON.
//
//   *** MOTOR OUTPUT IS PERMANENTLY DISABLED IN THIS PHASE. ***
//   *** THIS FIRMWARE IS NOT READY FOR MOTOR OPERATION.      ***
//
// It runs Protocol v2 (a port of js/mock-esp32.js), the safety kernel, the obstacle
// interlock logic and a WebSocket server, but it touches NO GPIO: the motor HAL is the locked
// one and the ultrasonic source reports "unavailable" (so the interlock stays blocked).
//
// STATUS: stub-checked on a host computer only. It has NOT been built with the ESP32
// toolchain, NOT flashed and NOT run on a board. GPIO assignments in config.h are
// UNVERIFIED. See README.md.
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
LockedMotorHal hal;                 // the ONLY HAL in this phase: no GPIO
Interlock interlock;                // stop distance unset: blocked
NullUltrasonicSource sonar;         // reports nothing: blocked
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
  if (wasUp && !up && kernel) kernel->onTransportClosed(now);   // Wi-Fi lost: stop at once
  if (!up && now - lastWifiTry >= 2000) {
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    lastWifiTry = now;
  }
  if (up && !serverStarted && wsServer) {
    wsServer->begin();
    serverStarted = true;
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
  Serial.begin(115200);
  Serial.println();
  Serial.println("esp32-follow PHASE 1: MOTOR OUTPUT LOCKED, GPIO UNVERIFIED, NOT READY FOR MOTORS");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);               // PROPOSAL: lower, steadier latency
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTry = nowMs();

  protocol = new Protocol(&rng, &sink);          // BOOT_LATCHED
  kernel = new SafetyKernel(*protocol, hal, interlock);
  wsServer = new WsServer(kWsPort, kWsPath, app);
  sink.server = wsServer;

  kernel->init(nowMs());
}

void loop() {
  const double now = nowMs();

  wifiMaintain(now);

  if (wsServer) wsServer->poll(now);

  // Sensor source (null in this phase): feeds the interlock when a measurement completes.
  for (int i = 0; i < Interlock::kSensors; i += 1) {
    Reading reading;
    if (sonar.poll(i, now, reading) && kernel) kernel->onReading(i, reading, now);
  }

  if (kernel) kernel->tick(now);      // protocol timers, then the interlock, then the single output write

  if (now - lastReport >= 1000) {
    lastReport = now;
    Serial.print("state=");
    Serial.print(protocol ? stateName(protocol->state()) : "?");
    Serial.print(" motor(effective)=");
    Serial.print(kernel ? motorName(kernel->effectiveMotor()) : "?");
    Serial.print(" interlock=");
    Serial.print(blockReasonName(interlock.reason()));
    Serial.println(" output=LOCKED");
  }

  delay(1);
}
