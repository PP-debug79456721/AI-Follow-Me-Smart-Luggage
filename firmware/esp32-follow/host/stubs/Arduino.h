#pragma once
#include <stddef.h>
#include <stdint.h>
struct HardwareSerial {
  void begin(unsigned long) {}
  void print(const char*) {}
  void print(unsigned) {}
  void print(double) {}
  template <typename T> void print(const T&) {}
  void println() {}
  void println(const char*) {}
};
static HardwareSerial Serial;
inline void delay(unsigned long) {}
// FreeRTOS critical section (used by ble_server.h)
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
