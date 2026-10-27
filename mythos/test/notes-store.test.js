'use strict';

// notes-store.test.js — memory/notes.js + the note_take/note_read/note_search
// effectors (2026-08-14 JARVIS upgrade, Track 2).
//
// What this file is actually guarding, beyond "the tools work":
//
//   1. THE FILE ON DISK IS THE STORE. The whole premise is that the operator can
//      open the directory in Obsidian after uninstalling MYTHOS, so the tests
//      assert real bytes at a real path, not a returned object.
//   2. TITLES BECOME FILENAMES. A note title is user text (dictated, so
//      arbitrary) reaching the filesystem. Traversal is tested directly rather
//      than trusted to the slugifier's regex.
//   3. THE EVIDENCE CONTRACT. Every result carries an oracle-backed `evidence`
//      string. A tool returning bare ok:true is exactly how a UI-type action
//      once got audited as delivered while the target app never received the
//      text — so "has evidence" is asserted per tool, not assumed.
//   4. AN EMPTY RESULT IS AN ANSWER. note_search over notes that don't match
//      must say so in words a spoken reply cannot round off into "I found your
//      note" (the BUG-172 shape).
//
// Paths come from os.tmpdir() — never a literal, per AD-7. A drive-rooted
// multi-segment literal anywhere in a tracked file (including a comment in a
// test fixture) fails that gate, and it only fails once the file is staged,
// because the gate reads git ls-files.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createNotesStore, slugifyTitle } = require('../src/core/memory/notes');
const { buildTools } = require('../src/core/effectors/from-memory');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

let dir;
let notes;
let tools;

function tool(name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, 'tool ' + name + ' must be registered by from-memory buildTools');
  return t;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-notes-'));
  notes = createNotesStore({ dir });
  tools = buildTools({ notes: notes });
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

describe('memory/notes.js — the file on disk is the store', () => {
  it('writes a real .md file with Obsidian frontmatter and keeps wikilinks verbatim', () => {
    const res = notes.write({ title: 'Project Aurora', text: 'Blocked on [[Vault Migration]] #infra' });
    assert.equal(res.created, true);
    assert.equal(res.slug, 'Project-Aurora');
    const onDisk = fs.readFileSync(path.join(dir, 'Project-Aurora.md'), 'utf8');
    assert.match(onDisk, /^---\n/, 'must open with YAML frontmatter Obsidian can read');
    assert.match(onDisk, /^created: \d{4}-\d{2}-\d{2}T/m);
    assert.match(onDisk, /^source: mythos$/m);
    assert.match(onDisk, /# Project Aurora/);
    assert.match(onDisk, /\[\[Vault Migration\]\] #infra/,
      'wikilinks and tags must survive byte-for-byte — that is the Obsidian contract');
    assert.equal(res.bytes, fs.statSync(res.path).size, 'reported bytes must be the real on-disk size');
  });

  it('appends under a timestamp by default and never loses the earlier body', () => {
    notes.write({ title: 'Standup', text: 'Monday: shipped the loader fix.' });
    notes.write({ title: 'Standup', text: 'Tuesday: vendored the skills.' });
    const onDisk = fs.readFileSync(path.join(dir, 'Standup.md'), 'utf8');
    assert.match(onDisk, /Monday: shipped the loader fix\./);
    assert.match(onDisk, /Tuesday: vendored the skills\./);
    assert.equal(onDisk.match(/^---$/gm).length >= 3, true, 'append adds a separator, keeping both entries readable');
  });

  it('replace mode overwrites the body but preserves the operator-visible frontmatter', () => {
    const first = notes.write({ title: 'Scratch', text: 'old text', tags: ['draft'] });
    const created = fs.readFileSync(first.path, 'utf8').match(/^created: (.+)$/m)[1];
    notes.write({ title: 'Scratch', text: 'new text', mode: 'replace' });
    const onDisk = fs.readFileSync(first.path, 'utf8');
    assert.match(onDisk, /new text/);
    assert.doesNotMatch(onDisk, /old text/);
    assert.match(onDisk, new RegExp('^created: ' + created.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'),
      'the original created stamp must survive a replace');
    assert.match(onDisk, /- draft/, 'tags written at create time must survive a replace');
  });

  it('read returns null for a note that does not exist, rather than an empty note', () => {
    assert.equal(notes.read('nothing here'), null);
  });

  it('search finds a phrase in the body and reports the matching line', () => {
    notes.write({ title: 'Wiring', text: 'the leash reads TIER_TABLE at call time' });
    notes.write({ title: 'Groceries', text: 'oat milk' });
    const res = notes.search('tier_table');
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].slug, 'Wiring');
    assert.match(res.matches[0].line, /TIER_TABLE/, 'the quotable line must come back, not just a filename');
    assert.equal(res.scanned, 2);
  });
});

