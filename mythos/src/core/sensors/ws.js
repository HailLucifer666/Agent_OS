'use strict';

// sensors/ws.js — WS Sensor: turns inbound WebSocket messages into perceptions.
// Phase 9 owns the actual `ws.Server` (server/index.js is not built until then) — this
// sensor's job in Phase 7 is solely the perception-shaping function `ingest()`, which
// Phase 9's connection handler calls per inbound message. start()/stop() here only
// manage connection-scoped bookkeeping (last-seen per connection), replacing NOVA's
// intake.js per the migration map ("WS sensor buffer... connection-scoped memory").
//
// perception.voice for spoken/typed utterances (high salience — human-initiated),
// perception.ws for connection lifecycle / explicit tool-invoke commands.

function createWsSensor({ bus, config }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createWsSensor requires a bus');
  }

  var running = false;
  var connections = new Map();   // connectionId -> { lastSeenAt }

  function start() {
    running = true;
  }

  function stop() {
    running = false;
    connections.clear();
  }

  // ingest({ connectionId, kind, text, tool, args }) — called externally by the WS
  // connection handler (Phase 9) for every inbound message.
  // kind: 'utterance' (spoken/typed free text) | 'command' (explicit tool-invoke) |
  //       'connect' | 'disconnect'
  function ingest(msg) {
    if (!running || !msg) return;
    connections.set(msg.connectionId, { lastSeenAt: Date.now() });

    if (msg.kind === 'utterance') {
      bus.emit('perception.voice', {
        kind: 'voice',
        summary: String(msg.text || '').slice(0, 200),
        channel: 'voice',
        salience: 0.8,           // high — human-initiated
        connectionId: msg.connectionId,
        text: msg.text
      });
      return;
    }

    bus.emit('perception.ws', {
      kind: 'ws',
      summary: (msg.kind || 'ws') + ' ' + (msg.tool || ''),
      channel: 'ws',
      salience: msg.kind === 'command' ? 0.8 : 0.3,
      connectionId: msg.connectionId,
      tool: msg.tool,
      args: msg.args
    });
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; },
    ingest: ingest,
    connectionCount: function() { return connections.size; }
  };
}

module.exports = { createWsSensor };
