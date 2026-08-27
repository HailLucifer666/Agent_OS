'use strict';

// test/bug-382-dark-node-harness.test.js — BUG-382, Track D-5.
//
// Five capability-map nodes were `dark`: 22 registered tools with ZERO recorded
// calls between them. Dark is not broken, it is unmeasured, and the work order is
// explicit that these "need a harness not a fix".
//
// scripts/verify-dark-nodes.js is that harness. This file gates it, because a
// harness nobody runs is a harness that rots — and because this one was WRONG
// THREE TIMES before it was right, each time blaming the product for its own
// mistake:
//
//   1. read `.path` off a generator result when the field is `savedTo`
//      -> three generators reported FAIL while holding real artifacts on disk
//   2. returned an array of vectors from a single-in embed function
//   3. returned a bare array where { provider, dim, vec } was required
//      -> vector-index add() silently returned false and search() returned []
//         for every query INCLUDING "the", and two tools were written up as
//         product failures
//
// All three drifted in the fail-open direction: what the harness could not do
// correctly, it reported as the code being broken. So the assertions below are
// mostly about the HARNESS being trustworthy, not about the tools.
//
// Final measured run: 17 pass, 3 dispositions, 0 FAIL — and no product defect.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const harness = require('../scripts/verify-dark-nodes.js');

describe('BUG-382 — the harness oracles actually discriminate', () => {
  it('isPdf accepts a real PDF header and rejects everything else', () => {
    assert.equal(harness.isPdf(Buffer.from('%PDF-1.7\n...')), true);
    // The cases that matter: an HTML fallback and an empty file must NOT pass as
    // a PDF, because "generate_pdf returned ok" was never the question.
    assert.equal(harness.isPdf(Buffer.from('<!doctype html>')), false);
    assert.equal(harness.isPdf(Buffer.alloc(0)), false);
    assert.equal(harness.isPdf(Buffer.from('PDF-1.7')), false, 'the leading % is load-bearing');
  });

  it('isZip accepts the PK local-file header and rejects near-misses', () => {
    assert.equal(harness.isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
    assert.equal(harness.isZip(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false,
      'PK\\x05\\x06 is an EMPTY archive end-record, not a file entry');
    assert.equal(harness.isZip(Buffer.from('PK')), false, 'too short to decide');
    assert.equal(harness.isZip(Buffer.from('%PDF-')), false);
  });

  it('zipHasEntry finds a member name and does not hallucinate one', () => {
    const buf = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('xl/workbook.xml'),
      Buffer.from([0, 1, 2]),
    ]);
    assert.equal(harness.zipHasEntry(buf, 'xl/workbook.xml'), true);
    assert.equal(harness.zipHasEntry(buf, 'ppt/presentation.xml'), false);
  });

  it('the four verdicts are distinct, so a disposition can never read as a pass', () => {
    const v = [harness.PASS, harness.FAIL, harness.UNAVAILABLE, harness.DISPOSITION];
    assert.equal(new Set(v).size, 4);
    // FAIL is the only one that should be shouty, because it is the only one that
    // means something is wrong.
    assert.equal(harness.FAIL, harness.FAIL.toUpperCase());
    assert.notEqual(harness.DISPOSITION, harness.PASS,
      'a deliberately-not-run tool must never be countable as a pass');
  });
});

describe('BUG-382 — the harness covers every dark node', () => {
  it('has a group per dark node, and they are runnable functions', () => {
    // The five nodes: file ops, generators, documents, code search, MCP bridge.
    const expected = ['fileops', 'generators', 'documents', 'codesearch', 'mcp'];
    assert.deepEqual(Object.keys(harness.GROUPS).sort(), expected.slice().sort());
    for (const [name, fn] of Object.entries(harness.GROUPS)) {
      assert.equal(typeof fn, 'function', name + ' must be callable');
    }
  });

  it('the script names the oracle for every tool it claims to verify', () => {
    // The header is the contract a future reader relies on. If a tool is added
    // to a group without an oracle named, this is the reminder.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-dark-nodes.js'), 'utf8');
    for (const claim of ['%PDF-', 'xl/workbook.xml', 'ppt/presentation.xml', 'no-spend', 'BUG-368']) {
      assert.ok(src.includes(claim), 'the header must still document: ' + claim);
    }
    assert.match(src, /ORACLE, not a self-report/,
      'the standing rule must stay stated: a tool returning ok:true proves nothing');
  });
});

