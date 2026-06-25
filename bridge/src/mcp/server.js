'use strict';

const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const log = require('../util/log');

// MCP server hosted by the bridge. Exposes the device as a set of tools the
// agent can call:
//
//   companion_status  (read)  -> current Copilot/device activity snapshot
//   companion_notify  (write) -> flash a message on the device screen
//   companion_confirm (write) -> ask the user a yes/no on the device and BLOCK
//                                until they press approve/deny (reuses the
//                                firmware's permission-prompt UI)
//
// Two transports are supported:
//   - HTTP (start):      registered in mcp-config.json as `type: "http"`; the
//                        bridge must already be running.
//   - stdio (startStdio): registered as `type: "local"`; Copilot CLI spawns the
//                        whole bridge per session and talks over stdin/stdout.
//
// This is the supported, stable "read + write" path: the agent routes a
// decision through companion_confirm and gets the physical button press back as
// the tool result. Runs stateless (no session affinity needed).
class CompanionMcpServer {
  constructor(bridge, cfg) {
    this._bridge = bridge;
    this._port = cfg.mcp.port;
    this._host = cfg.mcp.host;
    this._http = null;
    this._stdioServer = null;
    this._stdioTransport = null;
  }

  // stdio transport: one persistent server bound to this process's stdin/stdout.
  // Copilot CLI launches the bridge as a `local` MCP server and speaks JSON-RPC
  // over the pipe, so nothing else may write to stdout (logs go to stderr).
  async startStdio() {
    const {
      StdioServerTransport,
    } = require('@modelcontextprotocol/sdk/server/stdio.js');
    this._stdioServer = this._buildServer();
    this._stdioTransport = new StdioServerTransport();
    await this._stdioServer.connect(this._stdioTransport);
    log.info('MCP server attached to stdio (local transport).');
  }

  async start() {
    // Stateless Streamable HTTP: build a fresh server + transport per request
    // (the documented stateless pattern). Tools close over the shared bridge.
    this._http = http.createServer((req, res) => {
      if (req.url && req.url.split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      collectBody(req)
        .then(async (body) => {
          const server = this._buildServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            transport.close();
            server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        })
        .catch((err) => {
          log.error('MCP request error:', err.message);
          if (!res.headersSent) res.writeHead(500).end();
        });
    });

    await new Promise((resolve, reject) => {
      this._http.once('error', reject);
      this._http.listen(this._port, this._host, resolve);
    });
    log.info(`MCP server listening at http://${this._host}:${this._port}/mcp`);
    log.info('Add it to Copilot as an http MCP server pointing at that URL.');
  }

  _buildServer() {
    const server = new McpServer(
      { name: 'co-mpanion', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      'companion_status',
      {
        title: 'Companion status',
        description:
          'Read the current GitHub Copilot activity as shown on the co-mpanion ' +
          'device: session counts, busy/idle, recent messages, and whether a ' +
          'device is connected.',
        inputSchema: {},
      },
      async () => {
        const s = this._bridge.status;
        const payload = {
          connected: this._bridge.connected,
          total: s.total,
          running: s.running,
          waiting: s.waiting,
          msg: s.msg,
          entries: s.entries || [],
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );

    server.registerTool(
      'companion_notify',
      {
        title: 'Notify on device',
        description:
          'Flash a short message on the co-mpanion device screen for a few ' +
          'seconds. Use for status pings ("build passed", "deploying...").',
        inputSchema: {
          message: z.string().max(23).describe('Short message (<=23 chars shown).'),
        },
      },
      async ({ message }) => {
        const delivered = this._bridge.notify(message);
        return {
          content: [
            {
              type: 'text',
              text: delivered
                ? `Showed on device: ${message}`
                : 'No device connected; message not shown.',
            },
          ],
        };
      }
    );

    server.registerTool(
      'companion_confirm',
      {
        title: 'Confirm on device',
        description:
          'Ask the user to physically approve or deny an action on the ' +
          'co-mpanion device, then BLOCK until they press the approve (A) or ' +
          'deny (B) button. Returns "approved" or "denied". Use before risky or ' +
          'irreversible actions when you want a hardware confirmation.',
        inputSchema: {
          title: z.string().max(19).describe('Short action name, e.g. the tool/command.'),
          detail: z.string().max(43).optional().describe('One-line detail/hint.'),
          timeout_seconds: z
            .number()
            .int()
            .min(5)
            .max(600)
            .optional()
            .describe('How long to wait for a button press (default 60).'),
        },
      },
      async ({ title, detail, timeout_seconds }) => {
        const { decision } = await this._bridge.confirm({
          title,
          detail,
          timeoutMs: (timeout_seconds || 60) * 1000,
        });
        const text =
          decision === 'approved'
            ? 'approved'
            : decision === 'denied'
            ? 'denied'
            : decision === 'timeout'
            ? 'timeout: no response from the device'
            : 'unavailable: no co-mpanion device is connected';
        return {
          content: [{ type: 'text', text }],
          isError: decision === 'unavailable',
        };
      }
    );

    return server;
  }

  async stop() {
    if (this._http) {
      await new Promise((r) => this._http.close(r));
      this._http = null;
    }
    if (this._stdioServer) {
      try { await this._stdioServer.close(); } catch { /* noop */ }
      this._stdioServer = null;
      this._stdioTransport = null;
    }
  }
}

function collectBody(req) {
  if (req.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { CompanionMcpServer };
