'use strict';

const { execFile } = require('child_process');
const os = require('os');
const log = require('../util/log');

// One-shot + command messages the bridge sends to the device. These mirror the
// "One-shot on connect" and "Commands and acks" sections of REFERENCE.md.

// {"time":[epoch_sec, tz_offset_sec]} — tz offset is seconds east of UTC, e.g.
// PDT (UTC-7) -> -25200. JS getTimezoneOffset() returns minutes *behind* UTC.
function timeMessage(date = new Date()) {
  const epoch = Math.floor(date.getTime() / 1000);
  const tzOffsetSec = -date.getTimezoneOffset() * 60;
  return { time: [epoch, tzOffsetSec] };
}

function ownerMessage(name) {
  return { cmd: 'owner', name: String(name || '').slice(0, 31) };
}

function nameMessage(name) {
  return { cmd: 'name', name: String(name || '').slice(0, 31) };
}

function statusRequest() {
  return { cmd: 'status' };
}

function unpairMessage() {
  return { cmd: 'unpair' };
}

// Best-effort "owner first name": prefer the GitHub account name (matches the
// Copilot identity), fall back to git config, then the OS username.
function resolveOwnerName() {
  return new Promise((resolve) => {
    firstName(ghName)
      .catch(() => firstName(gitName))
      .catch(() => resolve(osFirstName()))
      .then((n) => resolve(n || osFirstName()))
      .catch(() => resolve(osFirstName()));
  });
}

function firstName(getter) {
  return getter().then((full) => {
    const first = String(full || '').trim().split(/\s+/)[0];
    if (!first) throw new Error('empty');
    return first;
  });
}

function ghName() {
  return run('gh', ['api', 'user', '--jq', '.name // .login']);
}

function gitName() {
  return run('git', ['config', '--get', 'user.name']);
}

function osFirstName() {
  try {
    const u = os.userInfo().username || 'there';
    return u.split(/[.\-_ ]/)[0];
  } catch {
    return 'there';
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) return reject(err);
      const out = String(stdout || '').trim();
      if (!out) return reject(new Error('empty'));
      resolve(out);
    });
  });
}

module.exports = {
  timeMessage,
  ownerMessage,
  nameMessage,
  statusRequest,
  unpairMessage,
  resolveOwnerName,
};
