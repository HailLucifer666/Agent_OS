'use strict';

// test/bug-320-321-wiki-links-and-stale-hints.test.js — two small defects from
// the 2026-08-22 session audit. Both are the same shape: the tool told the
// operator something that was not true about its own input or its own state.
//
// BUG-320. note_read was called three times with wiki-link brackets still on
// the title — note_read({title:"[[ai-news-digest-v2]]"}) and
// note_read({title:"[[AI News Landing Page Plan]]"}). The brackets are never
// stripped, so the lookup could not match, the error listed the real notes
// beside a bracketed name, the healer recorded the same lesson twice, and the
// pattern recurred in the next session. There IS a note called
// "Failed-Builds-AI-News-Digest-Landing-Page"; nothing was broken except the
// argument.
//
// BUG-321. The build-engine failure message ends with "Install it with `node
// mythos/scripts/setup-dsh.js --install`" while the SAME audit line reports
// online:true, evidence:"version-printed-and-matched-pin". A load-time crash in
// an engine that is installed and version-matched was telling the operator to
// reinstall it. Measured from Audit/2026-08-22.jsonl.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildTools } = require('../src/core/effectors/from-memory');

function toolsWith(notes) {
  const list = buildTools({ notes });
  const byName = {};
  for (const t of list) byName[t.name] = t;
  return byName;
}

// A notes store holding exactly one note, so a resolved title is unambiguous.
function fakeNotes() {
  const asked = [];
  return {
    asked,
    notesDir: () => 'vault/Notes', // relative on purpose — AD-7 forbids absolute paths in tracked source
    list: () => ({ notes: [{ slug: 'Failed-Builds-AI-News-Digest-Landing-Page' }], truncated: false }),
    read: (title) => {
      asked.push(title);
      if (title === 'Failed-Builds-AI-News-Digest-Landing-Page' || title === 'ai-news-digest-v2') {
        return { title: title, slug: title, bytes: 12, content: 'body', path: 'p/' + title + '.md' };
      }
      return null;
    },
  };
}

describe('BUG-320 — note_read must not be defeated by wiki-link brackets', () => {
  test('[[Title]] resolves the note Title', async () => {
    const notes = fakeNotes();
    const res = await toolsWith(notes).note_read.fn({ title: '[[ai-news-digest-v2]]' });
    assert.strictEqual(res.ok, true,
      'the brackets were passed straight through to the store: ' + JSON.stringify(notes.asked));
    assert.ok(notes.asked.indexOf('ai-news-digest-v2') !== -1,
      'the store should have been asked for the unbracketed title, got ' + JSON.stringify(notes.asked));
  });

  test('a bracketed title with spaces resolves too', async () => {
    const notes = fakeNotes();
    await toolsWith(notes).note_read.fn({ title: '[[Failed-Builds-AI-News-Digest-Landing-Page]]' });
    assert.ok(notes.asked.indexOf('Failed-Builds-AI-News-Digest-Landing-Page') !== -1,
      'got ' + JSON.stringify(notes.asked));
  });

  test('a genuinely missing note still fails, and the error names it unbracketed', async () => {
    const notes = fakeNotes();
    const res = await toolsWith(notes).note_read.fn({ title: '[[Does Not Exist]]' });
    assert.strictEqual(res.ok, false);
    assert.ok(res.result.error.indexOf('[[') === -1,
      'the error should quote the resolved title, not the raw brackets: ' + res.result.error);
    assert.match(res.result.error, /Does Not Exist/);
  });

  test('an unbracketed title is unaffected', async () => {
    const notes = fakeNotes();
    const res = await toolsWith(notes).note_read.fn({ title: 'ai-news-digest-v2' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(notes.asked, ['ai-news-digest-v2']);
  });

  test('brackets alone are treated as no title, not as a name', async () => {
    // "[[]]" must fall into the list-my-notes branch rather than searching for
    // an empty string, which would be a confusing failure.
    const notes = fakeNotes();
    const res = await toolsWith(notes).note_read.fn({ title: '[[]]' });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.result.notes), 'expected the note listing branch');
  });
});

describe('BUG-321 — do not tell the operator to reinstall an engine that is installed', () => {
  const { createBuildEngine } = require('../src/core/effectors/build-engine');
  const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
  const { createFsStore } = require('../src/core/memory/fs-store');

  // The real generate() path, not a helper — the defect was in the message that
  // path produces, and the audit line that proves it came from a live build.
  function engineWith(state) {
    return {
      runTask: async () => {
        throw new Error('dsh produced no terminal turn within 600000ms and was killed. '
          + 'Partial stdout: (none) | stderr: App threw an error during load');
      },
      getStatus: () => ({
        state: state,
        version: '0.1.1-rc.2',
        pinnedVersion: '0.1.1-rc.2',
        evidence: state === 'ONLINE' ? 'version-printed-and-matched-pin' : null,
      }),
    };
  }

  async function errorFor(state) {
    const dir = tempVaultDir();
    try {
      const be = createBuildEngine({
        engine: engineWith(state),
        vault: createFsStore(() => dir, null),
        bus: fakeBus(),
      });
      const res = await be.generate({ prompt: 'build a page', source: 'test' });
      return String(res.error || '');
    } finally { cleanupVaultDir(dir); }
  }

  test('a load-time crash on a version-matched engine gets no install instruction', async () => {
    const err = await errorFor('ONLINE');
    assert.ok(err.indexOf('--install') === -1,
      'the engine is present and pinned; an --install hint is misdirection: ' + err);
    assert.match(err, /task failure, not a missing install/i,
      'and it should say what the operator is actually looking at');
  });

  test('the real failure text is still carried through', async () => {
    const err = await errorFor('ONLINE');
    assert.match(err, /no terminal turn within 600000ms/,
      'suppressing the hint must not suppress the diagnosis');
  });

  test('a genuinely absent engine still gets the install instruction', async () => {
    const err = await errorFor('OFFLINE');
    assert.match(err, /setup-dsh\.js --install/);
  });

  test('an unknown state errs toward telling the operator how to install', async () => {
    const err = await errorFor(undefined);
    assert.match(err, /setup-dsh\.js --install/);
  });
});
