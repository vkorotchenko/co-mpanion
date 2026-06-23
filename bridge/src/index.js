#!/usr/bin/env node
'use strict';

const cfg = require('./config');
const log = require('./util/log');
const { Bridge } = require('./bridge');
const { CopilotSource } = require('./copilot/source');
const { SimulateSource } = require('./simulate');

function parseArgs(argv) {
  const a = { simulate: false, ble: true, fakeDevice: false, mcp: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--simulate' || arg === '-s') a.simulate = true;
    else if (arg === '--no-ble') a.ble = false;
    else if (arg === '--fake-device') { a.fakeDevice = true; a.ble = false; }
    else if (arg === '--mcp') a.mcp = true;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else log.warn('Unknown argument:', arg);
  }
  return a;
}

const HELP = `co-mpanion bridge — stream GitHub Copilot CLI activity to a BLE desk-buddy.

Usage: co-mpanion [options]

Options:
  -s, --simulate    Stream scripted fake activity instead of reading Copilot.
      --no-ble      Don't use Bluetooth; print outgoing lines to the console.
      --fake-device Simulate a connected device that auto-answers prompts
                    (implies --no-ble; for testing confirm/MCP round-trips).
      --mcp         Also run the MCP server (read+write tools for Copilot).
  -h, --help        Show this help.

Env:
  COPILOT_HOME           Copilot state dir (default ~/.copilot)
  COMPANION_NAME_PREFIX  BLE device name prefix to scan for (default "Copilot")
  COMPANION_MCP_PORT     MCP HTTP port (default 4317)
  COMPANION_LOG          Log level: debug|info|warn|error (default info)
`;

function makeTransport(args) {
  if (args.fakeDevice) {
    const { FakeDeviceTransport } = require('./transport/fakeDevice');
    return new FakeDeviceTransport();
  }
  if (!args.ble) {
    const { ConsoleTransport } = require('./transport/console');
    return new ConsoleTransport();
  }
  const { BleCentral } = require('./ble/central');
  return new BleCentral(cfg);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const transport = makeTransport(args);
  const source = args.simulate ? new SimulateSource(cfg) : new CopilotSource(cfg);
  log.info(args.simulate ? 'Source: simulated activity' : 'Source: Copilot CLI');

  const bridge = new Bridge(transport, cfg);
  source.on('model', (model) => bridge.setModel(model));

  let mcp = null;
  if (args.mcp) {
    const { CompanionMcpServer } = require('./mcp/server');
    mcp = new CompanionMcpServer(bridge, cfg);
    await mcp.start();
  }

  bridge.start();
  source.start();
  transport.start();

  const shutdown = async () => {
    log.info('Shutting down...');
    try { source.stop(); } catch { /* noop */ }
    try { bridge.stop(); } catch { /* noop */ }
    try { if (mcp) await mcp.stop(); } catch { /* noop */ }
    try { await transport.stop(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
