'use strict';

// Tiny leveled logger. Timestamps + level tags, nothing fancy. Set
// COMPANION_LOG=debug to see debug lines.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.COMPANION_LOG || 'info').toLowerCase()] || LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level.toUpperCase()}]`;
  if (level === 'error' || level === 'warn') {
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
};
