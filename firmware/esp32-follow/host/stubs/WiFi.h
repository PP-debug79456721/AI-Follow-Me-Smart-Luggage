#pragma once
#include <stddef.h>
#include <stdint.h>
enum wl_status_t { WL_IDLE_STATUS, WL_CONNECTED, WL_DISCONNECTED };
enum WiFiMode_t { WIFI_OFF, WIFI_STA };
struct IPAddress {};
struct WiFiClient {
  bool connected() { return false; }
  int available() { return 0; }
  int read(uint8_t*, size_t) { return 0; }
  size_t write(const uint8_t*, size_t n) { return n; }
  size_t print(const char*) { return 0; }
  void setNoDelay(bool) {}
  void stop() {}
  operator bool() const { return false; }
};
struct WiFiServer {
  explicit WiFiServer(uint16_t) {}
  void begin() {}
  WiFiClient available() { return WiFiClient(); }
};
struct WiFiClass {
  void mode(WiFiMode_t) {}
  void setSleep(bool) {}
  void begin(const char*, const char*) {}
  void disconnect() {}
  wl_status_t status() { return WL_DISCONNECTED; }
  IPAddress localIP() { return IPAddress(); }
};
static WiFiClass WiFi;
