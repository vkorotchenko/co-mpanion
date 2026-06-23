#pragma once
#include <M5Dial.h>
#include <time.h>

// ---------------------------------------------------------------------------
// M5Dial hardware abstraction.
//
// The buddy firmware was written for the M5StickC Plus (AXP192 power, IMU, two
// buttons, 135x240 LCD). The M5Dial is an M5StampS3 with a round 240x240
// GC9A01, capacitive touch, a rotary encoder, ONE button, an RTC8563, a buzzer
// and a different power path (no AXP192, HOLD on GPIO46). This header hides
// those differences so the rest of the firmware talks to neutral helpers.
//
// Notable losses vs the Stick (no IMU): shake->dizzy and face-down->nap are
// gone; a fast encoder spin now triggers dizzy, and "energy" drains on a timer.
// ---------------------------------------------------------------------------

// Round display geometry. Corners are not visible — keep content centered.
static const int HW_W = 240;
static const int HW_H = 240;
static const int HW_CX = 120;
static const int HW_CY = 120;
static const int HW_R  = 120;   // screen radius

// --- Power / battery -------------------------------------------------------

// 0..100, or -1 if unknown.
inline int hwBatteryPct() { return M5.Power.getBatteryLevel(); }

// Battery voltage in millivolts (0 if unavailable).
inline int hwBatteryVoltage_mV() { return M5.Power.getBatteryVoltage(); }

inline bool hwCharging() {
  return M5.Power.isCharging() == m5::Power_Class::is_charging_t::is_charging;
}

// USB/external power present. NOTE: M5Unified registers no PMIC/fuel-gauge for
// the M5Dial, so charge state, battery level and voltage are all unavailable
// (isCharging() always returns charge_unknown, getBatteryLevel() returns < 0).
// We therefore report "not on USB" so the idle screen-off timer actually runs;
// callers must treat the battery readouts as unknown when the pct is < 0.
inline bool hwOnUsb() { return false; }

// True when a real battery level is available (false on the M5Dial).
inline bool hwBatteryKnown() { return hwBatteryPct() >= 0; }

// Hard power-off (battery only; on USB the chip stays up). M5Unified drives
// the HOLD pin / PMIC as appropriate for the board.
inline void hwPowerOff() { M5.Power.powerOff(); }

// --- Screen ----------------------------------------------------------------

// brightLevel 0..4 -> 51..255.
inline uint8_t hwBrightnessFor(uint8_t level) {
  uint16_t v = 51 + (uint16_t)level * 51;
  return v > 255 ? 255 : (uint8_t)v;
}
inline void hwSetBrightness(uint8_t level) { M5Dial.Display.setBrightness(hwBrightnessFor(level)); }
inline void hwScreenOn(uint8_t level) { M5Dial.Display.wakeup(); M5Dial.Display.setBrightness(hwBrightnessFor(level)); }
inline void hwScreenOff() { M5Dial.Display.setBrightness(0); M5Dial.Display.sleep(); }
inline void hwDim() { M5Dial.Display.setBrightness(8); }

// --- Buzzer ----------------------------------------------------------------

inline void hwTone(uint16_t freq, uint16_t durMs) { M5Dial.Speaker.tone((float)freq, durMs); }
inline void hwToneUpdate() { /* M5Unified Speaker is non-blocking; nothing to pump */ }

// --- RTC (RTC8563) ---------------------------------------------------------

// Set the clock from a *local* epoch (caller already applied the tz offset).
inline void hwSetClockLocalEpoch(time_t localEpoch) {
  struct tm lt;
  gmtime_r(&localEpoch, &lt);
  M5Dial.Rtc.setDateTime(&lt);   // tm* overload
}
inline m5::rtc_datetime_t hwGetClock() { return M5Dial.Rtc.getDateTime(); }

// --- BLE name MAC ----------------------------------------------------------
// ESP32-S3 has no classic BT MAC; use the base/Wi-Fi MAC for the suffix.
inline void hwReadMac(uint8_t mac[6]) { esp_read_mac(mac, ESP_MAC_WIFI_STA); }
