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

  // Stale/aborted session: a request followed by ANY later event (here an
  // abort + session.shutdown) but no permission.completed must NOT linger as
  // pending — the session is no longer blocked on it.
  fs.appendFileSync(events, JSON.stringify({ type: 'abort', data: {}, id: 'ab1', timestamp: new Date().toISOString() }) + '\n');
  fs.appendFileSync(events, JSON.stringify({ type: 'session.shutdown', data: {}, id: 'sd1', timestamp: new Date().toISOString() }) + '\n');
  watch.update();
  assert.strictEqual(watch.pending(), null, 'aborted/shutdown request must not stay pending');

  // A fresh request after that is the last event again => pending once more.
  fs.appendFileSync(events, reqLine('req-ccc', 'shell', 'List files', 'ls -la', oldTs));
  watch.update();
  const c = watch.pending();
  assert.ok(c && c.id === 'perm-req-ccc', 'a new last-event request should be pending again');

  // ...until a subsequent tool call (not a completion) supersedes it.
  fs.appendFileSync(events, JSON.stringify({ type: 'tool.execution_start', data: { requestId: 'x' }, id: 't1', timestamp: new Date().toISOString() }) + '\n');
  watch.update();
  assert.strictEqual(watch.pending(), null, 'a later event of any type clears pending');

  // --- waiting-for-user detection -----------------------------------------
  // minAge 0 so the debounce doesn't hide the state in this test.
  const w2root = fs.mkdtempSync(path.join(os.tmpdir(), 'permwatch-w-'));
  fs.mkdirSync(path.join(w2root, 's'));
  const wev = path.join(w2root, 's', 'events.jsonl');
  const asstMsg = (tools) => JSON.stringify({
    type: 'assistant.message', data: { toolRequests: tools ? [{ name: 'bash' }] : [] },
    id: 'm', timestamp: new Date().toISOString(),
  }) + '\n';
  const waitWatch = new PermissionWatch({ sessionStateDir: w2root, perm: { minAgeMs: 0 } });

  // A message with tool calls => still working, not waiting.
  fs.writeFileSync(wev, asstMsg(true));
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), false, 'tool-call message is not waiting');

  // A no-tool message => the agent is waiting on the user.
  fs.appendFileSync(wev, asstMsg(false));
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), true, 'no-tool message means waiting for user');

  // The user replies => no longer waiting.
  fs.appendFileSync(wev, JSON.stringify({ type: 'user.message', data: {}, id: 'u', timestamp: new Date().toISOString() }) + '\n');
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), false, 'a user.message clears the waiting state');

  // An ask_user tool call blocks on the user's answer => waiting.
  const toolStart = (name) => JSON.stringify({
    type: 'tool.execution_start', data: { toolCallId: 'tc', toolName: name },
    id: 'ts', timestamp: new Date().toISOString(),
  }) + '\n';
  fs.appendFileSync(wev, asstMsg(true));        // message with the ask_user tool call
  fs.appendFileSync(wev, toolStart('bash'));    // ordinary work tool => not waiting
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), false, 'a work tool is not waiting');
  fs.appendFileSync(wev, toolStart('ask_user'));
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), true, 'ask_user blocks => waiting for user');
  fs.appendFileSync(wev, JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'tc' }, id: 'tcd', timestamp: new Date().toISOString() }) + '\n');
  waitWatch.update();
  assert.strictEqual(waitWatch.waitingForUser(), false, 'completing ask_user clears waiting');

  fs.rmSync(w2root, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: PermissionWatch detects prompts, stale/aborted, and waiting-for-user');
}

run();
