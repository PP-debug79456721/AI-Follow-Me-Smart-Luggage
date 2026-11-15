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
