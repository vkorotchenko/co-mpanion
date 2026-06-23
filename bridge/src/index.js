#!/usr/bin/env node
'use strict';

const cfg = require('./config');
const log = require('./util/log');
const snapshot = require('./protocol/snapshot');
const commands = require('./protocol/commands');
const { CopilotSource } = require('./copilot/source');
const { SimulateSource } = require('./simulate');

function parseArgs(argv) {
  const a = { simulate: false, ble: true, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--simulate' || arg === '-s') a.simulate = true;
    else if (arg === '--no-ble') a.ble = false;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else log.warn('Unknown argument:', arg);
  }
  return a;
}

const HELP = `co-mpanion bridge — stream GitHub Copilot CLI activity to a BLE desk-buddy.

Usage: co-mpanion [options]

Options:
  -s, --simulate   Stream scripted fake activity instead of reading Copilot.
      --no-ble     Don't use Bluetooth; print outgoing lines to the console.
  -h, --help       Show this help.

Env:
  COPILOT_HOME           Copilot state dir (default ~/.copilot)
  COMPANION_NAME_PREFIX  BLE device name prefix to scan for (default "Copilot")
  COMPANION_LOG          Log level: debug|info|warn|error (default info)
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  // --- transport (BLE central, or console for a hardware-free dry run) ------
  let transport;
  if (args.ble) {
    const { BleCentral } = require('./ble/central');
    transport = new BleCentral(cfg);
  } else {
    const { ConsoleTransport } = require('./transport/console');
    transport = new ConsoleTransport();
  }

  // --- data source ---------------------------------------------------------
  const source = args.simulate ? new SimulateSource(cfg) : new CopilotSource(cfg);
  log.info(args.simulate ? 'Source: simulated activity' : 'Source: Copilot CLI');

  // Resolve the owner's first name once; re-sent on every (re)connect.
  let ownerName = null;
  commands.resolveOwnerName().then((n) => {
    ownerName = n;
    log.debug('Owner name:', n);
    // If we connected before resolution finished, send it now.
    if (transport.connected) transport.writeLine(commands.ownerMessage(ownerName));
  });

  // --- snapshot send state -------------------------------------------------
  let latest = null;          // most recent wire snapshot
  let lastSent = null;        // last snapshot actually written
  let lastSentAt = 0;
  let statusTimer = null;

  function pushSnapshot(force) {
    if (!transport.connected || !latest) return;
    const changed = !lastSent || !snapshot.equal(latest, lastSent);
    const stale = Date.now() - lastSentAt >= cfg.keepaliveMs;
    if (!force && !changed && !stale) return;
    transport.writeLine(latest);
    lastSent = latest;
    lastSentAt = Date.now();
    log.debug('TX snapshot:', JSON.stringify(latest));
  }

  source.on('model', (model) => {
    latest = snapshot.buildSnapshot(model);
    pushSnapshot(false);
  });

  transport.on('scanning', () => log.info('Waiting for a co-mpanion device...'));

  transport.on('connected', async (name) => {
    log.info(`Link up: ${name}. Sending time + owner.`);
    // One-shot on connect: time sync, then owner name.
    await transport.writeLine(commands.timeMessage());
    if (ownerName) await transport.writeLine(commands.ownerMessage(ownerName));
    lastSent = null; // force a fresh snapshot to the new link
    pushSnapshot(true);

    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (transport.connected) transport.writeLine(commands.statusRequest());
    }, cfg.statusPollMs);
  });

  transport.on('disconnected', () => {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    lastSent = null;
  });

  transport.on('line', (msg) => handleDeviceMessage(msg));

  // --- keepalive: guarantee a push at least every keepaliveMs --------------
  const keepalive = setInterval(() => pushSnapshot(false), 1000);

  // --- lifecycle -----------------------------------------------------------
  source.start();
  transport.start();

  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(keepalive);
    if (statusTimer) clearInterval(statusTimer);
    try { source.stop(); } catch { /* noop */ }
    try { await transport.stop(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Device -> bridge messages: acks for our commands, and (deferred) permission
// decisions the user makes on the device.
function handleDeviceMessage(msg) {
  if (typeof msg === 'string') {
    log.debug('RX (raw):', msg);
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
  if (msg.cmd === 'permission') {
    // Deferred: forwarding this decision into the Copilot CLI's approval flow
    // is the permission-spike phase. For now we just surface it.
    log.warn(`Device permission decision received (id=${msg.id}, ` +
      `decision=${msg.decision}) but approve/deny wiring is not implemented yet.`);
    return;
  }
  log.debug('RX:', JSON.stringify(msg));
}

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
