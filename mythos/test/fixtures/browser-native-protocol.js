'use strict';
const MAX_MESSAGE = 1024 * 1024;
function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_MESSAGE) throw new Error('Native message exceeds limit');
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length); return Buffer.concat([size, body]);
}
function createNativeDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 2 || length > MAX_MESSAGE) throw new Error('Invalid native message size');
      if (buffer.length < 4 + length) return;
      const value = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')); buffer = buffer.subarray(4 + length); onMessage(value);
    }
  };
}

module.exports = { encodeNativeMessage, createNativeDecoder };

