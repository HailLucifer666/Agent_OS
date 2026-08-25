'use strict';

// BUG-160 — the "two brains" memory defect (operator incident 2026-08-07
// 04:30). Real vault evidence: Semantic/user-facts.md held THREE conflicting
// "open World Monitor" directives at once — the original (wrong) meteomatics
// URL, the operator's spoken correction (worldmonitor.app), and a vague
// third — because append-mode dedup is exact-match only and there was no
// forget tool at all. Which URL won retrieval was a coin flip per
// conversation, and "open world monitor" failed live at 04:27.
//
// Two fixes under test: (1) semantic.write() supersedes a DIRECTIVE fact
// ("when <trigger>, <action>") when a new fact carries the same canonical
// trigger clause; (2) semantic.forget() / the forget_fact effector remove a
// named fact and echo exactly what they removed.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createSemanticStore } = require('../src/core/memory/semantic');
const { buildTools } = require('../src/core/effectors/from-memory');

function makeStore() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const semantic = createSemanticStore({ fs, config: {}, bus: fakeBus(), logger: { warn() {} } });
  return { dir, fs, semantic };
}

describe('BUG-160: directive facts supersede instead of accumulating', () => {
  const ctx = makeStore();
  after(() => cleanupVaultDir(ctx.dir));

  it('THE RECORDED CASE: a re-worded correction replaces the directive it contradicts', () => {
    ctx.semantic.write('user-facts', [
      'When the operator asks to "open World Monitor", open this link in a new browser tab: https://www.meteomatics.com/en/weather-world-monitor/',
    ], { append: true, sources: ['voice-explicit'] });
    ctx.semantic.write('user-facts', [
      'When asked to "open world monitor", open https://www.worldmonitor.app/dashboard in a new browser tab.',
    ], { append: true, sources: ['voice-explicit'] });
    const raw = ctx.fs.readText('Semantic/user-facts.md', '');
    assert.ok(!raw.includes('meteomatics'), 'the contradicted directive must be gone, not kept beside its correction:\n' + raw);
    assert.ok(raw.includes('worldmonitor.app'), 'the correction must be the surviving fact');
  });

  it('observational facts with different wording still accumulate (supersede stays narrow)', () => {
    ctx.semantic.write('user-facts-obs', ['The operator likes tea'], { append: true });
    ctx.semantic.write('user-facts-obs', ['The operator enjoys jazz piano'], { append: true });
    const facts = ctx.fs.readText('Semantic/user-facts-obs.md', '');
    assert.ok(facts.includes('likes tea') && facts.includes('jazz piano'),
      'non-directive facts must never supersede each other');
  });

  it('directives with DIFFERENT triggers both survive', () => {
    ctx.semantic.write('user-facts-trig', [
      'When the operator asks to open the news, open Google News.',
    ], { append: true });
    ctx.semantic.write('user-facts-trig', [
      'When the operator asks to open the dashboard, open the HUD.',
    ], { append: true });
    const raw = ctx.fs.readText('Semantic/user-facts-trig.md', '');
    assert.ok(raw.includes('Google News') && raw.includes('the HUD'),
      'different triggers are different rules — both must survive');
  });

  it('exact-match dedup (P3-9) is byte-identical in behaviour: same sentence with trailing period does not duplicate', () => {
    ctx.semantic.write('user-facts-dedup', ['The operator really enjoys playing jazz piano'], { append: true });
    ctx.semantic.write('user-facts-dedup', ['The operator really enjoys playing jazz piano.'], { append: true });
    const raw = ctx.fs.readText('Semantic/user-facts-dedup.md', '');
    const count = (raw.match(/jazz piano/g) || []).length;
    assert.equal(count, 1, 'exact dedup must still collapse the pair');
  });
});

