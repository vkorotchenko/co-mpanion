'use strict';

const fs = require('fs');
const crypto = require('crypto');
const log = require('../util/log');

// Streams a firmware .bin to the device over the existing BLE link using the
// ota_begin / ota_chunk / ota_end protocol (see REFERENCE.md). Mirrors the
// device-side receiver in firmware/src/ota.h: each chunk is base64-encoded and
// acked before the next is sent (flow control — the device's RX ring and flash
// writes can't be outrun).
//
// Integrity: we send the image's MD5; Update.end() on the device verifies it
// before switching the boot partition, so a corrupted transfer is never booted.

const DEFAULT_CHUNK = 384;        // decoded bytes per chunk (base64 ~512 chars)
const ACK_TIMEOUT_MS = 15000;     // per-ack wait (first flash erase can be slow)

// Wait for the next ack matching `name` on the transport's 'line' events.
function waitAck(transport, name, timeoutMs = ACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const onLine = (msg) => {
      if (msg && typeof msg === 'object' && msg.ack === name) {
        cleanup();
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ack "${name}"`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      transport.removeListener('line', onLine);
    }
    transport.on('line', onLine);
  });
}

async function send(transport, obj, ackName, timeoutMs) {
  const ackP = waitAck(transport, ackName, timeoutMs);
  await transport.writeLine(obj);
  return ackP;
}

// Push `binPath` to the device. Resolves when ota_end is acked (the device
// reboots immediately after). `onProgress(written, total)` is called per chunk.
async function flashFirmware(transport, binPath, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  const onProgress = opts.onProgress || (() => {});

  const data = fs.readFileSync(binPath);
  const total = data.length;
  const md5 = crypto.createHash('md5').update(data).digest('hex');
  log.info(`Flashing ${binPath} (${total} bytes, md5=${md5}, chunk=${chunkSize}B)`);

  const begin = await send(
    transport,
    { cmd: 'ota_begin', size: total, md5, version: opts.version || '' },
    'ota_begin'
  );
  if (!begin.ok) throw new Error(`device rejected ota_begin: ${begin.error || 'unknown'}`);

  let written = 0;
  for (let off = 0; off < total; off += chunkSize) {
    const slice = data.subarray(off, off + chunkSize);
    const ack = await send(transport, { cmd: 'ota_chunk', d: slice.toString('base64') }, 'ota_chunk');
    if (!ack.ok) throw new Error(`chunk failed at ${off}: ${ack.error || 'unknown'}`);
    written = off + slice.length;
    onProgress(written, total);
  }

  const end = await send(transport, { cmd: 'ota_end' }, 'ota_end', ACK_TIMEOUT_MS);
  if (!end.ok) throw new Error(`device rejected ota_end: ${end.error || 'unknown'}`);
  log.info('ota_end acked — device is verifying and rebooting.');
  return { total, md5 };
}

module.exports = { flashFirmware, DEFAULT_CHUNK };
