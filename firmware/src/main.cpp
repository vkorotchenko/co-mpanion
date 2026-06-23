#include <M5Dial.h>
#include <LittleFS.h>
#include <stdarg.h>
#include "hw.h"
#include "ble_bridge.h"
#include "data.h"
#include "buddy.h"

// Full-screen canvas. The round GC9A01 is 240x240; off-circle pixels simply
// aren't shown, so we draw into a square sprite and keep content centered.
M5Canvas spr(&M5Dial.Display);

// Advertise as "Copilot-XXXX" (last two MAC bytes) so multiple devices in one
// room are distinguishable in the bridge's picker. Name persists in btName for
// the BLUETOOTH info page.
static char btName[16] = "Copilot";
static void startBt() {
  uint8_t mac[6] = {0};
  hwReadMac(mac);
  snprintf(btName, sizeof(btName), "Copilot-%02X%02X", mac[4], mac[5]);
  bleInit(btName);
}

#include "character.h"
#include "stats.h"

// Round 240x240 geometry.
const int W = 240, H = 240;
const int CX = W / 2;     // 120
const int CY = H / 2;     // 120
const int RAD = 120;

// Colors used across multiple UI surfaces. (GREEN/RED come from M5GFX's
// ili9341_colors; only the custom shades are defined here.)
const uint16_t HOT   = 0xFA20;   // red-orange: warnings, impatience, deny
const uint16_t PANEL = 0x2104;   // overlay panel background

enum PersonaState { P_SLEEP, P_IDLE, P_BUSY, P_ATTENTION, P_CELEBRATE, P_DIZZY, P_HEART };
const char* stateNames[] = { "sleep", "idle", "busy", "attention", "celebrate", "dizzy", "heart" };

TamaState    tama;
PersonaState baseState   = P_SLEEP;
PersonaState activeState = P_SLEEP;
uint32_t     oneShotUntil = 0;
unsigned long t = 0;

// Menu / overlay state
bool    menuOpen    = false;
uint8_t menuSel     = 0;
uint8_t brightLevel = 4;           // 0..4 -> hw brightness
bool    btnALong    = false;

enum DisplayMode { DISP_NORMAL, DISP_PET, DISP_INFO, DISP_COUNT };
uint8_t displayMode = DISP_NORMAL;
uint8_t infoPage = 0;
uint8_t petPage = 0;
const uint8_t PET_PAGES = 2;
uint8_t msgScroll = 0;
uint16_t lastLineGen = 0;
char     lastPromptId[40] = "";
uint32_t lastInteractMs = 0;
bool     screenOff = false;
bool     buddyMode = false;
bool     gifAvailable = false;
const uint8_t SPECIES_GIF = 0xFF;   // species NVS sentinel: use the installed GIF

// On a prompt, the encoder toggles which choice is highlighted; the button
// confirms it. Touch can also hit the on-screen buttons directly.
bool     promptDeny = false;        // false = approve highlighted, true = deny

// Cycle GIF (if installed) -> ASCII species 0..N-1 -> GIF.
static void nextPet() {
  uint8_t n = buddySpeciesCount();
  if (!buddyMode) {
    buddyMode = true;
    buddySetSpeciesIdx(0);
    speciesIdxSave(0);
  } else if (buddySpeciesIdx() + 1 >= n && gifAvailable) {
    buddyMode = false;
    speciesIdxSave(SPECIES_GIF);
  } else {
    buddyNextSpecies();
  }
  characterInvalidate();
  if (buddyMode) buddyInvalidate();
}

uint32_t wakeTransitionUntil = 0;
const uint32_t SCREEN_OFF_MS = 30000;

uint32_t promptArrivedMs = 0;
bool     responseSent = false;

static void applyBrightness() { hwSetBrightness(brightLevel); }

static void wake() {
  lastInteractMs = millis();
  if (screenOff) {
    hwScreenOn(brightLevel);
    screenOff = false;
    wakeTransitionUntil = millis() + 12000;
    statsOnWake();            // waking from rest tops up "energy"
  }
}

static void beep(uint16_t freq, uint16_t dur) {
  if (settings().sound) hwTone(freq, dur);
}

static void sendCmd(const char* json) {
  Serial.println(json);
  size_t n = strlen(json);
  bleWrite((const uint8_t*)json, n);
  bleWrite((const uint8_t*)"\n", 1);
}

const uint8_t INFO_PAGES = 6;
const uint8_t INFO_PG_CONTROLS = 1;
const uint8_t INFO_PG_CREDITS = 5;

void applyDisplayMode() {
  bool peek = displayMode != DISP_NORMAL;
  characterSetPeek(peek);
  buddySetPeek(peek);
  spr.fillSprite(0x0000);
  characterInvalidate();
}

// --- centered text helpers (round-safe: keep strings short) ----------------
static void cline(int y, uint16_t col, uint16_t bg, const char* fmt, ...) {
  char b[40]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a);
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(col, bg);
  spr.drawString(b, CX, y);
  spr.setTextDatum(TL_DATUM);
}

