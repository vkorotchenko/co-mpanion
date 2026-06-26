'use strict';

const fs = require('fs');
const EventEmitter = require('events');
const { CopilotStore } = require('./store');
const { CopilotLogTail } = require('./logtail');
const { PermissionWatch } = require('./permwatch');
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
    this._perm = new PermissionWatch(cfg);
    this._readSettings = makeSettingsReader(cfg.settingsJson);
    this._timer = null;
    // Celebration latch (see _buildModel): the newest turn timestamp we've
    // already accounted for, and the deadline until which to show "completed".
    this._lastTurnMs = 0;
    this._celebrateUntil = 0;
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
    this._perm.update();
    const running = this._log.runningCount(cfg.busyWindowMs);
    const storeTotal = this._store.countActiveSessions(cfg.activeWindowMs);
    const total = Math.max(storeTotal, running);
    // Passive detection of Copilot's built-in permission prompts: when a session
    // is blocked waiting on the user, surface it as the device prompt so the
    // buddy lights up (the buttons can't answer it — it clears when the user
    // responds in the terminal and `permission.completed` lands in the log).
    const pendingPerm = this._perm.pending();
    const waitingUser = this._perm.waitingForUser();
    const waiting = (pendingPerm || waitingUser) ? 1 : 0;

    const newest = this._store.newestTurnTime();
    // Edge-triggered completion: a new turn row appearing is the authoritative
    // "a turn just finished" signal (it's only written at a real turn boundary,
    // never mid-turn during a tool gap). Latch it for completedHoldMs so the
    // animation is visible, independent of the busy-grace window. New model
    // activity (a request open right now) cancels it immediately.
    const newestMs = newest ? newest.getTime() : 0;
    if (this._lastTurnMs === 0) {
      this._lastTurnMs = newestMs; // prime on startup; don't celebrate history
    } else if (newestMs > this._lastTurnMs) {
      this._lastTurnMs = newestMs;
      this._celebrateUntil = Date.now() + cfg.completedHoldMs;
    }
    const completed = !this._log.aiActive && Date.now() < this._celebrateUntil;

    // recentTurns is newest-first; the firmware renders the transcript oldest-
    // at-top and treats the LAST line as the newest ("fresh", highlighted, and
    // the only one shown in the compact live view). So hand it oldest-first
    // (newest last) — otherwise the buddy shows/highlights the oldest prompts.
    const turns = this._store.recentTurns(cfg.maxEntries);
    const entries = turns.map((t) => formatEntry(t)).filter(Boolean).reverse();

    const model = {
      total,
      running,
      waiting,
      completed: !!completed,
      msg: deriveMsg({ running, waiting, total, turns, pendingPerm, waitingUser }),
      entries,
    };

    // A pending built-in permission prompt rides the device's existing prompt
    // UI (buildSnapshot forwards model.prompt). The firmware de-dups by id, so
    // re-sending the same `perm-<requestId>` never re-nags. An MCP confirm, if
    // active, still takes precedence (the bridge overlays its own prompt).
    if (pendingPerm) {
      model.prompt = { id: pendingPerm.id, tool: pendingPerm.tool, hint: pendingPerm.hint };
    }

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

function deriveMsg({ running, total, pendingPerm, waitingUser }) {
  if (pendingPerm) return 'approval waiting';
  if (waitingUser) return 'your turn';
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
  let text = flatten(stripInjected(turn.userMessage));
  if (!text) {
    const base = (turn.repository || turn.cwd || '').split(/[\\/]/).pop();
    text = base ? `(${base})` : '';
  }
  text = text.slice(0, 150);
  if (!text) return '';
  return when ? `${when} ${text}` : text;
}

// The CLI/harness injects wrappers into a turn's user_message — <system_reminder>
// blocks (custom instructions, todo status, sql tables...) and <current_datetime>
// stamps — that aren't anything the user typed. Strip them so the device
// transcript shows the real prompt; a turn that's *only* injected content
// collapses to empty and is dropped by the filter in _buildModel.
function stripInjected(s) {
  if (!s) return '';
  return String(s)
    // Paired blocks anywhere in the message.
    .replace(/<system[_-]?reminder>[\s\S]*?<\/system[_-]?reminder>/gi, ' ')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, ' ')
    // An unclosed block appended to the end (no closing tag before EOF).
    .replace(/<system[_-]?reminder>[\s\S]*$/i, ' ')
    .replace(/<current_datetime>[\s\S]*$/i, ' ');
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

module.exports = { CopilotSource, stripInjected };
