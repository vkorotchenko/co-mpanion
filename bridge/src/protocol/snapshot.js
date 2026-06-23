'use strict';

// Builds the "heartbeat snapshot" wire object the firmware parses (see
// REFERENCE.md and firmware/src/data.h). Everything here is about shaping an
// internal activity model into exactly the fields/size limits the device
// expects, and detecting whether a new snapshot is worth sending.

// Firmware field limits (firmware/src/data.h):
//   msg        char[24]    -> 23 usable chars
//   entries    char[8][92] -> up to 8 lines, 91 usable chars each
const MSG_MAX = 23;
const ENTRY_MAX = 91;
const ENTRIES_MAX = 8;

function clamp(str, max) {
  if (str == null) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max) : str;
}

// Turn an internal activity model into the wire snapshot object.
//
// model = {
//   total, running, waiting,      // session counts
//   completed,                    // bool: a turn just finished
//   msg, entries,                 // display strings
//   tokens, tokensToday,          // best-effort token counters
//   prompt: {id, tool, hint}|null // permission request (deferred)
// }
function buildSnapshot(model) {
  const snap = {
    total: clampInt(model.total),
    running: clampInt(model.running),
    waiting: clampInt(model.waiting),
    completed: !!model.completed,
    msg: clamp(model.msg, MSG_MAX),
    entries: (model.entries || [])
      .slice(0, ENTRIES_MAX)
      .map((e) => clamp(e, ENTRY_MAX)),
  };
  if (Number.isFinite(model.tokens)) snap.tokens = clampInt(model.tokens, 0xffffffff);
  if (Number.isFinite(model.tokensToday)) {
    snap.tokens_today = clampInt(model.tokensToday, 0xffffffff);
  }
  if (model.prompt && model.prompt.id) {
    snap.prompt = {
      id: String(model.prompt.id),
      tool: clamp(model.prompt.tool, 19), // firmware promptTool char[20]
      hint: clamp(model.prompt.hint, 43), // firmware promptHint char[44]
    };
  }
  return snap;
}

function clampInt(n, max = 255) {
  n = Math.trunc(Number(n) || 0);
  if (n < 0) n = 0;
  if (n > max) n = max;
  return n;
}

// Serialize to a single newline-terminated line. The firmware only parses
// lines whose first byte is '{', so a compact object is exactly right.
function serialize(obj) {
  return JSON.stringify(obj) + '\n';
}

// Cheap structural equality so we only push when something actually changed.
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { buildSnapshot, serialize, equal, MSG_MAX, ENTRY_MAX, ENTRIES_MAX };
