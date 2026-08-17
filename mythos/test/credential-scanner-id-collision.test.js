'use strict';

// credential-scanner-id-collision.test.js
//
// The credential scanner is a PATTERN matched against attacker-and-operator
// controlled text, so rules/core.md §11.1 applies: the question is not "does it
// catch a key" but "what else does it catch by mistake". MYTHOS collides with
// its own id namespace — memory/skills.js mints procedural-skill ids as
// `'sk-' + crypto.randomUUID()`, which the first version of the `openai-key`
// pattern matched as an OpenAI secret.
//
// Both directions are pinned here, deliberately in one file, because a fix in
// either direction alone is the bug: narrowing the pattern until skill ids pass
// is worthless if it stops catching real keys, and catching real keys is
// worthless if every skill id is a false positive.
//
// The two consumers this protects, both traced before the fix:
//   * server/index.js's log redaction — a matched value renders [REDACTED], so
//     a false positive destroys the "which skill ran" trail in the HUD log.
//   * leash/index.js:320 — for tier >= 3, a match DENIES the action with reason
//     'credential-detected'. Not reachable via skill ids today (no effector
//     takes one as an input arg, and use_skill is T0), but T3 build tools carry
//     large free-text prompts, so a brief quoting an id would have been denied
//     with a misleading reason.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { scan, _PATTERNS } = require('../src/core/effectors/credential-scanner');

// Built the same way the real stores build them, not hand-typed — a literal
// would keep passing if the id format changed underneath this test.
const skillId = () => 'sk-' + crypto.randomUUID();
const lessonId = () => 'lsn-' + crypto.randomUUID();
const refinementId = () => 'ref-' + crypto.randomUUID();
const auditId = () => 'aud-' + crypto.randomBytes(6).toString('hex');

describe('credential scanner vs MYTHOS internal ids (false positives)', () => {
  test('a procedural-skill id is not a credential', () => {
    for (let i = 0; i < 50; i++) {
      const id = skillId();
      const result = scan({ note: id });
      assert.equal(result.found, false,
        'skill id must not scan as a credential: ' + id +
        (result.found ? ' matched ' + result.matches.map((m) => m.name).join(',') : ''));
    }
  });

  test('the id shape that caused the regression is pinned by literal too', () => {
    // The exact value from the 2026-08-17 investigation. Kept alongside the
    // generated cases so the specific reported failure can never silently return.
    assert.equal(scan({ note: 'sk-1ec74737-f6a4-4047-b156-0c645aa9f293' }).found, false);
  });

  test('a skill id embedded in free text is not a credential', () => {
    // The realistic leash path: a T3 build brief that quotes an id.
    const text = 'Follow the procedure recorded as ' + skillId() + ' when building this.';
    assert.equal(scan({ prompt: text }).found, false);
  });

  test('other MYTHOS id prefixes are not credentials either', () => {
    for (const make of [lessonId, refinementId, auditId]) {
      const id = make();
      assert.equal(scan({ note: id }).found, false, id + ' must not scan as a credential');
    }
  });
});

describe('credential scanner still catches real provider keys (true positives)', () => {
  // Shapes only — never a real key. Each is the documented format for its
  // provider, so narrowing a pattern to fix a false positive cannot silently
  // stop catching the thing the pattern exists for.
  const realShapes = [
    ['openai-key', 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(3)],
    ['openai-key', 'sk-proj-' + 'Bb9Xy7Zq'.repeat(5)],
    ['openai-key', 'sk-svcacct-' + 'Cc7Mn4Pl'.repeat(5)],
    ['groq-key', 'gsk_' + 'D4e5F6g7H8i9J0k1'.repeat(3)],
    ['nvidia-key', 'nvapi-' + 'E5f6G7h8I9j0K1l2'.repeat(3)],
  ];

  for (const [expected, value] of realShapes) {
    test(expected + ' shape is still detected', () => {
      const result = scan({ apiKey: value });
      assert.equal(result.found, true, 'must still detect ' + expected + ': ' + value);
      const names = result.matches.map((m) => m.name);
      assert.ok(names.includes(expected),
        'expected pattern ' + expected + ' to match, got: ' + names.join(','));
    });
  }

  test('the scanner never echoes the full secret in its sample', () => {
    // mythos/src/core/CLAUDE.md: "the scanner's own output is always redacted in
    // the audit reason — never the full secret." leash/index.js interpolates
    // m.sample straight into the audit line, so this is load-bearing.
    const secret = 'sk-' + 'Z9y8X7w6V5u4T3s2'.repeat(3);
    const result = scan({ apiKey: secret });
    assert.equal(result.found, true);
    for (const m of result.matches) {
      assert.ok(!m.sample.includes(secret),
        'sample must not contain the whole secret: ' + m.sample);
    }
  });
});

describe('the openai-key lookahead is narrow on purpose', () => {
  test('it rejects only the UUID shape, not every hyphenated value', () => {
    // Guards against "fixing" the false positive by gutting the pattern: a
    // hyphenated key that is NOT UUID-shaped must still be caught.
    assert.equal(scan({ k: 'sk-abcd1234-key-' + 'Q'.repeat(20) }).found, true,
      'a hyphenated non-UUID value must still match');
  });

  test('the pattern carries the global flag and is reset between uses', () => {
    // These regexes are module-scope singletons with /g; a caller that forgets
    // lastIndex gets non-deterministic results on the second call. Two
    // identical scans must agree.
    const value = 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(3);
    const first = scan({ k: value }).found;
    const second = scan({ k: value }).found;
    assert.equal(first, true);
    assert.equal(second, true, 'second scan of the same value must agree with the first');
  });

  test('every pattern in the exported list is a global regex', () => {
    // server/index.js's redactLogValue relies on /g for replace-all, and resets
    // lastIndex before each use. A non-global pattern there would replace only
    // the first occurrence in a log line.
    for (const p of _PATTERNS) {
      assert.ok(p.re instanceof RegExp, p.name + ' must expose a RegExp');
      assert.ok(p.re.flags.includes('g'), p.name + ' must carry the global flag');
    }
  });
});