describe('memory/notes.js — a title is user text reaching the filesystem', () => {
  it('slugify strips separators and dot-runs so traversal cannot survive', () => {
    assert.equal(slugifyTitle('../../etc/passwd'), 'etcpasswd');
    assert.equal(slugifyTitle('..'), '');
    assert.equal(slugifyTitle('a/b\\c'), 'abc');
    assert.equal(slugifyTitle('  spaced  out  '), 'spaced-out');
  });

  it('a traversal-shaped title writes INSIDE the notes directory or not at all', () => {
    const res = notes.write({ title: '../escaped', text: 'nope' });
    assert.equal(path.dirname(res.path), dir, 'the file must land in the notes dir, never above it');
    const outside = path.resolve(dir, '..', 'escaped.md');
    assert.equal(fs.existsSync(outside), false, 'nothing may be created outside the notes dir');
  });

  it('a title with no usable characters is refused, not silently renamed', () => {
    assert.throws(() => notes.write({ title: '///', text: 'body' }), /no usable characters/);
  });

  // Windows device names (2026-09-29 audit, follow-up to B2b). note_take is
  // tier 1, so a dictated title of "CON" wrote CON.md with no confirmation.
  // Windows 11 25H2 treats that as an ordinary file; Windows 10 and older
  // reserve it (Microsoft's naming documentation), and a vault moves between
  // machines. A title is not a filename, so the slug is suffixed, never refused.
  //
  // The expected listings are written out by hand rather than computed with
  // okf.js's isWindowsDeviceName: a test that asked the helper whether the disk
  // is clean would pass vacuously if the helper broke.
  //
  // Before the fix, (a) and (c) failed with CON.md, nul.md, Com1.md, aux.md,
  // con.txt.md and LPT9.md on disk; (b) passed before and after.
  // Mutation probes, 2026-09-30: six, each applied to the file, confirmed on
  // disk, run against this file, then restored from a byte copy and checked by
  // sha256. All killed:
  //   1. slugifyTitle returns the slug with no device check         -> (a) (c)
  //   2. every slug gets the "-note" suffix                          -> (b)
  //   3. okf.js WINDOWS_DEVICE_NAME loses its `i` flag               -> (a) (c)
  //   4. okf.js WINDOWS_DEVICE_NAME loses its `(\..*)?` group        -> (a) (c)
  //   5. read() strips the suffix before looking the note up         -> (c)
  //   6. the check reads the raw title instead of the slug           -> (a) (b)
  //      ("prn?" slips past as typed; "COM¹" is caught as typed although its
  //      slug "COM" is not a device, so the guard over-matches too)
  it('(a) a device-named title never produces a device-named file on disk', () => {
    // "prn?" is not a device name as typed; its slug "prn" is. It pins the check
    // to the SLUG, which is what reaches the disk, not to the raw title.
    for (const title of ['CON', 'nul', 'Com1', 'aux', 'con.txt', 'LPT9', 'prn?']) {
      notes.write({ title: title, text: 'body of ' + title });
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      'Com1-note.md', 'LPT9-note.md', 'aux-note.md', 'con.txt-note.md', 'CON-note.md', 'nul-note.md',
      'prn-note.md',
    ].sort());
  });

  it('(b) names that only resemble a device name keep their plain filename', () => {
    // console/com10/nullable/auxiliary share a prefix with a device name; "COM¹"
    // loses its superscript to the slug allowlist and becomes plain "COM", which
    // is not a device either. Any of these renamed is the guard over-matching.
    const titles = ['console', 'com10', 'nullable', 'auxiliary', 'Con Edison', 'COM¹', 'lpt'];
    for (const title of titles) notes.write({ title: title, text: 'x' });
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      'COM.md', 'Con-Edison.md', 'auxiliary.md', 'com10.md', 'console.md', 'lpt.md', 'nullable.md',
    ].sort());
  });

  it('(c) note_take and note_read agree on the suffixed name, so the note reads back by its title', async () => {
    const took = await tool('note_take').fn({ title: 'CON', text: 'dictated body' });
    assert.equal(took.ok, true);
    assert.deepEqual(fs.readdirSync(dir), ['CON-note.md'],
      'the tier-1 tool is the surface the audit named; its file must be the suffixed one');
    const back = await tool('note_read').fn({ title: 'CON' });
    assert.equal(back.ok, true, 'reading by the title the operator used must find the note');
    assert.match(back.result.content, /dictated body/);
    assert.match(back.result.content, /^# CON$/m, 'the heading keeps the title as written');
    // note_read with no title lists "CON-note" (listings come from filenames),
    // so reading by the LISTED name has to reach the same file.
    const listed = await tool('note_read').fn({});
    assert.deepEqual(listed.result.notes, ['CON-note']);
    const byListedName = await tool('note_read').fn({ title: 'CON-note' });
    assert.equal(byListedName.ok, true);
    assert.match(byListedName.result.content, /dictated body/);
  });
});

