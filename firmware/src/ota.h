#pragma once
#include <Arduino.h>
#include <Update.h>
#include <ArduinoJson.h>
#include <mbedtls/base64.h>
#include "ble_bridge.h"

// ---------------------------------------------------------------------------
// Over-the-air firmware update receiver (BLE, via the bridge).
//
// Parallels the character folder-push in xfer.h, but streams straight into the
// inactive OTA partition through the Arduino `Update` library instead of
// LittleFS. The bridge sends:
//
//   {"cmd":"ota_begin","size":<bytes>,"md5":"<32-hex>","version":"x.y.z"}
//   {"cmd":"ota_chunk","d":"<base64>"}    (repeated; ack carries bytes-so-far)
//   {"cmd":"ota_end"}                     (device verifies MD5, switches bank, reboots)
//   {"cmd":"ota_abort"}                   (cancel)
//
// Integrity: the image's MD5 is verified by Update.end() *before* the boot
// partition is switched, so a corrupted transfer can never be booted. The link
// itself is already encrypted (LE Secure Connections bonding). Signed firmware
// / Secure Boot and bootloader-level rollback are intentionally out of scope.
//
// Header-only with file-static state: include from exactly one translation unit
// (data.h, which is only pulled into main.cpp).
// ---------------------------------------------------------------------------

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

static bool     _otaActive = false;
static uint32_t _otaTotal = 0, _otaWritten = 0;
static uint32_t _otaStartMs = 0;

inline bool     otaActive()   { return _otaActive; }
inline uint32_t otaProgress() { return _otaWritten; }
inline uint32_t otaTotal()    { return _otaTotal; }

static void _otaAck(const char* what, bool ok, uint32_t n = 0, const char* err = nullptr) {
  char b[112];
  int len;
  if (err) len = snprintf(b, sizeof(b),
      "{\"ack\":\"%s\",\"ok\":%s,\"n\":%lu,\"error\":\"%s\"}\n",
      what, ok ? "true" : "false", (unsigned long)n, err);
  else len = snprintf(b, sizeof(b),
      "{\"ack\":\"%s\",\"ok\":%s,\"n\":%lu}\n",
      what, ok ? "true" : "false", (unsigned long)n);
  Serial.write(b, len);
  bleWrite((const uint8_t*)b, len);
}

// Returns true if `doc` was an ota_* command (caller skips other parsing).
inline bool otaCommand(JsonDocument& doc) {
  const char* cmd = doc["cmd"];
  if (!cmd) return false;

  if (strcmp(cmd, "ota_begin") == 0) {
    _otaTotal = doc["size"] | 0;
    const char* md5 = doc["md5"];
    if (_otaTotal == 0) { _otaAck("ota_begin", false, 0, "no size"); return true; }
    // U_FLASH = app partition. Update picks the next OTA slot automatically.
    if (!Update.begin(_otaTotal, U_FLASH)) {
      _otaAck("ota_begin", false, 0, "begin failed");
      return true;
    }
    if (md5 && strlen(md5) == 32) Update.setMD5(md5);
    _otaWritten = 0;
    _otaActive = true;
    _otaStartMs = millis();
    _otaAck("ota_begin", true);
    return true;
  }

  if (strcmp(cmd, "ota_chunk") == 0) {
    if (!_otaActive) { _otaAck("ota_chunk", false, 0, "not active"); return true; }
    const char* b64 = doc["d"];
    if (!b64) { _otaAck("ota_chunk", false, _otaWritten, "no data"); return true; }
    uint8_t buf[768];
    size_t outLen = 0;
    int rc = mbedtls_base64_decode(buf, sizeof(buf), &outLen,
                                   (const uint8_t*)b64, strlen(b64));
    if (rc != 0) { _otaAck("ota_chunk", false, _otaWritten, "b64"); return true; }
    size_t w = Update.write(buf, outLen);
    if (w != outLen) {
      Update.abort();
      _otaActive = false;
      _otaAck("ota_chunk", false, _otaWritten, "write");
      return true;
    }
    _otaWritten += outLen;
    _otaAck("ota_chunk", true, _otaWritten);
    return true;
  }

  if (strcmp(cmd, "ota_abort") == 0) {
    if (_otaActive) { Update.abort(); _otaActive = false; }
    _otaAck("ota_abort", true);
    return true;
  }

  if (strcmp(cmd, "ota_end") == 0) {
    if (!_otaActive) { _otaAck("ota_end", false, 0, "not active"); return true; }
    bool ok = Update.end(true);   // finalize + verify MD5; sets boot partition on success
    _otaActive = false;
    if (!ok) {
      _otaAck("ota_end", false, _otaWritten, Update.errorString());
      return true;
    }
    _otaAck("ota_end", true, _otaWritten);
    delay(500);                   // let the ack flush over BLE before we reboot
    ESP.restart();
    return true;
  }

  return false;
}
