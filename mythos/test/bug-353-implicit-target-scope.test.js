'use strict';

// BUG-353 — the window a pid-omitted ui_type/ui_click aims at was a bare
// module-scope `lastLaunchedPid` in from-pc.js that ANY launch overwrote and
// nothing ever expired.
//
// The original comment called the first half a "known scope limit" and named a
// hypothetical: "a concurrent internal launch_app (e.g. from-spotify.js's own
// auto-launch path, IF it ever routes through this same function)". It already
// did — from-whatsapp.js and from-spotify.js both call launch_app to resolve a
// window they then drive by EXPLICIT pid, and neither has ever read the
// implicit target. Measured before the fix, with a stubbed pc-child:
//
//   launch_app('notepad')          -> implicit target 1111  (the operator)
//   launch_app('whatsapp')         -> implicit target 2222  (internal resolution)
//   ui_type('dear diary')  no pid  -> typed into 2222, ok:true
//
// No honesty guard caught it, and the reason is worth keeping: ui_type's target
// cross-check compares pc-child's typedIntoPid against the pid ui_type was TOLD
// to target. Those agreed. A check on the delivered target cannot see a target
// that was swapped before it ran.
//
// The contamination test below is PAIRED with a negative control running the
// identical sequence without the opt-out, so a green result proves the opt-out
// is what does the work rather than something incidental to the harness.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const FROM_WA_PATH = path.resolve(__dirname, '../src/core/effectors/from-whatsapp.js');
const FROM_SP_PATH = path.resolve(__dirname, '../src/core/effectors/from-spotify.js');
const implicitTarget = require('../src/core/effectors/implicit-target');

const PIDS = { notepad: 1111, whatsapp: 2222 };

// A pc-child that resolves each app to a stable pid and reports where ui_type
// landed, so the target actually sent down the wire is observable.
function stubPcChild(calls, opts) {
  const o = opts || {};
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      calls.push(c);
      if (c.cmd === 'launch_app') {
        if (o.launchFails) return { ok: false, result: 'no application by that name' };
        const n = String(c.name).toLowerCase();
        return { ok: true, result: {
          pid: PIDS[n] || 9000, launched: true, matchedBy: 'process',
          resolvedName: o.resolvedNameFor ? o.resolvedNameFor(n) : n,
        } };
      }
      if (c.cmd === 'focus_window') {
        return o.focusFails ? { ok: false, result: 'no main window' } : { ok: true, result: { focused: true } };
      }
      if (c.cmd === 'close_window') return { ok: true, result: { closed: true } };
      if (c.cmd === 'ui_type') return { ok: true, result: { typed: true, typedIntoPid: c.pid } };
      return { ok: true, result: {} };
    },
  };
}

async function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    // AWAITED, not returned: an un-awaited fn() lets this finally run before the
    // async body does, which silently restores the clock seam mid-test.
    return await fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
    implicitTarget.forget();
    implicitTarget._setClock();
  }
}

// The pid a pid-omitted ui_type actually sends to pc-child, or null when it
// sends none (the "type into whatever is focused" branch).
async function omittedPidTarget(fromPc, calls) {
  calls.length = 0;
  await fromPc.ui_type({ text: 'x' });
  const c = calls.find((k) => k.cmd === 'ui_type');
  return c && c.pid !== undefined ? c.pid : null;
}

test('an INTERNAL launch does not steal the operator implicit target', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    await fromPc.launch_app({ name: 'whatsapp' }, implicitTarget.INTERNAL);
    assert.equal(await omittedPidTarget(fromPc, calls), PIDS.notepad,
      'a pid-omitted ui_type must still target the app the OPERATOR launched');
  });
});

test('NEGATIVE CONTROL: the same sequence without the opt-out is contaminated', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    await fromPc.launch_app({ name: 'whatsapp' }); // no INTERNAL — the old behaviour
    assert.equal(await omittedPidTarget(fromPc, calls), PIDS.whatsapp,
      'without the opt-out the last launch wins — this is the bug, pinned so the '
      + 'test above cannot pass for an unrelated reason');
  });
});