describe('BUG-160: semantic.forget() and the forget_fact effector', () => {
  const ctx = makeStore();
  after(() => cleanupVaultDir(ctx.dir));

  it('removes exactly the matching bullet and echoes it; the rest of the file survives byte-for-byte', () => {
    ctx.semantic.write('user-facts', [
      'The operator likes tea',
      'When the operator asks to open X, do Y',
      'The operator works late',
    ], { append: true });
    const before = ctx.fs.readText('Semantic/user-facts.md', '');
    const res = ctx.semantic.forget('likes tea');
    assert.equal(res.removed.length, 1);
    assert.match(res.removed[0], /likes tea/);
    const after_ = ctx.fs.readText('Semantic/user-facts.md', '');
    assert.ok(!after_.includes('likes tea'));
    assert.ok(after_.includes('works late') && after_.includes('do Y'), 'unrelated facts must survive');
    // Everything except the removed bullet line is unchanged.
    assert.deepEqual(
      after_.split('\n'),
      before.split('\n').filter((l) => !/likes tea/.test(l)),
      'forget must be a pure line filter — no rewrite of surviving content'
    );
  });

  it('no match → honest failure naming the topics searched (effector shape)', async () => {
    const tools = buildTools({ semantic: ctx.semantic, fs: ctx.fs });
    const forgetTool = tools.find((t) => t.name === 'forget_fact');
    assert.ok(forgetTool, 'forget_fact must be registered');
    const res = await forgetTool.fn({ query: 'nothing matches this phrase' });
    assert.equal(res.ok, false);
    assert.match(String(res.result.error), /No stored fact contains/);
    assert.match(String(res.result.error), /Topics searched/);
  });

  it('a too-broad query is refused rather than mass-deleting', () => {
    const facts = [];
    for (let i = 0; i < 7; i++) facts.push('The operator has a a preference number ' + i + ' about music');
    ctx.semantic.write('user-facts-broad', facts, { append: true });
    const res = ctx.semantic.forget('about music', { topic: 'user-facts-broad' });
    assert.equal(res.removed.length, 0);
    assert.match(String(res.error), /too broad/);
    const raw = ctx.fs.readText('Semantic/user-facts-broad.md', '');
    assert.equal((raw.match(/about music/g) || []).length, 7, 'nothing may be deleted on a refused query');
  });

  it('effector success echoes the removed text as evidence', async () => {
    ctx.semantic.write('user-facts-echo', ['The wrong URL is https://example.com/mock'], { append: true });
    const tools = buildTools({ semantic: ctx.semantic, fs: ctx.fs });
    const forgetTool = tools.find((t) => t.name === 'forget_fact');
    const res = await forgetTool.fn({ query: 'example.com/mock', topic: 'user-facts-echo' });
    assert.equal(res.ok, true);
    assert.match(res.result.forgot[0], /example\.com\/mock/);
    assert.match(res.result.evidence, /removed 1 fact/);
  });
});

