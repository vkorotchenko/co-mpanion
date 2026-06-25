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
npm run mcp          # also run the MCP server (read + write tools for Copilot)
npm run setup        # install: register MCP (http) + background service (see below)
npm run uninstall    # stop + remove the background service and MCP registration
npm test             # end-to-end MCP round-trip test against a fake device
```

Or directly:

```bash
node src/index.js [--simulate] [--no-ble] [--fake-device] [--mcp]
```

| Flag | Effect |
| --- | --- |
| `--simulate`, `-s` | Use scripted fake activity instead of reading Copilot. |
| `--no-ble` | Print outgoing JSON lines to the console instead of using BLE. |
| `--fake-device` | Simulate a connected device that auto-answers prompts (implies `--no-ble`). |
| `--mcp` | Also run the MCP server over HTTP (read + write tools for Copilot). |
| `--mcp-stdio` | Run the MCP server over stdio (implies `--mcp`); for `type: "local"` registration. Logs go to stderr. |
| `--help`, `-h` | Usage. |

### Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `COPILOT_HOME` | `~/.copilot` | Copilot CLI state directory. |
| `COMPANION_LOGS_DIR` | `$COPILOT_HOME/logs` | Where the live `process-*.log` lives. Set this if a launcher redirects logs via `--log-dir` (e.g. a wrapper using `~/.local/agency/logs/session_*/`); the tail searches it recursively. |
| `COMPANION_NAME_PREFIX` | `Copilot` | BLE device-name prefix to scan for. |
| `COMPANION_MCP_PORT` | `4317` | Port for the MCP HTTP server (`--mcp`). |
| `COMPANION_LOG` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Bidirectional mode (MCP): the device can answer the agent

By default the bridge is **read-only** telemetry. With `--mcp` it also hosts an
**MCP server** so the Copilot CLI agent can *talk back to the device* — the
supported "read + write" path (see the project notes on why a raw approve/deny
hook isn't possible). The MCP server reuses the device's existing
permission-prompt UI, so **no firmware change is needed**.

```bash
npm run mcp     # bridge + MCP server on http://127.0.0.1:4317/mcp
```

### Recommended — `make install` (HTTP + managed background service)

From the repo root, `make install` does everything: installs deps, registers
co-mpanion as a **`type:"http"`** MCP server in `~/.copilot/mcp-config.json`, and
installs a per-user background service (launchd on macOS, systemd `--user` on
Linux) that keeps **one** bridge running and owning the device. That single
shared bridge is the key: a Copilot session can spawn several processes
(interactive shell, agent subprocess, sub-agents) and the device accepts only
one BLE connection, so one long-lived owner — instead of a bridge-per-process
scramble — is what makes prompts reliably reach the device.

The MCP entry it writes is simply:

```json
{
  "mcpServers": {
    "co-mpanion": { "type": "http", "url": "http://127.0.0.1:4317/mcp", "tools": ["*"] }
  }
}
```

Manage it with `make service-restart`, `make service-logs`, `make uninstall`.
Restart any running Copilot session afterward so it loads the new config.

### Manual HTTP (no service)

Prefer to manage the process yourself? Start the bridge with `npm run mcp` (keep
it running) and add the same `type:"http"` entry above to
`~/.copilot/mcp-config.json` by hand.

### Advanced — stdio (`type: "local"`, single-process only)

Copilot can instead *launch the bridge itself* over stdio. Only use this if you
run a **single** Copilot process at a time: each process spawns its own bridge,
and only one can hold the BLE device — so with concurrent processes (agent
subprocesses, sub-agents, a separate interactive shell) the others get a
disconnected bridge and questions won't appear. Prefer HTTP above unless you
know you need this.

```json
{
  "mcpServers": {
    "co-mpanion": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/co-mpanion/bridge/src/index.js", "--mcp-stdio"],
      "tools": ["*"]
    }
  }
}
```

`--mcp-stdio` speaks JSON-RPC over stdout, so all logs are redirected to stderr.

Tools exposed to the agent:

| Tool | Direction | What it does |
| --- | --- | --- |
| `companion_status` | read | Returns current activity (sessions, busy/idle, recent messages, whether a device is connected). |
| `companion_notify` | write | Flashes a short message on the device screen. |
| `companion_confirm` | write | Shows an approve/deny prompt on the device and **blocks until the user presses a button**, returning `approved` / `denied`. |

Nudge the agent to route risky actions through it, e.g. in `AGENTS.md`:
*"Before any irreversible action, call `companion_confirm` and respect the
result."* The agent then gets a physical button press back as the tool result.

> This covers actions the agent *chooses* to route through the tool — it does
> not intercept Copilot's own built-in permission prompts (that isn't externally
> hookable today). See the project notes / `permission-spike`.


## Where the data comes from

| Wire field | Source | Notes |
| --- | --- | --- |
| `total` | `session-store.db` — sessions with a turn in the last 5 min | "active" sessions |
| `running` | open `--- ... Sending request to the AI model ---` groups in `logs/process-*.log` | counts in-flight model requests (stack-tracked); short grace window; falls back to file-growth on older log formats |
| `waiting` | — | always `0`; Copilot's own approval prompts aren't logged at INFO. Use the MCP `companion_confirm` tool to push questions to the device |
| `completed` | newest turn finished within ~5s and not busy | drives the device "celebrate/heart" |
| `msg` | derived | `working...` / `idle` / `approval waiting` |
| `entries` | recent `turns` (newest first) | `HH:MM <first line of your message>` |
| `tokens` / `tokens_used` / `tokens_max` | `CompactionProcessor: Utilization X% (used/total tokens)` log line | context-window usage; may be absent |
| `model` | `Using default model: <m>` (and override lines) in the log | e.g. `claude-opus-4.8` |
| `effort` | `defaultReasoningEffort` / `reasoning_effort` log lines | **debug-level only**, so usually absent at the default INFO log level |
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

- **Tokens are best-effort.** Parsed from the CLI's context-utilization log
  lines; absent until the first one is seen.
- **Live state is heuristic.** "Running" tracks open *"Sending request to the AI
  model"* log groups (accurate, and counts concurrent sub-agent requests), with
  a short grace window for tool-execution gaps; it falls back to file-growth only
  if a log predates those markers. It still can't attribute work to a *specific*
  session when several run at once.
- **`effort` needs debug logging.** Reasoning effort is only written at the CLI's
  debug log level, so on a normal INFO session the `effort` field is omitted.
- **Copilot's own approval prompts aren't auto-detected.** They aren't logged at
  INFO, so the bridge can't mirror them passively. To get questions on the
  device, run with `--mcp` and have the agent call `companion_confirm` (see the
  bidirectional section above and the repo `AGENTS.md`). Device decisions flow
  back as the tool result.

## Smoke test (no hardware)

```bash
npm run dry-run        # see scripted snapshots on the console
COMPANION_LOG=debug node src/index.js --no-ble   # see snapshots from your real Copilot activity
```