// ---------------------------------------------------------------------------
// Menus — centered panels sized to stay inside the circle.
// ---------------------------------------------------------------------------
const char* menuItems[] = { "settings", "turn off", "help", "about", "demo", "close" };
const uint8_t MENU_N = 6;

bool    settingsOpen = false;
uint8_t settingsSel  = 0;
// Dropped vs the Stick: "led" (no user LED) and "clock rot" (round, no
// orientation). Indices below map to applySetting().
const char* settingsItems[] = { "brightness", "sound", "bluetooth", "wifi", "transcript", "ascii pet", "reset", "back" };
const uint8_t SETTINGS_N = 8;

bool    resetOpen = false;
uint8_t resetSel  = 0;
const char* resetItems[] = { "delete char", "factory reset", "back" };
const uint8_t RESET_N = 3;
static uint32_t resetConfirmUntil = 0;
static uint8_t  resetConfirmIdx = 0xFF;

static void applySetting(uint8_t idx) {
  Settings& s = settings();
  switch (idx) {
    case 0: brightLevel = (brightLevel + 1) % 5; applyBrightness(); return;
    case 1: s.sound = !s.sound; break;
    case 2: s.bt = !s.bt; break;     // stored preference only — BLE stays live
    case 3: s.wifi = !s.wifi; break; // stored only — no WiFi stack linked
    case 4: s.hud = !s.hud; break;
    case 5: nextPet(); return;
    case 6: resetOpen = true; resetSel = 0; resetConfirmIdx = 0xFF; return;
    case 7: settingsOpen = false; characterInvalidate(); return;
  }
  settingsSave();
}

// Tap-twice confirm: first tap arms ("really?"), second within 3s executes.
static void applyReset(uint8_t idx) {
  uint32_t now = millis();
  bool armed = (resetConfirmIdx == idx) && (int32_t)(now - resetConfirmUntil) < 0;
  if (idx == 2) { resetOpen = false; return; }
  if (!armed) { resetConfirmIdx = idx; resetConfirmUntil = now + 3000; beep(1400, 60); return; }

  beep(800, 200);
  if (idx == 0) {
    File d = LittleFS.open("/characters");
    if (d && d.isDirectory()) {
      File e;
      while ((e = d.openNextFile())) {
        char path[80];
        snprintf(path, sizeof(path), "/characters/%s", e.name());
        if (e.isDirectory()) {
          File f;
          while ((f = e.openNextFile())) {
            char fp[128]; snprintf(fp, sizeof(fp), "%s/%s", path, f.name());
            f.close(); LittleFS.remove(fp);
          }
          e.close(); LittleFS.rmdir(path);
        } else { e.close(); LittleFS.remove(path); }
      }
      d.close();
    }
  } else {
    _prefs.begin("buddy", false); _prefs.clear(); _prefs.end();
    LittleFS.format();
    bleClearBonds();
  }
  delay(300);
  ESP.restart();
}

// A vertically-centered list panel. Returns nothing; selection highlighted.
static void drawListPanel(const char* const* items, uint8_t n, uint8_t sel,
                          uint16_t border, bool resetArm) {
  const Palette& p = characterPalette();
  const int rowH = 16;
  int mw = 150, mh = 14 + n * rowH + 8;
  int mx = (W - mw) / 2, my = (H - mh) / 2;
  spr.fillRoundRect(mx, my, mw, mh, 6, PANEL);
  spr.drawRoundRect(mx, my, mw, mh, 6, border);
  spr.setTextSize(1);
  Settings& s = settings();
  bool vals[] = { s.sound, s.bt, s.wifi, s.hud };
  for (int i = 0; i < n; i++) {
    bool seld = (i == sel);
    int ry = my + 12 + i * rowH;
    spr.setTextColor(seld ? p.text : p.textDim, PANEL);
    spr.setCursor(mx + 12, ry);
    spr.print(seld ? "> " : "  ");
    // reset-arm: items show "really?" when armed (only for the reset panel)
    if (resetArm && (i == resetConfirmIdx) && (int32_t)(millis() - resetConfirmUntil) < 0) {
      spr.setTextColor(HOT, PANEL); spr.print("really?");
      continue;
    }
    spr.print(items[i]);
    // settings value readouts on the right
    if (items == settingsItems) {
      spr.setCursor(mx + mw - 40, ry);
      if (i == 0) { spr.setTextColor(p.textDim, PANEL); spr.printf("%u/4", brightLevel); }
      else if (i >= 1 && i <= 4) { spr.setTextColor(vals[i-1] ? GREEN : p.textDim, PANEL); spr.print(vals[i-1] ? " on" : "off"); }
      else if (i == 5) {
        uint8_t total = buddySpeciesCount() + (gifAvailable ? 1 : 0);
        uint8_t pos = buddyMode ? buddySpeciesIdx() + 1 : total;
        spr.setTextColor(p.textDim, PANEL); spr.printf("%u/%u", pos, total);
      }
    }
    if (items == menuItems && i == 4) { spr.setTextColor(p.textDim, PANEL); spr.print(dataDemo() ? "  on" : " off"); }
  }
  // hint footer
  const Palette& q = p;
  spr.setTextColor(q.textDim, PANEL);
  spr.setTextDatum(MC_DATUM);
  spr.drawString("turn: move   press: select", CX, my + mh - 2);
  spr.setTextDatum(TL_DATUM);
}

