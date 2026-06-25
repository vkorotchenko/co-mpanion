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

    // --- "running" via AI-request groups -----------------------------------
    // The CLI brackets each model call with INFO lines:
    //   --- Start of group: Sending request to the AI model ---
    //   --- End of group ---
    // Groups are well-nested (LIFO) but "End of group" is generic, so we keep a
    // stack of booleans (isAiRequest) and count the open AI ones. This is far
    // more accurate than raw file growth and survives concurrent sub-agent
    // requests (multiple AI groups open at once).
    this._groupStack = [];   // bool[]: true = "Sending request to the AI model"
    this._aiOpen = 0;        // cached count of open AI-request groups
    this._lastAiMs = 0;      // last time an AI group opened or closed
    this._sawAiGroup = false;

    // --- session detail (model / effort / context tokens) ------------------
    this._model = null;      // e.g. "claude-opus-4.8"
    this._effort = null;     // e.g. "medium" (DEBUG-only; best-effort)
    this._ctxUsed = 0;       // context-window tokens in use
    this._ctxMax = 0;        // context-window size
    this._sawCtx = false;
  }

  // Poll: pick the newest log, attach if needed, consume appended bytes.
  update() {
    const newest = this._newestLog();
    if (!newest) return;

    if (newest !== this._file) {
      // Attach to the end of the (new) active file: we only care about growth
      // from now on, not historical megabytes.
      this._file = newest;
      let size = 0;
      try {
        size = fs.statSync(newest).size;
      } catch {
        size = 0;
      }
      // Seed "last value wins" state (model / effort / context tokens) from the
      // tail of the file so they appear immediately on connect instead of
      // waiting for the next occurrence. Groups (the running count) stay
      // tail-only — replaying historical open/close groups would be misleading.
      this._seedFromHistory(newest, size);
      this._offset = size;
      this._partial = '';
      // New file => the previous file's open groups are meaningless here.
      this._groupStack = [];
      this._aiOpen = 0;
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
    for (const line of lines) {
      this._parseGroups(line);
      this._parseTokens(line);
      this._parseModel(line);
      this._parseEffort(line);
    }
  }

  // Seed model / effort / context tokens from the tail of a freshly-attached
  // log so they're available on connect rather than only after the next
  // occurrence. Reads at most _maxReadBytes; never tails groups (running count).
  _seedFromHistory(file, size) {
    const start = Math.max(0, size - this._maxReadBytes);
    const length = size - start;
    if (length <= 0) return;
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
      text = buf.subarray(0, read).toString('utf8');
    } catch (err) {
      log.debug('history seed read failed:', err.message);
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      this._parseTokens(line);
      this._parseModel(line);
      this._parseEffort(line);
    }
  }

  // Track AI-request groups so "running" reflects actual generation rather than
  // any log activity. Groups are well-nested, so we push on every "Start of
  // group" (flagging the AI-model ones) and pop on every "End of group".
  _parseGroups(line) {
    const start = line.indexOf('Start of group: ');
    if (start !== -1) {
      const isAi = line.indexOf('Sending request to the AI model') !== -1;
      this._groupStack.push(isAi);
      if (isAi) {
        this._sawAiGroup = true;
        this._aiOpen++;
        this._lastAiMs = Date.now();
      }
      return;
    }
    if (line.indexOf('End of group') !== -1) {
      const wasAi = this._groupStack.pop();
      if (wasAi) {
        if (this._aiOpen > 0) this._aiOpen--;
        this._lastAiMs = Date.now();
      }
    }
  }

  // Context-window usage from the INFO line:
  //   CompactionProcessor: Utilization 35.0% (58817/168000 tokens) ...
  // This is the meaningful "tokens used" for a live session (used/total of the
  // window). We also keep the loose legacy match as a fallback for other lines.
  _parseTokens(line) {
    if (line.indexOf('token') === -1 && line.indexOf('Token') === -1) return;
    const ctx = /\((\d[\d,]*)\s*\/\s*(\d[\d,]*)\s+tokens\)/.exec(line);
    if (ctx) {
      const used = parseInt(ctx[1].replace(/,/g, ''), 10);
      const max = parseInt(ctx[2].replace(/,/g, ''), 10);
      if (Number.isFinite(used) && Number.isFinite(max)) {
        this._sawCtx = true;
        this._ctxUsed = used;
        this._ctxMax = max;
        this._sawTokens = true;
        this._tokens = used;
        return;
      }
    }
    const m =
      /"(?:total_tokens|output_tokens|outputTokens|cumulative_tokens|tokens)"\s*:\s*(\d+)/.exec(line) ||
      /\b(\d[\d,]*)\s+tokens\b/i.exec(line);
    if (!m) return;
    const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    if (!Number.isFinite(n)) return;
    this._sawTokens = true;
    if (n > this._tokens && !this._sawCtx) this._tokens = n;
  }

  // Active session model name. INFO logs "Using default model: <m>"; debug logs
  // carry currentModel="<m>". We deliberately ignore per-sub-agent
  // "model: <m> (override)" lines so the display reflects the session's model,
  // not a transient Task-tool sub-agent. Last session-level mention wins.
  _parseModel(line) {
    const m =
      /Using default model:\s*([A-Za-z0-9.\-]+)/.exec(line) ||
      /currentModel="([A-Za-z0-9.\-]+)"/.exec(line);
    if (m) this._model = m[1];
  }

  // Reasoning effort. Only emitted at DEBUG ("defaultReasoningEffort=medium" or
  // "reasoning_effort": "medium"), so this stays null on a normal INFO session.
  _parseEffort(line) {
    if (line.indexOf('ffort') === -1) return;
    const m =
      /defaultReasoningEffort[=:]\s*"?([A-Za-z]+)"?/.exec(line) ||
      /"reasoning_effort"\s*:\s*"([A-Za-z]+)"/.exec(line);
    if (m) this._effort = m[1].toLowerCase();
  }

  _newestLog() {
    // Search recursively so a launcher that redirects logs into per-session
    // subdirectories (e.g. `--log-dir <root>/session_*/process-*.log`) still
    // resolves to the single newest active log. A flat ~/.copilot/logs works
    // too (it's just depth 0).
    const best = { path: null, mtime: -1 };
    this._walkLogs(this._dir, 0, best);
    return best.path;
  }

  _walkLogs(dir, depth, best) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 4) this._walkLogs(full, depth + 1, best);
      } else if (/^process-.*\.log$/.test(ent.name)) {
        try {
          const mt = fs.statSync(full).mtimeMs;
          if (mt > best.mtime) { best.mtime = mt; best.path = full; }
        } catch { /* skip */ }
      }
    }
  }

  // True if the active log grew within the window.
  busy(windowMs) {
    return this._lastGrowthMs !== 0 && Date.now() - this._lastGrowthMs <= windowMs;
  }

  // Accurate "running" count: open AI-request groups, with a short grace window
  // so brief tool-execution gaps between requests don't flap idle. Falls back to
  // the file-growth heuristic only if this log never used AI-request groups
  // (e.g. an older CLI or a different log format).
  runningCount(graceMs) {
    if (this._aiOpen > 0) return this._aiOpen;
    if (this._sawAiGroup) {
      return this._lastAiMs !== 0 && Date.now() - this._lastAiMs <= graceMs ? 1 : 0;
    }
    return this.busy(graceMs) ? 1 : 0;
  }

  get lastGrowthMs() {
    return this._lastGrowthMs;
  }

  // Real-time: is a model request open *right now* (no grace window)? Unlike
  // runningCount(), this is the un-smoothed signal — used to detect a genuine
  // turn boundary and to cancel a just-finished "celebrate" the instant new
  // work actually starts.
  get aiActive() {
    return this._aiOpen > 0;
  }

  // Best-effort token usage (context-window "used" when available, else a loose
  // parse). null if we never parsed any.
  get tokens() {
    return this._sawTokens ? this._tokens : null;
  }

  // Context-window usage {used, max} (null until parsed).
  get contextTokens() {
    return this._sawCtx ? { used: this._ctxUsed, max: this._ctxMax } : null;
  }

  get model() {
    return this._model;
  }

  get effort() {
    return this._effort;
  }
}

module.exports = { CopilotLogTail };
