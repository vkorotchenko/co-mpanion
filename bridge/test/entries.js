'use strict';

// Unit test for stripInjected(): the device transcript must show what the user
// actually typed, not the <system_reminder>/<current_datetime> wrappers the
// CLI/harness injects into a turn's user_message.

const assert = require('assert');
const { stripInjected } = require('../src/copilot/source');

function norm(s) {
  return stripInjected(s).replace(/\s+/g, ' ').trim();
}

// A turn that is ONLY an injected reminder collapses to empty (=> dropped).
assert.strictEqual(
  norm('\n<system_reminder>\nCustom instructions from server/graph-svc/.github/copilot-instructions.md\n</system_reminder>'),
  '',
  'a pure system_reminder turn should strip to empty'
);

// A real message with a trailing (unclosed) reminder keeps only the real text.
assert.strictEqual(
  norm('fix the flaky test\n<system_reminder>\n<sql_tables>todos</sql_tables>\n'),
  'fix the flaky test',
  'trailing reminder should be stripped, real text kept'
);

// A leading datetime stamp is removed.
assert.strictEqual(
  norm('<current_datetime>2026-06-25T17:00:00</current_datetime>\nrun the build'),
  'run the build',
  'current_datetime wrapper should be stripped'
);

// Plain messages pass through untouched.
assert.strictEqual(norm('can you ask a question'), 'can you ask a question');

console.log('PASS: stripInjected removes injected wrappers from transcript entries');