static void drawMenu()     { drawListPanel(menuItems, MENU_N, menuSel, characterPalette().textDim, false); }
static void drawSettings() { drawListPanel(settingsItems, SETTINGS_N, settingsSel, characterPalette().textDim, false); }
static void drawReset()    { drawListPanel(resetItems, RESET_N, resetSel, HOT, true); }

void menuConfirm() {
  switch (menuSel) {
    case 0: settingsOpen = true; menuOpen = false; settingsSel = 0; break;
    case 1: hwPowerOff(); break;
    case 2:
    case 3:
      menuOpen = false;
      displayMode = DISP_INFO;
      infoPage = (menuSel == 2) ? INFO_PG_CONTROLS : 0;
      applyDisplayMode();
      characterInvalidate();
      break;
    case 4: dataSetDemo(!dataDemo()); break;
    case 5: menuOpen = false; characterInvalidate(); break;
  }
}

// ---------------------------------------------------------------------------
// Clock — single centered layout (the round screen has no orientation).
// ---------------------------------------------------------------------------
static const char* const MON[] = { "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec" };
static const char* const DOW[] = { "Sun","Mon","Tue","Wed","Thu","Fri","Sat" };

static m5::rtc_datetime_t _clk;
uint32_t _clkLastRead = 0;     // zeroed by data.h on time-sync
static bool _onUsb = false;
static void clockRefreshRtc() {
  if (millis() - _clkLastRead < 1000) return;
  _clkLastRead = millis();
  _onUsb = hwOnUsb();
  _clk = hwGetClock();
}
static uint8_t clockDow() { return ((_clk.date.weekDay % 7) + 7) % 7; }

static void drawClock() {
  const Palette& p = characterPalette();
  char hm[6]; snprintf(hm, sizeof(hm), "%02u:%02u", _clk.time.hours, _clk.time.minutes);
  char ss[4]; snprintf(ss, sizeof(ss), ":%02u", _clk.time.seconds);
  uint8_t mi = (_clk.date.month >= 1 && _clk.date.month <= 12) ? _clk.date.month - 1 : 0;
  char dl[14]; snprintf(dl, sizeof(dl), "%s %s %u", DOW[clockDow()], MON[mi], _clk.date.date);

  // lower-center band; the pet peeks above via peek mode
  spr.fillRect(0, 120, W, H - 120, p.bg);
  spr.setTextDatum(MC_DATUM);
  spr.setTextSize(4); spr.setTextColor(p.text, p.bg);    spr.drawString(hm, CX, 165);
  spr.setTextSize(2); spr.setTextColor(p.textDim, p.bg); spr.drawString(ss, CX, 198);
  spr.setTextSize(1);                                     spr.drawString(dl, CX, 218);
  spr.setTextDatum(TL_DATUM);
}

PersonaState derive(const TamaState& s) {
  if (!s.connected)            return P_IDLE;
  if (s.sessionsWaiting > 0)   return P_ATTENTION;
  if (s.recentlyCompleted)     return P_CELEBRATE;
  if (s.sessionsRunning >= 3)  return P_BUSY;
  return P_IDLE;
}

void triggerOneShot(PersonaState s, uint32_t durMs) {
  activeState = s;
  oneShotUntil = millis() + durMs;
}

// ---------------------------------------------------------------------------
// Info / pet / passkey / approval / HUD — centered for the round screen.
// ---------------------------------------------------------------------------
static void _infoHeader(const Palette& p, const char* section, uint8_t page) {
  cline(58, p.text, p.bg, "Info  %u/%u", page + 1, INFO_PAGES);
  cline(74, p.body, p.bg, "%s", section);
}

void drawPasskey() {
  const Palette& p = characterPalette();
  spr.fillSprite(p.bg);
  spr.setTextSize(1);
  cline(70, p.textDim, p.bg, "BLUETOOTH PAIRING");
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(p.text, p.bg);
  spr.setTextSize(3);
  char b[8]; snprintf(b, sizeof(b), "%06lu", (unsigned long)blePasskey());
  spr.drawString(b, CX, 120);
  spr.setTextSize(1);
  spr.setTextDatum(TL_DATUM);
  cline(170, p.textDim, p.bg, "enter on computer");
}

