'use strict';

// BUG-429: unknown settings are announced, never implemented implicitly.
// Recognised settings remain quiet; repeats use the existing backoff ladder.
// Probes 2026-09-10: disable serious kinds, bypass kill switch/dry-run mute,
// empty doctor unknowns. Each fails; absolute copy restores verified SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const doctor = require('../scripts/doctor');
const { readSettings } = require('../src/core/config/settings-store');
const { validate, SCHEMA } = require('../src/core/config');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function harness(config = {}) {
  const events = [];
  const announcer = createConversationAnnouncer({
    bus: { emit: (type, payload) => events.push({ type, payload }), subscribe: () => () => {} },
    brain: { think: async () => ({ offline: true }) }, config, speak: () => {}, now: () => 100000,
  });
  return { events, emit: (kind) => announcer._onHealthAnomaly({ payload: { kind } }) };
}
for (const kind of ['config-settings-ignored', 'config-settings-unreadable']) {
  it(kind + ' is announced once, with repeats backed off', () => {
    const h = harness(); h.emit(kind); h.emit(kind);
    assert.equal(h.events.filter((e) => e.type === 'conversation.announced').length, 1);
    assert.equal(h.events.filter((e) => e.type === 'conversation.suppressed' && e.payload.reason === 'repeat-backoff').length, 1);
  });
}
it('the voice kill switch preserves the former settings silence', () => {
  assert.equal(validate({}, SCHEMA).config.VOICE_SETTINGS_WARNINGS_ENABLED, true);
  const config = validate({ VOICE_SETTINGS_WARNINGS_ENABLED: 'false' }, SCHEMA).config;
  assert.equal(config.VOICE_SETTINGS_WARNINGS_ENABLED, false);
  const h = harness(config);
  h.emit('config-settings-ignored');
  assert.equal(h.events.length, 0);
});
it('dry run cannot speak a collected startup warning', () => {
  const previous = process.env.MYTHOS_DRY_RUN;
  process.env.MYTHOS_DRY_RUN = '1';
  try {
    const announcer = createConversationAnnouncer({
      bus: { emit() {}, subscribe: () => () => {} }, brain: { think: async () => ({}) }, config: {}, speak() { assert.fail('dry run spoke'); },
    });
    const diagnostics = { settingsUnknown: ['BROWSER_USE_MODEL'] };
    assert.equal(announcer.hasSettingsWarnings(diagnostics), false);
    assert.equal(announcer.appendSettingsWarnings('Greeting', diagnostics), 'Greeting');
  } finally {
    if (previous === undefined) delete process.env.MYTHOS_DRY_RUN; else process.env.MYTHOS_DRY_RUN = previous;
  }
});
it('doctor names the unknown key, never its value; recognised keys stay empty', () => {
  const settings = (data) => readSettings({ settingsPath: 'fixture.json', fs: { existsSync: () => true, readFileSync: () => JSON.stringify(data) } });
  const rows = doctor.settingsIntegrity(settings({ BROWSER_USE_MODEL: 'private-model-value' }));
  assert.deepEqual(rows, [{ name: 'BROWSER_USE_MODEL', message: 'no such MYTHOS setting' }]);
  assert.deepEqual(doctor.settingsIntegrity(settings({ MYTHOS_PORT: 4478 })), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-report-'));
  try {
    const report = doctor.buildReport(dir, { settings: settings({ BROWSER_USE_MODEL: 'private-model-value' }) });
    assert.deepEqual(report.settingsIntegrity, rows, 'the assembled doctor report carries the diagnosis');
    assert.doesNotMatch(JSON.stringify(report.settingsIntegrity), /private-model-value/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
