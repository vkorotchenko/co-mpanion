'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../util/log');

// Tails the active Copilot CLI process log (~/.copilot/logs/process-*.log) to
// derive *live* signals the session store can't give us:
//   - "busy": the active log grew recently => a session is actively running.
//   - tokens: best-effort parse of token counters from log lines.
//
// IMPORTANT: process-*.log is a human-readable log, not a stable API. The
// busy signal relies only on the file *growing* (format-independent and
// robust). Token parsing is best-effort and may yield nothing across CLI
// versions; it never throws and degrades to "unknown".
class CopilotLogTail {
  constructor(cfg) {
    this._dir = cfg.logsDir;
    this._file = null;     // currently followed file path
    this._offset = 0;      // byte offset we've consumed up to
    this._partial = '';    // leftover bytes from an incomplete trailing line
    this._lastGrowthMs = 0;
    this._tokens = 0;      // best-effort cumulative (monotonic)
    this._sawTokens = false;
    this._maxReadBytes = 256 * 1024; // cap per-poll read
  }

  // Poll: pick the newest log, attach if needed, consume appended bytes.
  update() {
    const newest = this._newestLog();
    if (!newest) return;

    if (newest !== this._file) {
      // Attach to the end of the (new) active file: we only care about growth
      // from now on, not historical megabytes.
      this._file = newest;
      try {
        this._offset = fs.statSync(newest).size;
      } catch {
        this._offset = 0;
      }
      this._partial = '';
      log.debug('Following log:', path.basename(newest));
      return;
    }

    let size;
    try {
      size = fs.statSync(newest).size;
    } catch {
      return;
    }

    if (size < this._offset) {
      // Truncated/rotated in place; restart from the beginning.
      this._offset = 0;
      this._partial = '';
    }
    if (size === this._offset) return;

    // The file grew => activity. This is the robust "busy" signal.
    this._lastGrowthMs = Date.now();

    const start = Math.max(this._offset, size - this._maxReadBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    try {
      const fd = fs.openSync(newest, 'r');
      read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
    } catch (err) {
      log.debug('log read failed:', err.message);
      return;
    }
    this._offset = size;
    this._consume(buf.subarray(0, read).toString('utf8'));
  }

  _consume(text) {
    const data = this._partial + text;
    const lines = data.split(/\r?\n/);
    this._partial = lines.pop(); // last element is an incomplete line
    for (const line of lines) this._parseTokens(line);
  }

  // Best-effort: pull a cumulative token count out of a log line, if present.
  // Kept deliberately loose and tolerant; never throws.
  _parseTokens(line) {
    if (line.indexOf('token') === -1 && line.indexOf('Token') === -1) return;
    let m =
      /"(?:total_tokens|output_tokens|outputTokens|cumulative_tokens|tokens)"\s*:\s*(\d+)/.exec(line) ||
      /\b(\d[\d,]*)\s+tokens\b/i.exec(line);
    if (!m) return;
    const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    if (!Number.isFinite(n)) return;
    this._sawTokens = true;
    if (n > this._tokens) this._tokens = n; // monotonic; avoid bogus regressions
  }

  _newestLog() {
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return null;
    }
    let best = null;
    let bestMtime = -1;
    for (const name of entries) {
      if (!/^process-.*\.log$/.test(name)) continue;
      const full = path.join(this._dir, name);
      try {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > bestMtime) { bestMtime = mt; best = full; }
      } catch { /* skip */ }
    }
    return best;
  }

  // True if the active log grew within the window.
  busy(windowMs) {
    return this._lastGrowthMs !== 0 && Date.now() - this._lastGrowthMs <= windowMs;
  }

  get lastGrowthMs() {
    return this._lastGrowthMs;
  }

  // Best-effort cumulative tokens (null if we never parsed any).
  get tokens() {
    return this._sawTokens ? this._tokens : null;
  }
}

module.exports = { CopilotLogTail };