void drawInfo() {
  const Palette& p = characterPalette();
  const int TOP = 92;
  spr.fillRect(0, 50, W, H - 50, p.bg);
  spr.setTextSize(1);
  int y = TOP;
  auto ln = [&](uint16_t c, const char* fmt, ...) {
    char b[40]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a);
    cline(y, c, p.bg, "%s", b); y += 11;
  };

  if (infoPage == 0) {
    _infoHeader(p, "ABOUT", infoPage);
    ln(p.textDim, "I watch your Copilot");
    ln(p.textDim, "CLI sessions.");
    y += 4;
    ln(p.textDim, "I wake when you work,");
    ln(p.textDim, "fret when approvals");
    ln(p.textDim, "pile up.");
    y += 4;
    ln(p.text, "Tap / press on a");
    ln(p.text, "prompt to approve.");

  } else if (infoPage == 1) {
    _infoHeader(p, "CONTROLS", infoPage);
    ln(p.text,    "rotary dial");
    ln(p.textDim, "scroll / navigate");
    y += 3;
    ln(p.text,    "button (press)");
    ln(p.textDim, "next screen / select");
    y += 3;
    ln(p.text,    "hold button");
    ln(p.textDim, "open menu");
    y += 3;
    ln(p.text,    "touch");
    ln(p.textDim, "approve / deny, wake");

  } else if (infoPage == 2) {
    _infoHeader(p, "COPILOT", infoPage);
    ln(p.textDim, "sessions  %u", tama.sessionsTotal);
    ln(p.textDim, "running   %u", tama.sessionsRunning);
    ln(p.textDim, "waiting   %u", tama.sessionsWaiting);
    y += 6;
    ln(p.text,    "LINK");
    ln(p.textDim, "via   %s", dataScenarioName());
    ln(p.textDim, "ble   %s", !bleConnected() ? "-" : bleSecure() ? "encrypted" : "OPEN");
    ln(p.textDim, "state %s", stateNames[activeState]);

  } else if (infoPage == 3) {
    _infoHeader(p, "DEVICE", infoPage);
    int pct = hwBatteryPct();
    int vBat = hwBatteryVoltage_mV();
    if (hwBatteryKnown() && vBat > 0) {
      cline(100, p.text, p.bg, "%d%%  %s", pct, hwCharging() ? "charging" : "battery");
      y = 120;
      ln(p.textDim, "battery %d.%02dV", vBat/1000, (vBat%1000)/10);
    } else {
      cline(100, p.text, p.bg, "no fuel gauge");
      y = 120;
      ln(p.textDim, "battery: n/a");
    }
    uint32_t up = millis() / 1000;
    ln(p.textDim, "uptime  %luh %02lum", up/3600, (up/60)%60);
    ln(p.textDim, "heap    %uKB", ESP.getFreeHeap()/1024);
    if (ownerName()[0]) ln(p.textDim, "owner   %s", ownerName());

  } else if (infoPage == 4) {
    _infoHeader(p, "BLUETOOTH", infoPage);
    bool linked = settings().bt && dataBtActive();
    cline(100, linked ? GREEN : (settings().bt ? HOT : p.textDim), p.bg,
          "%s", linked ? "linked" : (settings().bt ? "discover" : "off"));
    y = 120;
    ln(p.text, "%s", btName);
    uint8_t mac[6] = {0}; hwReadMac(mac);
    ln(p.textDim, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    if (!linked && settings().bt) {
      y += 4;
      ln(p.text,    "run the co-mpanion");
      ln(p.text,    "bridge to connect");
    }

  } else {
    _infoHeader(p, "CREDITS", infoPage);
    ln(p.textDim, "co-mpanion");
    ln(p.text,    "github.com/vkorotchenko");
    ln(p.text,    "/co-mpanion");
    y += 6;
    ln(p.textDim, "hardware");
    ln(p.text,    "M5Dial");
    ln(p.textDim, "ESP32-S3 + RTC8563");
  }
}

static void tinyHeart(int x, int y, bool filled, uint16_t col) {
  if (filled) {
    spr.fillCircle(x - 2, y, 2, col);
    spr.fillCircle(x + 2, y, 2, col);
    spr.fillTriangle(x - 4, y + 1, x + 4, y + 1, x, y + 5, col);
  } else {
    spr.drawCircle(x - 2, y, 2, col);
    spr.drawCircle(x + 2, y, 2, col);
    spr.drawLine(x - 4, y + 1, x, y + 5, col);
    spr.drawLine(x + 4, y + 1, x, y + 5, col);
  }
}

static void drawPetStats(const Palette& p) {
  spr.fillRect(0, 86, W, H - 86, p.bg);
  spr.setTextSize(1);
  int y = 96;

  // mood
  cline(y, p.textDim, p.bg, "mood"); y += 12;
  uint8_t mood = statsMoodTier();
  uint16_t moodCol = (mood >= 3) ? RED : (mood >= 2) ? HOT : p.textDim;
  for (int i = 0; i < 4; i++) tinyHeart(CX - 24 + i * 16, y, i < mood, moodCol);
  y += 16;

  // fed
  cline(y, p.textDim, p.bg, "fed"); y += 12;
  uint8_t fed = statsFedProgress();
  for (int i = 0; i < 10; i++) {
    int px = CX - 45 + i * 9;
    if (i < fed) spr.fillCircle(px, y, 2, p.body);
    else spr.drawCircle(px, y, 2, p.textDim);
  }
  y += 16;

  // energy
  cline(y, p.textDim, p.bg, "energy"); y += 12;
  uint8_t en = statsEnergyTier();
  uint16_t enCol = (en >= 4) ? 0x07FF : (en >= 2) ? 0xFFE0 : HOT;
  for (int i = 0; i < 5; i++) {
    int px = CX - 32 + i * 13;
    if (i < en) spr.fillRect(px, y - 3, 9, 6, enCol);
    else spr.drawRect(px, y - 3, 9, 6, p.textDim);
  }
  y += 18;

  cline(y, p.body, p.bg, "Lv %u  approved %u", stats().level, stats().approvals);
}