describe('BUG-382 — the fast groups really run, against a real sandbox', () => {
  // fileops + generators + mcp only. documents and codesearch are excluded on
  // purpose: index_project walks src/core and document_ingest chunks and embeds
  // six real files, which is right for a script and too slow for the suite. They
  // are covered by running the script — and the script is what CI-equivalent
  // verification uses. Stated rather than hidden.
  it('file ops verifies real files by reading the disk back', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'darknode-test-'));
    try {
      const rows = await harness.GROUPS.fileops(sandbox);
      assert.ok(rows.length >= 7, 'expected the 8 file-ops tools, got ' + rows.length);
      const failed = rows.filter((r) => r.verdict === harness.FAIL);
      assert.deepEqual(failed.map((r) => r.tool + ': ' + r.detail), [],
        'file ops is fully local and deterministic — a FAIL here is a real defect');
      // And the oracle is the filesystem, not the return value.
      const created = rows.find((r) => r.tool === 'create_folder');
      assert.match(created.detail, /on disk/,
        'the verdict must cite the disk, not the tool\'s own ok flag');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('generators are judged on magic bytes, and produce real artifacts here', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'darknode-gen-'));
    try {
      const rows = await harness.GROUPS.generators(sandbox);
      assert.ok(rows.length >= 3, 'expected the four generators, got ' + rows.length);
      const failed = rows.filter((r) => r.verdict === harness.FAIL);
      assert.deepEqual(failed.map((r) => r.tool + ': ' + r.detail), []);

      const sheet = rows.find((r) => r.tool === 'generate_spreadsheet');
      assert.equal(sheet.verdict, harness.PASS);
      assert.match(sheet.detail, /PK header \+ xl\/workbook\.xml/,
        'an xlsx must be proved a real ZIP with a workbook inside, not merely returned');

      // generate_image must be a disposition, never a pass — there is no free
      // keyed image lane under the no-spend decision.
      const img = rows.find((r) => r.tool === 'generate_image');
      assert.equal(img.verdict, harness.DISPOSITION);
      assert.match(img.detail, /no-spend/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the MCP bridge refusal is recorded as posture, not as a gap', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'darknode-mcp-'));
    try {
      const rows = await harness.GROUPS.mcp(sandbox);
      assert.ok(rows.length >= 2);
      assert.deepEqual(rows.filter((r) => r.verdict === harness.FAIL).map((r) => r.tool), []);

      const call = rows.find((r) => r.tool === 'mcp_call_tool');
      assert.equal(call.verdict, harness.DISPOSITION);
      assert.match(call.detail, /CORRECT SECURITY POSTURE/,
        'the T3/goalId refusal is the leash working — a harness that manufactured '
        + 'a goal to get past it would be measuring the wrong thing');

      // An unknown server must be REFUSED with a reason, not answered emptily.
      const list = rows.find((r) => r.tool === 'mcp_list_tools');
      assert.equal(list.verdict, harness.PASS);
      assert.match(list.detail, /refused with a reason/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('BUG-382 — the harness can actually report a failure', () => {
  it('a FAIL verdict is recorded and is distinguishable from a disposition', () => {
    // A harness whose FAIL path has never fired is a harness nobody should
    // trust. This drives the recorder directly: the alternative is breaking a
    // real tool to watch it go red, which would be a mutation on product code
    // to test a script.
    harness._results.length = 0;
    harness._record('probe', 'a_tool', harness.FAIL, 'the oracle says it lied');
    harness._record('probe', 'b_tool', harness.DISPOSITION, 'deliberately not run');
    harness._record('probe', 'c_tool', harness.PASS, 'disk read-back confirmed');

    const rows = harness._results.filter((r) => r.group === 'probe');
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.verdict === harness.FAIL).length, 1);
    assert.equal(rows.filter((r) => r.verdict === harness.PASS).length, 1);
    assert.equal(rows.filter((r) => r.verdict === harness.DISPOSITION).length, 1);
    harness._results.length = 0;
  });
});
