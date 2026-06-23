'use strict';

const crypto = require('crypto');
const snapshot = require('./protocol/snapshot');
const commands = require('./protocol/commands');
const log = require('./util/log');

// Orchestrates the device link: owns snapshot send/diff/keepalive, the one-shot
// time/owner handshake, and the bidirectional "write" surface (notify + confirm)
// that the MCP server drives.
//
// confirm() reuses the firmware's existing permission-prompt UI: we inject a
// `prompt` into the outgoing snapshot, the device shows it (A=approve, B=deny),
// and replies with {"cmd":"permission","id","decision"}. We correlate by id and
// resolve the pending promise. No firmware changes required.
class Bridge {
  constructor(transport, cfg) {
    this._t = transport;
    this._cfg = cfg;

    this._latest = null;      // latest telemetry snapshot from the source
    this._lastSent = null;
    this._lastSentAt = 0;
    this._statusTimer = null;
    this._keepalive = null;

    this._ownerName = null;
    this._pending = new Map();  // promptId -> { resolve, timer }
    this._activePrompt = null;  // { id, tool, hint } currently shown, or null
    this._notice = null;        // transient one-line override for msg
    this._noticeUntil = 0;

    this._wire();
  }

  _wire() {
    this._t.on('connected', (name) => this._onConnected(name));
    this._t.on('disconnected', () => this._onDisconnected());
    this._t.on('line', (msg) => this._onDeviceMessage(msg));
    this._t.on('scanning', () => log.info('Waiting for a co-mpanion device...'));
  }

  start() {
    commands.resolveOwnerName().then((n) => {
      this._ownerName = n;
      log.debug('Owner name:', n);
      if (this._t.connected) this._t.writeLine(commands.ownerMessage(n));
    });
    // Guarantee a push at least every keepaliveMs.
    this._keepalive = setInterval(() => this._push(false), 1000);
  }

  stop() {
    if (this._keepalive) clearInterval(this._keepalive);
    if (this._statusTimer) clearInterval(this._statusTimer);
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ decision: 'unavailable' });
    }
    this._pending.clear();
  }

  get connected() {
    return this._t.connected;
  }

  // --- telemetry (read) ----------------------------------------------------

  // Called by the orchestrator whenever the source emits a fresh activity model.
  setModel(model) {
    this._latest = snapshot.buildSnapshot(model);
    this._push(false);
  }

  // Most recent snapshot we computed (for the MCP status tool).
  get status() {
    return this._latest || { total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] };
  }

  // --- writes (notify / confirm) -------------------------------------------

  // Flash a short message on the device for a few seconds.
  notify(text, ttlMs = 6000) {
    this._notice = String(text || '').slice(0, snapshot.MSG_MAX);
    this._noticeUntil = Date.now() + ttlMs;
    this._push(true);
    return this._t.connected;
  }

  // Ask the device a yes/no question, reusing the permission-prompt UI.
  // Resolves to { decision: 'approved'|'denied'|'timeout'|'unavailable' }.
  confirm({ title, detail, timeoutMs = 60000 } = {}) {
    if (!this._t.connected) {
      return Promise.resolve({ decision: 'unavailable' });
    }
    const id = 'mcp-' + crypto.randomBytes(6).toString('hex');
    this._activePrompt = {
      id,
      tool: String(title || 'Confirm').slice(0, 19),
      hint: String(detail || '').slice(0, 43),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          this._clearPrompt();
          resolve({ decision: 'timeout' });
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
      this._push(true);
    });
  }

  // --- snapshot send -------------------------------------------------------

  _composed() {
    if (!this._latest) return null;
    const snap = Object.assign({}, this._latest);
    if (this._activePrompt) snap.prompt = this._activePrompt;
    if (this._notice && Date.now() < this._noticeUntil) snap.msg = this._notice;
    return snap;
  }

  _push(force) {
    if (!this._t.connected) return;
    const snap = this._composed();
    if (!snap) return;
    const changed = !this._lastSent || !snapshot.equal(snap, this._lastSent);
    const stale = Date.now() - this._lastSentAt >= this._cfg.keepaliveMs;
    if (!force && !changed && !stale) return;
    this._t.writeLine(snap);
    this._lastSent = snap;
    this._lastSentAt = Date.now();
    log.debug('TX snapshot:', JSON.stringify(snap));
  }

  _clearPrompt() {
    this._activePrompt = null;
    this._push(true);
  }

  // --- device link events --------------------------------------------------

  async _onConnected(name) {
    log.info(`Link up: ${name}. Sending time + owner.`);
    await this._t.writeLine(commands.timeMessage());
    if (this._ownerName) await this._t.writeLine(commands.ownerMessage(this._ownerName));
    this._lastSent = null;
    this._push(true);

    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(() => {
      if (this._t.connected) this._t.writeLine(commands.statusRequest());
    }, this._cfg.statusPollMs);
  }

  _onDisconnected() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    this._lastSent = null;
    // Fail any in-flight confirms; the user can re-ask once reconnected.
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve({ decision: 'unavailable' });
      this._pending.delete(id);
    }
    this._activePrompt = null;
  }

  _onDeviceMessage(msg) {
    if (typeof msg === 'string') {
      log.debug('RX (raw):', msg);
      return;
    }
    if (msg.cmd === 'permission' && msg.id) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        const decision = msg.decision === 'deny' ? 'denied' : 'approved';
        log.info(`Device answered ${msg.id}: ${decision}`);
        if (this._activePrompt && this._activePrompt.id === msg.id) this._clearPrompt();
        pending.resolve({ decision });
      } else {
        log.debug(`Permission reply for unknown id ${msg.id} (ignored).`);
      }
      return;
    }
    if (msg.ack) {
      if (msg.ack === 'status' && msg.data) {
        const d = msg.data;
        const bat = d.bat ? `${d.bat.pct}%${d.bat.usb ? '+' : ''}` : '?';
        log.info(`Device status: name=${d.name} bat=${bat} ` +
          `appr=${d.stats ? d.stats.appr : '?'} deny=${d.stats ? d.stats.deny : '?'}`);
      } else {
        log.debug(`ack ${msg.ack} ok=${msg.ok}`);
      }
      return;
    }
    log.debug('RX:', JSON.stringify(msg));
  }
}

module.exports = { Bridge };
