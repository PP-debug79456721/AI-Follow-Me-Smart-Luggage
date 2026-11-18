// ESP32 Follow-Me firmware: PHASE 2 (MOTOR OUTPUT ENABLED).
//
// Protocol v2 (a port of js/mock-esp32.js), the safety kernel, the obstacle interlock and two
// transports (Wi-Fi WebSocket and/or Bluetooth LE, kEnableWifi / kEnableBle in config.h, both on
// by default), driving two BTS7960 boards and the motor-power relay through BtsMotorHal
// (bts_motor_hal.h). The SafetyKernel is still the ONLY writer of motor output.
//
// Stops: app STOP/ESTOP, 600 ms movement watchdog, 600 ms session liveness, lost socket,
// lost Wi-Fi, obstacle interlock (only if kUltrasonicInstalled), loop-task watchdog reset.
// Hardware kill independent of this code: the E-STOP switch in the relay coil circuit.
//
// Settings (duty, turn ratio, direction, ultrasonic on/off) are in config.h.
//
// Needs no extra library: board "ESP32 Dev Module" with the Arduino-ESP32 core.
// With BLE on, choose Tools -> Partition Scheme -> "Huge APP (3MB No OTA/1MB SPIFFS)" (Wi-Fi + BLE
// do not fit the default 1.3 MB app partition).

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
#include "transport_router.h"
#if FOLLOW_WITH_BLE
#include "ble_server.h"
#endif

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

// Both transports feed the SAME protocol and safety kernel through one router (see
// transport_router.h). Replies go back to the transport the message came from.
struct WsChannel : Channel {
  WsServer* server = nullptr;
  bool sendText(const char* json, size_t length) override {
    return server != nullptr && server->sendText(json, length);
  }
};

struct KernelTarget : RouterTarget {
  void onMessage(const char* text, size_t length, double now) override;
  void onTransportClosed(double now) override;
};

struct App;

EspRandom rng;
TransportRouter router;             // the protocol's reply sink
WsChannel wsChannel;
KernelTarget kernelTarget;
#if FOLLOW_WITH_BLE
BleServer bleServer;
#endif
int wsChannelId = -1;
int bleChannelId = -1;
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

void KernelTarget::onMessage(const char* text, size_t length, double now) {
  if (kernel) kernel->onMessage(text, length, now);
}
void KernelTarget::onTransportClosed(double now) {
  if (kernel) kernel->onTransportClosed(now);
}

struct App : WsServer::Handler {
  void onText(const char* text, size_t length, double now) override {
    router.onText(wsChannelId, text, length, now);
  }
  void onClosed(double now) override { router.onClosed(wsChannelId, now); }
};
App app;

#if FOLLOW_WITH_BLE
struct BleApp : BleServer::Handler {
  void onText(const char* text, size_t length, double now) override {
    router.onText(bleChannelId, text, length, now);
  }
  void onClosed(double now) override { router.onClosed(bleChannelId, now); }
};
BleApp bleApp;
#endif

bool wasUp = false;
bool serverStarted = false;
double lastWifiTry = -10000;
double lastReport = 0;

const char* wifiDisconnectReasonName(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_UNSPECIFIED: return "UNSPECIFIED";
    case WIFI_REASON_AUTH_EXPIRE: return "AUTH_EXPIRE";
    case WIFI_REASON_AUTH_LEAVE: return "AUTH_LEAVE";
    case WIFI_REASON_ASSOC_EXPIRE: return "ASSOC_EXPIRE";
    case WIFI_REASON_ASSOC_TOOMANY: return "ASSOC_TOOMANY";
    case WIFI_REASON_NOT_AUTHED: return "NOT_AUTHED";
    case WIFI_REASON_NOT_ASSOCED: return "NOT_ASSOCED";
    case WIFI_REASON_ASSOC_LEAVE: return "ASSOC_LEAVE";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "4WAY_HANDSHAKE_TIMEOUT";
    case WIFI_REASON_GROUP_KEY_UPDATE_TIMEOUT: return "GROUP_KEY_UPDATE_TIMEOUT";
    case WIFI_REASON_IE_IN_4WAY_DIFFERS: return "IE_IN_4WAY_DIFFERS";
    case WIFI_REASON_MIC_FAILURE: return "MIC_FAILURE";
    case WIFI_REASON_BEACON_TIMEOUT: return "BEACON_TIMEOUT";
    case WIFI_REASON_NO_AP_FOUND: return "NO_AP_FOUND";
    case WIFI_REASON_AUTH_FAIL: return "AUTH_FAIL";
    case WIFI_REASON_ASSOC_FAIL: return "ASSOC_FAIL";
    case WIFI_REASON_HANDSHAKE_TIMEOUT: return "HANDSHAKE_TIMEOUT";
    default: return "UNKNOWN_REASON";
  }
}

