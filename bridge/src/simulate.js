'use strict';

const EventEmitter = require('events');

// Scripted stand-in for CopilotSource: cycles through representative scenarios
// so a device (or --no-ble console) can be exercised without any real Copilot
// activity. Same 'model' event contract as CopilotSource.
class SimulateSource extends EventEmitter {
  constructor(cfg) {
    super();
    this._cfg = cfg;
    this._i = 0;
    this._timer = null;
    this._stepMs = 6000;
  }

  start() {
    const tick = () => {
      const scn = SCENARIOS[this._i % SCENARIOS.length];
      this._i += 1;
      this.emit('model', scn());
    };
    tick();
    this._timer = setInterval(tick, this._stepMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SCENARIOS = [
  () => ({ total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [], tokens: 12000, model: 'claude-opus-4.8', effort: 'high', tokensUsed: 12000, tokensMax: 168000 }),
  () => ({
    total: 3, running: 2, waiting: 0, completed: false, msg: 'working...',
    entries: [`${now()} run the tests`, `${now()} fix the bridge`, `${now()} read config.js`],
    tokens: 89000, model: 'claude-opus-4.8', effort: 'high', tokensUsed: 89000, tokensMax: 168000,
  }),
  () => ({
    total: 2, running: 0, waiting: 1, completed: false, msg: 'approval waiting',
    entries: [`${now()} git push origin main`],
    tokens: 104000, model: 'claude-sonnet-4.6', effort: 'medium', tokensUsed: 104000, tokensMax: 168000,
    prompt: { id: 'sim-req-1', tool: 'Bash', hint: 'git push origin main' },
  }),
  () => ({
    total: 1, running: 0, waiting: 0, completed: true, msg: 'done',
    entries: [`${now()} all tests passed`],
    tokens: 142000, model: 'claude-sonnet-4.6', effort: 'medium', tokensUsed: 142000, tokensMax: 168000,
  }),
];

module.exports = { SimulateSource };
