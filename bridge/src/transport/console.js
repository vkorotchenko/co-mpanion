'use strict';

const EventEmitter = require('events');
const log = require('../util/log');

// A drop-in replacement for BleCentral that "connects" instantly and prints
// every outgoing line instead of writing it over BLE. Used by --no-ble for a
// hardware-free dry run of the whole pipeline.
class ConsoleTransport extends EventEmitter {
  constructor() {
    super();
    this._connected = false;
  }

  start() {
    setImmediate(() => {
      this._connected = true;
      log.info('Console transport ready (no BLE). Outgoing lines below:');
      this.emit('connected', 'console');
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
    return Promise.resolve(true);
  }

  async stop() {
    this._connected = false;
  }
}

module.exports = { ConsoleTransport };
