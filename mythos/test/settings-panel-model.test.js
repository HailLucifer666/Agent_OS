'use strict';

// test/settings-panel-model.test.js — the Settings panel's decisions.
//
// WHY THE PANEL EXISTS (operator, 2026-08-11): a packaged MYTHOS had NO UI
// anywhere for a non-secret configuration key. The wizard's key store handled
// provider API keys only, and mythos/.env — the other source — is excluded from
// package.json build.files. ~140 schema keys were unreachable in the install,
// which is what left it running on defaults nobody could see or change.
//
// The three properties worth pinning are the ones that would make the panel
// dishonest or dangerous: it must never render a secret value, never offer an
// input that silently does nothing, and never write a value that was not actually
// changed (which would pin a derived or default key permanently).

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let buildSettingsView, planSettingEdits, describeAutonomy;

before(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'setup', 'settings-panel-model.js'),
  ).href);
  buildSettingsView = mod.buildSettingsView;
  planSettingEdits = mod.planSettingEdits;
  describeAutonomy = mod.describeAutonomy;
});

const BODY = {
  file: 'C:\\Users\\x\\AppData\\Roaming\\MYTHOS\\config.json',
  autonomy: { effective: 2, configCeiling: 2, boundariesCeiling: 2, source: 'file' },
  keys: [
    { name: 'VOICE_S2S_ENABLED', type: 'bool', value: true, default: 'false', origin: 'config.json', secret: false },
    { name: 'WAKEWORD_ENABLED', type: 'bool', value: false, default: 'false', origin: 'default', secret: false },
    { name: 'VOICE_TTS_CHAIN', type: 'string', value: 'gemini,edge', default: '', origin: 'derived', secret: false },
    { name: 'AUTONOMOUS_MAX_TIER', type: 'number', value: '2', default: '2', origin: 'env', secret: false },
    { name: 'GOOGLE_CLIENT_SECRET', type: 'string', default: '', origin: 'default', secret: true, redacted: true, set: true },
    { name: 'AETHER_ENABLED', type: 'bool', value: true, default: 'false', origin: 'config.json', secret: false },
    { name: 'LOG_LEVEL', type: 'string', value: 'info', default: 'info', origin: 'default', secret: false, enum: ['debug', 'info', 'warn', 'error'] },
  ],
};

describe('buildSettingsView', () => {
  it('groups the incident-relevant keys first and counts each origin', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    assert.equal(view.ok, true);
    assert.deepEqual(view.groups.map((g) => g.id), ['voice', 'autonomy', 'devices', 'server']);
    assert.equal(view.counts.total, 7);
    // VOICE_S2S_ENABLED + AETHER_ENABLED (config.json) + AUTONOMOUS_MAX_TIER (env).
    assert.equal(view.counts.explicit, 3, 'env + config.json values are the ones an operator or their file set');
    assert.equal(view.counts.derived, 1, 'VOICE_TTS_CHAIN');
    // WAKEWORD_ENABLED + GOOGLE_CLIENT_SECRET + LOG_LEVEL.
    assert.equal(view.counts.default, 3);
    assert.equal(view.counts.secret, 1);
    assert.equal(view.file, BODY.file);
  });

  it('NEVER renders a secret value, and never offers an input for one', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    const secret = view.groups.flatMap((g) => g.rows).find((r) => r.name === 'GOOGLE_CLIENT_SECRET');
    assert.equal(secret.secret, true);
    assert.equal(secret.value, '', 'a secret has no value to render — the server never sends one');
    assert.equal(secret.editable, false, 'settings-store.js refuses this write anyway; saying so up front is honest');
    assert.equal(secret.set, true, 'presence IS reportable, and is all that is');
  });

  it('is READ-ONLY with no Electron bridge, and says why', () => {
    const view = buildSettingsView(BODY, { hasBridge: false });
    assert.equal(view.editable, false);
    assert.match(view.readOnlyReason, /browser tab/);
    assert.ok(view.groups.flatMap((g) => g.rows).every((r) => r.editable === false),
      'a browser tab has no bridge, so an input here would silently do nothing');
  });

  it('flags a key sitting at its schema default — the thing to look at when a feature is dead', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    const wake = view.groups.flatMap((g) => g.rows).find((r) => r.name === 'WAKEWORD_ENABLED');
    assert.equal(wake.atDefault, true);
    const live = view.groups.flatMap((g) => g.rows).find((r) => r.name === 'VOICE_S2S_ENABLED');
    assert.equal(live.atDefault, false);
  });

  it('an INDETERMINATE response paints nothing', () => {
    for (const body of [null, undefined, {}, { keys: 'no' }]) {
      const view = buildSettingsView(body, { hasBridge: true });
      assert.equal(view.ok, false);
      assert.equal(view.reason, 'indeterminate');
      assert.deepEqual(view.groups, []);
    }
  });
});

describe('planSettingEdits', () => {
  it('an unchanged value is NOT a write', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    const plan = planSettingEdits(view, { VOICE_S2S_ENABLED: 'true' });
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.unchanged, ['VOICE_S2S_ENABLED'],
      'writing a value that already holds would pin a derived or default key permanently for no reason');
  });

  it('collects real changes with their previous value', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    const plan = planSettingEdits(view, { WAKEWORD_ENABLED: 'true', LOG_LEVEL: 'debug' });
    assert.deepEqual(plan.changes.map((c) => [c.name, c.value, c.previous]).sort(), [
      ['LOG_LEVEL', 'debug', 'info'],
      ['WAKEWORD_ENABLED', 'true', 'false'],
    ]);
  });

  it('rejects a secret, an unknown key, and anything not editable here', () => {
    const view = buildSettingsView(BODY, { hasBridge: true });
    const plan = planSettingEdits(view, { GOOGLE_CLIENT_SECRET: 'oops', NOT_REPORTED: 'x' });
    assert.deepEqual(plan.changes, []);
    const reasons = Object.fromEntries(plan.rejected.map((r) => [r.name, r.reason]));
    assert.match(reasons.GOOGLE_CLIENT_SECRET, /key store/);
    assert.match(reasons.NOT_REPORTED, /not a key this server reported/);
  });

  it('rejects everything when the panel is read-only', () => {
    const view = buildSettingsView(BODY, { hasBridge: false });
    const plan = planSettingEdits(view, { WAKEWORD_ENABLED: 'true' });
    assert.deepEqual(plan.changes, []);
    assert.match(plan.rejected[0].reason, /not editable/);
  });
});

describe('describeAutonomy — incident 3 must never be invisible again', () => {
  it('names the clamp when boundaries.md is present but unparseable', () => {
    const text = describeAutonomy({ effective: 1, configCeiling: 3, boundariesCeiling: 1, source: 'malformed-failsafe' });
    assert.match(text, /tier 1/);
    assert.match(text, /clamped from your configured tier 3/);
    assert.match(text, /could not be parsed/);
  });

  it('says so when there is no boundaries file yet', () => {
    const text = describeAutonomy({ effective: 2, configCeiling: 2, boundariesCeiling: 2, source: 'absent-config-ceiling' });
    assert.match(text, /no Identity\/boundaries\.md yet/);
  });

  it('reports a deliberate tightening as a tightening, not a fault', () => {
    const text = describeAutonomy({ effective: 1, configCeiling: 3, boundariesCeiling: 1, source: 'file' });
    assert.match(text, /tightens it to 1/);
  });

  it('says nothing at all when the server did not report a ceiling', () => {
    assert.equal(describeAutonomy(null), '');
    assert.equal(describeAutonomy({ effective: null }), '');
  });
});
