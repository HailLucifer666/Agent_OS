'use strict';

// providers/stt-hints.js — Whisper recognition hints.
//
// The change under test is one `form.append('prompt', …)` in groq-stt.js, and it
// is worth this many tests only because of HOW a Whisper prompt can go wrong. It
// is not an instruction and not a glossary: the decoder treats it as PRECEDING
// TRANSCRIPT TEXT, which produces three specific hazards, and each one below is
// a test rather than a comment.
//
//   * SILENT TRUNCATION past 224 tokens. A long list does not fail — it loses
//     its tail, so the least guessable term has to come first.
//   * ECHO. Because it reads as prior transcript, a prompt written as a sentence
//     can leak fragments of itself into the output on near-silent audio. This
//     repo already documents Whisper inventing stock phrases from silence
//     (groq-stt.js's HALLUCINATION_PHRASES); a prompt gives it fresh material.
//   * IT MUST NOT BE REQUIRED. It is an accuracy aid on the voice hot path, so
//     every failure in it has to degrade to "no hint", never to "no transcript".
//
// Live A/B on real synthesized speech is scripts/verify-stt-hints.js — measured
// 4/8 terms without hints vs 8/8 with, on 2026-08-22. These tests pin the
// properties; that script measures the effect.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hints = require('../providers/stt-hints');

describe('stt-hints — the prompt is a TERM LIST, never a sentence', () => {
  const prompt = hints.buildPrompt(null);

  it('carries no sentence-ending punctuation for the decoder to continue', () => {
    // A prompt that reads like prose gives Whisper a grammatical frame to
    // complete on silent audio. A bare comma-separated list gives it none.
    assert.equal(/[.!?]/.test(prompt), false, 'prompt must not contain . ! or ? — got: ' + prompt);
  });

  it('is comma-separated and non-empty', () => {
    assert.ok(prompt.length > 0);
    assert.ok(prompt.split(', ').length > 5, 'a handful of terms is not worth the request field');
  });

  it('contains the term the operator actually mishears most', () => {
    assert.match(prompt, /MYTHOS/);
  });
});

describe('stt-hints — length is bounded BELOW Whisper\'s silent truncation point', () => {
  it('never exceeds the character cap', () => {
    assert.ok(hints.buildPrompt(null).length <= hints.MAX_PROMPT_CHARS,
      'over the cap, and Whisper truncates silently rather than erroring');
  });

  it('the cap leaves real headroom under 224 tokens', () => {
    // Nothing here can count tokens without a tokenizer, so the character cap is
    // the proxy. At a conservative ~3 chars/token for short technical words the
    // cap must stay well under 224 tokens — this asserts the proxy is still
    // conservative if someone raises MAX_PROMPT_CHARS.
    assert.ok(hints.MAX_PROMPT_CHARS / 3 < 224,
      'MAX_PROMPT_CHARS was raised past the point where the token cap is safe');
  });

  it('truncates by DROPPING TRAILING TERMS, never by cutting a term in half', () => {
    // A half-word is worse than a missing word: it biases the decoder toward a
    // string that is not a real term.
    const many = [];
    for (let i = 0; i < 400; i++) many.push('synthetic-term-' + i);
    const out = hints.buildPrompt(many);
    assert.ok(out.length <= hints.MAX_PROMPT_CHARS);
    for (const term of out.split(', ')) {
      assert.ok(term.length > 0);
      assert.equal(/synthetic-term-\d+$/.test(term) || !/^synthetic/.test(term), true,
        'a truncated synthetic term leaked through: ' + JSON.stringify(term));
    }
  });

  it('puts the LEAST guessable term first, so truncation cannot eat it', () => {
    const out = hints.buildPrompt(['zzz-first-term']);
    const first = out.split(', ')[0];
    // The git branch wins when there is one; the caller's extra term otherwise.
    // Either way a CORE_TERM must not be first, because core terms are the ones
    // safe to lose.
    assert.equal(hints.CORE_TERMS.includes(first), false,
      'a core term is first, so the branch/caller term is what truncation drops');
  });

  it('de-duplicates case-insensitively, so budget is not spent twice', () => {
    const out = hints.buildPrompt(['mythos', 'MYTHOS', 'Mythos']);
    const lowered = out.split(', ').map((t) => t.toLowerCase());
    assert.equal(new Set(lowered).size, lowered.length, 'duplicate terms: ' + out);
  });
});

