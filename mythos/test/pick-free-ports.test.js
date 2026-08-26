'use strict';

// The pre-commit hook used to name its ports. Measured 2026-08-27, both of the
// names it had chosen were occupied by orphaned children of a dead session's
// suite run — pid 4296 on 4997, pid 10904 on 5097 — and the resulting three
// failures (`boot`, `BUG-274 T4 engine attribution`, `proactiveSpeak routes
// through the Live session`) read as a regression on a tree that was green.
//
// The hook had already learned this lesson once, for 4478/5050, and fixed it by
// picking a different hardcoded pair. This asserts the version that cannot
// recur: ask the OS which port is free rather than asserting one is.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const ports = require('../scripts/pick-free-ports.js');

const listen = (port) => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(port, '127.0.0.1', () => resolve(srv));
});
const close = (srv) => new Promise((resolve) => srv.close(resolve));

describe('pick-free-ports', () => {
  test('returns two distinct ports above the schema minimum', async () => {
    const { mythosPort, edgeTtsPort } = await ports.pickPorts();
    assert.notStrictEqual(mythosPort, edgeTtsPort,
      'both servers run at once, so one number handed back twice IS the collision');
    for (const p of [mythosPort, edgeTtsPort]) {
      assert.ok(Number.isInteger(p) && p >= ports.MIN_PORT,
        `${p} must clear the config schema minimum — MYTHOS_PORT=0 is rejected as a config `
        + 'error, not treated as "pick one for me"');
    }
  });

  test('the ports it returns are genuinely bindable', async () => {
    const { mythosPort, edgeTtsPort } = await ports.pickPorts();
    const a = await listen(mythosPort);
    const b = await listen(edgeTtsPort);
    try {
      assert.ok(a.address().port === mythosPort && b.address().port === edgeTtsPort);
    } finally {
      await close(a);
      await close(b);
    }
  });

  test('it never returns a port something else is already holding', async () => {
    // The actual defect, reproduced: a live listener occupying a candidate.
    const squatter = await listen(0);
    const held = squatter.address().port;
    try {
      assert.strictEqual(await ports.isFree(held), false,
        'an occupied port must read as occupied — this is the check the hook never made');
      for (let i = 0; i < 8; i += 1) {
        const { mythosPort, edgeTtsPort } = await ports.pickPorts();
        assert.notStrictEqual(mythosPort, held);
        assert.notStrictEqual(edgeTtsPort, held);
      }
    } finally {
      await close(squatter);
    }
  });

  test('a free port reads as free', async () => {
    const srv = await listen(0);
    const port = srv.address().port;
    await close(srv);
    assert.strictEqual(await ports.isFree(port), true);
  });

  test('it fails loudly rather than returning a port below the minimum', async () => {
    // If the OS ever handed back something under 1024, silently passing it on
    // would surface as a config-schema error deep inside a spawned server —
    // the failure mode this whole area keeps producing. Fake the assignment.
    const createServer = () => {
      const srv = net.createServer();
      const realListen = srv.listen.bind(srv);
      srv.listen = (_port, host, cb) => realListen(0, host, cb);
      srv.address = () => ({ port: 80 });
      return srv;
    };
    await assert.rejects(
      () => ports.pickPorts({ createServer }),
      /below the schema minimum/,
      'a port the schema will reject must fail here, where the message can say why',
    );
  });
});
