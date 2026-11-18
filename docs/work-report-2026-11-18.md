# รายงานงานวันที่ 2026-11-18 · งานค้าง · วิธีใช้แอป

Branch: `esp32-link` (commit ล่าสุด `ebccdcb`) · ภาษา: ไทย
อ่านคู่กับ `CLAUDE.md` (บันทึกส่งต่อหลัก) และ `docs/work-report-2026-11-17.md`

> หลักการของรายงานนี้: แยก "ทำแล้วและทดสอบแล้ว" ออกจาก "เขียนแล้วแต่ยังไม่เคยลองบนของจริง" อย่างชัดเจน

---

## 1. สรุปสั้น

เป้าหมายวันนี้คือแก้อาการ **ล้อขยับแปบ ๆ แล้วหยุด** และ **ARM/FOLLOW หลุดบ่อย**

| สาเหตุที่ไล่เจอ | ผล |
|---|---|
| BLE: RTT 200–500 ms และข้อความถูกปฏิเสธ ~6 % (`PROOF_STALE`, `RATE_LIMITED`) | เปลี่ยนมาใช้ Wi-Fi แทน BLE (ปิด BLE ตอนคอมไพล์) |
| Wi-Fi: ไม่มีข้อความถูกปฏิเสธ (`rej=0`) แต่ `rtt` 330 ms เพราะ main thread ของหน้ามือถือหนัก | ย้ายตัวตรวจจับคนไปรันใน **Web Worker** |
| หลังใช้ Web Worker บนมือถือจริง | `rtt` ไม่เกิน 200 ms (ต่ำกว่าเกณฑ์ 300 ms) · `page stall` ยัง 100–300 ms |

สถานะ: worker **ใช้งานได้บนมือถือจริงแล้ว** (การ์ดขึ้น `GPU · WORKER`) แต่ยังไม่ได้ทดสอบตอน ARM/FOLLOW ล้อวิ่งจริง และยังไม่ได้ตั้งเป็นค่าเริ่มต้น

---

## 2. งานที่ทำวันนี้ (เรียงตามลำดับ)

### 2.1 เชื่อมต่อ BLE และวัด RTT (commit `4104f74`, `faf0cdd`, `f4262bd`)
- เฟิร์มแวร์ขอ connection interval 15–30 ms จากมือถือหลังเชื่อมต่อ
- เพิ่ม `blemtu=` ใน serial (เช็กว่าข้อความถูกตัดเป็นชิ้น 20 ไบต์หรือไม่) → วัดได้ `blemtu=247` จึง **ตัดสมมติฐานเรื่องชิ้น 20 ไบต์ทิ้ง**
- เพิ่มตัวเลขวินิจฉัยบนการ์ด ESP32: `ble write avg/max`, `send avg/max`, `chunk(s)`, `ble reply assembly`
- ผลวัด: RTT 200–500 ms แม้ขอ interval แล้ว, serial เห็น `PROOF_STALE` และ `RATE_LIMITED` ~6 % ซึ่งทำให้หน้าเว็บสั่ง STOP แล้วรอ token ใหม่ = อาการเดินแปบ ๆ หยุด

### 2.2 เปลี่ยนไปใช้ Wi-Fi (commit `e8ea0df`, `e654309`)
- ค่าเริ่มต้นเฟิร์มแวร์: **Wi-Fi เปิด, BLE ปิด** (เจ้าของเลือก) โค้ด BLE ยังอยู่ไว้ใช้ภายหลัง
- สวิตช์ BLE เป็น **preprocessor `FOLLOW_WITH_BLE`** ใน `config.h` (0 = ไม่คอมไพล์ BLE เลย) เพราะแค่ `constexpr` ปิด BLE ทำให้สเก็ตช์ใหญ่ 114 % ของพาร์ทิชันปกติ (`Sketch too big`)
- ชื่อสวิตช์ตั้งให้ไม่มีคำว่า ENABLE/UNLOCK เพราะเทสต์ F5 ห้ามสวิตช์ลักษณะนั้นในสเก็ตช์ (ไม่ได้ผ่อนเทสต์)
- ผลทดสอบ Wi-Fi: `wifi=3`, `rssi −55..−62`, `rej=0 rate=0`, ทิศเลี้ยวถูก (`RIGHT L0.60/R0.40`, `LEFT L0.36/R0.66`)