describe('stt-hints — it degrades to "no hint", never to "no transcript"', () => {
  it('a missing git branch is not an error', () => {
    // Not a git checkout, or no git on PATH. Both are legitimate for a
    // contributor, and neither may break voice input.
    hints._resetBranchCache();
    assert.doesNotThrow(() => hints.buildPrompt(null));
    assert.ok(hints.buildPrompt(null).length > 0, 'core terms must still be present');
  });

  it('the branch lookup is cached, so it is not a spawn per utterance', () => {
    hints._resetBranchCache();
    const first = hints._gitBranch();
    const second = hints._gitBranch();
    assert.equal(first, second);
    // A stale branch is a valid hint; a spawnSync on every voice turn is latency
    // on the hot path. The cache is the deliberate trade.
    const src = fs.readFileSync(path.join(__dirname, '..', 'providers', 'stt-hints.js'), 'utf8');
    assert.match(src, /cachedBranch !== undefined/, 'the cache guard must survive');
  });

  it('never returns a detached-HEAD literal as a vocabulary term', () => {
    // `git rev-parse --abbrev-ref HEAD` prints the string "HEAD" when detached,
    // and "HEAD" is not a word anyone dictates.
    //
    // FIXED after mutation testing. The first version of this test only did
    // `notEqual(branch, 'HEAD')`, which passes on any machine that is NOT on a
    // detached HEAD — i.e. vacuously, here and in CI. Deleting the filter caught
    // nothing. The filter itself is what has to be asserted, and the state it
    // guards has to be reachable, so both are checked.
    hints._resetBranchCache();
    assert.notEqual(hints._gitBranch(), 'HEAD');
    const src = fs.readFileSync(path.join(__dirname, '..', 'providers', 'stt-hints.js'), 'utf8');
    assert.match(src, /name !== 'HEAD'/,
      'the detached-HEAD filter must survive — without it "HEAD" becomes a hint term');
  });

  it('tolerates junk from a caller without emitting empty terms', () => {
    const out = hints.buildPrompt(['', '   ', null, undefined, 'real-term']);
    assert.equal(out.split(', ').some((t) => t.trim() === ''), false);
    assert.match(out, /real-term/);
  });
});

describe('stt-hints — the wiring in groq-stt.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'providers', 'groq-stt.js'), 'utf8');

  it('sends the prompt field, which is the whole change', () => {
    // FIXED after mutation testing. The first version matched
    // /form\.append\('prompt', hint\)/, which still matched when the mutation
    // changed the GUARD around it to `if (false)` — the append text was intact
    // and unreachable. So this asserts the guard AND the absence of a
    // short-circuit, which is the shape that actually disables it.
    assert.match(src, /if \(hint\) form\.append\('prompt', hint\)/,
      'the append must be guarded on a truthy hint and nothing else');
    assert.equal(/if \(false\)/.test(src), false,
      'a short-circuited branch leaves the code present and dead');
    // And the value really does come from the hints module, not a literal.
    assert.match(src, /require\('\.\/stt-hints'\)\.buildPrompt/);
  });

  it('is opt-OUT, so the accuracy fix is on by default', () => {
    // The failure mode of a hint is mild; the defect it fixes is constant. But a
    // knob has to exist, or the A/B in verify-stt-hints.js cannot be repeated on
    // a real microphone later.
    assert.match(src, /VOICE_STT_HINTS/);
    assert.match(src, /!==\s*'off'/, 'the default branch must be ON');
  });

  it('still sends temperature 0 and an explicit language', () => {
    // Both are load-bearing against hallucination on near-silent audio, and a
    // prompt gives the decoder MORE material to hallucinate from — so neither
    // may be dropped in the same edit that adds hints.
    assert.match(src, /form\.append\('temperature', '0'\)/);
    assert.match(src, /form\.append\('language', 'en'\)/);
  });

  it('keeps the stock-hallucination filter, which the prompt makes more important', () => {
    // FIXED after mutation testing. The first version matched the CONSTANT and
    // the FUNCTION NAME, both of which survive when only the call in the return
    // gate is deleted — so removing the actual filtering caught nothing. A
    // prompt gives Whisper fresh material to hallucinate from on near-silent
    // audio, which makes this filter MORE load-bearing than before, not less.
    assert.match(src, /isStockHallucination\(text\)/,
      'the filter must be CALLED, not merely defined');
    // Pin it to the return gate specifically: a call somewhere that ignores the
    // result would pass the assertion above.
    //
    // FOUND BY THIS TEST HANGING. The first version of this line used a nested
    // quantifier — /\(([^)]*\)?)*[^\n]*\)/ — which backtracks catastrophically
    // on a file this size and turned a 253 ms test file into a >240 s one. A
    // LINE SCAN answers the same question in linear time, and the lesson
    // generalises: a regex is the wrong tool for "find the statement that
    // contains all of these".
    const gate = src.split('\n').find((l) => /return ''/.test(l) && /!hasWord/.test(l));
    assert.ok(gate, 'the empty-result gate must still exist on one line');
    assert.match(gate, /isStockHallucination\(text\)/,
      'the filter result must gate the return, not be computed and discarded');
    assert.match(gate, /isLowConfidence\(data\.segments\)/,
      'the confidence gate must survive alongside it');
  });

  it('does not put any hint term INTO the hallucination filter', () => {
    // If a hinted term were also filtered as a hallucination, the two mechanisms
    // would fight and the hint would look broken.
    const engine = require('../providers/groq-stt');
    assert.equal(typeof engine.transcribe, 'function');
    const filtered = /HALLUCINATION_PHRASES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(filtered, 'the filter list must still be readable');
    const phrases = filtered[1].toLowerCase();
    for (const term of hints.CORE_TERMS) {
      assert.equal(phrases.includes("'" + term.toLowerCase() + "'"), false,
        'hinted term "' + term + '" is also in HALLUCINATION_PHRASES — they would fight');
    }
  });
});