// Wave 4 (2026-08-13), incident from BUGS.md: forget_fact's exact-substring
// match was the ONLY mode, so a paraphrased correction ("forget that I said
// kids come first") never matched the stored fact it was meant to retire
// ("children/family priority") — reported as "no stored fact" even though the
// fact was right there. A normalized token-overlap fallback closes that,
// auto-resolving a single plausible match and asking "which one?" on more
// than one instead of guessing.
describe('Wave 4: forget() falls back to a fuzzy match when exact substring finds nothing', () => {
  const ctx = makeStore();
  after(() => cleanupVaultDir(ctx.dir));

  it('a single fuzzy match auto-resolves exactly like an exact match would', () => {
    ctx.semantic.write('user-facts-fuzzy1', ['The operator says children and family come first'], { append: true });
    const res = ctx.semantic.forget('kids and family are the priority');
    assert.equal(res.removed.length, 1, 'a single plausible fuzzy match must be removed, not just reported');
    assert.match(res.removed[0], /children and family/);
    assert.equal(res.matchedBy, 'fuzzy', 'the raw result marks how it matched, so callers can distinguish exact from paraphrase');
    const raw = ctx.fs.readText('Semantic/user-facts-fuzzy1.md', '');
    assert.ok(!raw.includes('children and family'), 'the fact must actually be gone from disk');
  });

  it('more than one plausible fuzzy match returns candidates instead of deleting anything', () => {
    ctx.semantic.write('user-facts-fuzzy2', [
      'The operator prefers tea over coffee in the morning',
      'The operator prefers tea over coffee at work',
    ], { append: true });
    const before = ctx.fs.readText('Semantic/user-facts-fuzzy2.md', '');
    const res = ctx.semantic.forget('coffee preference in the morning at work');
    assert.equal(res.removed.length, 0, 'ambiguous — nothing may be deleted');
    assert.ok(Array.isArray(res.candidates) && res.candidates.length >= 2, 'must report the candidates it found');
    const after_ = ctx.fs.readText('Semantic/user-facts-fuzzy2.md', '');
    assert.equal(after_, before, 'the file must be byte-identical — ambiguity never writes');
  });

  it('a genuinely unrelated query still reports no match, not a low-confidence guess', () => {
    ctx.semantic.write('user-facts-fuzzy3', ['The operator likes jazz piano'], { append: true });
    const res = ctx.semantic.forget('the quarterly financial report is due');
    assert.equal(res.removed.length, 0);
    assert.equal(res.candidates, undefined, 'no shared vocabulary at all must not manufacture a candidate');
  });

  it('the exact-substring path still wins outright when it matches — fuzzy is a fallback, not a replacement', () => {
    ctx.semantic.write('user-facts-fuzzy4', ['The wrong URL is https://example.com/mock'], { append: true });
    const res = ctx.semantic.forget('example.com/mock');
    assert.equal(res.removed.length, 1);
    assert.equal(res.candidates, undefined);
  });
});

describe('Wave 4: forget_fact effector surfaces "which one?" on ambiguity, and names a paraphrase match', () => {
  const ctx = makeStore();
  after(() => cleanupVaultDir(ctx.dir));

  it('asks which fact on multiple fuzzy candidates, without deleting either', async () => {
    ctx.semantic.write('user-facts-fx1', [
      'The operator prefers tea over coffee in the morning',
      'The operator prefers tea over coffee at work',
    ], { append: true });
    const tools = buildTools({ semantic: ctx.semantic, fs: ctx.fs });
    const forgetTool = tools.find((t) => t.name === 'forget_fact');
    const res = await forgetTool.fn({ query: 'coffee preference in the morning at work', topic: 'user-facts-fx1' });
    assert.equal(res.ok, false);
    assert.match(String(res.result.error), /Found 2 similar facts/);
    assert.match(String(res.result.error), /which one/i);
    const raw = ctx.fs.readText('Semantic/user-facts-fx1.md', '');
    assert.ok(raw.includes('morning') && raw.includes('at work'), 'nothing may be deleted while ambiguous');
  });

  it('a single fuzzy match succeeds and the note says it was a paraphrase, not an exact hit', async () => {
    ctx.semantic.write('user-facts-fx2', ['The operator says children and family come first'], { append: true });
    const tools = buildTools({ semantic: ctx.semantic, fs: ctx.fs });
    const forgetTool = tools.find((t) => t.name === 'forget_fact');
    const res = await forgetTool.fn({ query: 'kids and family are the priority', topic: 'user-facts-fx2' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.result.evidence, /paraphrase match/);
    assert.match(res.result.forgot[0], /children and family/);
  });
});

describe('BUG-160: wiring — voice reach and tier row', () => {
  it('forget_fact is on the Live voice allowlist (registering an effector does NOT reach voice by itself)', () => {
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
    assert.ok(DEFAULT_ALLOWLIST.includes('forget_fact'));
  });

  it('forget_fact has an explicit tier row (unknown tools fail-safe to T3 confirm-every-time)', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.forget_fact, 2);
  });
});
