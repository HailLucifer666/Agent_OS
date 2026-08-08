'use strict';

// aether/scanner-proxy.js — makes a phone look like a conformant Aether scanner.
//
// WHY THIS EXISTS
// Aether's topology (PROTOCOL.md §2) is a star in which the AGGREGATOR dials
// out to every scanner as a WebSocket *client*, so §4 requires a scanner to run
// its own WebSocket *server* and push its state to whoever connects. A phone
// cannot honour that: its LAN address roams, doze tears down listeners, and no
// port is stable across reconnects. Pushing `reading` straight at the
// aggregator's client port does not work either — aggregator.py's
// _handle_inbound_client_message only understands wake/say/ask/placeDevice/
// setCalibration/setTuning and silently ignores everything else (§3), so a
// phone's readings would vanish without a single error.
//
// So MYTHOS runs the scanner half on the phone's behalf: one loopback WS server
// per node id, republishing whatever that phone pushes up its own outbound
// socket. Direction of every leg:
//
//   phone  --(dials MYTHOS /ws, sends {type:'node-reading'})-->  MYTHOS
//   MYTHOS --(serves ws://127.0.0.1:<base+i>, sends 'reading'/'lost')--> aggregator dials in
//
// Zero Python-side change, zero edits to the Aether-BLE repo.
//
// PORT ORDER IS THE CONTRACT. The i-th id in AETHER_NODE_IDS owns port
// AETHER_PROXY_PORT_BASE + i, and the aggregator's --peers must list those
// ports in the same order or every reading is attributed to the wrong room.
// That coupling is launch-time and invisible at runtime, so start() refuses a
// malformed or duplicated id list loudly instead of mis-assigning a port.
//
// FAIL-HONEST, like sensors/aether.js: a node that stops pushing is reported
// `lost` (§4.2) rather than left painting a stale RSSI, and the aggregator
// treats `lost` as not-present so it can never win the election. A node that
// never pushed at all is `lost` from the first connect — never a fabricated
// reading.

const { WebSocketServer } = require('ws');

const SMOOTHING_ALPHA = 0.3;   // §4.1 reference EMA: smoothed = α·raw + (1-α)·prev
const LOST_AFTER_MS = 6000;    // mirrors bridge.py's PRESENCE_TIMEOUT_SECONDS
const SWEEP_MS = 1000;         // how often silence is re-checked
const BROADCAST_MS = 400;      // §4.3 — bounded, roughly-regular, data-independent
const MAX_NAME_LENGTH = 64;    // node-supplied display name; never trusted for size