### 2.3 IP คงที่ แบบปลอดภัย (commit `d3edc76`)
- `kUseStaticIp = true`, `kStaticIp 192.168.137.50`
- บอร์ดต่อด้วย DHCP ก่อนเสมอ แล้วสลับเป็น IP คงที่ **เฉพาะเมื่อ lease อยู่ subnet เดียวกัน** (gateway/mask ใช้ตาม lease) ถ้าไม่ตรง ใช้ DHCP ต่อและพิมพ์ `static IP skipped: ...`
- ผู้ใช้ยืนยันจาก serial: `GOT_IP ip=192.168.137.50 gateway=192.168.137.1`
- Re-ID ช้าลงในโหมดมือถือ (`reidIntervalsFor`: ค้นหา 1 วินาที, เรียนรู้ 4 วินาทีตอน FOLLOW), ค่า `rtt` บนการ์ดปัดเลขเต็ม

### 2.4 ไลบรารีแบบ local-first (commit `a391d7b`)
- `js/vendor-assets.js`, `tools/fetch-vendor.ps1`, `/vendor/` (git-ignore) ให้หน้าเว็บใช้ MediaPipe / ONNX Runtime / โมเดล `.tflite` จากดิสก์ก่อน แล้วค่อย fallback ไป CDN
- การ์ดแสดง `LIB LOCAL | CDN | MIXED`
- **ยังไม่เคยรันสคริปต์บนเครื่องจริง** (ตอนนี้ยังขึ้น `LIB CDN`)

### 2.5 Web Worker สำหรับตัวตรวจจับคน (commit `a9e54e8`, `ebccdcb`)
- `js/person-worker.js` (classic worker, โหลดบันเดิล MediaPipe ด้วย dynamic `import()`, GPU แล้ว CPU)
- `js/person-worker-client.js` ส่งภาพเป็น `ImageBitmap` (transfer), มีการตรวจทีละ 1 เฟรมเท่านั้น, ผลลัพธ์ใช้ **เวลาของเฟรม** ไม่ใช่เวลาที่ผลมาถึง
- ถ้า worker เริ่มไม่ได้ / ไม่ตอบ 3 วินาที / ผิดพลาดต่อเนื่อง 5 เฟรม → **สลับกลับไปตรวจบน main thread เอง**
- เปิดด้วย `?worker=1` เท่านั้น (`WORKER_DEFAULT_IN_LITE = false`)
- ป้ายบนการ์ด PERSON DETECTION: `GPU · WORKER`, `· MAIN (worker unavailable)`, `· MAIN (worker failed)` และ `LAT <ms>`
- เทสต์: `person-worker-client.test.mjs` (14 ข้อ, worker ปลอม), `lite-mode.test.mjs` (เพิ่ม 2 ข้อ), `tests/e2e/person-worker.e2e.mjs` (5 ข้อ, ใช้ worker ตัวจริงของโปรเจกต์ + MediaPipe ปลอม; ตัวตรวจ 250 ms ทำให้หน้าค้างสูงสุด 506 ms บน main thread แต่ 23 ms ใน worker)
- ผลบนมือถือจริง (Android Chrome ผ่าน adb): ขึ้น `GPU · WORKER`, `INF 49–64 / 310–337 ms`, `LAT ~40–50 ms`, `rtt ≤ 200`, `page stall 100–300`

### 2.6 ตั้งค่าการทดสอบบนมือถือผ่าน adb (ไม่ได้แก้โค้ด)
- `adb reverse tcp:8000 tcp:8000` ทำให้ `localhost:8000` บนมือถือชี้ไปเซิร์ฟเวอร์บนโน้ตบุ๊ก → เป็น secure context และ `?modelMode=development` ใช้ได้บนมือถือ ไม่ต้องตั้ง `chrome://flags`
- ติดตั้ง/ใช้ `C:\platform-tools`, ต่อ Wireless debugging

### 2.7 ผลตรวจสุขภาพบอร์ด (serial)
- เคยหลุดซ้ำ 9 รอบด้วย `reason=2 AUTH_EXPIRE` (ลิงก์/hotspot ไม่เสถียร ไม่ใช่รหัสผ่านผิด) แล้วต่อติด
- ล่าสุด: `wifi=3`, `rssi −57..−71`, `maxgap=13`, `drop=0`, `rej=0` ลูปปกติ
- บอร์ดอยู่ `state=BOOT_LATCHED` จนกว่าหน้าเว็บจะเชื่อมต่อ (ปกติ)

