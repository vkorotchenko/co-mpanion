# Agent instructions for co-mpanion

co-mpanion is a desk-buddy (an M5Dial running the firmware in `firmware/`) plus a
Node bridge (`bridge/`) that streams GitHub Copilot CLI activity to it over BLE.
When the bridge runs with `--mcp`, it exposes three tools you should use so the
physical buddy can show what's happening and ask the user real questions.

## Use the companion device

- **Before any risky or irreversible action, call `companion_confirm`** and respect
  the result. If it returns `denied`, do not perform the action. If it returns
  `unavailable` (no device connected) or `timeout`, fall back to your normal
  approval flow. Treat these as needing a hardware yes/no:
  - destructive git (`git push --force`, `git reset --hard`, branch/tag deletion,
    history rewrites), `rm -rf`, dropping/migrating databases, deploys/releases,
    OTA-flashing the device, or anything that's hard to undo.
  - Pass a short `title` (≤19 chars, e.g. the command) and a one-line `detail`.
- **Use `companion_notify` for milestone pings** (≤23 chars) so the buddy reflects
  progress: "build passed", "tests green", "deploying…", "release cut".
- `companion_status` reports current session activity (running/idle, recent
  messages, whether a device is connected) if you need to check state.

These tools are best-effort: if no device is connected they no-op gracefully, so
it is always safe to call them.

> This nudge only applies while working in this repo. To get device confirmations
> across all your sessions, copy the "Use the companion device" section into your
> global `~/.copilot/copilot-instructions.md`.

## Building & testing

- Firmware: `cd firmware && pio run` (build), `pio run -t upload` (USB flash).
- Bridge: `cd bridge && npm test` (MCP + OTA round-trip), `npm run dry-run`
  (print simulated wire snapshots, no hardware).
- See `README.md`, `bridge/README.md`, and `REFERENCE.md` for the wire protocol.
