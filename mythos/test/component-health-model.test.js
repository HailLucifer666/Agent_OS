'use strict';

// test/component-health-model.test.js — the banner that says a component the
// operator asked for was never actually installed.
//
// THE INCIDENT (2026-08-11): install-selection.json recorded silero:true,
// wakeword:true and adb:true. Nothing was fetched, the wizard's Components step
// never completed, and resources\app.asar.unpacked\mythos\ui\public\models\ did
// not exist on disk. The only symptom the operator ever saw was that saying
// "hey jarvis" did nothing.
//
// Same import-the-ESM-module-under-node:test idiom the other ui/public/js model
// tests use (see hud-model.test.js, update-banner-model.test.js).

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let deriveComponentHealth, summariseInstallResults;

before(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'setup', 'component-health-model.js'),
  ).href);
  deriveComponentHealth = mod.deriveComponentHealth;
  summariseInstallResults = mod.summariseInstallResults;
});

describe('deriveComponentHealth', () => {
  it('names a component that was selected during setup and is not installed', () => {
    const out = deriveComponentHealth({
      components: [
        { id: 'wakeword', label: 'Wake word "hey jarvis"', selected: true, installed: false, available: true },
        { id: 'piper', label: 'Offline voice (Piper)', selected: false, installed: false, available: true },
      ],
    });
    assert.equal(out.show, true);
    assert.equal(out.reason, 'selected-not-installed');
    assert.deepEqual(out.missing.map((m) => m.id), ['wakeword']);
    assert.match(out.message, /Wake word "hey jarvis" was selected during setup but is not installed\./);
  });

  it('lists all three when the whole Components step never ran — the operator\'s actual case', () => {
    const out = deriveComponentHealth({
      components: [
        { id: 'silero', label: 'Silero VAD', selected: true, installed: false, available: true },
        { id: 'wakeword', label: 'Wake word "hey jarvis"', selected: true, installed: false, available: true },
        { id: 'adb', label: 'Phone control (adb)', selected: true, installed: false, available: true },
      ],
    });
    assert.equal(out.show, true);
    assert.equal(out.missing.length, 3);
    assert.match(out.message, /3 components were selected during setup but are not installed/);
  });

  it('stays quiet about a component nobody asked for', () => {
    const out = deriveComponentHealth({
      components: [{ id: 'hermes', label: 'Hermes', selected: false, installed: false, available: true }],
    });
    assert.equal(out.show, false);
    assert.equal(out.reason, 'ok');
  });

  it('installed:null (unobservable) is never reported as missing', () => {
    const out = deriveComponentHealth({
      components: [{ id: 'autostart', label: 'Start at sign-in', selected: true, installed: null, available: true }],
    });
    assert.equal(out.show, false, 'unknown is not the same as missing');
  });

  it('does not blame a component the machine cannot install (Hermes with no WSL)', () => {
    const out = deriveComponentHealth({
      components: [{ id: 'hermes', label: 'Hermes', selected: true, installed: false, available: false }],
    });
    assert.equal(out.show, false);
  });

  it('an INDETERMINATE probe never paints', () => {
    for (const body of [null, undefined, {}, { components: 'nope' }, { error: 'boom' }]) {
      const out = deriveComponentHealth(body);
      assert.equal(out.show, false);
      assert.equal(out.reason, 'indeterminate');
    }
  });
});

describe('summariseInstallResults', () => {
  it('reports a verified-false install as failed, with the installer\'s own words', () => {
    const out = summariseInstallResults([
      { id: 'silero', ok: true, verified: true },
      { id: 'wakeword', ok: false, verified: false, error: 'HTTP 403 for melspectrogram.onnx' },
    ]);
    assert.equal(out.ok, false);
    assert.deepEqual(out.failed.map((f) => f.id), ['wakeword']);
    assert.match(out.message, /HTTP 403/, 'a generic "install failed" is never actionable');
  });

  it('a zero exit code with verified:false is still a failure', () => {
    const out = summariseInstallResults([{ id: 'silero', ok: false, verified: false, code: 0, error: '' }]);
    assert.equal(out.ok, false);
    assert.match(out.failed[0].error, /files are not on disk/);
  });

  it('verified:null is not a failure — the exit code is all that exists for it', () => {
    const out = summariseInstallResults([{ id: 'autostart', ok: true, verified: null }]);
    assert.equal(out.ok, true);
    assert.deepEqual(out.failed, []);
  });

  it('an empty or missing result set is not a failure', () => {
    assert.equal(summariseInstallResults([]).ok, true);
    assert.equal(summariseInstallResults(null).ok, true);
  });
});
