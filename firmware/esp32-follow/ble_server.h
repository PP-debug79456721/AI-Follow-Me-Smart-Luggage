// Bluetooth LE transport for the Arduino-ESP32 core (built-in BLE library, no extra download).
//
// STATUS: NOT COMPILED AGAINST THE REAL ESP32 TOOLCHAIN and never run on a board. The portable
// pieces (line framing, queue, router) are unit-tested on the host (host/transport_test.cpp);
// this glue is written from the core's BLE API and only syntax-checked against host stubs
// (host/stubs/BLE*.h), which prove nothing about the real library. Build it once in the Arduino
// IDE before trusting it.
//
// GATT layout = Nordic UART Service, so generic phone apps (nRF Connect, Serial Bluetooth
// Terminal) can talk to it for a bench test:
//   service 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
//   RX  6E400002-...  central -> device  (write / write without response)
//   TX  6E400003-...  device  -> central (notify)
//
// Threading: the BLE stack calls onWrite/onConnect/onDisconnect from its own task. Those
// callbacks only (a) cut bytes into lines and push them into a MessageQueue, (b) set flags.
// poll() runs in loop() and is the ONLY place that talks to the router and the kernel.
// sendText() also runs in loop().
//
// One client at a time: advertising stops while connected and restarts after a disconnect.
#pragma once

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
// The notify descriptor (CCCD, 0x2902) is what lets a phone switch notifications on. With the default
// (Bluedroid) BLE library it is NOT added automatically, on core 2.x AND 3.x: without it a phone app
// says "no CCCD" and never receives anything. Add it whenever the header exists (it may print a
// deprecation warning on newer cores; that is harmless).
#if __has_include(<BLE2902.h>)
#include <BLE2902.h>
#define FOLLOW_ADD_CCCD 1
#endif

#include "ble_framing.h"
#include "config.h"
#include "transport_router.h"

namespace follow {

constexpr const char* kBleServiceUuid = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* kBleRxUuid = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* kBleTxUuid = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

class BleServer : public Channel {
 public:
  struct Handler {
    virtual ~Handler() {}
    virtual void onText(const char* text, size_t length, double now) = 0;
    virtual void onClosed(double now) = 0;
  };

  void begin(const char* name) {
    BLEDevice::init(name);
    BLEDevice::setMTU(247);
    server_ = BLEDevice::createServer();
    server_->setCallbacks(&serverCallbacks_);
    BLEService* service = server_->createService(kBleServiceUuid);

    tx_ = service->createCharacteristic(kBleTxUuid, BLECharacteristic::PROPERTY_NOTIFY);
#ifdef FOLLOW_ADD_CCCD
    tx_->addDescriptor(new BLE2902());
#endif

    BLECharacteristic* rx = service->createCharacteristic(
        kBleRxUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    rx->setCallbacks(&rxCallbacks_);

    service->start();
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(kBleServiceUuid);
    advertising->setScanResponse(true);
    BLEDevice::startAdvertising();
    started_ = true;
  }

  // Runs in loop(): reports a disconnect first (so the kernel stops at once), then delivers every
  // queued message (at most a few per call, so loop() stays short).
  void poll(double now, Handler& handler) {
    if (!started_) return;
    if (disconnectPending_) {
      disconnectPending_ = false;
      handler.onClosed(now);
    }
    char message[ble::kMaxLine + 1];
    size_t length = 0;
    for (int i = 0; i < 4 && queue_.pop(message, sizeof(message), length); i += 1) {
      handler.onText(message, length, now);
    }
  }

  bool connected() const { return connected_; }
  uint32_t droppedIn() const { return queue_.dropped() + assembler_.overflows(); }
  uint32_t droppedOut() const { return droppedOut_; }
  uint32_t connects() const { return connects_; }

  // Channel: one JSON message as a line, cut into notifications. A message that cannot be sent in
  // full is counted as dropped (the app treats a missing reply as a timeout and stops).
  bool sendText(const char* json, size_t length) override {
    if (!started_ || !connected_ || tx_ == nullptr) return false;
    uint8_t framed[ble::kMaxLine];
    const size_t total = ble::frameLine(json, length, framed, sizeof(framed));
    if (total == 0) {
      droppedOut_ += 1;
      return false;
    }
    const size_t mtu = server_->getPeerMTU(server_->getConnId());
    const size_t payload = ble::chunkPayload(mtu, kBleMaxChunk);
    for (size_t offset = 0; offset < total; offset += payload) {
      const size_t n = (total - offset < payload) ? (total - offset) : payload;
      tx_->setValue(framed + offset, n);
      tx_->notify();
    }
    return true;
  }

 private:
  struct PortMuxLock {
    portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
    void lock() { portENTER_CRITICAL(&mux); }
    void unlock() { portEXIT_CRITICAL(&mux); }
  };

  struct ServerCallbacks : BLEServerCallbacks {
    explicit ServerCallbacks(BleServer& owner) : owner_(owner) {}
    void onConnect(BLEServer*) override {
      owner_.assembler_.reset();
      owner_.queue_.clear();
      owner_.connected_ = true;
      owner_.connects_ += 1;
    }
    void onDisconnect(BLEServer*) override {
      owner_.connected_ = false;
      owner_.disconnectPending_ = true;
      BLEDevice::startAdvertising();          // accept the next client
    }
    BleServer& owner_;
  };

  struct RxCallbacks : BLECharacteristicCallbacks {
    explicit RxCallbacks(BleServer& owner) : owner_(owner) {}
    void onWrite(BLECharacteristic* characteristic) override {
      const uint8_t* data = characteristic->getData();
      const size_t length = characteristic->getLength();
      if (data == nullptr || length == 0) return;
      owner_.assembler_.feed(data, length, [this](const char* line, size_t n) { owner_.queue_.push(line, n); });
    }
    BleServer& owner_;
  };

  BLEServer* server_ = nullptr;
  BLECharacteristic* tx_ = nullptr;
  ServerCallbacks serverCallbacks_{*this};
  RxCallbacks rxCallbacks_{*this};
  ble::LineAssembler assembler_;                         // touched only by the BLE task
  ble::MessageQueue<4, ble::kMaxLine + 1, PortMuxLock> queue_;
  volatile bool connected_ = false;
  volatile bool disconnectPending_ = false;
  volatile uint32_t connects_ = 0;
  uint32_t droppedOut_ = 0;
  bool started_ = false;
};

}  // namespace follow
