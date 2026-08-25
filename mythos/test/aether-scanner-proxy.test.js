'use strict';

// Voice Nodes Stage 1 — the per-phone Aether scanner-proxy.
//
// The proxy's whole job is to be indistinguishable, on the wire, from a real
// bridge.py scanner: the aggregator dials it as a WS client and must receive
// PROTOCOL.md §4.1 `reading` / §4.2 `lost` frames, pushed on connect and on
// every update, with no handshake. So these tests drive it the way the
// aggregator does — connect a plain WS client and read frames — rather than
// asserting on internals.
//
// Ports are fixed by position (base+i) because that ordering IS the contract
// with the aggregator's --peers, which is also why a duplicate id has to be a
// loud failure and not a silent last-wins. That means these tests need REAL
// consecutive ports, not port 0 — so each case probes for a free block instead
// of hardcoding one. Hardcoding was tried and failed: Windows reserves opaque
// TCP ranges (Hyper-V/WinNAT), and a base landing inside one fails as
// EADDRINUSE on a machine where nothing is listening.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');
const { createScannerProxy, parseNodeIds, SMOOTHING_ALPHA } = require('../src/core/aether/scanner-proxy');

const SILENT = { info() {}, warn() {}, error() {} };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Can we actually bind this exact port right now?
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// A base such that base..base+count-1 are all bindable. Starts from an
// ephemeral port the OS just handed us (so it is outside any reserved range)
// and walks forward. Racy in principle — a test could lose the port between
// probe and use — but every consumer here binds within microseconds.
async function freeBase(count) {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  let candidate = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  for (let attempt = 0; attempt < 200; attempt++) {
    const checks = [];
    for (let i = 0; i < count; i++) checks.push(canBind(candidate + i));
    const results = await Promise.all(checks);
    if (results.every(Boolean)) return candidate;
    candidate += count;
  }
  throw new Error(`no free block of ${count} consecutive ports found`);
}

// Bind with retry. freeBase probes a block and then RELEASES it, so under
// full-suite load another process (or another test file) can take the port in
// the microseconds before the proxy binds — measured 2026-08-13 as
// `EADDRINUSE 127.0.0.1:61054` during a release build, which blocked the commit
// gate for a port race rather than a defect. A fresh block on retry costs
// milliseconds; a false red costs a release.
async function startProxy(ids, count = 1) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = await freeBase(count);
    const p = proxy(ids, base);
    p.start();
    try {
      await p.whenReady();
      return { p, base };
    } catch (err) {
      p.stop();
      lastErr = err;
      if (!/EADDRINUSE/.test(String(err && err.message))) throw err;
    }
  }
  throw lastErr;
}

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

function proxy(ids, portBase) {
  return createScannerProxy({
    config: { AETHER_NODE_IDS: ids, AETHER_PROXY_PORT_BASE: portBase },
    logger: SILENT
  });
}