### 2.8 ผลทดสอบชุดทดสอบ
- `node --test tests/*.test.mjs`: **435 ผ่าน / 2 ล้มเหลว** (F2 ตรวจ syntax เฟิร์มแวร์กับ stub ของโฮสต์, MT7 fixture ของเฟิร์มแวร์ motor-test เก่า) สองข้อนี้ล้มก่อนงานวันนี้
- `tests/e2e/phase-c.e2e.mjs`: ล้ม 7 ข้อ **เหมือนกันทั้งก่อนและหลังแก้** (แถวโมเดลใบหน้าที่ยังคาดว่าเป็น OFF บน localhost)
- `tests/e2e/esp32-panel.e2e.mjs` ข้อ 2–3 (ESTOP, disconnect/reconnect) ล้มก่อนงานวันนี้เช่นกัน
- ก่อน push ทุกครั้งรัน ESLint `no-undef` + smoke load (เพราะเคยเกิดค่าคงที่หายใน `ai-owner.js` ตอนแก้)

---

## 3. สิ่งที่ยัง "ไม่พิสูจน์" (อย่าเข้าใจผิดว่าเสร็จ)

| รายการ | สถานะ |
|---|---|
| Worker ตอน ARM/FOLLOW ล้อวิ่งจริง ว่ากระตุกลดลงหรือไม่ | ยังไม่ทดสอบ |
| Re-ID / ONNX ใน worker | **ยังไม่ได้ทำ** (ยังอยู่ main thread) |
| ตรวจใบหน้าใน worker | **ยังไม่ได้ทำ** (ยังอยู่ main thread ตอน `lite=0`) |
| `tools/fetch-vendor.ps1` | ไม่เคยรันบนเครื่องจริง |
| BLE (เฟิร์มแวร์+Web Bluetooth) | ไม่ได้ใช้แล้ว แต่โค้ดยังอยู่ ไม่เคยคอมไพล์/ทดสอบครบบนบอร์ดจริง |
| IP คงที่ในเฟิร์มแวร์ | ผ่านตามผล serial แต่ตรวจกับ host stub เท่านั้นก่อนหน้า |
| จดจำใบหน้า/Re-ID บนกล้องจริง | เวอร์ชันแรก ค่าเกณฑ์เป็นค่าตั้งต้น ยังไม่จูน |

---

## 4. งานค้าง (เรียงลำดับความสำคัญที่แนะนำ)

1. **วัด worker ตอนล้อวิ่งจริง** (ยกล้อลอยก่อน): CONNECT → TRACKING → ARM → FOLLOW ดู `rtt`, `page stall`, ล้อกระตุกหรือไม่ เทียบ `lite=1` กับ `lite=0`
2. ถ้าผลดี: ตั้ง `WORKER_DEFAULT_IN_LITE = true` และเขียนลง `CLAUDE.md`
3. ถ้า `page stall` ยังสูงเพราะใบหน้า: ย้ายตรวจใบหน้า (และ Re-ID ถ้าจำเป็น) ไป worker
4. ป้องกัน Wi-Fi หลุด: ขยับบอร์ดใกล้ hotspot ให้ `rssi` ดีกว่า −65, ปิด power saving ของ hotspot/การ์ด Wi-Fi, ตรวจไฟเลี้ยงบอร์ด
5. จดจำใบหน้าบนมือถือ: ลงทะเบียนใหม่บนมือถือ (origin `localhost:8000` บนมือถือแยกจากโน้ตบุ๊ก), ทดสอบและจูนค่าเกณฑ์ด้วยกล้องจริง
6. ขนาดภาพกล้องบนมือถือ ("กล้องเล็ก"): รอ `index.html`/CSS ของหน้าสีชมพูที่มีเฉพาะใน `C:\follow-app` และรอคำตอบว่าจะแบบ A (CSS ขยายเต็มความกว้าง) หรือ B (เพิ่มความละเอียดจับภาพ)
7. รัน `fetch-vendor.ps1` แล้วเช็กว่าการ์ดขึ้น `LIB LOCAL` (จะไม่ต้องพึ่งอินเทอร์เน็ตของมือถือ) และเซิร์ฟเวอร์ส่ง `.mjs` เป็น `text/javascript`
8. รายการเดิมใน `CLAUDE.md` หัวข้อ 7: สลับสายมอเตอร์/จูน `kRightGain`, E-STOP → GPIO23, เซ็นเซอร์ HC-SR04, เฝ้าแรงดันแบตเตอรี่, เขียนเทสต์ล็อกเฟส 1 (F2–F6, MT7–MT8) ใหม่, แก้ e2e `phase-c` และ `esp32-panel`

