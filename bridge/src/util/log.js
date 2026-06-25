'use strict';

// Tiny leveled logger. Timestamps + level tags, nothing fancy. Set
// COMPANION_LOG=debug to see debug lines.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.COMPANION_LOG || 'info').toLowerCase()] || LEVELS.info;

// When true, every log line goes to stderr. Required when the process speaks an
// stdio MCP transport: stdout is the JSON-RPC channel and must stay clean.
let stderrOnly = process.env.COMPANION_LOG_STDERR === '1';

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level.toUpperCase()}]`;
  if (stderrOnly || level === 'error' || level === 'warn') {
    console.error(line, ...args);
  } else {
    console.log(line, ...args);
  }
}

module.exports = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  setStderrOnly: (v) => { stderrOnly = !!v; },
  isStderrOnly: () => stderrOnly,
};
