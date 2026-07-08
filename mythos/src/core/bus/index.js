'use strict';

const { createEvent } = require('./event');

function matchGlob(pattern, type) {
  if (pattern === '*') return true;
  if (pattern === type) return true;
  // Support dot-prefix wildcard: 'health.*' matches 'health.anomaly'
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return type.startsWith(prefix);
  }
  return false;
}

function createBus(opts) {
  opts = opts || {};
  const historySize = opts.historySize || 500;
  const maxDepth = opts.maxDepth || 32;
  const stormWindowMs = (opts.storm && opts.storm.windowMs) || 1000;
  const stormMaxPerWindow = (opts.storm && opts.storm.maxPerWindow) || 400;

  const subs = new Map();
  const history = [];
  const middleware = [];
  let seq = 0;
  let stormTimestamps = [];

  function publish(event) {
    // Run middleware chain
    let e = event;
    for (let i = 0; i < middleware.length; i++) {
      e = middleware[i](e);
      if (!e) return;  // dropped
    }

    // Causal depth guard
    if (e.depth >= maxDepth) {
      safeEmit('health.anomaly', { kind: 'causal-loop', eventId: e.id, depth: e.depth });
      return;
    }

    // Storm guard
    const now = Date.now();
    stormTimestamps = stormTimestamps.filter(function(t) { return now - t < stormWindowMs; });
    if (stormTimestamps.length >= stormMaxPerWindow) {
      const critical = ['health', 'lifecycle', 'audit'].indexOf(e.channel) !== -1;
      if (!critical) {
        safeEmit('perception.coalesced', { count: 1, original: e.type });
        return;
      }
    }
    stormTimestamps.push(now);

    // Assign sequence, record history
    e.seq = ++seq;
    history.push(e);
    if (history.length > historySize) {
      history.shift();
    }

    // Dispatch to matching subscribers
    for (const [pattern, handlers] of subs) {
      if (matchGlob(pattern, e.type)) {
        for (const handler of handlers) {
          try {
            handler(e);
          } catch (err) {
            safeEmit('health.anomaly', { kind: 'handler-error', pattern: pattern, error: err.message });
          }
        }
      }
    }
  }

  function safeEmit(type, payload) {
    // Bypass middleware for system events
    const e = createEvent(type, payload, { source: 'bus-internal' });
    e.seq = ++seq;
    history.push(e);
    if (history.length > historySize) history.shift();

    for (const [pattern, handlers] of subs) {
      if (matchGlob(pattern, e.type)) {
        for (const handler of handlers) {
          try { handler(e); } catch (_) { /* swallow safeEmit errors */ }
        }
      }
    }
  }

  function subscribe(pattern, handler) {
    if (!handler) {
      // subscribe(pattern) with single function arg = subscribe('*', fn)
      handler = pattern;
      pattern = '*';
    }
    if (!subs.has(pattern)) subs.set(pattern, new Set());
    subs.get(pattern).add(handler);

    return function unsubscribe() {
      const set = subs.get(pattern);
      if (set) set.delete(handler);
    };
  }

  function emit(type, payload, opts) {
    publish(createEvent(type, payload, opts));
  }

  function use(mw) {
    middleware.push(mw);
  }

  function getHistory(filter) {
    if (!filter) return history.slice();
    return history.filter(filter);
  }

  function stats() {
    return { subs: subs.size, historySize: history.length, seq: seq };
  }

  return { publish, emit, subscribe, use, history: getHistory, stats };
}

module.exports = { createBus, createEvent, matchGlob };
