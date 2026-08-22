'use strict';

// test/whatsapp-fuzzy-contact.test.js — 2026-08-21 capability audit.
//
// THE INCIDENT, measured from %APPDATA%\MYTHOS\vault\Audit\*.jsonl:
// whatsapp_send is 16 ok / 24 fail all-time. Four of the 24 are recipient
// resolution, and two of those are one shape — STT spelling drift on a saved
// contact:
//   to:"Mousumi"       -> saved contact "Moushumi"      (edit distance 1)
//   to:"Mousumi Paul"  -> saved contact "Mausumi Paul"  (edit distance 1)
// Both were refused with "is not in my contact list", and the refusal then
// read the correct name aloud in its "Known contacts:" list. The operator had
// already recorded the problem as a fact in the vault: the contact "Mausumi
// Paul" is "the same person the operator may refer to as Mousumi, Mousumi, or
// Mousami. Any variation in pronunciation like that means output to 'Mausumi
// Paul'." So the system knew, and still refused.
//
// SCOPE, stated honestly rather than oversold: this fixes 2 of 24 failures.
// The larger clusters are elsewhere and are NOT touched here —
//   7  typed but could not submit ("the message box is empty")
//   5  REFUSED: WhatsApp is showing a different conversation
//   3  typed into the wrong window (the caret/foreground class)
//   3  could not identify its window   <- addressed separately
//   2  could not read the message box
// Naming them here so the next reader does not mistake a recipient fix for a
// whatsapp_send fix.
//
// WHY A FUZZY RUNG IS SAFE HERE, WHEN IT WAS NOT SAFE FOR forget_fact.
// The same audit rejected lowering semantic.forget()'s recall floor, because
// forget() DELETES on a single fuzzy candidate with no confirmation. This rung
// is the opposite on every axis that matters:
//   - it runs only when exact, prefix-strip and substring all found nothing,
//     so it can never override a stronger match;
//   - a tie at the same distance ASKS instead of picking;
//   - the substitution is never silent — fuzzyNote is threaded into the spoken
//     result, so the operator hears which contact was chosen;
//   - whatsapp_send is T3, so the leash still confirm-gates the send.
// Messaging the wrong human is not recoverable, which is why the distance cap
// is tight and the tie rule refuses rather than guesses.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { levenshtein } = require('../src/core/lib/levenshtein');

// The real saved contacts at the time of the audit, copied from
// vault/Contacts/contacts.json. Built from the file the effector actually
// reads rather than hand-written booleans — a fixture more generous than the
// wire is how a gate passes in test and refuses in production.
// Note "Moushumi" and "Mausumi Paul" share a number: they are duplicate
// entries for one person, which is exactly why a tie between them must not
// silently pick one.
const CONTACTS = {
  alex: '+919903382050',
  Moushumi: '+6361119795',
  mom: '+9163269846',
  dad: '+8017473687',
  'Mausumi Paul': '+6361119795',
};

// resolveRecipient reads contacts through the injected vault fs (ctx.memory.fs),
// not through the environment — so this wires it exactly the way src/main.js
// does, via registerFromWhatsapp. A fixture that reached around that seam
// would be testing a path production never takes.
const { registerFromWhatsapp, _internal } = require('../src/core/effectors/from-whatsapp');
const { resolveRecipient } = _internal;

before(() => {
  registerFromWhatsapp({ register() {} }, {
    memory: {
      fs: {
        readJSONStrict(p, fallback) {
          return p === _internal.CONTACTS_PATH ? CONTACTS : fallback;
        },
      },
    },
  });
});

after(() => {
  // Leave no injected vault behind for other in-process tests.
  registerFromWhatsapp({ register() {} }, {});
});

