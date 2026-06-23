'use strict';

const os = require('os');
const path = require('path');

const COPILOT_HOME =
  process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

module.exports = {
  // --- Copilot CLI local state ---------------------------------------------
  copilotHome: COPILOT_HOME,
  sessionStoreDb: path.join(COPILOT_HOME, 'session-store.db'),
  logsDir: path.join(COPILOT_HOME, 'logs'),

  // --- BLE / Nordic UART Service -------------------------------------------
  // The device advertises NUS; the bridge is the central. UUIDs are written
  // without dashes the way noble expects them.
  ble: {
    serviceUuid: '6e400001b5a3f393e0a9e50e24dcca9e',
    rxCharUuid: '6e400002b5a3f393e0a9e50e24dcca9e', // central -> device (write)
    txCharUuid: '6e400003b5a3f393e0a9e50e24dcca9e', // device -> central (notify)
    namePrefix: process.env.COMPANION_NAME_PREFIX || 'Copilot',
    // Fallback write chunk size when the negotiated MTU is unknown (default
    // ATT MTU 23 -> 20 usable payload bytes).
    fallbackChunk: 20,
  },

  // --- Timing --------------------------------------------------------------
  // How often to recompute the activity model and (if changed) push a snapshot.
  tickMs: 2000,
  // Push at least this often even when nothing changed (protocol keepalive;
  // the device treats >30s of silence as a dead link).
  keepaliveMs: 10000,
  // Poll the device's status ack this often (for the on-device stats panel).
  statusPollMs: 15000,

  // --- Activity heuristics -------------------------------------------------
  // A session counts as "active/total" if it produced a turn within this window.
  activeWindowMs: 5 * 60 * 1000,
  // The active log file growing within this window means a session is "running".
  busyWindowMs: 20 * 1000,
  // A turn that finished within this window flips the "completed" flag (the
  // device celebrates / shows hearts on a fast completion).
  completedWindowMs: 5 * 1000,
  // Max recent transcript entries to send (device stores up to 8).
  maxEntries: 6,
};
