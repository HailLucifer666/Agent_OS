'use strict';

// test/electron-settings-confirm.test.js — no provider key or setting changes
// without the operator's click in a native dialog that shows exactly what will
// be written, and no synthetic input while that dialog is on screen
// (2026-09-29 audit, B3b; review fixes 2026-09-30).
//
// THE DEFECT. mythos:set-key and mythos:set-setting trusted only the sender (the
// HUD's main document, B3a). B3a measured that a same-origin iframe calling
// window.parent's bridge reports the HUD's main frame as its sender — so a
// generated page shown in the HUD could raise AUTONOMOUS_MAX_TIER or replace a
// key, and MYTHOS's own input tools could press Save. Nothing asked anyone.
//
// Tested on the mechanism. The settings channels are DRIVEN — electron/
// settings-ipc.js registered on a fake ipcMain, the real settings-store writing a
// temporary config.json, a recording confirmer — so "Cancel writes nothing" and
// "a batch is all or nothing" are measured on disk, not read off the source. The
// drivers' inhibit runs through the real pc-child sendCommand and processQueue
// with a fake child that RECORDS what reaches it. main.js and server/index.js
// are read as text only for their wiring, because the suite does not boot
// Electron.
//
// Probes: see the probe record at the end of this file.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSettingsConfirm, createChildInputInhibit, isProviderKeyName, MAX_SHOWN, ANSWER } = require('../../electron/settings-confirm');
const { registerSettingsIpc } = require('../../electron/settings-ipc');
const settingsStore = require('../src/core/config/settings-store');
const inputInhibit = require('../adapters/input-inhibit');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'setup', 'settings-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const RLO = String.fromCharCode(0x202e);

function recorder(answer) {
  const events = [];
  const dialogs = [];
  const confirm = createSettingsConfirm({
    showMessageBox: async (...args) => {
      const opts = args[args.length - 1];
      dialogs.push({ args, opts });
      events.push('dialog');
      return typeof answer === 'function' ? answer(opts) : { response: answer };
    },
    getWindow: () => ({ id: 'hud' }),
    inhibitInput: async (on) => { events.push('inhibit:' + on); return true; }, // held: a dialog is drawn only on a held inhibit (2026-10-05)
  });
  return { confirm, events, dialogs };
}