// §3: `ts` is HH:MM:SS local time, for human display only. Never used for
// ordering — the aggregator has its own tick counter for that.
function displayTs(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// Comma-separated -> trimmed, non-empty ids. Kept separate from validation so
// callers (and tests) can parse without starting anything.
function parseNodeIds(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function createScannerProxy(ctx) {
  const config = (ctx && ctx.config) || {};
  const logger = (ctx && ctx.logger) || { info() {}, warn() {}, error() {} };

  const portBase = config.AETHER_PROXY_PORT_BASE || 4480;
  const host = '127.0.0.1'; // the aggregator runs on this machine; never expose these
  const nodeIds = parseNodeIds(config.AETHER_NODE_IDS);

  // nodeId -> { id, port, wss, clients:Set, name, rssi, smoothedRssi, lastUpdateMs, present }
  const nodes = new Map();
  let running = false;
  let sweepTimer = null;
  let broadcastTimer = null;
  // Binding a WS server is async — start() returns before any port is actually
  // accepting, so "listening" must not be logged (or dialled) until this
  // settles. It rejects on EADDRINUSE, which is the one proxy failure an
  // operator will actually hit: the base port range colliding with something
  // else on the machine.
  let readyPromise = Promise.resolve();

  // Shared by stop() and a failed start(): closes every socket/server this
  // instance has opened and clears the sweep/broadcast timers. Split out so a
  // partial bind failure (one node's port already taken) can tear down the
  // sibling nodes that DID bind instead of leaving them listening for the
  // rest of the process lifetime while boot reports healthy.
  function closeAllServers() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
    nodes.forEach((node) => {
      node.clients.forEach((ws) => { try { ws.close(); } catch (_) {} });
      node.clients.clear();
      if (node.wss) { try { node.wss.close(); } catch (_) {} }
    });
    nodes.clear();
  }

  function stateOf(node, now) {
    // §4.2: past the lost threshold (or never seen) the scanner reports `lost`
    // and nothing else — no last-known rssi, which the aggregator would treat
    // as a live candidate.
    if (!node.present) {
      return { type: 'lost', scanner: node.id, name: node.name, ts: displayTs(now) };
    }
    return {
      type: 'reading',
      scanner: node.id,
      name: node.name,
      rssi: node.rssi,
      smoothedRssi: node.smoothedRssi,
      // §4.1: milliseconds since the beacon was last actually observed. The
      // phone observed it; we measure from when its push arrived, which is that
      // plus one LAN hop.
      lastSeenMs: Math.max(0, now - node.lastUpdateMs),
      ts: displayTs(now)
    };
  }

  function sendState(node, ws, now) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(stateOf(node, now)));
    } catch (_) {
      // A dead peer is the aggregator's problem to redial (it retries every
      // 2s forever); never let one bad socket break the sweep for the others.
    }
  }

  function pushNode(node, now) {
    node.clients.forEach((ws) => sendState(node, ws, now));
  }

  // Fold a fresh phone push into this node's smoothed state. First sample seeds
  // the EMA (§4.1) — seeding at 0 would drag the first few seconds of every
  // reconnect toward an RSSI the radio never reported.
  function updateReading(nodeId, reading) {
    const node = nodes.get(nodeId);
    if (!node) {
      logger.warn('aether.proxy.unknown-node', { nodeId: String(nodeId) });
      return false;
    }
    const rssi = Number(reading && reading.rssi);
    if (!Number.isFinite(rssi)) {
      logger.warn('aether.proxy.bad-rssi', { nodeId: node.id });
      return false;
    }
    const now = Date.now();
    node.rssi = rssi;
    node.smoothedRssi = node.present && node.smoothedRssi != null
      ? SMOOTHING_ALPHA * rssi + (1 - SMOOTHING_ALPHA) * node.smoothedRssi
      : rssi;
    // Informational only (§4.1), and re-broadcast to every aggregator client
    // every BROADCAST_MS — so it gets a hard cap rather than being echoed at
    // whatever size a node felt like sending.
    if (reading && reading.name) node.name = String(reading.name).slice(0, MAX_NAME_LENGTH);
    node.lastUpdateMs = now;
    node.present = true;
    pushNode(node, now);
    return true;
  }

  // The phone itself says it lost the beacon (its own §11.2 verification
  // failed, or its lost sweep fired) — believe it immediately rather than
  // waiting out LOST_AFTER_MS.
  function markLost(nodeId) {
    const node = nodes.get(nodeId);
    if (!node) return false;
    if (node.present) {
      node.present = false;
      node.smoothedRssi = null;
      node.rssi = null;
      pushNode(node, Date.now());
    }
    return true;
  }

  // Silence is indistinguishable from "phone died", and both mean the same
  // thing to the election: not present.
  function sweep() {
    const now = Date.now();
    nodes.forEach((node) => {
      if (node.present && now - node.lastUpdateMs > LOST_AFTER_MS) {
        node.present = false;
        node.smoothedRssi = null;
        node.rssi = null;
        logger.info('aether.proxy.node-lost', { nodeId: node.id });
        pushNode(node, now);
      }
    });
  }

  function start() {
    if (running) return;
    if (nodeIds.length === 0) {
      throw new Error('AETHER_PROXY_ENABLED is true but AETHER_NODE_IDS is empty — nothing to proxy.');
    }
    const seen = new Set();
    nodeIds.forEach((id) => {
      if (seen.has(id)) {
        // Two ids the same means two ports claim one room and the second
        // silently shadows the first. Refuse rather than pick.
        throw new Error(`AETHER_NODE_IDS contains a duplicate id "${id}" — ids map to ports by position and must be unique.`);
      }
      seen.add(id);
    });

    running = true;
    const listens = [];
    nodeIds.forEach((id, i) => {
      const port = portBase + i;
      const node = {
        id,
        port,
        wss: null,
        clients: new Set(),
        name: id,          // until the phone reports the beacon's advertised name
        rssi: null,
        smoothedRssi: null,
        lastUpdateMs: 0,
        present: false
      };
      const wss = new WebSocketServer({ host, port });
      node.wss = wss;
      listens.push(new Promise((resolve, reject) => {
        wss.once('listening', resolve);
        wss.once('error', (err) => reject(
          new Error(`Aether scanner-proxy could not bind ${host}:${port} for node "${id}": ${err && err.message}`)
        ));
      }));
      wss.on('connection', (ws) => {
        node.clients.add(ws);
        // §4: push current state immediately on connect, then on every update.
        // There is no hello handshake — the reference scanner sends nothing
        // else, and build_hello_message is used only by Aether's own tests.
        sendState(node, ws, Date.now());
        ws.on('close', () => node.clients.delete(ws));
        ws.on('error', () => node.clients.delete(ws));
      });
      wss.on('error', (err) => {
        logger.error('aether.proxy.server-error', { nodeId: id, port, error: err && err.message });
      });
      nodes.set(id, node);
    });
    readyPromise = Promise.all(listens).then(
      () => {
        nodes.forEach((node) => logger.info('aether.proxy.listening', { nodeId: node.id, port: node.port }));
        sweepTimer = setInterval(sweep, SWEEP_MS);
        if (sweepTimer.unref) sweepTimer.unref();
        // §4.3's bounded re-broadcast: without it a phone that goes quiet for
        // exactly under the threshold leaves the aggregator's own lastSeenMs
        // growing stale between pushes.
        broadcastTimer = setInterval(() => {
          const now = Date.now();
          nodes.forEach((node) => pushNode(node, now));
        }, BROADCAST_MS);
        if (broadcastTimer.unref) broadcastTimer.unref();
      },
      (err) => {
        // One port collision must not leave the OTHER nodes' servers (which
        // bound fine) listening for the rest of the process lifetime while
        // boot reports healthy — tear every one of them down and let the
        // caller retry start() after fixing whatever held the port.
        closeAllServers();
        running = false;
        throw err;
      }
    );
  }

  function stop() {
    running = false;
    // A rejected readyPromise nobody awaited (stop() straight after a failed
    // bind) would surface as an unhandled rejection; swallow it here only.
    readyPromise = readyPromise.catch(() => {});
    closeAllServers();
  }

  return {
    start,
    stop,
    // Resolves once every per-node port is accepting; rejects on a bind
    // failure. Await before dialling (tests) or before claiming "listening".
    whenReady: () => readyPromise,
    updateReading,
    markLost,
    isRunning: () => running,
    knows: (nodeId) => nodes.has(nodeId),
    // { nodeId: port } — what the aggregator's --peers has to match, in order.
    ports: () => {
      const out = {};
      nodes.forEach((node) => { out[node.id] = node.port; });
      return out;
    },
    _internal: { stateOf, sweep, nodes }
  };
}

module.exports = { createScannerProxy, parseNodeIds, SMOOTHING_ALPHA, LOST_AFTER_MS };
