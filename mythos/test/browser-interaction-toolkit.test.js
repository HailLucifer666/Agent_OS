'use strict';

// test/browser-interaction-toolkit.test.js — snapshot-and-refs Phase 5.
//
// The snapshot gives the model something real to aim at; these four tools are
// the rest of what "do anything a browser can do" actually requires. The one
// with real blast radius is browser_upload_file: it reads a file off the
// operator's disk and hands it to a web page, so its allowlist gets the most
// attention here and is tested as a pure function, with no browser anywhere
// near it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);
const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');

let originalWithPage, originalGetStatus, originalEnsureOnline, originalUploadDir;

function stubOnline() {
  originalWithPage = realBrowserAgent.withPage;
  originalGetStatus = realBrowserAgent.getStatus;
  originalEnsureOnline = realBrowserAgent.ensureOnline;
  originalUploadDir = process.env.BROWSER_UPLOAD_DIR;
  realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
  realBrowserAgent.ensureOnline = async () => {};
}
function restore() {
  realBrowserAgent.withPage = originalWithPage;
  realBrowserAgent.getStatus = originalGetStatus;
  realBrowserAgent.ensureOnline = originalEnsureOnline;
  if (originalUploadDir === undefined) delete process.env.BROWSER_UPLOAD_DIR;
  else process.env.BROWSER_UPLOAD_DIR = originalUploadDir;
  delete require.cache[FROM_BROWSER];
}

function fakePage(overrides) {
  const calls = [];
  return Object.assign({
    _calls: calls,
    url: () => 'https://jobs.example.test/apply',
    title: async () => 'Apply',
    evaluate: async () => ({ focused: null, video: null }),
    keyboard: { press: async (k) => { calls.push({ keyboardPress: k }); } },
    waitForSelector: async () => {},
    locator: (sel) => ({
      click: async () => { calls.push({ click: sel }); },
      fill: async (v) => { calls.push({ fill: sel, value: v }); },
      hover: async () => { calls.push({ hover: sel }); },
      press: async (k) => { calls.push({ press: sel, key: k }); },
      selectOption: async (o) => { calls.push({ selectOption: sel, option: o }); return ['ok']; },
      setInputFiles: async (p) => { calls.push({ setInputFiles: sel, file: p }); },
      count: async () => 1,
      first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    }),
  }, overrides || {});
}

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  return require(FROM_BROWSER);
}

// A real temp directory tree, because the containment check is about the
// filesystem and a mocked fs would only prove the mock agrees with itself.
function makeUploadFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-upload-'));
  const allowed = path.join(root, 'documents');
  const secrets = path.join(root, 'secrets');
  fs.mkdirSync(allowed);
  fs.mkdirSync(secrets);
  const resume = path.join(allowed, 'resume.pdf');
  const secret = path.join(secrets, 'id-scan.png');
  fs.writeFileSync(resume, 'pdf');
  fs.writeFileSync(secret, 'png');
  return { root, allowed, secrets, resume, secret };
}

describe('browser_upload_file — the allowlist is the security boundary', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('refuses every upload when no folder is configured, and says how to configure it', () => {
    delete process.env.BROWSER_UPLOAD_DIR;
    const fb = require(FROM_BROWSER);
    const r = fb.resolveUploadPath('C:/anything.pdf');
    assert.equal(r.ok, false);
    assert.match(r.reason, /BROWSER_UPLOAD_DIR/,
      'the default must be "refuse", never a convenient guess like the whole home directory');
  });

  it('accepts a file inside the configured folder', () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);

    const r = fb.resolveUploadPath(fx.resume);
    assert.equal(r.ok, true);
    assert.equal(fs.realpathSync(r.resolved), fs.realpathSync(fx.resume));
  });

  it('refuses a sibling folder the operator did not list', () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);

    const r = fb.resolveUploadPath(fx.secret);
    assert.equal(r.ok, false);
    assert.match(r.reason, /outside the folders/i);
  });

  it('refuses a ../ escape out of the allowed folder', () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);

    const r = fb.resolveUploadPath(path.join(fx.allowed, '..', 'secrets', 'id-scan.png'));
    assert.equal(r.ok, false, 'lexical resolution must happen before the containment test');
  });

  it('refuses a symlink planted INSIDE the allowed folder that points outside it', (t) => {
    const fx = makeUploadFixture();
    const link = path.join(fx.allowed, 'innocent.png');
    try {
      fs.symlinkSync(fx.secret, link);
    } catch (_) {
      // Creating a symlink needs Developer Mode or elevation on Windows. Skip
      // rather than pretend: an un-runnable check must not read as a pass.
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);

    const r = fb.resolveUploadPath(link);
    assert.equal(r.ok, false,
      'a lexical check alone would pass this — the realpath check is what makes containment mean anything');
  });

  it('refuses a file that does not exist, naming it', () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);

    const r = fb.resolveUploadPath(path.join(fx.allowed, 'nope.pdf'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /No such file/);
  });

  it('attaches an allowed file to the ref the snapshot named', async () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e7'], 1);

    const r = await fb.browser_upload_file({ ref: 'e7', path: fx.resume });

    assert.equal(r.ok, true);
    const call = page._calls.find((c) => c.setInputFiles);
    assert.equal(call.setInputFiles, 'aria-ref=e7');
    assert.equal(fs.realpathSync(call.file), fs.realpathSync(fx.resume));
    assert.equal(r.result.uploaded, 'resume.pdf');
  });

  it('never touches the page when the path is refused', async () => {
    const fx = makeUploadFixture();
    process.env.BROWSER_UPLOAD_DIR = fx.allowed;
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e7'], 1);

    const r = await fb.browser_upload_file({ ref: 'e7', path: fx.secret });
    assert.equal(r.ok, false);
    assert.equal(page._calls.length, 0, 'the refusal must happen before anything reaches the browser');
  });
});