// Stand in for the aggregator: collect every frame this peer receives.
async function dial(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  ws.on('message', (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames, last: () => frames[frames.length - 1] };
}

describe('aether scanner-proxy — port assignment and config validation', () => {
  it('assigns ports by position in AETHER_NODE_IDS', async () => {
    const { p, base } = await startProxy('kitchen-phone,desk-phone', 2);
    try {
      assert.deepEqual(p.ports(), { 'kitchen-phone': base, 'desk-phone': base + 1 });
    } finally { p.stop(); }
  });

  it('refuses to start with an empty id list rather than proxying nothing', async () => {
    const p = proxy('', await freeBase(1));
    assert.throws(() => p.start(), /AETHER_NODE_IDS is empty/);
    assert.equal(p.isRunning(), false);
  });

  it('refuses a duplicate id — two ports claiming one room must not silently last-win', async () => {
    const p = proxy('phone,phone', await freeBase(1));
    assert.throws(() => p.start(), /duplicate id "phone"/);
  });

  it('parseNodeIds trims and drops blanks without inventing ids', () => {
    assert.deepEqual(parseNodeIds(' a , b ,, '), ['a', 'b']);
    assert.deepEqual(parseNodeIds(''), []);
    assert.deepEqual(parseNodeIds(null), []);
  });
});

describe('aether scanner-proxy — §4 wire contract', () => {
  it('pushes state on connect with no handshake, and reports lost before any reading', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    const peer = await dial(base);
    try {
      // §4: the scanner pushes immediately; the aggregator sends nothing first.
      assert.ok(await waitFor(() => peer.frames.length > 0, 1000), 'no frame pushed on connect');
      const first = peer.frames[0];
      // A node that has never observed the beacon must NOT look present — a
      // fabricated reading here would let an unseen phone win the election.
      assert.equal(first.type, 'lost');
      assert.equal(first.scanner, 'kitchen-phone');
      assert.equal(typeof first.ts, 'string');
      assert.equal(first.rssi, undefined);
    } finally { peer.ws.close(); p.stop(); }
  });

  it('turns a phone push into a §4.1 reading, seeding the EMA on the first sample', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    const peer = await dial(base);
    try {
      assert.equal(p.updateReading('kitchen-phone', { rssi: -60, name: 'Pixel Watch' }), true);
      assert.ok(await waitFor(() => peer.frames.some((f) => f.type === 'reading'), 1000), 'no reading frame');
      const r = peer.frames.filter((f) => f.type === 'reading').pop();
      assert.equal(r.scanner, 'kitchen-phone');
      assert.equal(r.name, 'Pixel Watch');
      assert.equal(r.rssi, -60);
      // First sample seeds the average — smoothing from 0 would drag the first
      // seconds of every reconnect toward an RSSI the radio never reported.
      assert.equal(r.smoothedRssi, -60);
      assert.ok(r.lastSeenMs >= 0 && r.lastSeenMs < 1000);
    } finally { peer.ws.close(); p.stop(); }
  });

  it('smooths subsequent samples with the reference EMA (alpha 0.3)', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    const peer = await dial(base);
    try {
      p.updateReading('kitchen-phone', { rssi: -60 });
      p.updateReading('kitchen-phone', { rssi: -70 });
      const expected = SMOOTHING_ALPHA * -70 + (1 - SMOOTHING_ALPHA) * -60; // -63
      assert.ok(await waitFor(() => {
        const r = peer.frames.filter((f) => f.type === 'reading').pop();
        return r && Math.abs(r.smoothedRssi - expected) < 1e-9;
      }, 1000), 'smoothedRssi did not match the reference EMA');
    } finally { peer.ws.close(); p.stop(); }
  });

  it('markLost drops the node to §4.2 lost and clears its rssi', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    const peer = await dial(base);
    try {
      p.updateReading('kitchen-phone', { rssi: -55 });
      await waitFor(() => peer.frames.some((f) => f.type === 'reading'), 1000);
      p.markLost('kitchen-phone');
      assert.ok(await waitFor(() => peer.last() && peer.last().type === 'lost', 1000), 'never went lost');
      // Stale rssi must not survive the transition — the aggregator would read
      // it as a live candidate.
      assert.equal(peer.last().rssi, undefined);
    } finally { peer.ws.close(); p.stop(); }
  });

  it('caps a node-supplied name — it is echoed to every peer every 400ms', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    const peer = await dial(base);
    try {
      p.updateReading('kitchen-phone', { rssi: -50, name: 'x'.repeat(5000) });
      assert.ok(await waitFor(() => peer.frames.some((f) => f.type === 'reading'), 1000), 'no reading');
      const r = peer.frames.filter((f) => f.type === 'reading').pop();
      assert.equal(r.name.length, 64);
    } finally { peer.ws.close(); p.stop(); }
  });

  it('an unknown nodeId is dropped, never auto-registered', async () => {
    const { p, base } = await startProxy('kitchen-phone');
    try {
      assert.equal(p.updateReading('rogue-phone', { rssi: -40 }), false);
      assert.equal(p.knows('rogue-phone'), false);
      assert.deepEqual(p.ports(), { 'kitchen-phone': base });
    } finally { p.stop(); }
  });

  it('a non-numeric rssi is rejected rather than published as NaN', async () => {
    const p = proxy('kitchen-phone', await freeBase(1));
    p.start();
    try {
      assert.equal(p.updateReading('kitchen-phone', { rssi: 'strong' }), false);
      assert.equal(p.updateReading('kitchen-phone', {}), false);
      assert.equal(p._internal.stateOf(p._internal.nodes.get('kitchen-phone'), Date.now()).type, 'lost');
    } finally { p.stop(); }
  });

  it('silence past the lost threshold goes lost on its own — a dead phone must not paint a stale rssi', async () => {
    const p = proxy('kitchen-phone', await freeBase(1));
    p.start();
    try {
      p.updateReading('kitchen-phone', { rssi: -50 });
      const node = p._internal.nodes.get('kitchen-phone');
      assert.equal(node.present, true);
      // Backdate the last push past LOST_AFTER_MS instead of waiting 6s.
      node.lastUpdateMs = Date.now() - 60000;
      p._internal.sweep();
      assert.equal(node.present, false);
      assert.equal(p._internal.stateOf(node, Date.now()).type, 'lost');
    } finally { p.stop(); }
  });

  it('H13: a partial bind failure tears down every port it already opened', async () => {
    const base = await freeBase(2);
    // Occupy the second port so this node's bind fails while the first (which
    // starts binding first) succeeds — exactly the "one collision, N nodes"
    // shape the audit finding describes.
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(base + 1, '127.0.0.1', resolve));
    try {
      const p = proxy('kitchen-phone,desk-phone', base);
      p.start();
      await assert.rejects(p.whenReady(), /could not bind/);
      assert.equal(p.isRunning(), false, 'proxy must not report itself running after a partial bind failure');
      // The sibling node's server DID bind — it must be closed too, or it
      // keeps listening (and the aggregator keeps talking to it) for the
      // rest of the process lifetime while boot reports healthy.
      assert.ok(await canBind(base), 'first node\'s port is still held after the partial bind failure');
    } finally {
      blocker.close();
    }
  });

  it('stop() releases the ports so a restart can rebind them', async () => {
    const { p: p1, base } = await startProxy('kitchen-phone');
    p1.stop();
    const p2 = proxy('kitchen-phone', base);
    p2.start();
    try {
      await p2.whenReady();
      const peer = await dial(base);
      assert.ok(await waitFor(() => peer.frames.length > 0, 1000), 'rebind did not serve');
      peer.ws.close();
    } finally { p2.stop(); }
  });
});
