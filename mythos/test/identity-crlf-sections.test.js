'use strict';

// identity-crlf-sections.test.js — BUG-254.
//
// self.md is operator-editable markdown. Edited on Windows — by Notepad, by an
// Obsidian vault synced from a Windows machine, by anything that writes CRLF —
// every `## Section` header ends `\r\n`, and extractSection()'s regex required a
// literal `\n` immediately after the header text. Every section then returned
// null and loadSelf() silently fell back to its defaults, so persona() composed
// "You are MYTHOS." while a full JARVIS character brief sat on disk being
// ignored. Measured on the operator's real vault before the fix: Purpose,
// Persona, Values and Origin all null against a CRLF self.md.
//
// The silence is the defect. A parse failure that returns a plausible default
// is indistinguishable from "the operator never wrote one", which is why this
// survived long enough for the operator to ask why the persona had no effect.
//
// topLearnedPrefs() carried the same `\n`-literal assumption and appeared to
// work only by accident: identity.learn() prepends a SECOND '## Learned
// Preferences' header using bare \n, so the regex skipped the operator's CRLF
// copy and matched the code-written one further down the file.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createIdentity } = require('../src/core/identity');

// Minimal identity store: the only surface extractSection()/topLearnedPrefs()
// touch is readRaw(). Everything else is stubbed to the shape createIdentity
// expects, so this exercises the real parsing code with no filesystem.
function identityWith(rawSelfMd) {
  const store = {
    readRaw: () => rawSelfMd,
    read: () => ({}),
    write: () => {},
    init: async () => {},
  };
  return createIdentity({
    identityStore: store,
    fs: {
      exists: () => false,
      readText: () => '',
      readJSON: (_p, fallback) => fallback,
      writeJSON: () => {},
      writeText: () => {},
      vaultPath: (...s) => s.join('/'),
      ensureDir: () => {},
    },
    config: { MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 },
    bus: { emit: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  });
}

const SELF_MD_BODY = [
  '# Self',
  '',
  '## Purpose',
  'To run the operator\'s machine and keep their attention for what matters.',
  '',
  '## Persona',
  'You are JARVIS — dryly witty, unfailingly polite, British-butler in spirit.',
  '',
  '## Values',
  'Candour over comfort. Precision over speed.',
  '',
  '## Origin',
  'Built by the operator, for the operator.',
  '',
  '## Learned Preferences',
  '- Prefers Brave over Chrome',
  '- Dislikes being asked to confirm twice',
  '',
];

const LF = SELF_MD_BODY.join('\n');
const CRLF = SELF_MD_BODY.join('\r\n');

// loadSelf() is internal; persona() is the composed public surface every
// caller (server's Live frame, brain's batch path) actually reads, so assert
// through it rather than reaching past the API.
async function personaFrom(rawSelfMd) {
  const identity = identityWith(rawSelfMd);
  await identity.init();
  return identity.persona();
}

describe('BUG-254: self.md sections parse under CRLF as well as LF', () => {
  test('LF self.md composes the operator brief (the pre-existing behaviour, unchanged)', async () => {
    const composed = await personaFrom(LF);
    assert.match(composed, /JARVIS/);
    assert.match(composed, /Candour over comfort/);
    assert.match(composed, /Built by the operator/);
  });

  test('CRLF self.md composes identically — this is what was broken', async () => {
    const composed = await personaFrom(CRLF);
    assert.match(composed, /JARVIS/,
      'a CRLF self.md must not silently fall back to the MYTHOS_NAME default');
    assert.match(composed, /Candour over comfort/);
    assert.match(composed, /Built by the operator/);
  });

  test('a CRLF body carries no stray CR into the composed persona', async () => {
    const composed = await personaFrom(CRLF);
    assert.equal(composed.includes('\r'), false, 'the composed persona must be clean text');
    assert.match(composed, /^You are JARVIS/,
      'the operator brief already starts "You are X" and must not be re-wrapped');
  });

  test('learned preferences parse under CRLF, without relying on a second LF-written header', async () => {
    const identity = identityWith(CRLF);
    await identity.init();
    const composed = identity.persona();
    assert.match(composed, /Prefers Brave over Chrome/,
      'learned preferences must survive CRLF rather than depending on a code-written duplicate header');
  });

  test('a genuinely absent section still falls back to its default', async () => {
    const composed = await personaFrom('# Self\r\n\r\n## Purpose\r\nOnly a purpose here.\r\n');
    assert.match(composed, /^You are MYTHOS\./, 'absent Persona still falls back to MYTHOS_NAME');
    assert.match(composed, /Helpfulness, honesty, efficiency/);
    assert.match(composed, /Not a corporate product/, 'BUG-163 origin default must survive');
  });
});
