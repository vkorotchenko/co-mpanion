'use strict';

const EventEmitter = require('events');
const { CopilotStore } = require('./store');
const { CopilotLogTail } = require('./logtail');
const log = require('../util/log');

// Aggregates the two Copilot CLI data sources (session store + live log tail)
// into a single activity model and emits it on a fixed tick. The orchestrator
// turns models into wire snapshots and handles send/diff/keepalive.
//
// Events:
//   'model' -> (model)   see buildSnapshot() in protocol/snapshot.js for shape
class CopilotSource extends EventEmitter {
  constructor(cfg) {
    super();
    this._cfg = cfg;
    this._store = new CopilotStore(cfg);
    this._log = new CopilotLogTail(cfg);
    this._timer = null;
  }

  start() {
    this._store.open();
    const tick = () => {
      try {
        this.emit('model', this._buildModel());
      } catch (err) {
        log.error('source tick failed:', err.message);
      }
    };
    tick();
    this._timer = setInterval(tick, this._cfg.tickMs);
  }

  _buildModel() {
    const cfg = this._cfg;
    const busy = this._log.busy(cfg.busyWindowMs);
    const running = busy ? 1 : 0;
    const storeTotal = this._store.countActiveSessions(cfg.activeWindowMs);
    const total = Math.max(storeTotal, running);
    const waiting = 0; // permission prompts are a deferred phase

    const newest = this._store.newestTurnTime();
    const completed =
      !busy && newest && Date.now() - newest.getTime() <= cfg.completedWindowMs;

    const turns = this._store.recentTurns(cfg.maxEntries);
    const entries = turns.map((t) => formatEntry(t)).filter(Boolean);

    const model = {
      total,
      running,
      waiting,
      completed: !!completed,
      msg: deriveMsg({ running, waiting, total, turns }),
      entries,
    };

    const tokens = this._log.tokens;
    if (tokens != null) model.tokens = tokens;

    return model;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._store.close();
  }
}

function deriveMsg({ running, waiting, total }) {
  if (waiting > 0) return 'approval waiting';
  if (running > 0) return 'working...';
  if (total > 0) return 'idle';
  return 'idle';
}

// "HH:MM <summary>" for the device transcript, newest first.
function formatEntry(turn) {
  const when = turn.time ? hhmm(turn.time) : '';
  let text = firstLine(turn.userMessage);
  if (!text) {
    const base = (turn.repository || turn.cwd || '').split(/[\\/]/).pop();
    text = base ? `(${base})` : '';
  }
  text = text.slice(0, 60);
  if (!text) return '';
  return when ? `${when} ${text}` : text;
}

function firstLine(s) {
  if (!s) return '';
  const line = String(s)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line || '').replace(/\s+/g, ' ');
}

function hhmm(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

module.exports = { CopilotSource };
