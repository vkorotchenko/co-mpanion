'use strict';

// Reassembles newline-delimited messages from a byte stream. BLE notifications
// fragment at the MTU boundary, so the device->bridge direction needs the same
// accumulate-until-'\n' logic the firmware uses in the other direction.

class LineFramer {
  constructor(onLine) {
    this._buf = '';
    this._onLine = onLine;
  }

  push(chunk) {
    this._buf += chunk.toString('utf8');
    let idx;
    while ((idx = this._buf.search(/[\r\n]/)) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) this._onLine(trimmed);
    }
  }

  reset() {
    this._buf = '';
  }
}

module.exports = { LineFramer };