describe('the native confirmation', () => {
  test('Cancel is the default AND the cancel button, so Enter, Space and Esc all cancel; only the second button confirms', async () => {
    const r = recorder(0);
    assert.equal(await r.confirm.confirmKey('GEMINI_API_KEY'), ANSWER.NO);
    const o = r.dialogs[0].opts;
    assert.equal(o.buttons[0], 'Cancel');
    assert.equal(o.defaultId, 0);
    assert.equal(o.cancelId, 0);
    assert.equal(o.noLink, true);
    assert.equal(await recorder(1).confirm.confirmKey('GEMINI_API_KEY'), ANSWER.YES, 'ADJACENT: the second button confirms');
    assert.equal(r.dialogs[0].args.length, 2, 'modal to the HUD window');
  });

  test('a key is named, never shown: confirmKey takes no value at all', async () => {
    const r = recorder(1);
    assert.equal(r.confirm.confirmKey.length, 1);
    await r.confirm.confirmKey('MISTRAL_API_KEY');
    assert.match([r.dialogs[0].opts.message, r.dialogs[0].opts.detail].join('\n'), /MISTRAL_API_KEY/);
  });

  // (1) B3b review: 27 entries used to show 25 lines and "… and 2 more", and write all 27.
  test('(1) a batch dialog lists EVERY change; one it could not list in full is never shown at all', async () => {
    const r = recorder(1);
    const list = Array.from({ length: MAX_SHOWN }, (_, i) => ({ name: 'S' + i, value: i === 0 ? '' : 'v' + i }));
    assert.equal(await r.confirm.confirmSettings(list), ANSWER.YES);
    const d = r.dialogs[0].opts.detail;
    for (let i = 0; i < MAX_SHOWN; i++) assert.match(d, new RegExp('^S' + i + ' = ', 'm'), 'line ' + i);
    assert.match(d, /^S0 = \(cleared\)$/m);
    assert.doesNotMatch(d, /more/);
    const big = recorder(1);
    assert.equal(await big.confirm.confirmSettings(Array.from({ length: MAX_SHOWN + 1 }, (_, i) => ({ name: 'S' + i, value: 'x' }))), ANSWER.NO);
    assert.equal(big.dialogs.length, 0, 'too many to show is refused before any dialog');
  });

  // (2) B3b review: an invisible direction override or a line break could re-shape the dialog.
  test('(2) control, invisible and direction-changing characters are shown as escapes, never drawn', async () => {
    const r = recorder(1);
    await r.confirm.confirmSettings([{ name: 'A', value: 'x' + RLO + 'y' }]);
    const d = r.dialogs[0].opts.detail;
    assert.ok(!d.includes(RLO), 'the override character itself never reaches the dialog');
    assert.match(d, /u\{202e\}/);
  });

  test('input is inhibited BEFORE the dialog is drawn and released after — even when the dialog throws', async () => {
    const r = recorder(1);
    await r.confirm.confirmSettings([{ name: 'A', value: '1' }]);
    assert.deepEqual(r.events, ['inhibit:true', 'dialog', 'inhibit:false']);
    const events = [];
    const failing = createSettingsConfirm({
      showMessageBox: async () => { events.push('dialog'); throw new Error('no display'); },
      getWindow: () => null,
      inhibitInput: async (on) => { events.push('inhibit:' + on); return true; },
    });
    await assert.rejects(failing.confirmKey('K'), /no display/, 'a dialog that cannot be shown is not a yes');
    assert.deepEqual(events, ['inhibit:true', 'dialog', 'inhibit:false']);
  });

  // (6) B3b review: a queue let a page stack 5,000 dialogs, or slip its own ahead of the operator's.
  test('(6) one dialog at a time: a request while one is open is refused at once, never queued', async () => {
    let release;
    const shown = [];
    const c = createSettingsConfirm({
      // The first dialog waits for release(); any later one answers at once, so a
      // confirmer that queued or stacked would show it and answer "no", not hang.
      showMessageBox: (opts) => { shown.push(opts.message); return shown.length === 1 ? new Promise((r) => { release = () => r({ response: 1 }); }) : Promise.resolve({ response: 0 }); },
      getWindow: () => null,
      inhibitInput: async () => true,
    });
    const first = c.confirmKey('ONE');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await c.confirmKey('TWO'), ANSWER.BUSY, 'refused while the first is open');
    assert.equal(shown.length, 1);
    release();
    assert.equal(await first, ANSWER.YES);
    assert.equal(shown.length, 1, 'the refused one never appeared later either');
  });

  test('a minimised HUD is brought back before its dialog is shown', async () => {
    const calls = [];
    const win = { isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
    const c = createSettingsConfirm({ showMessageBox: async () => { calls.push('dialog'); return { response: 0 }; }, getWindow: () => win, inhibitInput: async () => true });
    await c.confirmKey('K');
    assert.deepEqual(calls, ['restore', 'show', 'focus', 'dialog']);
  });

  test('the import dialog names its source, every setting it can fit, the file count, and whether it REPLACES', async () => {
    const r = recorder(0);
    assert.equal(await r.confirm.confirmImport({ from: 'other-install/mythos', settings: ['AUTONOMOUS_MAX_TIER', 'TRUSTED_TOOLS'], vaultFiles: 12, overwrite: true }), ANSWER.NO);
    const d = r.dialogs[0].opts.detail;
    assert.match(r.dialogs[0].opts.message, /other-install\/mythos/);
    assert.match(d, /Settings: 2 \(AUTONOMOUS_MAX_TIER, TRUSTED_TOOLS\)/);
    assert.match(d, /Vault files.*: 12/);
    assert.match(d, /WILL BE REPLACED/);
  });
});