describe('note_take / note_read / note_search effectors', () => {
  it('note_take writes the file and returns oracle-backed evidence', async () => {
    const out = await tool('note_take').fn({ title: 'Voice Test', text: 'spoken body' });
    assert.equal(out.ok, true);
    const full = path.join(dir, 'Voice-Test.md');
    assert.equal(fs.existsSync(full), true);
    assert.match(out.result.evidence, /created /);
    assert.match(out.result.evidence, /bytes on disk/);
    assert.equal(out.result.bytes, fs.statSync(full).size,
      'evidence must be measured from disk, not from what the tool intended to write');
  });

  it('note_read with no title lists the notes; with an unknown title it fails by name', async () => {
    const empty = await tool('note_read').fn({});
    assert.equal(empty.ok, true);
    assert.equal(empty.result.count, 0);
    assert.match(empty.result.note, /NO NOTES EXIST YET/, 'an empty store must be stated, not implied');

    await tool('note_take').fn({ title: 'Kept', text: 'x' });
    const listed = await tool('note_read').fn({});
    assert.deepEqual(listed.result.notes, ['Kept']);

    const missing = await tool('note_read').fn({ title: 'Absent' });
    assert.equal(missing.ok, false);
    assert.match(missing.result.error, /No note called "Absent"/);
    assert.match(missing.result.error, /Kept/, 'the failure names what DOES exist so the model can correct itself');
  });

  it('note_read returns the real file content', async () => {
    await tool('note_take').fn({ title: 'Readable', text: 'the body [[linked]]' });
    const out = await tool('note_read').fn({ title: 'Readable' });
    assert.equal(out.ok, true);
    assert.match(out.result.content, /the body \[\[linked\]\]/);
    assert.match(out.result.evidence, /Readable\.md \(\d+ bytes\)/);
  });

  it('note_search says nothing matched in words a reply cannot round off (BUG-172 shape)', async () => {
    await tool('note_take').fn({ title: 'Only', text: 'unrelated content' });
    const out = await tool('note_search').fn({ query: 'quantum' });
    assert.equal(out.ok, true);
    assert.equal(out.result.count, 0);
    assert.match(out.result.note, /NO NOTE MATCHES/);
    assert.match(out.result.note, /do not invent a note/);
    assert.match(out.result.evidence, /0 matches/);
  });

  it('note_search returns quotable matches with evidence', async () => {
    await tool('note_take').fn({ title: 'Findable', text: 'the refine loop is bounded at two iterations' });
    const out = await tool('note_search').fn({ query: 'refine loop' });
    assert.equal(out.result.count, 1);
    assert.equal(out.result.matches[0].note, 'Findable');
    assert.match(out.result.matches[0].line, /bounded at two iterations/);
    assert.match(out.result.evidence, /1 match/);
  });

  it('every note tool degrades honestly when the store is absent — never a fake ok', async () => {
    const bare = buildTools({});
    for (const name of ['note_take', 'note_read', 'note_search']) {
      const t = bare.find((x) => x.name === name);
      const out = await t.fn({ title: 'x', text: 'y', query: 'z' });
      assert.equal(out.ok, false, name + ' must fail, not pretend');
      assert.match(out.result.error, /notes store unavailable/);
    }
  });

  it('all three tools carry evidence on the success path (evidence contract)', async () => {
    const takeOut = await tool('note_take').fn({ title: 'Evidence', text: 'body' });
    const readOut = await tool('note_read').fn({ title: 'Evidence' });
    const searchOut = await tool('note_search').fn({ query: 'body' });
    for (const [name, out] of [['note_take', takeOut], ['note_read', readOut], ['note_search', searchOut]]) {
      assert.equal(out.ok, true, name);
      assert.ok(out.result.evidence && out.result.evidence.length > 10,
        name + ' must return an oracle-backed evidence string, never a bare ok:true');
    }
  });
});

describe('notes tools are wired into the policy surfaces', () => {
  it('are tiered explicitly — reads T0, the write T1 (never the unknown-tool T3 fail-safe)', () => {
    assert.equal(TIER_TABLE.note_read, 0);
    assert.equal(TIER_TABLE.note_search, 0);
    assert.equal(TIER_TABLE.note_take, 1);
  });

  it('reach the Live voice surface as a complete act+read set', () => {
    // The recorded lesson this pins: a withheld read tool next to an act tool
    // makes the model substitute the nearest reachable tool and narrate the
    // result. note_take without note_read/note_search would send "what's in my
    // note" to recall_memory — MYTHOS's own facts — reported as the operator's.
    for (const name of ['note_take', 'note_read', 'note_search']) {
      assert.ok(DEFAULT_ALLOWLIST.includes(name), name + ' must be on the Live tool allowlist');
    }
  });
});