static void drawPetHowTo(const Palette& p) {
  spr.fillRect(0, 86, W, H - 86, p.bg);
  spr.setTextSize(1);
  int y = 96;
  auto ln = [&](uint16_t c, const char* s) { cline(y, c, p.bg, "%s", s); y += 11; };
  ln(p.body,    "MOOD");
  ln(p.textDim, "approve fast = up");
  y += 3;
  ln(p.body,    "FED");
  ln(p.textDim, "50K tokens = level up");
  y += 3;
  ln(p.body,    "ENERGY");
  ln(p.textDim, "rest (sleep) refills");
}

void drawPet() {
  const Palette& p = characterPalette();
  if (petPage == 0) drawPetStats(p);
  else drawPetHowTo(p);
  spr.setTextSize(1);
  if (ownerName()[0]) cline(76, p.text, p.bg, "%s's %s  %u/%u", ownerName(), petName(), petPage + 1, PET_PAGES);
  else                cline(76, p.text, p.bg, "%s  %u/%u", petName(), petPage + 1, PET_PAGES);
}

// Approval prompt: tool name centered, two touch buttons below. The currently
// highlighted choice (encoder-selectable) gets a bright border.
static const int APPR_BTN_Y = 188, APPR_BTN_H = 34, APPR_BTN_W = 74;
static const int APPR_DENY_CX = 76, APPR_APPR_CX = 164;
static void drawApproval() {
  const Palette& p = characterPalette();
  spr.fillRect(0, 96, W, H - 96, p.bg);

  uint32_t waited = (millis() - promptArrivedMs) / 1000;
  cline(108, waited >= 10 ? HOT : p.textDim, p.bg, "approve?  %lus", (unsigned long)waited);

  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(p.text, p.bg);
  int toolLen = strlen(tama.promptTool);
  spr.setTextSize(toolLen <= 11 ? 2 : 1);
  spr.drawString(tama.promptTool, CX, 134);
  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  if (tama.promptHint[0]) {
    char h[22]; snprintf(h, sizeof(h), "%.21s", tama.promptHint);
    spr.drawString(h, CX, 156);
  }
  spr.setTextDatum(TL_DATUM);

  if (responseSent) {
    cline(190, p.textDim, p.bg, "sent...");
    return;
  }

  // buttons
  int by = APPR_BTN_Y - APPR_BTN_H / 2;
  // deny
  spr.fillRoundRect(APPR_DENY_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, PANEL);
  spr.drawRoundRect(APPR_DENY_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, promptDeny ? HOT : p.textDim);
  // approve
  spr.fillRoundRect(APPR_APPR_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, PANEL);
  spr.drawRoundRect(APPR_APPR_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, !promptDeny ? GREEN : p.textDim);
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(HOT, PANEL);   spr.drawString("deny",    APPR_DENY_CX, APPR_BTN_Y);
  spr.setTextColor(GREEN, PANEL); spr.drawString("approve", APPR_APPR_CX, APPR_BTN_Y);
  spr.setTextDatum(TL_DATUM);
}

// Greedy word-wrap into fixed-width rows.
static uint8_t wrapInto(const char* in, char out[][24], uint8_t maxRows, uint8_t width) {
  uint8_t row = 0, col = 0;
  const char* p = in;
  while (*p && row < maxRows) {
    while (*p == ' ') p++;
    const char* w = p;
    while (*p && *p != ' ') p++;
    uint8_t wlen = p - w;
    if (wlen == 0) break;
    uint8_t need = (col > 0 ? 1 : 0) + wlen;
    if (col + need > width) {
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      col = 0;
    }
    if (col > 0) out[row][col++] = ' ';
    while (wlen > width - col) {
      uint8_t take = width - col;
      memcpy(&out[row][col], w, take); col += take; w += take; wlen -= take;
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      col = 0;
    }
    memcpy(&out[row][col], w, wlen); col += wlen;
  }
  if (col > 0 && row < maxRows) { out[row][col] = 0; row++; }
  return row;
}