// (3) B3b review: every key-store name becomes an env var in the server child,
// where it outranks config.json. setKey('ALLOWED_ORIGINS', …) was shown as "a
// provider key".
describe('(3) the key store takes provider keys only', () => {
  test('credential-shaped names and the named sign-in ids pass; settings and environment switches do not', () => {
    for (const n of ['GEMINI_API_KEY', 'MISTRAL_API_KEY', 'MYTHOS_AUTH_TOKEN', 'SOME_SECRET', 'GOOGLE_CLIENT_ID']) assert.equal(isProviderKeyName(n), true, n);
    for (const n of ['ALLOWED_ORIGINS', 'AUTONOMOUS_MAX_TIER', 'TRUSTED_TOOLS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'MYTHOS_TEST_HATCH', 'NODE_OPTIONS', '']) assert.equal(isProviderKeyName(n), false, n);
  });

  test('main.js refuses such a name before any dialog, and stores only on a YES', () => {
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('mythos:set-key'"), MAIN.indexOf("ipcMain.handle('mythos:get-key-names'"));
    const refuse = h.indexOf('if (!isProviderKeyName(name)) return { ok: false, error: NOT_A_KEY };');
    const ask = h.indexOf('await settingsConfirm.confirmKey(name)');
    assert.ok(refuse > 0 && refuse < ask, 'the name is refused before any dialog');
    assert.match(h, /if \(keyAnswer !== 'yes'\) return \{ ok: false, error: refusalFor\(keyAnswer\) \};/,
      'only the exact answer yes stores — the answers are strings, so a truthiness test would store on "no"');
    assert.ok(ask < h.indexOf('saveStore(store)'));
  });
});

// ---- the settings channels, DRIVEN ------------------------------------------

function drive(answer) {
  const handlers = {};
  const asked = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b3b-'));
  const file = path.join(dir, 'config.json');
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    hudTrust: { ipc: (event) => ({ ok: event === 'hud' }) },
    settingsStore,
    settingsPath: () => file,
    settingsConfirm: {
      confirmSettings: async (list) => { asked.push(list); return answer; },
      confirmKey: async () => answer,
    },
    ENV_INJECTION_DENYLIST: new Set(['NODE_OPTIONS']),
  });
  const onDisk = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  return { handlers, asked, file, onDisk, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const SETTING_A = 'VOICE_TTS_PROVIDER';
const SETTING_B = 'WAKEWORD_ENABLED';

describe('the settings channels, driven through a fake ipcMain and the real settings store', () => {
  test('Cancel writes nothing; YES writes exactly what was shown', async () => {
    const no = drive(ANSWER.NO);
    try {
      const r = await no.handlers['mythos:set-settings']('hud', [{ name: SETTING_A, value: 'piper' }]);
      assert.equal(r.ok, false);
      assert.deepEqual(no.onDisk(), {});
    } finally { no.done(); }
    const yes = drive(ANSWER.YES);
    try {
      const r = await yes.handlers['mythos:set-settings']('hud', [{ name: SETTING_A, value: 'piper' }, { name: SETTING_B, value: 'true' }]);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(yes.onDisk(), { [SETTING_A]: 'piper', [SETTING_B]: 'true' });
      assert.deepEqual(yes.asked[0], [{ name: SETTING_A, value: 'piper' }, { name: SETTING_B, value: 'true' }], 'the dialog was shown exactly what was written');
    } finally { yes.done(); }
  });

  // (2)(7) B3b review: an entry that fails only after the click could shape the dialog, and the rest was half-written.
  test('(2)(7) every entry is validated BEFORE any dialog: one bad entry means no dialog and nothing written', async () => {
    const t = drive(ANSWER.YES);
    try {
      for (const bad of [
        [{ name: SETTING_A, value: 'piper' }, { name: 'NOT_A_SETTING', value: 'x' }],
        [{ name: 'VOICE_TTS_PROVIDER = "piper"\n\n(no other change)', value: '' }, { name: 'AUTONOMOUS_MAX_TIER', value: '4' }],
        [{ name: SETTING_A, value: ['a\nb'] }],
        [{ name: SETTING_A, value: 'two\nlines' }],
        [{ name: 'GEMINI_API_KEY', value: 'x' }],
        [{ name: 'NODE_OPTIONS', value: '--inspect' }],
        [{ name: SETTING_A, value: 'a' }, { name: SETTING_A, value: 'b' }],
      ]) {
        const r = await t.handlers['mythos:set-settings']('hud', bad);
        assert.equal(r.ok, false, JSON.stringify(bad));
      }
      assert.equal(t.asked.length, 0, 'no dialog was ever shown');
      assert.deepEqual(t.onDisk(), {});
    } finally { t.done(); }
  });

  test('(1) more changes than the dialog lists are refused before any dialog', async () => {
    const t = drive(ANSWER.YES);
    try {
      // Distinct, VALID settings — so only the count can refuse it (a list of one
      // name repeated was refused by the duplicate check and proved nothing).
      const { SCHEMA } = require('../src/core/config/schema');
      const names = Object.keys(SCHEMA).filter((n) => settingsStore.validateSetting(n, 'x').ok).slice(0, MAX_SHOWN + 1);
      assert.equal(names.length, MAX_SHOWN + 1);
      const r = await t.handlers['mythos:set-settings']('hud', names.map((name) => ({ name, value: 'x' })));
      assert.equal(r.ok, false);
      assert.equal(t.asked.length, 0);
    } finally { t.done(); }
  });

  test('(6) a dialog already open: refused as busy, nothing written; any other sender: thrown', async () => {
    const t = drive(ANSWER.BUSY);
    try {
      const r = await t.handlers['mythos:set-setting']('hud', SETTING_A, 'piper');
      assert.equal(r.ok, false);
      assert.match(r.error, /already open/);
      assert.deepEqual(t.onDisk(), {});
      await assert.rejects(t.handlers['mythos:set-settings']('not-the-hud', [{ name: SETTING_A, value: 'piper' }]), /denied/);
    } finally { t.done(); }
  });

  test('set-setting validates before its dialog, too', async () => {
    const t = drive(ANSWER.YES);
    try {
      assert.equal((await t.handlers['mythos:set-setting']('hud', 'NOT_A_SETTING', 'x')).ok, false);
      assert.equal(t.asked.length, 0);
      assert.equal((await t.handlers['mythos:set-setting']('hud', SETTING_A, 'piper')).ok, true);
      assert.deepEqual(t.onDisk(), { [SETTING_A]: 'piper' });
    } finally { t.done(); }
  });
});

describe('wiring that only exists in main.js and server/index.js', () => {
  test('main.js registers the settings channels and keeps no second copy', () => {
    assert.match(MAIN, /registerSettingsIpc\(\{ ipcMain, hudTrust, settingsStore, settingsPath, settingsConfirm, ENV_INJECTION_DENYLIST \}\);/);
    assert.equal((MAIN.match(/ipcMain\.handle\('mythos:set-setting/g) || []).length, 0);
  });

  // (8) B3b review: a late ack for one message could satisfy the next.
  test('(8) the inhibit waits for ITS OWN ack: a late ack for an earlier message settles nothing', async () => {
    const sent = [];
    const logs = [];
    const child = { connected: true, send: (m) => sent.push(m) };
    const t = createChildInputInhibit({ getChild: () => child, log: (...a) => logs.push(a.join(' ')), timeoutMs: 60 });
    const first = t.inhibit(true);
    assert.equal(await first, false, 'no ack: timed out');
    let settled = false;
    const second = t.inhibit(false).then((v) => { settled = true; return v; });
    t.heardAck({ seq: sent[0].seq }); // the first message's late ack
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(settled, false, 'a late ack for the first message does not settle the second');
    t.heardAck({ seq: sent[1].seq });
    assert.equal(await second, true);
    assert.notEqual(sent[0].seq, sent[1].seq);
    // 2026-10-05 security bundle: with no server child nothing can send input (pc-child
    // and cua-driver live in it), so the inhibit HOLDS; the state reaches the next child
    // through envFor() (test/input-inhibit-integrity.test.js (d2)).
    assert.equal(await createChildInputInhibit({ getChild: () => null, log() {} }).inhibit(true), true, 'no child: nothing can type');
    assert.match(MAIN, /if \(childInputInhibit\.handles\(msg\)\) return;/);
    assert.match(MAIN, /inhibitInput: childInputInhibit\.inhibit,/);
  });

  test('dialog is required at the use site, never destructured at module scope', () => {
    assert.match(MAIN, /showMessageBox: \(\.\.\.args\) => require\('electron'\)\.dialog\.showMessageBox\(\.\.\.args\)/);
    assert.doesNotMatch(MAIN, /^const \{[^}]*\bdialog\b[^}]*\} = require\('electron'\)/m);
  });

  test('(5) server/index.js acks the inhibit only once no input is in flight, with its sequence number', () => {
    const at = SERVER.indexOf("msg.channel === 'mythos:input-inhibit'");
    const block = SERVER.slice(at, at + 1400);
    assert.match(block, /require\('\.\.\/adapters\/input-inhibit'\)\.setInputInhibited\(msg\.on === true\)/);
    assert.match(block, /seq: msg\.seq/);
    // 2026-10-05: the ack says whether BOTH backends went idle; Electron draws the
    // dialog only on idle:true (test/input-inhibit-integrity.test.js (b)).
    assert.match(block, /Promise\.all\(\[pcChild\.whenInputIdle\(2000\), require\('\.\.\/adapters\/cua-driver'\)\.whenInputIdle\(2000\)\]\)/);
    assert.match(block, /idle: idle === true/);
    const save = PANEL.slice(PANEL.indexOf("saveBtn.addEventListener('click'"));
    assert.match(save.slice(0, 1500), /await bridge\.setSettings\(/);
    assert.doesNotMatch(save.slice(0, 1500), /bridge\.setSetting\(/, 'no per-field loop: that would be one dialog per field');
  });

  // (4) B3b review: /api/setup/import rewrote config.json and Identity/boundaries.md
  // with no dialog, reachable by any same-origin page.
  test('(4) the import route, driven: Cancel or busy imports NOTHING; yes (or a headless run) imports', async () => {
    const { mountImportRoutes } = require('../server/routes/import-existing');
    const source = { dir: path.resolve('/src-install'), label: 'dev', settings: { AUTONOMOUS_MAX_TIER: '4' }, vault: { root: '/src-install/vault', files: 3 } };
    for (const [answer, expectImport] of [['no', false], ['busy', false], ['yes', true], ['no-shell', true]]) {
      const routes = {};
      const calls = [];
      const asked = [];
      mountImportRoutes({ get: (p, fn) => { routes['GET ' + p] = fn; }, post: (p, fn) => { routes['POST ' + p] = fn; } }, {
        config: { MYTHOS_VAULT_ROOT: '/own/vault' }, settingsPath: '/own/config.json', vaultRoot: '/own/vault',
        settingsStore: { readSettings: () => ({ values: {} }), resolveSettingsPath: () => '/own/config.json' },
        importer: {
          scanForExisting: () => ({ sources: [source] }),
          importSettings: (o) => { calls.push('settings'); return { imported: Object.keys(o.settings), skipped: [] }; },
          importVaultFiles: () => { calls.push('vault'); return { copied: ['x'], skipped: [] }; },
        },
        confirmImport: async (summary) => { asked.push(summary); return answer; },
      });
      let status = 200;
      let body = null;
      const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
      await routes['POST /api/setup/import']({ body: { dir: source.dir, overwrite: true } }, res);
      assert.equal(asked.length, 1, answer + ': asked once');
      assert.deepEqual(asked[0].settings, ['AUTONOMOUS_MAX_TIER'], 'the dialog is told which settings');
      assert.equal(asked[0].overwrite, true);
      if (expectImport) { assert.deepEqual(calls, ['settings', 'vault'], answer); assert.equal(status, 200); }
      else { assert.deepEqual(calls, [], answer + ': nothing imported'); assert.equal(status, 409); assert.match(body.error, /not imported/); }
    }
  });

  test('(4) the import route asks Electron before it writes; main.js answers from the same confirmer', () => {
    assert.match(SERVER, /mountImportRoutes\(app, \{ config, logger, confirmImport: \(summary\) => confirmImportInElectron\(summary\) \}\)/);
    assert.match(MAIN, /msg\.channel === 'mythos:confirm-import'\) \{ settingsConfirm\.confirmImport\(msg\.summary\)/);
  });
});

// ---- the drivers refuse input while a dialog is on screen --------------------

describe('while a confirmation dialog is open, no synthetic keystroke or click is sent', () => {
  const pcChild = require('../adapters/pc-child');
  let writes = [];
  let holdNext = null;
  let held = null;
  function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (s) => {
      const c = JSON.parse(s);
      if (c.cmd !== 'ping') writes.push(c.cmd);
      const answer = () => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: c.id, ok: true, result: {} }) + '\n'));
      if (holdNext && c.cmd === holdNext) { holdNext = null; held = answer; return; } // stays in flight until released
      queueMicrotask(answer);
    } };
    child.kill = () => {};
    return child;
  }
  before(async () => { await pcChild.startPcChild({ spawnImpl: () => fakeChild() }); });
  after(() => { inputInhibit.setInputInhibited(false); pcChild.shutdownPcChild(); });
  beforeEach(() => { writes = []; inputInhibit.setInputInhibited(false); });

  test('pc-child: every input command is refused before it reaches the child; reading still works', async () => {
    inputInhibit.setInputInhibited(true);
    for (const cmd of ['ui_type', 'ui_click', 'click_at', 'right_click_at', 'send_key', 'drag', 'scroll_at', 'submit_message', 'clear_focused_box', 'focus_message_box', 'new_document', 'diagnose_type', 'uia_pump_probe']) {
      const r = await pcChild.sendCommand({ cmd, text: 'x', key: 'space', x: 1, y: 1 });
      assert.equal(r.ok, false, cmd);
      assert.equal(r.error, inputInhibit.REFUSAL, cmd);
    }
    assert.deepEqual(writes, [], 'nothing reached the child');
    assert.equal((await pcChild.sendCommand({ cmd: 'list_windows' })).ok, true, 'ADJACENT: reading the screen still works');
    assert.deepEqual(writes, ['list_windows']);
  });

  // (5) B3b review: the inhibit was checked only when a command was QUEUED. A
  // keystroke queued behind a slow command before the dialog opened was sent
  // after it — Tab onto the confirm button, Enter to press it.
  test('(5) a keystroke queued BEFORE the dialog opened is not sent after it — the inhibit is checked again when it would be sent', async () => {
    holdNext = 'ui_elements';
    const slow = pcChild.sendCommand({ cmd: 'ui_elements', pid: 1 });
    const tab = pcChild.sendCommand({ cmd: 'send_key', key: 'tab' });
    const enter = pcChild.sendCommand({ cmd: 'send_key', key: 'enter' });
    await new Promise((r) => setTimeout(r, 20));
    inputInhibit.setInputInhibited(true); // the dialog opens while they wait
    held();
    await slow;
    assert.equal((await tab).error, inputInhibit.REFUSAL);
    assert.equal((await enter).error, inputInhibit.REFUSAL);
    assert.deepEqual(writes, ['ui_elements'], 'neither keystroke reached the child');
  });

  test('(5) whenInputIdle waits for a keystroke already inside the child, so the ack comes after it', async () => {
    holdNext = 'send_key';
    const key = pcChild.sendCommand({ cmd: 'send_key', key: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    let idle = false;
    const waiting = pcChild.whenInputIdle(2000).then((v) => { idle = v; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(idle, false, 'not idle while the keystroke is in flight');
    held();
    await key;
    await waiting;
    assert.equal(idle, true);
    assert.equal(await pcChild.whenInputIdle(50), true, 'ADJACENT: nothing in flight answers at once');
  });

  test('ADJACENT: once the dialog is answered, input flows again', async () => {
    inputInhibit.setInputInhibited(true);
    inputInhibit.setInputInhibited(false);
    assert.equal((await pcChild.sendCommand({ cmd: 'send_key', key: 'space' })).ok, true);
    assert.deepEqual(writes, ['send_key']);
  });

  test('cua-driver: a click is refused at its one door; its read tools are not', async () => {
    const cua = require('../adapters/cua-driver');
    inputInhibit.setInputInhibited(true);
    const click = await cua.invoke('click', { pid: 1, element_index: 1 });
    assert.equal(click.ok, false);
    assert.equal(click.result, inputInhibit.REFUSAL);
    const read = await cua.invoke('get_window_state', { pid: 1 });
    assert.notEqual(read.result, inputInhibit.REFUSAL, 'ADJACENT: a read tool is not refused by the inhibit (here it is simply offline)');
  });
});

// AFTER THE REVIEW (Opus 5.5, 2026-09-30), 24 more, same day, each applied,
// checked by sha256 and restored: the default button confirming; the inhibit
// never released; no inhibit before the dialog; scroll_at off the list;
// cua-driver ignoring it; the server never setting it; set-key storing on any
// truthy answer (the answers are strings — "no" is truthy); any key name
// accepted; the provider-key rule opened; the batch unvalidated; the batch
// uncapped (red once the test used 41 DISTINCT settings — a repeated name was
// caught by the duplicate check instead); the dialog uncapped; hidden characters
// drawn; dialogs queued instead of refused (the test made to fail rather than
// hang); set-setting unvalidated; the store's own validation removed (red in
// packaged-config-parity.test.js); a queued keystroke sent after the dialog
// opened; whenInputIdle ignoring a keystroke in flight; the server acking at
// once; an ack of any sequence settling (red once the test checked the second
// request was still waiting); the import route skipping its confirmation; a
// minimised HUD left minimised; and the FIXTURE — the driven confirmer answering
// yes whatever it was told. One probe of the first set, the queue-time inhibit
// check in sendCommand, survived: processQueue's send-time check made it
// redundant, so it was removed rather than defended.
//
// PROBE RECORD, 2026-09-30 — twelve mutations, each applied, checked by sha256,
// run against this file and restored; each red here: the confirmation removed
// from mythos:set-key, from mythos:set-setting and from mythos:set-settings; the
// default button made the confirming one; the inhibit never released; the
// inhibit not set before the dialog; dialogs allowed to stack; pc-child ignoring
// the inhibit; scroll_at left off its list; cua-driver ignoring it; the server
// never setting it; and a FIXTURE mutation — the recording dialog answering
// "yes" whatever it was told — which proves the Cancel test reads the answer.
//
// LIVE, 2026-09-30, a real Electron 43.4.1 main process and the real confirmer:
// the dialog was on screen as a Windows #32770 window owned by that process,
// titled "MYTHOS — change settings", buttons ["Cancel", "Change settings"] with
// Cancel the default and the cancel button; closed through Electron's own
// AbortSignal (no click sent) it answered false; the inhibit was set before it
// and released after ([true, false]).
