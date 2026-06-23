'use strict';

// End-to-end test of the MCP read+write surface against a fake device.
// Spins up Bridge + FakeDeviceTransport + CompanionMcpServer in-process, then
// drives it with the real MCP client SDK over HTTP:
//   - lists tools
//   - companion_status (read)
//   - companion_notify (write)
//   - companion_confirm -> fake device auto-APPROVES
//   - companion_confirm -> fake device auto-DENIES (via env)
//
// Run: node test/mcp-roundtrip.js   (exits non-zero on failure)

const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PORT = 4399;
process.env.COMPANION_MCP_PORT = String(PORT);
process.env.COMPANION_FAKE_DELAY_MS = '150';
process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'warn';

const cfg = require('../src/config');
const { Bridge } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { CompanionMcpServer } = require('../src/mcp/server');

function textOf(res) {
  return (res.content || []).map((c) => c.text).join('');
}

async function connectClient() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
  await client.connect(transport);
  return client;
}

async function withRig(fakeDecision, fn) {
  if (fakeDecision) process.env.COMPANION_FAKE_DECISION = fakeDecision;
  else delete process.env.COMPANION_FAKE_DECISION;

  const transport = new FakeDeviceTransport();
  const bridge = new Bridge(transport, cfg);
  const mcp = new CompanionMcpServer(bridge, cfg);
  await mcp.start();
  bridge.start();
  transport.start();
  // Give the fake device a tick to "connect".
  await new Promise((r) => setTimeout(r, 50));
  // Seed a telemetry snapshot so status has content.
  bridge.setModel({ total: 2, running: 1, waiting: 0, msg: 'working...', entries: ['10:00 hello'] });

  try {
    await fn(bridge);
  } finally {
    bridge.stop();
    await mcp.stop();
    await transport.stop();
  }
}

async function main() {
  await withRig('once', async () => {
    const client = await connectClient();

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepStrictEqual(
      tools,
      ['companion_confirm', 'companion_notify', 'companion_status'],
      `unexpected tool list: ${tools}`
    );

    const status = JSON.parse(textOf(await client.callTool({ name: 'companion_status', arguments: {} })));
    assert.strictEqual(status.connected, true, 'status.connected should be true');
    assert.strictEqual(status.running, 1, 'status.running should reflect the model');

    const notify = textOf(await client.callTool({
      name: 'companion_notify',
      arguments: { message: 'build passed' },
    }));
    assert.match(notify, /Showed on device: build passed/, `notify result: ${notify}`);

    const approved = textOf(await client.callTool({
      name: 'companion_confirm',
      arguments: { title: 'git push', detail: 'origin main', timeout_seconds: 5 },
    }));
    assert.strictEqual(approved, 'approved', `expected approved, got: ${approved}`);

    await client.close();
  });

  await withRig('deny', async () => {
    const client = await connectClient();
    const denied = textOf(await client.callTool({
      name: 'companion_confirm',
      arguments: { title: 'rm -rf', detail: '/tmp/foo', timeout_seconds: 5 },
    }));
    assert.strictEqual(denied, 'denied', `expected denied, got: ${denied}`);
    await client.close();
  });

  console.log('PASS: MCP read+write round-trip (status, notify, confirm approve, confirm deny)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });
