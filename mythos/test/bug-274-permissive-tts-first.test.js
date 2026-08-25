'use strict';

// bug-274-permissive-tts-first.test.js — BUG-274 T1 + T2.
//
// THE LICENCE FACTS, verified against the GitHub API on 2026-08-19, not against
// articles or against this repo's own older comments:
//
//   rhasspy/piper        11,279 stars   MIT     ARCHIVED 2025-08-26
//   OHF-Voice/piper1-gpl  5,172 stars   GPL-3.0 actively maintained
//   hexgrad/kokoro        8,466 stars   Apache-2.0 — code AND weights
//   edge-tts (upstream)   LGPLv3, labelled personal/hobby use
//
// So the default TTS chain reached for two engines with copyleft or
// personal-use exposure before it reached the one that is Apache-2.0 end to
// end — and `providers/kokoro-tts.js` has existed the whole time, with
// `kokoro-js` already a runtime dependency and the Apache-2.0 weights already
// recorded in THIRD_PARTY_NOTICES.md. The fix costs nothing to install.
//
// WHAT THIS TEST PINS, and what it deliberately does not:
//
// Q5 — IS THE CHANGE THE RIGHT SIZE? This is a REORDER, not a removal. edge and
// piper stay in the chain: the operator keeps them as BYO fallbacks, the
// rollback is one config line, and a machine with no Kokoro weights cached must
// still be able to speak. Deleting them would trade a licence problem for a
// mute assistant on first boot, which is a worse failure.
//
// Q3 — WHO READS THIS? `deriveVoiceDefaults()` only fires when the operator has
// left VOICE_TTS_CHAIN completely alone. An explicit chain is a deliberate
// choice and still wins outright — that behaviour is pinned below so this fix
// cannot quietly start overriding operator config.
//
// Q7 — WHAT DID THE TICKET SAY? BUG-274 T2 asks for the stale licence claim in
// providers/piper-tts.js to be CORRECTED, not replaced with a new legal
// conclusion. CLAUDE.md is explicit that a licence verdict is a lawyer's call,
// so the guard below checks that the false claims are gone — it does not
// require any particular replacement verdict.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? A licence claim written in a comment
// that was true when written and silently stopped being true. Nothing rechecks
// those, which is why the last guard here is generic over the provider files
// rather than specific to Piper.
//
// Run: cd mythos && node --test test/bug-274-permissive-tts-first.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveVoiceDefaults } = require('../src/core/config/voice-defaults');

const ROOT = path.join(__dirname, '..');
const order = (chain) => String(chain).split(',').map((s) => s.trim());
const before = (chain, a, b) => order(chain).indexOf(a) < order(chain).indexOf(b);

describe('BUG-274 T1 — the permissively licensed engine is reached first', () => {
  it('kokoro comes before edge and piper when a Google key exists', () => {
    const chain = deriveVoiceDefaults({ GOOGLE_API_KEY: 'k' }).VOICE_TTS_CHAIN;
    assert.ok(before(chain, 'kokoro', 'edge'),
      'edge-tts is LGPLv3 and labelled personal/hobby; kokoro is Apache-2.0 end to end');
    assert.ok(before(chain, 'kokoro', 'piper'),
      'rhasspy/piper is archived and its only maintained fork is GPL-3.0');
  });

  it('kokoro comes first when there is no Google key at all', () => {
    const chain = deriveVoiceDefaults({}).VOICE_TTS_CHAIN;
    assert.equal(order(chain)[0], 'kokoro',
      'with no cloud voice available, the offline Apache-2.0 engine leads');
  });

  it('edge and piper are still in the chain — this is a reorder, not a removal', () => {
    // Q5. Kokoro downloads its weights from Hugging Face on first use, and
    // isAvailable() bounds that with a timeout. If the download has not happened
    // yet the chain MUST still reach an engine that can speak, or the fix turns a
    // licence problem into a mute assistant on first boot.
    for (const env of [{ GOOGLE_API_KEY: 'k' }, {}]) {
      const chain = order(deriveVoiceDefaults(env).VOICE_TTS_CHAIN);
      assert.ok(chain.includes('edge'), 'edge stays as a fallback');
      assert.ok(chain.includes('piper'), 'piper stays as a fallback');
      assert.ok(chain.length >= 3, 'the chain keeps real depth');
    }
  });

  it('gemini still leads when its key is present — voice identity is unchanged', () => {
    // voice-defaults.js documents why: providers/tts.js maps gemini-tts to
    // GEMINI_LIVE_VOICE, so the operator hears the SAME person as the duplex
    // path. Reordering the licence-risky engines must not change who MYTHOS
    // sounds like when the key is there.
    const chain = deriveVoiceDefaults({ GOOGLE_API_KEY: 'k' }).VOICE_TTS_CHAIN;
    assert.equal(order(chain)[0], 'gemini');
  });

  it("an explicit operator chain still wins outright", () => {
    // Q3: this module only speaks when the operator has said nothing.
    for (const env of [{ VOICE_TTS_CHAIN: 'edge' }, { VOICE_TTS_PROVIDER: 'piper' }]) {
      assert.deepEqual(deriveVoiceDefaults(env), {},
        'a configured chain is a deliberate choice and is never argued with');
    }
  });
});

describe('BUG-274 T2 — provider files do not assert licence facts that went stale', () => {
  // Comment text WRAPS across lines with a `//` prefix, so a regex run over raw
  // source silently fails to see a claim that is plainly there — the first draft of
  // this file passed for exactly that reason. Strip comment markers and collapse
  // whitespace first. A guard that cannot see the thing it guards against is the
  // "looks like coverage, does nothing" defect BUG-274 is named after.
  const flatten = (src) => src.replace(/^\s*\/\/ ?/gm, ' ').replace(/\s+/g, ' ');
  const PIPER = flatten(
    fs.readFileSync(path.join(ROOT, 'providers', 'piper-tts.js'), 'utf8'));

  it('piper-tts.js no longer claims Piper is MIT', () => {
    // rhasspy/piper (MIT) was ARCHIVED 2025-08-26; the only maintained fork,
    // OHF-Voice/piper1-gpl, is GPL-3.0. The file said "Piper is MIT".
    assert.doesNotMatch(PIPER, /Piper is MIT/i);
  });

  it('piper-tts.js no longer claims it is the only engine usable in a sold product', () => {
    // It said exactly that — and it is now the engine with the most copyleft
    // exposure of the four, while Kokoro sits Apache-2.0 in the same chain.
    assert.doesNotMatch(PIPER, /only one of the three usable in a product that is sold/i);
  });

  it('it records the archive and the GPL successor, so the next reader has the fact', () => {
    assert.match(PIPER, /archiv/i, 'the upstream being archived is the load-bearing fact');
    assert.match(PIPER, /GPL/, 'and that the maintained fork is GPL-licensed');
  });

  it('no provider file declares itself safe to sell — that is not ours to conclude', () => {
    // Q6/Q7. CLAUDE.md: "Do not write a confident legal conclusion into any
    // tracked file — that is a lawyer's call." Generic over every provider so the
    // next stale verdict is caught wherever it is written, not just in Piper.
    const dir = path.join(ROOT, 'providers');
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      if (/usable in a product that is sold|safe to sell|cleared for commercial/i.test(flatten(src))) {
        offenders.push(name);
      }
    }
    assert.deepEqual(offenders, [],
      'state the licence FACTS and point at the 6.5 gate; do not rule on them');
  });

  // 2026-08-20 — THE SWEEP ABOVE STOPS AT `providers/`, AND THAT IS HOW BOTH T1 AND T2
  // SURVIVED IN THE ONE FILE EVERY NEW INSTALL COPIES.
  //
  // `.env.example` is not documentation, it is the template a fresh clone starts from,
  // and root CLAUDE.md makes it the binding record of supported config for an
  // open-source user. It carried BOTH defects this ticket had already fixed elsewhere:
  // its worked example read `VOICE_TTS_CHAIN=gemini,edge,piper` (the exact chain T1
  // replaced — and an explicit override beats a derived default, so copying it reverts
  // T1 on the spot), and it repeated T2's corrected claim that piper is "MIT + open
  // voices. The shippable one."
  //
  // Same invariant broken twice, so this is the assertion rather than a third instance
  // fix: the guard now covers the template as well as the code. Q6, and the operator's
  // own .env was the untracked third copy — a config file a test cannot read, which is
  // why the tracked one has to be pinned here.
  describe('and the template a fresh clone copies says the same thing as the code', () => {
    const EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    // Q1 — WHAT ELSE MATCHES THIS? Both matchers here were wrong on their first draft,
    // in opposite directions, and the file caught them:
    //   - `([a-z,\s]+)` also matched the commented-out `# VOICE_TTS_CHAIN=` placeholder,
    //     because `\s` matches the CRLF line ending, so an EMPTY value parsed as a chain
    //     with no kokoro in it and failed. A worked example must start with a letter.
    //   - a bare doesNotMatch on the stale phrase fired on this suite's OWN historical
    //     note ("this line used to read ..."), i.e. on the correction rather than on the
    //     defect. Recording what a claim used to say is how the next reader knows why it
    //     changed; the test must catch the file ASSERTING it, not MENTIONING it.
    const lines = EXAMPLE.split(/\r?\n/);
    const exampleChains = lines
      .map((l) => (l.match(/^#?\s*VOICE_TTS_CHAIN=([a-z][a-z,]*)/) || [])[1])
      .filter(Boolean);
    // A line quoting the old wording must say so on the same line.
    const HISTORICAL = /used to read|corrected|no longer|used to say/i;
    const staleClaimLines = lines.filter(
      (l) => /MIT \+ open voices|The shippable one/i.test(l) && !HISTORICAL.test(l));

    it('does not hand a fresh clone the pre-T1 chain as its worked example', () => {
      assert.ok(exampleChains.length, 'the example must still show a chain, or there is nothing to check');
      for (const chain of exampleChains) {
        assert.ok(order(chain).includes('kokoro'),
          'this example is copied verbatim into a real .env and then beats the derived '
          + 'default — omitting kokoro here silently reverts T1 for every new install');
        assert.ok(before(chain, 'kokoro', 'edge') && before(chain, 'kokoro', 'piper'),
          'and it must show the same ORDER voice-defaults.js derives, not just the same members');
      }
    });

    it('does not repeat the stale Piper licence claim that T2 corrected in code', () => {
      assert.deepEqual(staleClaimLines, [],
        'a line stating this as current fact is the defect; quoting it as history is the fix');
      // And it carries the facts that replaced it, so the next reader is not left
      // with a gap where a wrong answer used to be.
      assert.match(EXAMPLE, /archiv/i, 'upstream rhasspy/piper being archived is the load-bearing fact');
      assert.match(EXAMPLE, /GPL/, 'and that the maintained fork is GPL-licensed');
    });

    it('does not declare anything safe to sell — the rule that applies to every tracked file', () => {
      assert.doesNotMatch(EXAMPLE, /usable in a product that is sold|safe to sell|cleared for commercial/i,
        'CLAUDE.md: a confident legal conclusion in a tracked file is a lawyer\'s call, not ours');
    });
  });
});
