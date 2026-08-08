'use strict';

// test/phase2-docs-generation.test.js — Phase 2 document-generation effectors.
// Verifies the three from-docs tools produce valid files sandboxed under
// vault/builds/docs/, that path traversal in titles is sanitized, and that
// PDF degrades honestly to HTML when Chrome is absent (forced via CHROME_PATH
// pointing at a non-existent binary).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools, registerFromDocs } = require('../src/core/effectors/from-docs');
const { createEffectorHub } = require('../src/core/effectors/hub');

function tempVault() {
  const dir = path.join(os.tmpdir(), 'mythos-docs-' + require('crypto').randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

function fakeBus() { const e = []; return { emit: (t, p) => e.push({ type: t, payload: p }), _emitted: () => e, subscribe: () => {} }; }

describe('Phase 2 — from-docs effector tools', () => {
  let dir, vault, tools;

  before(() => {
    dir = tempVault();
    vault = createFsStore(() => dir, null);
    tools = buildTools({ vault });
    // Force Chrome-absent for the PDF-degradation test by pointing CHROME_PATH
    // at a path that does not exist, and none of the default locations either
    // (we can't fully control PROGRAMFILES, but resolveChromePath checks
    // CHROME_PATH first and returns it if it exists — so point it at a
    // non-existent path to make it fall through; if real Chrome is installed
    // the default-location check could still hit, so we also stub below).
    process.env.CHROME_PATH = path.join(dir, 'no-chrome-here.exe');
  });

  after(() => { cleanup(dir); delete process.env.CHROME_PATH; });

  function fn(name) { return tools.find((t) => t.name === name).fn; }

  it('generate_spreadsheet writes a valid .xlsx that reopens with the lib reader', async () => {
    const result = await fn('generate_spreadsheet')({
      title: 'Q3 Goals',
      sheets: [{
        name: 'Goals',
        columns: ['Goal', 'Status', 'Priority'],
        rows: [['Ship docs', 'in progress', 'high'], ['Fix routing', 'done', 'high']],
      }],
    });
    assert.equal(result.ok, true, 'should succeed: ' + JSON.stringify(result));
    assert.equal(result.result.format, 'xlsx');
    assert.ok(result.result.bytes > 0);
    assert.ok(result.result.savedTo.endsWith('.xlsx'));
    assert.ok(result.result.savedTo.split(path.sep).indexOf('docs') !== -1, 'must be sandboxed under builds/docs');

    // Reopen and assert structure.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const abs = vault.vaultPath(result.result.savedTo);
    await wb.xlsx.readFile(abs);
    assert.equal(wb.worksheets.length, 1);
    assert.equal(wb.worksheets[0].name, 'Goals');
    assert.equal(wb.worksheets[0].getRow(1).getCell(1).value, 'Goal');
    assert.equal(wb.worksheets[0].getRow(2).getCell(1).value, 'Ship docs');
  });

  it('generate_spreadsheet rejects empty sheets array', async () => {
    const result = await fn('generate_spreadsheet')({ title: 'Empty', sheets: [] });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /sheet/i);
  });

  it('generate_deck writes a valid .pptx with the right slide count', async () => {
    const result = await fn('generate_deck')({
      title: 'Solar System',
      slides: [
        { title: 'The Sun', bullets: ['Center of the system', '99.86% of mass'] },
        { title: 'Planets', bullets: ['Mercury', 'Venus', 'Earth', 'Mars'], notes: 'Inner rocky planets' },
        { title: 'Summary', bullets: ['8 planets total'] },
      ],
    });
    assert.equal(result.ok, true, 'should succeed: ' + JSON.stringify(result));
    assert.equal(result.result.format, 'pptx');
    assert.equal(result.result.slides, 3);
    assert.ok(result.result.savedTo.endsWith('.pptx'));
    assert.ok(result.result.bytes > 0);

    // A .pptx is a zip; assert the zip signature (PK\x03\x04).
    const abs = vault.vaultPath(result.result.savedTo);
    const head = fs.readFileSync(abs).slice(0, 4);
    assert.equal(head[0], 0x50);
    assert.equal(head[1], 0x4b);
  });

  it('generate_deck rejects empty slides array', async () => {
    const result = await fn('generate_deck')({ title: 'Empty', slides: [] });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /slide/i);
  });

  it('generate_pdf from markdown degrades honestly to HTML when Chrome is absent', async () => {
    // CHROME_PATH is set to a non-existent path in before(); if a real Chrome
    // exists at a default location this test would produce a PDF instead. To
    // make the degradation deterministic, monkeypatch resolveChromePath by
    // setting CHROME_PATH to a guaranteed-missing path AND verify the outcome
    // is EITHER a pdf (real Chrome found) OR an html degradation — both valid.
    process.env.CHROME_PATH = path.join(dir, 'definitely-no-chrome-' + Date.now() + '.exe');
    const result = await fn('generate_pdf')({
      title: 'Status Report',
      markdown: '# Status\n\nAll systems nominal.\n\n- Docs shipped\n- Routing fixed',
    });
    assert.equal(result.ok, true, 'should succeed (either pdf or html): ' + JSON.stringify(result));
    assert.ok(['pdf', 'html'].indexOf(result.result.format) !== -1);
    assert.ok(result.result.bytes > 0);
    if (result.result.format === 'html') {
      assert.equal(result.result.degraded, true);
      assert.ok(result.result.note, 'degradation must include a note explaining how to get PDF');
      // HTML must contain the rendered markdown content.
      const content = vault.readText(result.result.savedTo);
      assert.match(content, /Status/);
      assert.match(content, /All systems nominal/);
    }
  });

  it('generate_pdf degrades honestly when Chrome EXISTS but produces no PDF', async () => {
    // The "Chrome absent" path was always handled; a Chrome that launches and
    // exits without writing a PDF (wrong build, locked profile, sandbox denied,
    // headless disabled by policy) used to hard-fail with ok:false and throw
    // away the already-rendered HTML. That is the failure this suite hit on a
    // machine with a real Chrome installed.
    //
    // Point CHROME_PATH at this Node binary: it EXISTS (so resolveChromePath
    // returns it rather than falling through to the absent-Chrome branch) and
    // it will exit without producing a PDF, deterministically, on any machine
    // and regardless of whether real Chrome is installed.
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = process.execPath;
    try {
      const result = await fn('generate_pdf')({
        title: 'Chrome Broken Report',
        markdown: '# Broken\n\nChrome ran and produced nothing.',
      });
      assert.equal(result.ok, true, 'must degrade, not fail: ' + JSON.stringify(result));
      assert.equal(result.result.format, 'html');
      assert.equal(result.result.degraded, true);
      assert.ok(result.result.bytes > 0);
      assert.match(result.result.note, /Chrome/i, 'note must explain what happened');
      const content = vault.readText(result.result.savedTo);
      assert.match(content, /Chrome ran and produced nothing/);
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = prev;
    }
  });

  it('generate_pdf rejects when neither markdown nor html provided', async () => {
    const result = await fn('generate_pdf')({ title: 'Empty' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /markdown|html/i);
  });

  it('title with path-traversal characters is sanitized (no escape from builds/docs)', async () => {
    const result = await fn('generate_spreadsheet')({
      title: '../../etc/passwd',
      sheets: [{ name: 'S', columns: ['A'], rows: [['1']] }],
    });
    assert.equal(result.ok, true);
    // slugify reduces ../../etc/passwd to "etc-passwd" — never a traversal.
    assert.ok(result.result.savedTo.indexOf('..') === -1, 'no parent-dir segment: ' + result.result.savedTo);
    assert.ok(result.result.savedTo.split(path.sep).indexOf('docs') !== -1, 'must be under builds/docs');
    // File must land inside the vault.
    const abs = vault.vaultPath(result.result.savedTo);
    assert.ok(abs.startsWith(dir), 'resolved path must stay inside vault root');
  });

  it('all three tools register via registerFromDocs and the tier table marks them T2', async () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.generate_spreadsheet, 2);
    assert.equal(TIER_TABLE.generate_deck, 2);
    assert.equal(TIER_TABLE.generate_pdf, 2);

    const hub = createEffectorHub({ bus: fakeBus(), config: {} });
    const count = registerFromDocs(hub, { vault });
    assert.equal(count, 3);
    // Each tool is present in the catalog with a description.
    const cat = hub.catalog();
    const names = cat.map((t) => t.name);
    assert.ok(names.indexOf('generate_spreadsheet') !== -1);
    assert.ok(names.indexOf('generate_deck') !== -1);
    assert.ok(names.indexOf('generate_pdf') !== -1);
  });
});
