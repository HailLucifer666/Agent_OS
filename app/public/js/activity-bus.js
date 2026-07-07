// activity-bus.js — one ring buffer of everything happening, fed by WS broadcasts.
// Consumed by command-deck activity feed and any future widget.
import { onBroadcast } from '/js/ws.js';

const MAX = 200;
const events = [];
const subs = new Set();

function push(evt) {
  events.push({ ...evt, at: Date.now() });
  if (events.length > MAX) events.shift();
  subs.forEach((fn) => {
    try { fn(events[events.length - 1]); } catch { /* subscriber errors are swallowed */ }
  });
}

// Subscribe to server broadcasts that represent activity.
['activity', 'voice-ui', 'job-update'].forEach((t) => {
  onBroadcast(t, (msg) => push({ type: t, ...msg }));
});

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function recent(n = 50) {
  return events.slice(-n);
}
