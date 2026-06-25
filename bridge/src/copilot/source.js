'use strict';

const fs = require('fs');
const EventEmitter = require('events');
const { CopilotStore } = require('./store');
const { CopilotLogTail } = require('./logtail');
const log = require('../util/log');

// Read the user's configured model/effort from ~/.copilot/settings.json. The
// INFO-level process log only names the model when it's the *default* ("Using
// default model: ..."); an explicitly-pinned model (settings.json "model")
// never appears there, so this is the reliable source for it. Cached by mtime
// so we re-read only when the file actually changes. Best-effort: any error
// degrades to nulls.
function makeSettingsReader(file) {
  let mtimeMs = -1;
  let cached = { model: null, effort: null };
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { model: null, effort: null };
    }
    if (stat.mtimeMs === mtimeMs) return cached;
    mtimeMs = stat.mtimeMs;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      cached = {
        model: typeof j.model === 'string' && j.model ? j.model : null,
        effort:
          typeof j.effortLevel === 'string' && j.effortLevel
            ? j.effortLevel
            : null,
      };
    } catch {
      cached = { model: null, effort: null };
    }
    return cached;
  };
}

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
    this._readSettings = makeSettingsReader(cfg.settingsJson);
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
    // Advance the log tail first so running-count and token parsing reflect the
    // latest log bytes. (Without this the tail never reads and the device stays
    // permanently "idle" with no tokens.)
    this._log.update();
    const running = this._log.runningCount(cfg.busyWindowMs);
    const busy = running > 0;
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
    const ctx = this._log.contextTokens;
    if (ctx) { model.tokensUsed = ctx.used; model.tokensMax = ctx.max; }

    // Model/effort: prefer the live log, fall back to the user's settings.json
    // (the log omits an explicitly-pinned model and only logs effort at debug).
    const settings = this._readSettings();
    const modelName = this._log.model || settings.model;
    const effort = this._log.effort || settings.effort;
    if (modelName) model.model = modelName;
    if (effort) model.effort = effort;

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

// "HH:MM <summary>" for the device transcript, newest first. The summary is
// the full prompt with whitespace/newlines collapsed to single spaces; the
// device word-wraps and scrolls it, so we send it (nearly) whole rather than
// truncating to a single short line.
function formatEntry(turn) {
  const when = turn.time ? hhmm(turn.time) : '';
  let text = flatten(turn.userMessage);
  if (!text) {
    const base = (turn.repository || turn.cwd || '').split(/[\\/]/).pop();
    text = base ? `(${base})` : '';
  }
  text = text.slice(0, 150);
  if (!text) return '';
  return when ? `${when} ${text}` : text;
}

// Collapse a multi-line message into one whitespace-normalized string.
function flatten(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function hhmm(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

module.exports = { CopilotSource };
