'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../util/log');

// Passive detection of Copilot's *built-in* permission prompts so the buddy
// lights up whenever a session is actually waiting for the user — not only when
// an agent explicitly calls companion_confirm.
//
// Source: the Copilot CLI writes one event per line to
//   ~/.copilot/session-state/<session-id>/events.jsonl
// including a paired lifecycle we can follow without any DEBUG logging:
//   {"type":"permission.requested","data":{"requestId","permissionRequest":{
//        "kind":"shell|write|read|...","intention","fullCommandText","path"}}}
//   {"type":"permission.completed","data":{"requestId","result":{"kind":...}}}
// A request is *pending* when a `requested` has no matching `completed`.
//
// A session blocked on a prompt has a FROZEN events.jsonl mtime (stuck at the
// request line), so we can't just follow the newest file — we track every
// recently-active file plus any file that still has an unresolved request.
//
// This is read-only/best-effort: the device only *reflects* the pending prompt
// (the buttons can't answer Copilot's terminal prompt — that's resolved when
// `completed` appears). Any parse/IO error degrades to "nothing pending".
class PermissionWatch {
  constructor(cfg) {
    const p = (cfg && cfg.perm) || {};
    this._dir = cfg.sessionStateDir;
    this._recentWindowMs = p.recentWindowMs || 30 * 60 * 1000;
    // Ignore requests younger than this so fast auto-approvals (e.g. --yolo,
    // session-approved tools) don't flash on the device for one tick.
    this._minAgeMs = p.minAgeMs || 1500;
    this._maxReadBytes = 256 * 1024; // cap per-poll and initial-tail reads
    // path -> { offset, partial, pending: Map(requestId -> {ts, tool, hint}) }
    this._files = new Map();
  }

  // Poll: (re)scan candidate event files and consume any appended bytes.
  update() {
    let files;
    try {
      files = this._candidates();
    } catch (err) {
      log.debug('permwatch scan failed:', err.message);
      return;
    }
    // Drop state for files that vanished (session cleaned up).
    for (const known of this._files.keys()) {
      if (!files.has(known)) this._files.delete(known);
    }
    for (const file of files) {
      try {
        this._follow(file);
      } catch (err) {
        log.debug('permwatch follow failed:', err.message);
      }
    }
  }

  // The most relevant pending request (newest, older than the debounce), or
  // null. Shape: { id, tool, hint, ts }.
  pending(now = Date.now()) {
    let best = null;
    for (const st of this._files.values()) {
      for (const [requestId, req] of st.pending) {
        if (now - req.ts < this._minAgeMs) continue;
        if (!best || req.ts > best.ts) {
          best = { id: 'perm-' + requestId, tool: req.tool, hint: req.hint, ts: req.ts };
        }
      }
    }
    return best;
  }

  // List <dir>/*/events.jsonl worth scanning: modified within the recent
  // window, or already tracked with an unresolved request (a blocked session
  // whose mtime has gone stale).
  _candidates() {
    const out = new Set();
    const now = Date.now();
    let entries = [];
    try {
      entries = fs.readdirSync(this._dir, { withFileTypes: true });
    } catch {
      return out; // no session-state dir (e.g. fresh install) => nothing
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(this._dir, ent.name, 'events.jsonl');
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue; // no events.jsonl in this session dir
      }
      const tracked = this._files.get(file);
      const hasPending = tracked && tracked.pending.size > 0;
      if (now - mtimeMs <= this._recentWindowMs || hasPending) out.add(file);
    }
    return out;
  }

  _follow(file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    let st = this._files.get(file);
    if (!st) {
      // First sight: seed from the tail so an already-pending request (which
      // sits at/near EOF for a blocked session) is caught immediately.
      st = { offset: Math.max(0, size - this._maxReadBytes), partial: '', pending: new Map() };
      this._files.set(file, st);
    }
    if (size < st.offset) {
      // Truncated/rotated in place; restart.
      st.offset = 0;
      st.partial = '';
    }
    if (size === st.offset) return;

    const start = Math.max(st.offset, size - this._maxReadBytes);
    const length = size - start;
    let read = 0;
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      buf = Buffer.allocUnsafe(length);
      read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
    } catch (err) {
      log.debug('permwatch read failed:', err.message);
      return;
    }
    st.offset = size;
    this._consume(st, buf.subarray(0, read).toString('utf8'));
  }

  _consume(st, text) {
    const data = st.partial + text;
    const lines = data.split(/\r?\n/);
    st.partial = lines.pop(); // incomplete trailing line
    for (const line of lines) {
      if (!line || line.indexOf('permission.') === -1) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const d = ev && ev.data;
      if (!d || !d.requestId) continue;
      if (ev.type === 'permission.requested') {
        st.pending.set(d.requestId, this._describe(d, ev.timestamp));
      } else if (ev.type === 'permission.completed') {
        st.pending.delete(d.requestId);
      }
    }
  }

  // Build the device-facing { ts, tool, hint } from a permission.requested.
  _describe(data, timestamp) {
    const pr = data.permissionRequest || {};
    const kind = pr.kind || 'permission';
    const tool = TOOL_LABELS[kind] || kind;
    let hint = pr.fullCommandText || pr.path || pr.url || pr.intention || '';
    hint = String(hint).replace(/\s+/g, ' ').trim();
    let ts = Date.parse(timestamp);
    if (!Number.isFinite(ts)) ts = Date.now();
    return { ts, tool, hint };
  }
}

// Short, device-friendly labels (firmware prompt "tool" field is 19 chars).
const TOOL_LABELS = {
  shell: 'run command',
  write: 'edit file',
  read: 'read file',
  fetch: 'fetch url',
  network: 'network',
};

module.exports = { PermissionWatch };
