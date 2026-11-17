// HOST STUB of the Arduino-ESP32 BLE API, written from memory of the real library to syntax-check
// ble_server.h on a PC. It proves nothing about the real library: build in the Arduino IDE.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "Arduino.h"

class BLEServer;
class BLECharacteristic;

struct BLEServerCallbacks {
  virtual ~BLEServerCallbacks() {}
  virtual void onConnect(BLEServer*) {}
  virtual void onDisconnect(BLEServer*) {}
};

struct BLECharacteristicCallbacks {
  virtual ~BLECharacteristicCallbacks() {}
  virtual void onWrite(BLECharacteristic*) {}
};

class BLEDescriptor {};

class BLECharacteristic {
 public:
  void addDescriptor(BLEDescriptor*) {}
  static const uint32_t PROPERTY_NOTIFY = 1;
  static const uint32_t PROPERTY_WRITE = 2;
  static const uint32_t PROPERTY_WRITE_NR = 4;
  void setCallbacks(BLECharacteristicCallbacks*) {}
  void setValue(uint8_t*, size_t) {}
  void notify() {}
  uint8_t* getData() { return nullptr; }
  size_t getLength() { return 0; }
};

class BLEService {
 public:
  BLECharacteristic* createCharacteristic(const char*, uint32_t) { return nullptr; }
  void start() {}
};

class BLEServer {
 public:
  void setCallbacks(BLEServerCallbacks*) {}
  BLEService* createService(const char*) { return nullptr; }
  uint16_t getConnId() { return 0; }
  uint16_t getPeerMTU(uint16_t) { return 23; }
};

class BLEAdvertising {
 public:
  void addServiceUUID(const char*) {}
  void setScanResponse(bool) {}
};

class BLEDevice {
 public:
  static void init(const char*) {}
  static void setMTU(uint16_t) {}
  static BLEServer* createServer() { return nullptr; }
  static BLEAdvertising* getAdvertising() { return nullptr; }
  static void startAdvertising() {}
};
