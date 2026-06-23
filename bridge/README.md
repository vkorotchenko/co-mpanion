# co-mpanion bridge

The Copilot-side host app. It is the BLE **central**: it scans for a co-mpanion
device, connects, and streams your **GitHub Copilot CLI** activity to it as
newline-delimited JSON "heartbeat" snapshots (see `../REFERENCE.md`).

This is the piece the Claude desktop app provides natively for
`claude-desktop-buddy` — Copilot has no equivalent, so the bridge supplies it.

## Install

```bash
cd bridge
npm install
```

Native dependencies:

- `@abandonware/noble` — BLE central (CoreBluetooth on macOS).
- `better-sqlite3` — read-only access to the Copilot session store.

On macOS, the first run triggers a Bluetooth permission prompt; grant it. If
Bluetooth is off the bridge logs `BLE adapter state: poweredOff` and waits.

## Run

```bash
npm start            # read Copilot CLI activity, stream to a "Copilot-XXXX" device
npm run simulate     # stream scripted fake activity to a real device
npm run dry-run      # simulate + print lines to the console (no Bluetooth/device)
```

Or directly:

```bash
node src/index.js [--simulate] [--no-ble]
```

| Flag | Effect |
| --- | --- |
| `--simulate`, `-s` | Use scripted fake activity instead of reading Copilot. |
| `--no-ble` | Print outgoing JSON lines to the console instead of using BLE. |
| `--help`, `-h` | Usage. |

### Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `COPILOT_HOME` | `~/.copilot` | Copilot CLI state directory. |
| `COMPANION_NAME_PREFIX` | `Copilot` | BLE device-name prefix to scan for. |
| `COMPANION_LOG` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Where the data comes from

| Wire field | Source | Notes |
| --- | --- | --- |
| `total` | `session-store.db` — sessions with a turn in the last 5 min | "active" sessions |
| `running` | `logs/process-*.log` grew in the last ~20s | file-growth heuristic (format-independent) |
| `waiting` | — | always `0`; permission prompts are a later phase |
| `completed` | newest turn finished within ~5s and not busy | drives the device "celebrate/heart" |
| `msg` | derived | `working...` / `idle` / `approval waiting` |
| `entries` | recent `turns` (newest first) | `HH:MM <first line of your message>` |
| `tokens` | best-effort parse of log token lines | may be absent; the store has no counter |
| `time` / owner | OS clock / `gh api user` → git config → OS user | sent once on connect |

## How it's wired

```
copilot/store.js   ┐
copilot/logtail.js ┘→ copilot/source.js ─model→ index.js ─snapshot→ ble/central.js → device
                                                  │                 (or transport/console.js)
simulate.js ──────────────────────model─────────┘
```

- `protocol/snapshot.js` shapes a model into the exact wire object + size limits
  the firmware parses (`firmware/src/data.h`), and diffs snapshots so we only
  send on change (plus a ≤10s keepalive).
- `protocol/commands.js` builds the one-shot `time`/`owner` messages and the
  `status`/`name`/`unpair` commands; `index.js` handles the device's acks.
- `protocol/lineframer.js` reassembles MTU-fragmented notifications from the
  device into whole JSON lines.

## Caveats

- **Tokens are best-effort.** The local store has no token counter; we parse
  what we can from logs and otherwise omit the field.
- **Live state is heuristic.** "Running" is inferred from the active log file
  growing, not from a stable API — robust to log *format* changes, but it can't
  distinguish how many sessions are running (reports `running: 1` when busy).
- **Approve/deny is not implemented.** The device can already send a permission
  decision; wiring it back into the Copilot CLI's approval flow is the
  `permission-spike` phase (see `../plan` / project notes). Decisions received
  from the device are logged, not acted on.

## Smoke test (no hardware)

```bash
npm run dry-run        # see scripted snapshots on the console
COMPANION_LOG=debug node src/index.js --no-ble   # see snapshots from your real Copilot activity
```