describe('browser_select_option — native dropdowns, honest about custom ones', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('selects by visible label', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e4'], 1);

    const r = await fb.browser_select_option({ ref: 'e4', label: 'United Kingdom' });
    assert.equal(r.ok, true);
    assert.deepEqual(page._calls.find((c) => c.selectOption).option, { label: 'United Kingdom' });
  });

  it('selects by value', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e4'], 1);

    await fb.browser_select_option({ ref: 'e4', value: 'uk' });
    assert.deepEqual(page._calls.find((c) => c.selectOption).option, { value: 'uk' });
  });

  it('a failure on a custom dropdown tells the model the click-open route instead', async () => {
    const page = fakePage({
      locator: () => ({
        selectOption: async () => { throw new Error('Element is not a <select> element'); },
        count: async () => 1,
      }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e4'], 1);

    const r = await fb.browser_select_option({ ref: 'e4', label: 'x' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /custom dropdown/i);
    assert.match(String(r.result), /browser_click/, 'a dead-end failure is the BUG-107 mistake');
  });

  it('requires something to select', async () => {
    const fb = loadEffector(fakePage());
    const r = await fb.browser_select_option({ ref: 'e4' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /value or label/i);
  });
});

describe('browser_press_key — form flow keys, allowlisted', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('presses on the focused element when no target is given', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    const r = await fb.browser_press_key({ key: 'Enter' });

    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.keyboardPress === 'Enter'));
  });

  it('presses on a specific ref when one is given', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e2'], 1);

    await fb.browser_press_key({ key: 'Tab', ref: 'e2' });
    assert.ok(page._calls.some((c) => c.press === 'aria-ref=e2' && c.key === 'Tab'));
  });

  it('accepts the key case-insensitively but presses the canonical name', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    await fb.browser_press_key({ key: 'escape' });
    assert.ok(page._calls.some((c) => c.keyboardPress === 'Escape'));
  });

  it('refuses anything outside the allowlist — this is not a text-entry tool', async () => {
    const page = fakePage();
    const fb = loadEffector(page);

    for (const bad of ['Control+A', 'a', 'F4', 'Meta']) {
      const r = await fb.browser_press_key({ key: bad });
      assert.equal(r.ok, false, bad + ' must be refused');
      assert.match(String(r.result), /browser_type/, 'and point at the tool that does enter text');
    }
    assert.equal(page._calls.length, 0, 'a refused key must never reach the page');
  });
});

describe('browser_hover — reveal, then look again', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('hovers the ref and tells the model to re-snapshot', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e9'], 1);

    const r = await fb.browser_hover({ ref: 'e9' });
    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.hover === 'aria-ref=e9'));
    assert.match(r.result.hint, /browser_snapshot/,
      'hovering exists to reveal something; the next step should not have to be guessed');
  });

  it('a stale ref is refused here too — one rule for every ref tool', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 3);

    const r = await fb.browser_hover({ ref: 'eOLD' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /browser_snapshot again/i);
    assert.equal(page._calls.length, 0);
  });
});

describe('Phase 5 wiring — registered, tiered, reachable', () => {
  it('every new tool is in the catalog, tiered, and on the voice allowlist', () => {
    const { TOOLS } = require(FROM_BROWSER);
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

    const expected = {
      browser_upload_file: 3,
      browser_select_option: 3,
      browser_press_key: 3,
      browser_hover: 1,
    };
    for (const [name, tier] of Object.entries(expected)) {
      assert.ok(TOOLS.find((t) => t.name === name), name + ' must be registered');
      assert.equal(TIER_TABLE[name], tier, name + ' must be tier ' + tier);
      assert.ok(DEFAULT_ALLOWLIST.includes(name), name + ' must be reachable from voice');
    }
  });

  it('the write-shaped tools are T3 — they drive the operator\'s real logged-in browser', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    // Pinned deliberately: a future "these are just form helpers" retier to T2
    // would auto-allow them for the autonomous loop, on a browser holding the
    // operator's real sessions.
    for (const name of ['browser_upload_file', 'browser_select_option', 'browser_press_key']) {
      assert.equal(TIER_TABLE[name], 3, name + ' must keep asking the first time');
    }
  });

  it('the upload folder is documented in .env.example as a boundary, not a convenience', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    assert.match(env, /BROWSER_UPLOAD_DIR/);
    assert.match(env, /REFUSES every upload/,
      'an operator reading the config must learn that unset means refuse');
  });
});
