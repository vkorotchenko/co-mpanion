# co-mpanion

A tiny desk-buddy for **GitHub Copilot CLI** users. It mirrors the experience of
[`claude-desktop-buddy`](../claude-desktop-buddy): a small ESP32 pet (an
**M5Dial**) that wakes up when you're working, looks busy while sessions run, and
shows recent activity on its round screen.

The original buddy relies on the **Claude desktop app**, which natively scans
for the device over Bluetooth and streams session data to it. Copilot has no
such built-in bridge — so co-mpanion ships that piece itself.

```
┌────────────────────┐   reads    ┌──────────────────────┐   BLE / NUS   ┌────────────┐
│ GitHub Copilot CLI │ ─────────▶ │  co-mpanion bridge   │ ────JSON────▶ │  firmware  │
│  (~/.copilot/…)     │  store +   │  (Node.js, BLE       │  heartbeat    │ (M5Dial)   │
│                     │  logs      │   central)           │  snapshots    │            │
└────────────────────┘            └──────────────────────┘               └────────────┘
```

## Layout

| Path | What it is |
| --- | --- |
| `firmware/` | The ESP32 device firmware (forked from `claude-desktop-buddy`, rebranded for Copilot). Build with PlatformIO. |
| `bridge/` | **New.** A Node.js host app that acts as the BLE central, reads Copilot CLI state from `~/.copilot`, and streams it to the device. |
| `REFERENCE.md` | The BLE Nordic-UART wire protocol both sides speak (unchanged from the source repo). |
| `Makefile` | Build / USB-upload / OTA-flash / cut a release. Run `make help`. |

## How it works

The device is a BLE **peripheral** advertising the Nordic UART Service. The
bridge is the BLE **central** — it scans for a device whose name starts with
`Copilot`, connects, and then streams newline-delimited JSON "heartbeat"
snapshots describing your Copilot activity (sessions running, recent messages,
busy/idle state). See `REFERENCE.md` for the full protocol.

The bridge sources data from the Copilot CLI's local state:

- `~/.copilot/session-store.db` — session history (counts, recent transcript).
- `~/.copilot/logs/process-*.log` — the live event stream (busy/turn signals).

### Current scope

- **Read-only telemetry**: session counts, recent messages, busy/idle states,
  best-effort token estimates.
- **`--simulate` mode**: stream fake snapshots to bring up / test a device
  without any real Copilot activity.
- **Approve/deny from the device**: deferred. The Copilot CLI's approval flow
  isn't obviously hookable from outside the process — see the
  `permission-spike` notes. The protocol path is designed but not wired up.

## Quick start

### 1. Flash the firmware

```bash
cd firmware
pio run -t upload
```

The firmware targets the **M5Dial** (`board = m5stack-stamps3`, ESP32-S3). The
platform is pinned to `espressif32@6.9.0` and the libraries are M5Dial /
M5Unified / M5GFX. It builds with the bundled **dual-bank** `partitions_ota_8mb.csv`
(two ~1.94MB app slots for OTA + ~4MB LittleFS for GIF character packs).

#### Updating over the air (OTA)

Once the dual-bank firmware is on the device, you can update it over BLE instead
of USB. The simplest path is the Makefile:

```bash
make flash                      # build + OTA-flash the local firmware over BLE
# or push a published release to the device:
make flash-release VERSION=0.2.0
```

Under the hood that builds `firmware.bin` and runs
`bridge → npm run flash -- <bin>`; the bridge scans for the device, streams the
image into the *other* app slot, and the device verifies an MD5 and reboots into
it. A full image is ~1.2MB and takes a few minutes over BLE.

- **One-time USB step:** the dual-bank partition table is a flash-layout change,
  so the *first* time you must flash over USB (`make upload`). Every update after
  that can be OTA.
- **Integrity:** the MD5 is checked before the boot partition is switched, so a
  corrupted transfer is never booted; the link is already encrypted. Signed
  firmware / bootloader rollback are out of scope — see `REFERENCE.md`.
- The running version is reported in the `status` ack (`data.fw`).

#### Cutting a release

Releases are tag-driven. The Makefile bumps the version, tags, and pushes; a
GitHub Actions workflow then builds the firmware and publishes the `.bin` +
SHA256 to a GitHub Release (with the tag version baked into `FW_VERSION`).

```bash
make release-firmware-patch     # firmware-vX.Y.(Z+1)
make release-firmware-minor     # firmware-vX.(Y+1).0
make release-firmware-major     # firmware-v(X+1).0.0
```

(`make help` lists every target. Local dev builds report `FW_VERSION=dev`; only
release builds carry a real version.)

#### Controls (M5Dial)

The M5Dial has a round touchscreen, a rotary dial, and one button (on the
bezel). There is **no IMU**, so the Stick's shake/face-down gestures are gone.

| Input | Action |
| --- | --- |
| **Rotate dial** | scroll the transcript / move menu selection / change page; on a prompt, pick approve vs deny |
| **Spin fast** | the buddy gets dizzy (replaces "shake") |
| **Press button** | next screen (home → pet → info) / confirm a menu item / answer a prompt |
| **Hold button** | open / close the menu |
| **Touch** | tap the on-screen **approve**/**deny** buttons on a prompt; tap anywhere to wake |

The screen powers off after 30s idle on battery (kept on while charging or when
a prompt is up); any input wakes it. "Attention" pulses a red ring at the
screen edge (there's no separate LED) plus a periodic chirp.

> Migrating from the M5StickC Plus version? It lives in git history before the
> M5Dial migration commit.

### 2. Run the bridge

```bash
cd bridge
npm install
npm start          # scans for a "Copilot-XXXX" device and streams live data
# or:
npm run simulate   # streams scripted fake data to test the device
```

On macOS the first run will prompt for Bluetooth permission; grant it.

## Status & caveats

co-mpanion is a maker/hobby tool, not an official GitHub product.

- Token counts are **best-effort** (the local store has no token counter; we
  estimate from logs).
- Live "busy/idle" state is parsed from a **human-readable log**, not a stable
  API — it may need tweaks across Copilot CLI versions.

## License

See `LICENSE`. Firmware is derived from `claude-desktop-buddy`.