test('the implicit target expires, and an expired one sends no pid at all', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    let now = 1000000;
    implicitTarget._setClock(() => now);
    await fromPc.launch_app({ name: 'notepad' });

    assert.equal(await omittedPidTarget(fromPc, calls), PIDS.notepad, 'valid immediately');
    now += implicitTarget.TTL_MS;
    assert.equal(await omittedPidTarget(fromPc, calls), PIDS.notepad,
      'still valid AT the TTL — expiry is strictly greater-than, so the boundary is not off by one');
    now += 1;
    assert.equal(await omittedPidTarget(fromPc, calls), null,
      'past the TTL ui_type must fall back to the focused-window branch rather than '
      + 'aim at an hour-old pid Windows may since have recycled');
  });
});

test('an explicit pid wins over the implicit target, and survives its expiry', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    let now = 1000000;
    implicitTarget._setClock(() => now);
    await fromPc.launch_app({ name: 'notepad' });

    calls.length = 0;
    await fromPc.ui_type({ text: 'x', pid: 4242 });
    assert.equal(calls.find((c) => c.cmd === 'ui_type').pid, 4242, 'explicit pid wins inside the TTL');

    now += implicitTarget.TTL_MS + 1;
    calls.length = 0;
    await fromPc.ui_type({ text: 'x', pid: 4242 });
    assert.equal(calls.find((c) => c.cmd === 'ui_type').pid, 4242,
      'expiry governs only the DEFAULT — it must never suppress a pid the caller supplied');
  });
});

test('ui_click defaults from the same target as ui_type', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    await fromPc.launch_app({ name: 'whatsapp' }, implicitTarget.INTERNAL);
    calls.length = 0;
    await fromPc.ui_click({ elementPath: ['0'] });
    assert.equal(calls.find((c) => c.cmd === 'ui_click').pid, PIDS.notepad,
      'ui_click and ui_type must never disagree about what "the app you just opened" means');
  });
});

test('a launch that resolves to a DIFFERENT app clears only its own pid', async () => {
  const calls = [];
  // Ask for 'whatsapp', get a process actually named something else: launch_app
  // downgrades to unverified and must not target it. Before the fix it cleared
  // the target outright, discarding the operator's still-valid notepad.
  const mock = stubPcChild(calls, { resolvedNameFor: (n) => (n === 'whatsapp' ? 'SomethingElse' : n) });
  await withMockedPcChild(mock, async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    const wrong = await fromPc.launch_app({ name: 'whatsapp' }, implicitTarget.INTERNAL);
    assert.equal(wrong.unverified, true, 'a name mismatch must still be reported as unverified');
    assert.equal(await omittedPidTarget(fromPc, calls), PIDS.notepad,
      'the mismatched launch must not take the operator target down with it');

    // The other half: a NON-internal mismatched launch did set the target, so it
    // must clear it. Targeting a process that turned out to be a different
    // application is the one thing worse than having no target at all.
    await fromPc.launch_app({ name: 'whatsapp' });
    assert.equal(implicitTarget.get(), null,
      'a launch that set the target and then proved to be the wrong app must clear it');
  });
});

test('closing a window drops it as the implicit target', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    await fromPc.close_window({ pid: PIDS.notepad });
    assert.equal(await omittedPidTarget(fromPc, calls), null,
      'Windows recycles pids, so a closed one must not stay the default target');
  });
});

test('a pid proven dead by a failing focus drops as the implicit target', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls, { focusFails: true }), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    await omittedPidTarget(fromPc, calls);
    assert.equal(implicitTarget.get(), null,
      'after focus fails twice the pid is a corpse and must stop being the default');
  });
});