describe('levenshtein is shared, not duplicated', () => {
  it('computes the distances this fix depends on', () => {
    assert.equal(levenshtein('mousumi', 'moushumi'), 1);
    assert.equal(levenshtein('mousumi paul', 'mausumi paul'), 1);
    assert.equal(levenshtein('mom', 'dad'), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('voice-agent.js uses the shared module rather than keeping its own copy', () => {
    // The whole point of extracting it. Two copies drift, and one of the two
    // callers decides which human receives a message.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8'
    );
    assert.match(src, /require\(['"][./]*lib\/levenshtein['"]\)/,
      'voice-agent.js should require the shared levenshtein module');
    assert.ok(!/^function levenshtein\s*\(/m.test(src),
      'voice-agent.js still defines its own levenshtein — delete it, the module is the source of truth');
  });
});

describe('whatsapp recipient resolution — fuzzy rung (2026-08-21 audit)', () => {
  it('the fixture loaded (negative control)', () => {
    // Without this, every refusal assertion below could pass because the
    // contact file was never read at all.
    const hit = resolveRecipient('alex');
    assert.equal(hit.error, undefined, 'exact lookup must work or the fixture is not wired: ' + hit.error);
    assert.equal(hit.number, '+919903382050');
  });

  it('"Mousumi" resolves to the saved contact "Moushumi"', () => {
    const r = resolveRecipient('Mousumi');
    assert.equal(r.error, undefined, 'should no longer refuse: ' + r.error);
    assert.equal(r.name, 'Moushumi');
    assert.equal(r.number, '+6361119795');
  });

  it('"Mousumi Paul" resolves to the saved contact "Mausumi Paul"', () => {
    const r = resolveRecipient('Mousumi Paul');
    assert.equal(r.error, undefined, 'should no longer refuse: ' + r.error);
    assert.equal(r.name, 'Mausumi Paul');
    assert.equal(r.number, '+6361119795');
  });

  it('a fuzzy resolution is never silent — it reports what it matched', () => {
    const r = resolveRecipient('Mousumi Paul');
    assert.ok(r.fuzzyNote, 'a fuzzy hit must carry a note so the send can say so out loud');
    assert.match(r.fuzzyNote, /Mausumi Paul/, 'the note must name the contact actually chosen');
    assert.match(r.fuzzyNote, /Mousumi Paul/, 'the note must name what was asked for');
  });

  it('an EXACT match never carries a fuzzy note and is never overridden', () => {
    // Assert the mechanism, not just the answer: an exact hit must not have
    // gone anywhere near the fuzzy rung.
    const r = resolveRecipient('Moushumi');
    assert.equal(r.name, 'Moushumi');
    assert.equal(r.fuzzyNote, undefined, 'exact matches must not be reported as fuzzy');
  });

  it('a name close to TWO contacts asks instead of picking', () => {
    // "Mausumi" sits 1 edit from "Moushumi"... and is a prefix of
    // "Mausumi Paul". Whatever the ladder does, it must never silently choose
    // between two different saved entries.
    const r = resolveRecipient('Mausumi');
    if (r.error) {
      assert.match(r.error, /more than one|Which one/i,
        'an ambiguous contact must produce a which-one question, got: ' + r.error);
    } else {
      // A single confident winner is acceptable ONLY if it is reported.
      assert.ok(r.fuzzyNote || r.name === 'Mausumi Paul',
        'an unreported silent pick between two contacts is the unrecoverable case');
    }
  });

  it('genuine nonsense is still refused, and still lists the known contacts', () => {
    const r = resolveRecipient('Zebediah Thornbury');
    assert.ok(r.error, 'must refuse a name that matches nobody');
    assert.match(r.error, /not in my contact list/);
    assert.match(r.error, /alex/, 'the refusal must still name the known contacts');
  });

  it('"dad" and "mom" are 3 edits apart and never resolve to each other', () => {
    // The nightmare case: a tight cap is the only thing standing between a
    // short nickname and the wrong parent.
    const r = resolveRecipient('dad');
    assert.equal(r.number, '+8017473687');
    const r2 = resolveRecipient('mom');
    assert.equal(r2.number, '+9163269846');
  });

  it('a phone number still resolves as a number, not a fuzzy name', () => {
    const r = resolveRecipient('+919903382050');
    assert.equal(r.error, undefined);
    assert.equal(r.number, '+919903382050');
    assert.equal(r.fuzzyNote, undefined);
  });
});

// ---------------------------------------------------------------------------
// The three branch guards above turned out to be VACUOUS: mutating the code to
// (a) run the fuzzy rung unconditionally, (b) drop the tie-refusal and (c)
// loosen the short-name cap all left the suite green, because the real contact
// list happens not to exercise any of those branches. A guard that cannot fail
// reads as coverage while testing nothing, so each branch gets a contact set
// built specifically to reach it.
describe('fuzzy rung branch guards (contact sets chosen to reach each branch)', () => {
  function withContacts(contacts, fn) {
    registerFromWhatsapp({ register() {} }, {
      memory: { fs: { readJSONStrict: (p, fb) => (p === _internal.CONTACTS_PATH ? contacts : fb) } },
    });
    try { return fn(); } finally {
      registerFromWhatsapp({ register() {} }, {
        memory: { fs: { readJSONStrict: (p, fb) => (p === _internal.CONTACTS_PATH ? CONTACTS : fb) } },
      });
    }
  }

  it('an exact match is never overridden by a nearer-looking neighbour', () => {
    // "alex" is exact; "alexa" is 1 edit away. If the fuzzy rung ever ran
    // before/regardless of the exact hit, this would resolve to "alexa" — a
    // different human. This is the case the earlier exact-match test could not
    // reach, because the real contact list has no near-neighbour pair.
    withContacts({ alex: '+919903382001', alexa: '+919903382002' }, () => {
      const r = resolveRecipient('alex');
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.name, 'alex', 'exact match must win over the 1-edit neighbour');
      assert.equal(r.number, '+919903382001');
      assert.equal(r.fuzzyNote, undefined, 'an exact hit must not be reported as fuzzy');
    });
  });

  it('two contacts at the SAME distance ask instead of picking one', () => {
    // "ron" and "jon" are both exactly 1 edit from "ton", and neither is a
    // substring of it. Silently choosing either is the unrecoverable case.
    withContacts({ ron: '+919903382001', jon: '+919903382002' }, () => {
      const r = resolveRecipient('ton');
      assert.ok(r.error, 'a tie must not resolve to a recipient');
      assert.match(r.error, /close to more than one contact|Which one/i,
        'the tie must produce a which-one question, got: ' + r.error);
      assert.match(r.error, /ron/);
      assert.match(r.error, /jon/);
    });
  });

  it('a short name is not reachable at 2 edits — the mom/dad guard', () => {
    // "bab" is 2 edits from "dad" and 3 from "mom". Under the general cap of
    // max(2, 20%) it would resolve to "dad" as a lone candidate; the <=4-char
    // rule holds it to 1 edit, so it refuses. There is no undo on a message
    // sent to the wrong parent.
    withContacts({ mom: '+919903382001', dad: '+919903382002' }, () => {
      const r = resolveRecipient('bab');
      assert.ok(r.error, 'a 2-edit miss on a 3-letter name must refuse, got: ' + JSON.stringify(r));
      assert.match(r.error, /not in my contact list/);
    });
  });
});