### ความปลอดภัย (ต้องคงไว้)
- **ฟิวส์ 10 A ยังไม่ได้ติด** → คง `kDriveDuty` ไม่เกิน 0.60 และติดฟิวส์ 10–15 A ที่สาย + ของแบตก่อนสวิตช์หลัก
- ไดโอดคร่อมคอยล์รีเลย์ (flyback) แนะนำให้ใส่ ยังไม่ยืนยัน
- ไม่มีโหมด "ไม่หยุด" · ESTOP, ลิงก์หลุด, ไม่เจอเจ้าของ, กล้องหลุด = หยุดเสมอ · สวิตช์ E-STOP ฮาร์ดแวร์คือตัวตัดอิสระ
- **อย่า commit `wifi_secrets.h`** และอย่าวางรหัส Wi-Fi ในแชต (รหัสเก่าอยู่ในประวัติ commit `af05e41` ควรเปลี่ยนรหัส hotspot)

---

## 5. Workflow การใช้แอป (ตั้งแต่ต้น)

### 5.1 เตรียมครั้งเดียว
1. คัดลอก `index.html`, `css/`, `js/` จาก branch `esp32-link` ไป `C:\follow-app` (ต้องมีไฟล์ `person-worker.js` และ `person-worker-client.js` ใน `js\`)
2. วางไฟล์โมเดลใบหน้า (`models\face\face_recognition_sface_2021dec.onnx`) และ Re-ID (`models\person-reid\person-reid.onnx`) ถ้าต้องการจดจำเจ้าของ
3. (ทางเลือก) รัน `tools\fetch-vendor.ps1` ตอนมีอินเทอร์เน็ต เพื่อใช้ไลบรารีจากดิสก์
4. เฟิร์มแวร์: เปิด `esp32-follow` ใน Arduino IDE บอร์ด ESP32 Dev Module ตรวจ `wifi_secrets.h` แล้วอัปโหลด ดู serial ว่า `GOT_IP` และ `WebSocket server: ws://192.168.137.50:81/ws`

### 5.2 เริ่มใช้งานทุกครั้ง
1. เปิด hotspot (เครื่อง Windows, 2.4 GHz, ปิด power saving) และเปิดไฟบอร์ด
2. บนโน้ตบุ๊ก: รัน PowerShell **แบบ Administrator** เซิร์ฟเวอร์สถิตที่ `C:\follow-app` พอร์ต 8000 (สคริปต์อยู่ใน `CLAUDE.md` หัวข้อ 4) อย่าคลิกในหน้าต่างนั้น ถ้าค้างกด Esc
3. มือถือ (Android Chrome) ต่อ hotspot เดียวกัน แล้วต่อ adb
   ```powershell
   cd C:\platform-tools
   .\adb connect 192.168.137.152:<พอร์ตจากหน้า Wireless debugging>
   .\adb reverse tcp:8000 tcp:8000
   ```
   (พอร์ตของ Wireless debugging เปลี่ยนทุกครั้งที่เปิดปิด)
4. เปิดหน้าเว็บบนมือถือ

| ต้องการ | URL |
|---|---|
| ใช้งานปกติ เบา ไม่จดจำใบหน้า | `http://localhost:8000/?modelMode=development&lite=1&mode=demo&worker=1` |
| มีตรวจใบหน้า/จดจำเจ้าของ (หนักกว่า) | `http://localhost:8000/?modelMode=development&lite=0&mode=demo&worker=1` |
| บนโน้ตบุ๊ก | `http://localhost:8000/?modelMode=development` |

   สะกดให้ถูก: `development` (มี p)

### 5.3 ขั้นตอนบนหน้าเว็บ
1. **START CAMERA** → ยืนห่าง 2–3 เมตรให้เห็นทั้งตัว
2. การ์ด PERSON DETECTION ควรขึ้น `GPU · WORKER` (ถ้าไม่ขึ้นดูข้อ 5.5)
3. **เลือกเจ้าของ**: แตะกรอบคน (ขึ้น `ติดตาม … TRACKING`) · หรือใช้ ENROL OWNER FACE / REMEMBER CLOTHES / FIND OWNER (ต้อง `lite=0` สำหรับใบหน้า)
4. กรอก URL บอร์ด `ws://192.168.137.50:81/ws` → **CONNECT** → ต้องขึ้น `CONNECTED (STOP)` (หน้าจะจำ URL และต่อซ้ำเองจนกด DISCONNECT)
5. **ARM** → **FOLLOW** (FOLLOW ไม่ต่อใหม่เองหลังหลุด ต้องกดเอง)
6. ดูค่า: `rtt` (ควรต่ำกว่า 300 ms), `page stall`, ช่วงห่างตรวจคน (ควร ~200 ms ตอน FOLLOW), MOTOR COMMAND (STOP/FORWARD/LEFT/RIGHT และความสูงกรอบ %)
7. จบงาน: กด FOLLOW ปิด/DISCONNECT และปิดสวิตช์หลัก (หรือสวิตช์ E-STOP) ก่อนยกกระเป๋า

### 5.4 เงื่อนไขที่ล้อจะหยุดเสมอ
เจ้าของหายไป (SEARCHING/LOST), ข้อมูลเก่าเกิน (age > 450 ms หรือ 1200 ms ในโหมด DEMO), `rtt` เกินเกณฑ์, ลิงก์หลุด, กล้องหลุด, ESTOP, กรอบสูง ≥ 95 % (ใกล้เกินไป; เริ่มเดินอีกครั้งเมื่อต่ำกว่า 87 %)

### 5.5 เมื่อมีปัญหา

| อาการ | สาเหตุที่พบบ่อย / สิ่งที่ทำ |
|---|---|
| หน้าเว็บบนมือถือเปิดไม่ได้ | adb หลุด (ต่อใหม่ + `adb reverse`), เซิร์ฟเวอร์ PowerShell ค้าง (กด Esc), พิมพ์ URL ไม่มี `http://` |
| `adb` ไม่รู้จักคำสั่ง | รันจาก `C:\platform-tools` ด้วย `.\adb` หรือเพิ่ม PATH |
| การ์ดไม่ขึ้น `WORKER` | ไฟล์ใน `C:\follow-app\js\` ยังเก่า (ตรวจ `Select-String ... "worker unavailable"`), ไม่ได้ใส่ `worker=1`, แคชเบราว์เซอร์ → ปิดแท็บแล้วเปิดใหม่ |
| ขึ้น `MAIN (worker unavailable/failed)` | worker ใช้ไม่ได้บนเครื่องนี้ → ดูคอนโซลที่ `chrome://inspect/#devices` (บรรทัดขึ้นต้น `[worker]`) |
| ไม่มีกรอบฟ้า `FACE nn%` บนมือถือ | อยู่ใน `lite=1` (ไม่ตรวจใบหน้า) → ใช้ `lite=0` และตรวจแถวโมเดลใบหน้าว่า READY |
| ข้อมูลเจ้าของหาย | `localhost:8000` บนมือถือเป็น origin ใหม่ ต้องลงทะเบียนใหม่ |
| หาบอร์ดไม่เจอ/ต่อไม่ได้ | `ping 192.168.137.50`, ดู serial (`wifi=3`, `rssi`, `DISCONNECTED reason=2 AUTH_EXPIRE`), ขยับบอร์ดใกล้ hotspot, มือถืออยู่ hotspot เดียวกันหรือไม่ |
| `DEVICE BUSY` | มีอีกหน้า/อีกเครื่องต่อบอร์ดอยู่ — ให้มีหน้าเดียวเท่านั้น |
| ล้อกระตุก `LEASE_EXPIRED` | ช่วงห่างตรวจคนเกิน ~300 ms หรือ `rtt` สูง |
| `relay=ON` แต่ล้อไม่หมุน | แบตเตอรี่/สวิตช์หลัก/สวิตช์ E-STOP (ไม่มีไฟมอเตอร์) |

---

## 6. ไฟล์ที่เปลี่ยนวันนี้ (ส่วนหลัก)

- เว็บ: `js/ai-owner.js`, `js/lite-mode.js`, `js/person-worker.js` (ใหม่), `js/person-worker-client.js` (ใหม่), `js/vendor-assets.js` (ใหม่), `js/ble-socket.js`, `js/app.js`, `js/esp32-session.js`, `js/camera.js`, `js/embedding/embedding-engine.js`
- เฟิร์มแวร์: `firmware/esp32-follow/config.h`, `esp32-follow.ino` (+ ไฟล์ BLE ที่คอมไพล์ออกด้วย `FOLLOW_WITH_BLE 0`)
- เครื่องมือ: `tools/fetch-vendor.ps1` (ใหม่, ยังไม่ทดสอบ)
- เทสต์: `person-worker-client`, `lite-mode`, `ble-socket`, `vendor-assets`, `embedding-engine-ort`, `transport-host`, `tests/e2e/person-worker.e2e.mjs` (+ `fake-vision.mjs`)
- เอกสาร: `CLAUDE.md`, `docs/work-report-2026-11-17.md`, ไฟล์นี้
