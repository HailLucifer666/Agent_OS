'use strict';

function createEvent(type, payload, opts) {
  opts = opts || {};
  const cause = opts.cause || null;
  const source = opts.source || 'unknown';
  const id = 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);

  return {
    id: id,
    type: type,
    channel: type.split('.')[0],
    payload: payload,
    ts: Date.now(),
    source: source,
    causeId: cause ? cause.id : null,
    traceId: cause ? cause.traceId : id,
    depth: cause ? cause.depth + 1 : 0,
    seq: 0
  };
}

module.exports = { createEvent };
