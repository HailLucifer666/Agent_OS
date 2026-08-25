'use strict';

// effector-evidence-honesty.test.js — Task E3.
//
// Four instances of the same class, all from the 2026-08-12 installed-build
// session: spotify_play reported ok while a sleep story played; a WhatsApp
// message went to +9903382050 (country code dropped) and reported success;
// launch_app reported ok for a window it could not find (Proton VPN,
// 02:13:21); open_folder's allowlist refusal was narrated as a mystery
// (02:21:27) instead of a rule. In every case the evidence already existed
// inside the effector — this pins that it reaches the result.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');

// ---------------------------------------------------------------------------
// (a) spotify_play: a mismatch between the now-playing title and the query
// must reach the result as unverified:true, carrying the actual title.
// ---------------------------------------------------------------------------
describe('(a) spotify_play carries the actual now-playing title into an honest unverified result', () => {
  it('reports unverified:true with the real title when it does not match the query (click_at path)', async () => {
    const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
    const dir = tempVaultDir();
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    let listWindowsCalls = 0;
    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          listWindowsCalls++;
          // Idle title before the click, a WRONG track after it — a sleep
          // story played instead of the requested song, the recorded shape.
          const title = listWindowsCalls === 1 ? 'Spotify' : 'Calm Sleep Story - Rainfall';
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return { ok: true, result: { elements: [
            { name: 'Play', type: 'ControlType.Button', automationId: 'play-button', rect: { x: 100, y: 200, width: 40, height: 40 } }
          ] } };
        }
        if (tool === 'click_at') return { ok: true, result: { clicked: true, x: args.x, y: args.y } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };
    try {
      registerFromSpotify(hub, { effectors: mockPcEffectors });
      const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody Queen' }, {});
      assert.equal(result.ok, true, 'a click did land — this is not a call failure');
      assert.equal(result.unverified, true, 'a title mismatch must not be laundered into a bare ok:true');
      assert.match(result.reason, /Calm Sleep Story - Rainfall/,
        'the reply must carry the ACTUAL title, not just say "mismatch"');
      assert.match(result.reason, /not what was asked for/);
    } finally {
      cleanupVaultDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) whatsapp_send: a number that is not E.164-shaped is rejected with a
// message naming the expected shape, rather than being sent (or silently
// mistaken for a contact-name lookup).
// ---------------------------------------------------------------------------
describe('(b) whatsapp_send rejects a non-E.164 number and names the expected shape', () => {
  const { whatsapp_send, registerFromWhatsapp, _internal } = require('../src/core/effectors/from-whatsapp');

  function wireNoContacts() {
    registerFromWhatsapp({ register() {} }, {
      memory: { fs: { readJSONStrict: () => ({}) } },
      logger: { warn() {}, info() {} },
    });
  }

  it('rejects a number missing its leading "+" (the recorded dropped-country-code shape) with the expected shape named', async () => {
    wireNoContacts();
    // "9903382050" alone: 10 digits, no leading '+'. Real E.164 requires the '+'.
    const res = await whatsapp_send({ to: '9903382050', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /E\.164/i, 'must name the expected shape');
    assert.match(String(res.result), /\+/, 'must show the required "+" in the example/rule');
  });

  it('rejects a too-short digit string as not E.164, not as an unknown contact', async () => {
    wireNoContacts();
    const res = await whatsapp_send({ to: '+123', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /not a phone number I can use/i);
    assert.doesNotMatch(String(res.result), /not in my contact list/i,
      'a malformed number attempt must not be misreported as an unknown contact name');
  });

  it('rejects a leading zero after the "+" (not a valid country code start)', async () => {
    wireNoContacts();
    const res = await whatsapp_send({ to: '+0123456789', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /E\.164/i);
  });

  it('still accepts a legitimate international E.164 number (no false rejection)', async () => {
    wireNoContacts();
    const res = await whatsapp_send({ to: '+919876543210', text: 'hi' });
    // No contacts and no pc-child wiring here means it will fail LATER (trying
    // to open WhatsApp) — the point is it must NOT fail at the number-shape
    // check. A shape rejection says "E.164"/"not a phone number"; anything
    // past that point is a different, later failure.
    if (!res.ok) {
      assert.doesNotMatch(String(res.result), /not a phone number I can use/i,
        'a real E.164 number must clear the shape check');
    }
  });

  it('_internal.sanitizeNumber rejects a bare national number and accepts real E.164 numbers', () => {
    assert.equal(_internal.sanitizeNumber('9876543210'), null, 'no leading + must be rejected');
    assert.equal(_internal.sanitizeNumber('+15551234567'), '+15551234567');
    assert.equal(_internal.sanitizeNumber('+919876543210'), '+919876543210');
    assert.equal(_internal.sanitizeNumber('+0123456789'), null, 'leading zero after + must be rejected');
    assert.equal(_internal.sanitizeNumber('+12'), null, 'too short to be a real number must be rejected');
  });
});

// ---------------------------------------------------------------------------
// (c) launch_app: no matching window must surface as unverified:true, not a
// bare ok. (Proton VPN, 02:13:21 — a launch reported ok for a window that
// could never be confirmed.)
// ---------------------------------------------------------------------------
describe('(c) launch_app reports unverified:true when no matching window appears', () => {
  const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
  const originalRequire = Module.prototype.require;

  function withMockedPcChild(mock, fn) {
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/pc-child') return mock;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[FROM_PC_PATH];
    try {
      return fn(require(FROM_PC_PATH));
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[FROM_PC_PATH];
    }
  }

  it('an unresolvable launch (no pid, no title candidate) is unverified:true, never a bare ok', async () => {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async () => ({
        ok: true,
        result: { name: 'Proton VPN', launched: true, resolved: false, note: 'No process named like "Proton VPN" owns a window.' },
      }),
    };
    await withMockedPcChild(mock, async (fromPc) => {
      const res = await fromPc.launch_app({ name: 'Proton VPN' }, { bus: { emit() {} } });
      assert.equal(res.ok, true, 'launched:true means the OS call was accepted');
      assert.equal(res.unverified, true, 'OLD bug: this was reported as a bare, confirmed success');
      assert.match(res.result.note, /Proton VPN/);
    });
  });

  it('a title-only match (candidatePid, no pid) is unverified:true and names the unrelated window', async () => {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async () => ({
        ok: true,
        result: {
          name: 'Proton VPN', launched: true, resolved: false, matchedBy: 'title',
          candidatePid: 9001, candidateTitle: 'Proton VPN — Account Settings (Chrome tab)',
        },
      }),
    };
    await withMockedPcChild(mock, async (fromPc) => {
      const res = await fromPc.launch_app({ name: 'Proton VPN' }, { bus: { emit() {} } });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, true);
      assert.match(res.reason, /Proton VPN — Account Settings/, 'the unrelated window it refused to target must be named');
    });
  });

  it('a real process-window match is verifiedOk, not unverified', async () => {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async () => ({
        ok: true,
        result: { name: 'notepad', launched: true, resolved: true, matchedBy: 'process', pid: 5150 },
      }),
    };
    await withMockedPcChild(mock, async (fromPc) => {
      const res = await fromPc.launch_app({ name: 'notepad' }, { bus: { emit() {} } });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, false);
      assert.equal(res.evidence.oracle, 'process-window');
    });
  });
});

// ---------------------------------------------------------------------------
// (d) open_folder: an out-of-allowlist refusal carries the rule and the
// allowed roots as structured fields, not only prose the operator has to
// parse — the boundary refusal must read as a rule, not a mystery.
// ---------------------------------------------------------------------------
describe('(d) open_folder names the allowlist rule and roots as structured fields', () => {
  const { open_folder, allowedRoots } = require('../src/core/effectors/from-computer');

  it('an out-of-allowlist path fails with .rule and .allowedRoots, not only a prose reason', async () => {
    const res = await open_folder({ path: 'C:\\Windows\\System32' });
    assert.equal(res.ok, false);
    assert.ok(res.result && typeof res.result === 'object', 'the failure must be a structured object, not a bare string');
    assert.equal(res.result.rule, 'outside-allowed-roots');
    assert.ok(Array.isArray(res.result.allowedRoots) && res.result.allowedRoots.length > 0);
    assert.deepEqual(res.result.allowedRoots, allowedRoots());
    assert.match(String(res.result.error), /outside the folders I can access/i, 'prose is still present for the voice layer');
  });
});