test('forgetIf clears only the matching pid', () => {
  implicitTarget._setClock();
  implicitTarget.forget();
  implicitTarget.remember(PIDS.notepad);
  implicitTarget.forgetIf(PIDS.whatsapp);
  assert.equal(implicitTarget.get(), PIDS.notepad, 'an unrelated pid must not clear a valid target');
  implicitTarget.forgetIf(PIDS.notepad);
  assert.equal(implicitTarget.get(), null, 'the matching pid must clear it');
});

test('only an explicit implicitTarget:false opts out — an absent ctx still records', () => {
  assert.equal(implicitTarget.isInternal(undefined), false, 'a direct call with no ctx must behave as before');
  assert.equal(implicitTarget.isInternal({}), false, 'an empty ctx is not an opt-out');
  assert.equal(implicitTarget.isInternal({ signal: null, bus: null, goalId: null }), false,
    'the operator dispatch ctx must never read as internal');
  // The REAL Live-voice shape, from live-tool-adapter.js:833. Note it carries no
  // goalId at all, which is why this fix cannot key on one. Pinned so that if a
  // goalId ever does appear upstream, somebody has to come here and decide.
  assert.equal(implicitTarget.isInternal({ tier: 2, channel: 'voice-live', traceId: 'call_1' }), false,
    'a Live-voice dispatch ctx must record a target, not read as an internal call');
  assert.equal(implicitTarget.isInternal({ implicitTarget: false }), true);
  assert.equal(implicitTarget.isInternal(implicitTarget.INTERNAL), true);
});

// ---- the two real internal callers, driven for real ----
//
// These call the shipped entry points with from-pc/the effector hub stubbed and
// assert the ctx that ACTUALLY arrives at launch_app, rather than scanning the
// source for the constant. A regex over source would pass on a call site that
// is unreachable, or on one whose ctx a wrapper drops in between.

test('whatsapp_send opts its window-resolution launches out', async () => {
  const seen = [];
  const stub = {
    launch_app: async (args, ctx) => { seen.push(ctx); return { ok: false, result: 'stubbed' }; },
    list_windows: async () => ({ ok: true, result: { windows: [] } }),
    focus_window: async () => ({ ok: false, result: 'stubbed' }),
  };
  Module.prototype.require = function (id) {
    if (id === './from-pc') return stub;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_WA_PATH];
  try {
    const wa = require(FROM_WA_PATH);
    await wa.whatsapp_send({ to: '+12025550123', text: 'hi' });
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_WA_PATH];
  }

  assert.ok(seen.length > 0, 'whatsapp_send must actually have reached launch_app');
  for (const ctx of seen) {
    assert.equal(implicitTarget.isInternal(ctx), true,
      'every WhatsApp window-resolution launch must opt out — it is driven afterwards by explicit pid');
  }
});

test('spotify_play opts its launch out', async () => {
  const seen = [];
  const sp = require(FROM_SP_PATH);
  sp.registerFromSpotify({ register: () => {} }, {
    effectors: {
      invoke: async (tool, args, ctx) => {
        if (tool === 'launch_app') seen.push(ctx);
        return { ok: true, result: {} };
      },
    },
  });
  await sp.spotify_play({ trackId: '4cOdK2wGLETKBW3PvgPWqT' });

  assert.ok(seen.length > 0, 'spotify_play must actually have reached launch_app');
  for (const ctx of seen) {
    assert.equal(implicitTarget.isInternal(ctx), true,
      'a Spotify launch must not become the operator implicit target');
  }
});

// ---- "clear on launch" — the ticket clause that had no implementation ----
//
// BUG-353 asked for three things: per-goal binding (measured inert, see above), a
// TTL, and "clear on launch". The third had nothing doing it, and it is the one
// that produces a wrong-window WRITE rather than merely a stale default.

