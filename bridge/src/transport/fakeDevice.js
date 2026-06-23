'use strict';

const EventEmitter = require('events');
const log = require('../util/log');

// A transport that pretends to be a connected device. It logs outgoing lines
// like ConsoleTransport, but also *auto-answers* any permission prompt it sees
// in an outgoing snapshot by emitting a {"cmd":"permission",...} line back.
// This lets the whole confirm() round-trip (and the MCP companion_confirm tool)
// be exercised end-to-end with no hardware.
//
// Set COMPANION_FAKE_DECISION=deny to make it deny instead of approve, and
// COMPANION_FAKE_DELAY_MS to control how long the "button press" takes.
class FakeDeviceTransport extends EventEmitter {
  constructor() {
    super();
    this._connected = false;
    this._decision = process.env.COMPANION_FAKE_DECISION === 'deny' ? 'deny' : 'once';
    this._delay = parseInt(process.env.COMPANION_FAKE_DELAY_MS || '400', 10);
    this._answered = new Set();
  }

  start() {
    setImmediate(() => {
      this._connected = true;
      log.info(`Fake device ready (auto-answers prompts: ${this._decision}).`);
      this.emit('connected', 'fake-device');
    });
  }

  get connected() {
    return this._connected;
  }

  writeLine(obj) {
    return this.writeRaw(JSON.stringify(obj) + '\n');
  }

  writeRaw(str) {
    process.stdout.write('  TX> ' + str);
    // Inspect for a permission prompt and schedule an auto-answer.
    try {
      const obj = JSON.parse(str);
      if (obj && obj.prompt && obj.prompt.id && !this._answered.has(obj.prompt.id)) {
        this._answered.add(obj.prompt.id);
        const id = obj.prompt.id;
        setTimeout(() => {
          const reply = { cmd: 'permission', id, decision: this._decision };
          log.info(`Fake device pressing ${this._decision === 'deny' ? 'DENY' : 'APPROVE'} for ${id}`);
          this.emit('line', reply);
        }, this._delay);
      }
    } catch {
      /* not JSON, ignore */
    }
    return Promise.resolve(true);
  }

  async stop() {
    this._connected = false;
  }
}

module.exports = { FakeDeviceTransport };