void drawHUD() {
  if (tama.promptId[0]) { drawApproval(); return; }
  const Palette& p = characterPalette();
  const int SHOW = 3, LH = 12, WIDTH = 20;
  const int BASE = 168;        // first line y; centered band in the lower half
  spr.fillRect(0, 150, W, H - 150, p.bg);
  spr.setTextSize(1);

  if (tama.lineGen != lastLineGen) { msgScroll = 0; lastLineGen = tama.lineGen; wake(); }

  if (tama.nLines == 0) {
    cline(BASE + LH, p.text, p.bg, "%s", tama.msg);
    return;
  }

  static char disp[32][24];
  static uint8_t srcOf[32];
  uint8_t nDisp = 0;
  for (uint8_t i = 0; i < tama.nLines && nDisp < 32; i++) {
    uint8_t got = wrapInto(tama.lines[i], &disp[nDisp], 32 - nDisp, WIDTH);
    for (uint8_t j = 0; j < got; j++) srcOf[nDisp + j] = i;
    nDisp += got;
  }

  uint8_t maxBack = (nDisp > SHOW) ? (nDisp - SHOW) : 0;
  if (msgScroll > maxBack) msgScroll = maxBack;
  int end = (int)nDisp - msgScroll;
  int start = end - SHOW; if (start < 0) start = 0;
  uint8_t newest = tama.nLines - 1;
  for (int i = 0; start + i < end; i++) {
    uint8_t row = start + i;
    bool fresh = (srcOf[row] == newest) && (msgScroll == 0);
    cline(BASE + i * LH, fresh ? p.text : p.textDim, p.bg, "%s", disp[row]);
  }
  if (msgScroll > 0) cline(BASE + SHOW * LH, p.body, p.bg, "-%u", msgScroll);
}

// Pulsing attention ring at the screen edge (replaces the Stick's red LED).
static void drawAttentionRing() {
  const Palette& p = characterPalette();
  bool on = (millis() / 400) % 2;
  uint16_t c = on ? HOT : p.bg;
  spr.drawCircle(CX, CY, RAD - 1, c);
  spr.drawCircle(CX, CY, RAD - 2, c);
  spr.drawCircle(CX, CY, RAD - 3, c);
}

// ---------------------------------------------------------------------------
// Input — rotary encoder, one button, capacitive touch.
// ---------------------------------------------------------------------------
static int32_t encPrev = 0;
static int32_t encAccum = 0;          // sub-detent accumulator
static uint32_t encLastStepMs = 0;
static int encFastCount = 0;

// Returns net detent steps since last call (one detent = 4 encoder counts) and
// flags a fast spin for the dizzy easter egg.
static int readEncoder(bool& fastSpin) {
  fastSpin = false;
  int32_t now = M5Dial.Encoder.read();
  int32_t d = now - encPrev;
  encPrev = now;
  if (d == 0) return 0;
  encAccum += d;
  int steps = encAccum / 4;
  encAccum -= steps * 4;
  if (steps != 0) {
    uint32_t t = millis();
    if (t - encLastStepMs < 90) { if (++encFastCount >= 6) { fastSpin = true; encFastCount = 0; } }
    else encFastCount = 0;
    encLastStepMs = t;
  }
  return steps;
}

static bool touchInButton(int tx, int ty, int bcx) {
  int by = APPR_BTN_Y - APPR_BTN_H / 2;
  return tx >= bcx - APPR_BTN_W/2 && tx <= bcx + APPR_BTN_W/2 &&
         ty >= by && ty <= by + APPR_BTN_H;
}

static void doApprove() {
  char cmd[96];
  snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"once\"}", tama.promptId);
  sendCmd(cmd);
  responseSent = true;
  uint32_t tookS = (millis() - promptArrivedMs) / 1000;
  statsOnApproval(tookS);
  beep(2400, 60);
  if (tookS < 5) triggerOneShot(P_HEART, 2000);
}
static void doDeny() {
  char cmd[96];
  snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"deny\"}", tama.promptId);
  sendCmd(cmd);
  responseSent = true;
  statsOnDenial();
  beep(600, 60);
}

void setup() {
  auto cfg = M5.config();
  M5Dial.begin(cfg, /*enableEncoder=*/true, /*enableRFID=*/false);
  M5Dial.Display.setRotation(0);
  M5Dial.Speaker.begin();
  M5Dial.Speaker.setVolume(160);
  M5Dial.BtnA.setHoldThresh(600);   // match the 600ms long-press used in loop()
  applyBrightness();
  lastInteractMs = millis();

  // Allocate the 240x240 canvas (~112KB) before BLE grabs heap, so the large
  // contiguous block isn't fragmented away.
  spr.setColorDepth(16);
  if (!spr.createSprite(W, H)) {
    Serial.println("sprite alloc failed");
  }

  startBt();

  statsLoad();
  settingsLoad();
  petNameLoad();
  buddyInit();

  characterInit(nullptr);
  gifAvailable = characterLoaded();
  buddyMode = !(gifAvailable && speciesIdxLoad() == SPECIES_GIF);
  applyDisplayMode();

  encPrev = M5Dial.Encoder.read();

  {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextSize(2);
    if (ownerName()[0]) {
      char line[40]; snprintf(line, sizeof(line), "%s's", ownerName());
      spr.setTextColor(p.text, p.bg); spr.drawString(line, CX, CY - 12);
      spr.setTextColor(p.body, p.bg); spr.drawString(petName(), CX, CY + 12);
    } else {
      spr.setTextColor(p.body, p.bg); spr.drawString("Hello!", CX, CY - 12);
      spr.setTextSize(1);
      spr.setTextColor(p.textDim, p.bg); spr.drawString("a buddy appears", CX, CY + 14);
    }
    spr.setTextDatum(TL_DATUM); spr.setTextSize(1);
    spr.pushSprite(0, 0);
    delay(1800);
  }
  Serial.printf("buddy: %s\n", buddyMode ? "ASCII mode" : "GIF character loaded");
}