test('a FAILED launch clears the target instead of leaving the previous app', async () => {
  const calls = [];
  const opts = {};
  await withMockedPcChild(stubPcChild(calls, opts), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    assert.equal(implicitTarget.get(), PIDS.notepad, 'precondition: notepad is the target');

    // The operator now asks for something that does not launch.
    opts.launchFails = true;
    const failed = await fromPc.launch_app({ name: 'spotify' });
    assert.equal(failed.ok, false, 'the launch must actually have failed for this test to mean anything');

    assert.equal(implicitTarget.get(), null,
      'a launch attempt moves the operator intent, so the OLD target must not survive it');
    assert.equal(await omittedPidTarget(fromPc, calls), null,
      'and the dictation that follows must fall through to the focused-window branch, which has its own typedIntoTitle cross-check, rather than type into Notepad');
  });
});

test('an INTERNAL launch that fails leaves the operator target intact', async () => {
  const calls = [];
  const opts = {};
  await withMockedPcChild(stubPcChild(calls, opts), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    opts.launchFails = true;
    await fromPc.launch_app({ name: 'whatsapp' }, implicitTarget.INTERNAL);
    assert.equal(implicitTarget.get(), PIDS.notepad,
      'from-whatsapp failing to resolve its own window is not the operator changing their mind — clear-on-launch must not fire for an internal caller');
  });
});

// ---- pinned dispositions: things deliberately NOT changed ----

test('send_key deliberately does NOT default to the implicit target', async () => {
  const calls = [];
  await withMockedPcChild(stubPcChild(calls), async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' });
    calls.length = 0;
    await fromPc.send_key({ key: 'escape' });
    const sent = calls.find((c) => c.cmd === 'send_key');
    assert.ok(sent, 'send_key must have reached pc-child');
    assert.equal(sent.pid, undefined,
      'from-pc.js documents this divergence at send_key: with a pid, ps-automation refuses the key when the caret belongs to another app, which would break "press escape" aimed at whatever the operator is looking at. Locking it in so the next reader does not "fix" the inconsistency with ui_type.');
  });
});

// ---- two mutations survived the first pass; both were real gaps in THIS file ----

test('remember refuses anything that is not a pid, rather than recording it', () => {
  implicitTarget._setClock();
  // The only caller today cannot reach this: launch_app's byProcess check already
  // requires typeof r.pid === 'number'. It is asserted anyway because remember() is
  // public and the failure it prevents is the worst kind available — a recorded
  // non-pid would be sent down by ui_type for PowerShell to reject at Int32
  // binding, and a recorded RECYCLED number would bind fine and type into a
  // stranger. Failing closed (recording nothing) is the only safe answer.
  for (const bad of [undefined, null, 'Notepad PID', '4242', 0, -1, NaN, Infinity, 1.5, {}, []]) {
    implicitTarget.forget();
    implicitTarget.remember(bad);
    assert.equal(implicitTarget.get(), null,
      'remember(' + JSON.stringify(bad) + ') must record nothing');
  }
  // ...and the one shape it must accept.
  implicitTarget.forget();
  implicitTarget.remember(4242);
  assert.equal(implicitTarget.get(), 4242, 'a real pid must still be recorded');
  implicitTarget.forget();
});

test('a freshly required from-pc module instance owns no target', () => {
  // Pinned HERE as well as implicitly in the ~20 other files that reset by dropping
  // from-pc from the require cache. Without a local assertion, a reader of this file
  // sees an unexplained forget() at module scope in from-pc.js and deletes it, and
  // the breakage lands in somebody else's test file as inherited state.
  implicitTarget._setClock();
  implicitTarget.forget();
  implicitTarget.remember(9999);
  assert.equal(implicitTarget.get(), 9999, 'precondition: a target is set');

  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return stubPcChild([]);
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    require(FROM_PC_PATH);
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }

  assert.equal(implicitTarget.get(), null,
    'loading from-pc must reset the target, or every test that reloads it inherits '
    + 'whatever the previous test left behind');
});
