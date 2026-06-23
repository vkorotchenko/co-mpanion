# co-mpanion

A tiny desk-buddy for **GitHub Copilot CLI** users. It mirrors the experience of
[`claude-desktop-buddy`](../claude-desktop-buddy): a small ESP32 pet (M5StickC
Plus) that wakes up when you're working, looks busy while sessions run, and
shows recent activity on its screen.

The original buddy relies on the **Claude desktop app**, which natively scans
for the device over Bluetooth and streams session data to it. Copilot has no
such built-in bridge — so co-mpanion ships that piece itself.

```
┌────────────────────┐   reads    ┌──────────────────────┐   BLE / NUS   ┌────────────┐
│ GitHub Copilot CLI │ ─────────▶ │  co-mpanion bridge   │ ────JSON────▶ │  firmware  │
│  (~/.copilot/…)     │  store +   │  (Node.js, BLE       │  heartbeat    │ (M5StickC) │
│                     │  logs      │   central)           │  snapshots    │            │
└────────────────────┘            └──────────────────────┘               └────────────┘
```

## Layout

| Path | What it is |
| --- | --- |
| `firmware/` | The ESP32 device firmware (forked from `claude-desktop-buddy`, rebranded for Copilot). Build with PlatformIO. |
| `bridge/` | **New.** A Node.js host app that acts as the BLE central, reads Copilot CLI state from `~/.copilot`, and streams it to the device. |
| `REFERENCE.md` | The BLE Nordic-UART wire protocol both sides speak (unchanged from the source repo). |

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

- ✅ **Read-only telemetry**: session counts, recent messages, busy/idle states,
  best-effort token estimates.
- 🧪 **`--simulate` mode**: stream fake snapshots to bring up / test a device
  without any real Copilot activity.
- ⏳ **Approve/deny from the device**: deferred. The Copilot CLI's approval flow
  isn't obviously hookable from outside the process — see the
  `permission-spike` notes. The protocol path is designed but not wired up.

## Quick start

### 1. Flash the firmware

```bash
cd firmware
pio run -t upload
```

(See `firmware/` / the original `claude-desktop-buddy` README for hardware and
flashing details — same M5StickC Plus target.)

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
