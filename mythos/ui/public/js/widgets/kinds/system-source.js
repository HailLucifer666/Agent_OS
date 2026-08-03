// system-source.js — ONE shared poller for GET /api/system, subscribed to by
// both the SYSTEM and CORES widgets.
//
// THIS IS A CORRECTNESS REQUIREMENT, NOT AN OPTIMISATION. /api/system reports
// CPU as the delta since the previous request (server/routes/system.js keeps
// the last os.cpus() sample, because a single cumulative read gives
// average-since-boot). That makes the endpoint STATEFUL: every request consumes
// the accumulated window and resets it.
//
// If SYSTEM and CORES each polled on their own timer, their requests would
// interleave and each would see roughly half the other's window — two widgets
// showing different CPU numbers for the same machine at the same instant, both
// jittery, neither wrong in a way that looks like a bug. One poller, one
// reading, fanned out.
//
// Reference-counted: the interval starts when the first widget subscribes and
// stops when the last unsubscribes, so hiding both cards stops the polling.

const POLL_MS = 2000;

function createSystemSource() {
  const listeners = new Set();
  let timer = null;
  let last = null;

  async function load() {
    let data = null;
    try {
      const res = await fetch('/api/system');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch {
      // null is the honest "we could not read the host" signal; each widget
      // renders its own unavailable state from it.
      data = null;
    }
    last = data;
    for (const fn of listeners) {
      try { fn(data); } catch { /* one widget throwing must not stop the others */ }
    }
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      // Hand a late subscriber the most recent reading immediately, so the
      // second widget to mount is not blank until the next tick.
      if (last !== null) { try { fn(last); } catch { /* ignore */ } }
      if (!timer) {
        load();
        timer = setInterval(load, POLL_MS);
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
          last = null;
        }
      };
    },
  };
}

export const fetchSystem = createSystemSource();
