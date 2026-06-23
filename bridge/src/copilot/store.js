'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../util/log');

// Read-only view over the Copilot CLI session store (~/.copilot/session-store.db).
// This is the *history* source: session counts and recent transcript. It does
// not contain live token counters or running/waiting state — that comes from
// the log tailer. We never write to this DB.
class CopilotStore {
  constructor(cfg) {
    this._dbPath = cfg.sessionStoreDb;
    this._db = null;
    this._Database = null;
  }

  open() {
    if (this._db) return true;
    if (!fs.existsSync(this._dbPath)) {
      log.warn(`Session store not found at ${this._dbPath}; session counts will be 0.`);
      return false;
    }
    try {
      // eslint-disable-next-line global-require
      this._Database = require('better-sqlite3');
    } catch (err) {
      log.error('better-sqlite3 not available; session history disabled.', err.message);
      return false;
    }
    try {
      this._db = new this._Database(this._dbPath, { readonly: true, fileMustExist: true });
      this._db.pragma('busy_timeout = 2000');
      log.info(`Opened session store: ${path.basename(this._dbPath)}`);
      return true;
    } catch (err) {
      log.error('Failed to open session store (read-only):', err.message);
      this._db = null;
      return false;
    }
  }

  get ready() {
    return !!this._db;
  }

  // Distinct sessions that produced a turn within the window.
  countActiveSessions(windowMs) {
    if (!this._db) return 0;
    try {
      const arg = `-${Math.round(windowMs / 1000)} seconds`;
      const row = this._db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS n
             FROM turns
            WHERE timestamp >= datetime('now', ?)`
        )
        .get(arg);
      return row ? row.n : 0;
    } catch (err) {
      log.debug('countActiveSessions failed:', err.message);
      return 0;
    }
  }

  // Newest turn timestamp across all sessions, as a Date (or null).
  newestTurnTime() {
    if (!this._db) return null;
    try {
      const row = this._db
        .prepare('SELECT MAX(timestamp) AS ts FROM turns')
        .get();
      return row && row.ts ? parseUtc(row.ts) : null;
    } catch (err) {
      log.debug('newestTurnTime failed:', err.message);
      return null;
    }
  }

  // Most recent turns, newest first, with the session's working directory.
  recentTurns(limit) {
    if (!this._db) return [];
    try {
      const rows = this._db
        .prepare(
          `SELECT s.cwd AS cwd, s.repository AS repository,
                  t.user_message AS userMessage, t.timestamp AS ts
             FROM turns t
             JOIN sessions s ON s.id = t.session_id
            ORDER BY t.timestamp DESC, t.id DESC
            LIMIT ?`
        )
        .all(limit);
      return rows.map((r) => ({
        cwd: r.cwd || '',
        repository: r.repository || '',
        userMessage: r.userMessage || '',
        time: parseUtc(r.ts),
      }));
    } catch (err) {
      log.debug('recentTurns failed:', err.message);
      return [];
    }
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch { /* noop */ }
      this._db = null;
    }
  }
}

// Store timestamps are UTC text ('YYYY-MM-DD HH:MM:SS') from datetime('now').
function parseUtc(ts) {
  if (!ts) return null;
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { CopilotStore };
