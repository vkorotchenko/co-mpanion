'use strict';

// Unit test for PermissionWatch: it should detect an unresolved
// permission.requested in a session-state events.jsonl and clear it once the
// matching permission.completed is appended.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PermissionWatch } = require('../src/copilot/permwatch');

function reqLine(requestId, kind, intention, text, tsIso) {
  const permissionRequest = { kind, intention, toolCallId: 'tc-' + requestId };
  if (kind === 'shell') permissionRequest.fullCommandText = text;
  else permissionRequest.path = text;
  return JSON.stringify({
    type: 'permission.requested',
    data: { requestId, permissionRequest },
    id: 'evt-' + requestId,
    timestamp: tsIso,
  }) + '\n';
}

function doneLine(requestId, tsIso) {
  return JSON.stringify({
    type: 'permission.completed',
    data: { requestId, result: { kind: 'approved' } },
    id: 'evtc-' + requestId,
    timestamp: tsIso,
  }) + '\n';
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permwatch-'));
  const sessDir = path.join(root, 'sess-1');
  fs.mkdirSync(sessDir);
  const events = path.join(sessDir, 'events.jsonl');

  const cfg = { sessionStateDir: root, perm: { minAgeMs: 0, recentWindowMs: 60 * 60 * 1000 } };
  const watch = new PermissionWatch(cfg);

  // No files / nothing pending yet.
  watch.update();
  assert.strictEqual(watch.pending(), null, 'expected no pending before any request');

  // A blocked request (old timestamp so the min-age debounce passes).
  const oldTs = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(events, reqLine('req-aaa', 'shell', 'Push to origin', 'git push origin main', oldTs));
  watch.update();
  const p = watch.pending();
  assert.ok(p, 'expected a pending request to be detected');
  assert.strictEqual(p.id, 'perm-req-aaa', 'id should be perm-<requestId>');
  assert.strictEqual(p.tool, 'run command', 'shell kind -> "run command" label');
  assert.strictEqual(p.hint, 'git push origin main', 'hint should be the command text');

  // Debounce: a brand-new request must not surface until it ages past minAgeMs.
  const watch2 = new PermissionWatch({ sessionStateDir: root, perm: { minAgeMs: 10 * 1000 } });
  watch2.update();
  assert.strictEqual(watch2.pending(), null, 'fresh request younger than min-age must be suppressed');

  // Resolving it (append completed) clears the pending state.
  fs.appendFileSync(events, doneLine('req-aaa', new Date().toISOString()));
  watch.update();
  assert.strictEqual(watch.pending(), null, 'pending should clear after permission.completed');

  // A write request maps to the "edit file" label and uses the path as hint.
  fs.appendFileSync(events, reqLine('req-bbb', 'write', 'Edit file', '/tmp/foo.txt', oldTs));
  watch.update();
  const w = watch.pending();
  assert.ok(w && w.id === 'perm-req-bbb', 'expected the write request pending');
  assert.strictEqual(w.tool, 'edit file', 'write kind -> "edit file" label');
  assert.strictEqual(w.hint, '/tmp/foo.txt', 'hint should be the path');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: PermissionWatch detects, debounces, and clears permission prompts');
}

run();