void loop() {
  M5Dial.update();
  t++;
  uint32_t now = millis();

  dataPoll(&tama);

  // --- OTA in progress: take over the screen, suspend everything else -------
  // Each loop dataPoll() drained pending BLE bytes into Update.write(); just
  // show progress and keep the device awake until the device reboots on
  // ota_end (or the transfer aborts).
  if (otaActive()) {
    if (screenOff) { hwScreenOn(brightLevel); screenOff = false; }
    lastInteractMs = now;
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    cline(98, p.text, p.bg, "updating");
    uint32_t done = otaProgress(), total = otaTotal();
    int pct = total ? (int)((uint64_t)done * 100 / total) : 0;
    cline(132, p.body, p.bg, "%d%%", pct);
    int barW = 170;
    spr.drawRect(CX - barW/2, 150, barW, 10, p.textDim);
    if (total > 0) {
      int fill = (int)((uint64_t)(barW - 2) * done / total);
      if (fill > 0) spr.fillRect(CX - barW/2 + 1, 151, fill, 8, p.body);
    }
    cline(182, p.textDim, p.bg, "keep powered");
    spr.pushSprite(0, 0);
    delay(4);
    return;
  }

  if (statsPollLevelUp()) triggerOneShot(P_CELEBRATE, 3000);
  baseState = derive(tama);

  if (baseState == P_IDLE && (int32_t)(now - wakeTransitionUntil) < 0) baseState = P_SLEEP;
  if ((int32_t)(now - oneShotUntil) >= 0) activeState = baseState;

  // attention buzzer chirp (the ring is drawn in the render section)
  if (activeState == P_ATTENTION && settings().sound) {
    static uint32_t lastChirp = 0;
    if (now - lastChirp > 2000) { lastChirp = now; hwTone(1200, 60); }
  }

  // Prompt arrival: beep, jump to the approval screen, reset response flag.
  if (strcmp(tama.promptId, lastPromptId) != 0) {
    strncpy(lastPromptId, tama.promptId, sizeof(lastPromptId)-1);
    lastPromptId[sizeof(lastPromptId)-1] = 0;
    responseSent = false;
    if (tama.promptId[0]) {
      promptArrivedMs = now;
      promptDeny = false;
      wake();
      beep(1200, 80);
      displayMode = DISP_NORMAL;
      menuOpen = settingsOpen = resetOpen = false;
      applyDisplayMode();
      characterInvalidate();
      if (buddyMode) buddyInvalidate();
    }
  }

  bool inPrompt = tama.promptId[0] && !responseSent;

  // --- read inputs ---------------------------------------------------------
  bool fastSpin = false;
  int enc = readEncoder(fastSpin);
  bool click = M5Dial.BtnA.wasClicked();
  bool longPress = M5Dial.BtnA.pressedFor(600) && !btnALong;
  bool released = M5Dial.BtnA.wasReleased();

  // touch
  bool touched = false; int tx = 0, ty = 0;
  if (M5Dial.Touch.getCount()) {
    auto d = M5Dial.Touch.getDetail();
    if (d.wasPressed()) { touched = true; tx = d.x; ty = d.y; }
  }

  // Any input wakes the screen. Snapshot the off-state *before* wake() clears
  // it, so a wake interaction doesn't also act this frame.
  bool wasOff = screenOff;
  bool anyInput = enc != 0 || click || touched || M5Dial.BtnA.isPressed();
  if (anyInput) wake();
  if (wasOff) {
    // consumed solely as a wake; don't act this frame
    enc = 0; click = false; touched = false; longPress = false;
  }

  // fast encoder spin -> dizzy (replaces the Stick's shake)
  if (fastSpin && !menuOpen && !settingsOpen && !resetOpen && !inPrompt &&
      (int32_t)(now - oneShotUntil) >= 0) {
    triggerOneShot(P_DIZZY, 2000);
  }

  // --- long press: menu toggle / back -------------------------------------
  if (longPress) {
    btnALong = true;
    beep(800, 60);
    if (resetOpen) resetOpen = false;
    else if (settingsOpen) { settingsOpen = false; characterInvalidate(); }
    else { menuOpen = !menuOpen; menuSel = 0; if (!menuOpen) characterInvalidate(); }
  }
  if (released) btnALong = false;

  // --- encoder: navigate / scroll -----------------------------------------
  if (enc != 0) {
    if (inPrompt) {
      promptDeny = (enc > 0) ? true : false;   // right = deny, left = approve
      beep(1800, 20);
    } else if (resetOpen) {
      resetSel = (resetSel + (enc > 0 ? 1 : RESET_N - 1)) % RESET_N;
      resetConfirmIdx = 0xFF; beep(1800, 20);
    } else if (settingsOpen) {
      settingsSel = (settingsSel + (enc > 0 ? 1 : SETTINGS_N - 1)) % SETTINGS_N; beep(1800, 20);
    } else if (menuOpen) {
      menuSel = (menuSel + (enc > 0 ? 1 : MENU_N - 1)) % MENU_N; beep(1800, 20);
    } else if (displayMode == DISP_INFO) {
      infoPage = (infoPage + (enc > 0 ? 1 : INFO_PAGES - 1)) % INFO_PAGES; beep(1800, 20);
    } else if (displayMode == DISP_PET) {
      petPage = (petPage + (enc > 0 ? 1 : PET_PAGES - 1)) % PET_PAGES; applyDisplayMode(); beep(1800, 20);
    } else {
      // home: scroll transcript
      int ns = (int)msgScroll + (enc > 0 ? 1 : -1);
      if (ns < 0) ns = 0; if (ns > 30) ns = 30;
      msgScroll = ns; beep(1500, 15);
    }
  }

  // --- button click: select / advance -------------------------------------
  if (click && !btnALong) {
    if (inPrompt) {
      if (promptDeny) doDeny(); else doApprove();
    } else if (resetOpen) {
      applyReset(resetSel); beep(2400, 30);
    } else if (settingsOpen) {
      applySetting(settingsSel); beep(2400, 30);
    } else if (menuOpen) {
      menuConfirm(); beep(2400, 30);
    } else {
      // home/info/pet: advance to next screen
      displayMode = (displayMode + 1) % DISP_COUNT;
      applyDisplayMode();
      beep(1800, 30);
    }
  }

  // --- touch: approve/deny buttons, or wake -------------------------------
  if (touched && !inPrompt && menuOpen) {
    // tap a menu row to select it
  }
  if (touched && inPrompt && !responseSent) {
    if (touchInButton(tx, ty, APPR_APPR_CX)) doApprove();
    else if (touchInButton(tx, ty, APPR_DENY_CX)) doDeny();
  }

  static uint32_t lastPasskey = 0;
  uint32_t pk = blePasskey();
  if (pk && !lastPasskey) { wake(); beep(1800, 60); }
  lastPasskey = pk;

  // --- charging clock ------------------------------------------------------
  // The M5Dial can't sense USB power (no PMIC via M5Unified), so the clock
  // shows whenever the link is idle and the RTC has been synced; the idle
  // screen-off timer below still sleeps it on battery after 30s.
  clockRefreshRtc();
  bool clocking = displayMode == DISP_NORMAL
               && !menuOpen && !settingsOpen && !resetOpen && !inPrompt
               && tama.sessionsRunning == 0 && tama.sessionsWaiting == 0
               && dataRtcValid();
  static bool wasClocking = false;
  if (clocking != wasClocking) {
    if (clocking) characterSetPeek(true); else applyDisplayMode();
    characterInvalidate();
    if (buddyMode) buddyInvalidate();
    wasClocking = clocking;
  }
  if (clocking) {
    uint8_t dow = clockDow();
    bool weekend = (dow == 0 || dow == 6);
    uint8_t h = _clk.time.hours;
    if (h >= 1 && h < 7)        activeState = P_SLEEP;
    else if (weekend)           activeState = (now/8000 % 6 == 0) ? P_HEART : P_SLEEP;
    else if (h >= 22 || h == 0) activeState = (now/7000 % 3 == 0) ? P_DIZZY : P_SLEEP;
    else                        activeState = (now/10000 % 5 == 0) ? P_SLEEP : P_IDLE;
  }

  // --- render pet into the sprite -----------------------------------------
  if (screenOff) {
    // nothing
  } else if (buddyMode) {
    buddyTick(activeState);
  } else if (characterLoaded()) {
    characterSetState(activeState);
    characterTick();
  } else {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    if (xferActive()) {
      uint32_t done = xferProgress(), total = xferTotal();
      cline(110, p.textDim, p.bg, "installing");
      cline(126, p.textDim, p.bg, "%luK / %luK", done/1024, total/1024);
      int barW = 160;
      spr.drawRect(CX - barW/2, 140, barW, 8, p.textDim);
      if (total > 0) { int fill = (int)((uint64_t)barW * done / total); if (fill > 1) spr.fillRect(CX - barW/2 + 1, 141, fill - 1, 6, p.body); }
    } else {
      cline(120, p.textDim, p.bg, "no character loaded");
    }
  }

  // --- overlays ------------------------------------------------------------
  if (!screenOff) {
    if (blePasskey()) drawPasskey();
    else if (clocking) drawClock();
    else if (displayMode == DISP_INFO) drawInfo();
    else if (displayMode == DISP_PET) drawPet();
    else if (settings().hud) drawHUD();

    if (activeState == P_ATTENTION && !menuOpen && !settingsOpen && !resetOpen) drawAttentionRing();

    if (resetOpen) drawReset();
    else if (settingsOpen) drawSettings();
    else if (menuOpen) drawMenu();
    spr.pushSprite(0, 0);
  }

  // --- auto screen-off (battery only) -------------------------------------
  if (!screenOff && !inPrompt && !_onUsb && millis() - lastInteractMs > SCREEN_OFF_MS) {
    hwScreenOff();
    screenOff = true;
  }

  delay(screenOff ? 100 : 16);
}