void registerWifiDiagnostics() {
  static uint32_t connectedCount = 0;
  static uint32_t disconnectedCount = 0;
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    switch (event) {
      case ARDUINO_EVENT_WIFI_STA_CONNECTED:
        ++connectedCount;
        Serial.print("[WiFi] STA_CONNECTED count=");
        Serial.println(connectedCount);
        break;
      case ARDUINO_EVENT_WIFI_STA_GOT_IP:
        Serial.print("[WiFi] GOT_IP ip=");
        Serial.print(WiFi.localIP());
        Serial.print(" gateway=");
        Serial.print(WiFi.gatewayIP());
        Serial.print(" subnet=");
        Serial.println(WiFi.subnetMask());
        break;
      case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
        ++disconnectedCount;
        const uint8_t reason = info.wifi_sta_disconnected.reason;
        Serial.print("[WiFi] DISCONNECTED count=");
        Serial.print(disconnectedCount);
        Serial.print(" reason=");
        Serial.print(reason);
        Serial.print(" name=");
        Serial.println(wifiDisconnectReasonName(reason));
        break;
      }
      case ARDUINO_EVENT_WIFI_STA_LOST_IP:
        Serial.println("[WiFi] LOST_IP");
        break;
      default:
        break;
    }
  });
}

void wifiMaintain(double now) {
  const bool up = WiFi.status() == WL_CONNECTED;
  if (wasUp && !up) {
    router.onClosed(wsChannelId, now);                          // Wi-Fi lost: stop at once
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

  if (kEnableWifi) {
    registerWifiDiagnostics();
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
  } else {
    Serial.println("Wi-Fi: OFF (kEnableWifi = false)");
  }

  // BLE is started before the protocol objects: esp_random() is a true random source only while
  // the Wi-Fi or Bluetooth radio is active.
#if FOLLOW_WITH_BLE
  bleServer.begin(kBleName);
  Serial.print("BLE: advertising as ");
  Serial.println(kBleName);
#else
  Serial.println("BLE: OFF (compiled out, FOLLOW_WITH_BLE 0 in config.h)");
#endif

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
  protocol = new Protocol(&rng, &router, nullptr, protocolConfig);   // BOOT_LATCHED
  kernel = new SafetyKernel(*protocol, hal, interlock);
  wsServer = new WsServer(kWsPort, kWsPath, app);
  wsChannel.server = wsServer;
  wsChannelId = router.addChannel(&wsChannel);
#if FOLLOW_WITH_BLE
  bleChannelId = router.addChannel(&bleServer);
#endif
  router.setTarget(&kernelTarget);

  kernel->init(nowMs());
}

double lastLoopAt = 0;
double maxLoopGapMs = 0;

void loop() {
  const double now = nowMs();
  if (lastLoopAt > 0 && now - lastLoopAt > maxLoopGapMs) maxLoopGapMs = now - lastLoopAt;
  lastLoopAt = now;

  if (kEnableWifi) {
    wifiMaintain(now);
    if (wsServer) wsServer->poll(now);
  }
#if FOLLOW_WITH_BLE
  bleServer.poll(now, bleApp);
#endif

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
    if (kUltrasonicInstalled) {
      for (int i = 0; i < Interlock::kSensors; i += 1) {
        Reading r;
        Serial.print(i == 0 ? " sonar=" : "/");
        if (!interlock.lastReading(i, r)) Serial.print("none");
        else if (r.status == EchoStatus::Distance) { Serial.print(r.distanceMm); Serial.print("mm"); }
        else if (r.status == EchoStatus::Clear) Serial.print("clear");
        else if (r.status == EchoStatus::NoEcho) Serial.print("NO_ECHO");
        else Serial.print("n/a");
      }
    }
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
      if (kEnableWifi) {
        Serial.print(" wifi=");
        Serial.print(static_cast<int>(WiFi.status()));
        Serial.print(" rssi=");
        Serial.print(WiFi.RSSI());
      }
#if FOLLOW_WITH_BLE
      {
        Serial.print(" ble=");
        Serial.print(bleServer.connected() ? 1 : 0);
        Serial.print("/");
        Serial.print(bleServer.connects());
        Serial.print(" blereq=");
        Serial.print(bleServer.connParamRequests());
        Serial.print(" blemtu=");
        Serial.print(bleServer.peerMtu());
        Serial.print(" bledrop=");
        Serial.print(bleServer.droppedIn());
        Serial.print("/");
        Serial.print(bleServer.droppedOut());
      }
#endif
    }
    Serial.print(" maxgap=");
    Serial.print(static_cast<int>(maxLoopGapMs));
    maxLoopGapMs = 0;
    Serial.println();
  }

  delay(1);
}
