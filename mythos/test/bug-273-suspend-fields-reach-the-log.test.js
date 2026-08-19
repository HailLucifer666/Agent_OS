'use strict';

// bug-273-suspend-fields-reach-the-log.test.js — the class, not the instance.
//
// THIS IS THE THIRD TIME. `voice.capture-suspend` is assembled in two places: the
// client puts fields on the transition message (ui/public/js/voice/s2s-bridge.js)
// and the server copies a hand-maintained ALLOWLIST of them onto the log line
// (server/index.js). Adding a field to one and not the other is silent — the number
// is computed, sent over the wire, and dropped.
//
//   BUG-271  fixed it for ownVoiceGate/prerollFrames/framesZeroed/...
//   BUG-272  reintroduced it for bargeVetoed/bargeVetoTier/bleedFloor
//   BUG-273  reintroduced it AGAIN, for A1's bleedPeak/learnedFloor and A2's
//            flushedFrames/flushedZeroed/flushedRaw
//
// The comment above the allowlist already says why: "it means every new client field
// has to be added in two places, and forgetting the second is silent." It was written
// by the person who fixed it the second time, and it did not stop the third.
//
// WHAT IT COST THIS TIME. `flushedRaw` is the single datum BUG-273 A2's remaining
// acoustic fix waits on. Two sessions were run to collect it. Both produced nothing,
// and the verifier reported "not reported — log predates BUG-273 A2 instrumentation",
// which was true of the FIRST session and false of the second: that build had the
// instrumentation and the field was being discarded at the seam. So a P0 sat blocked
// on "we need another live session" when it was actually blocked on a missing line in
// an allowlist — and the tool built to detect exactly this printed PASS, because a
// missing field and an old log are indistinguishable to it. Precisely the
// fabricated-pass shape as `8d61547`.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? "The same invariant broken three times."
// The repo's own rule for that is to stop patching instances and write the assertion
// somewhere that runs repeatedly. This file IS that assertion: it reads the fields
// the client actually puts on the transition payload and fails if the server would
// drop any of them. Adding a fourth field with no allowlist entry now fails at commit
// time instead of costing another live session.
//
// Q2 — the allowlist itself STAYS. It is the right shape: a transcript must never
// reach a log line by accident, and an open passthrough would let one. What was wrong
// was that nothing checked it, not that it existed.
//
// Run: cd mythos && node --test test/bug-273-suspend-fields-reach-the-log.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const stripComments = (t) => t.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const BRIDGE = stripComments(
  fs.readFileSync(path.join(ROOT, 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8'));
const SERVER = stripComments(
  fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'));

// The server's copy loop, as a set of names.
function serverAllowlist() {
  const at = SERVER.indexOf("'voice-capture-suspend'");
  assert.notEqual(at, -1, 'the handler must still exist');
  const loop = SERVER.slice(at, SERVER.indexOf("logger.info('voice.capture-suspend'", at));
  const list = loop.slice(loop.indexOf('for (const k of ['));
  const names = list.slice(0, list.indexOf(']')).match(/'([A-Za-z][A-Za-z0-9]*)'/g) || [];
  const set = new Set(names.map((n) => n.replace(/'/g, '')));
  // The four fields the handler sets directly on `fields` rather than copying in the
  // loop (suspended/holdMs/reason/at) are just as delivered — counting them as
  // dropped would make this test fail on a field that demonstrably reaches the log.
  const base = loop.slice(loop.indexOf('const fields = {'), loop.indexOf('for (const k of ['));
  for (const m of base.match(/([A-Za-z][A-Za-z0-9]*)s*:/g) || []) set.add(m.replace(':', '').trim());
  return set;
}

// Keys of one object literal in the bridge, located by a marker inside it. Read from
// source rather than from a duplicated list here: a hand-copied expectation is the same
// two-places problem wearing a different hat.
function objectLiteralKeys(marker, why) {
  const at = BRIDGE.indexOf(marker);
  assert.notEqual(at, -1, why);
  // Walk back to the start of the object literal, forward to its close.
  const open = BRIDGE.lastIndexOf('{', at);
  const close = BRIDGE.indexOf('};', open);
  const body = BRIDGE.slice(open, close);
  const keys = body.match(/^\s{2,}([A-Za-z][A-Za-z0-9]*)\s*:/gm) || [];
  return keys.map((k) => k.trim().replace(':', ''));
}

// BUG-274 W1 WIDENED THIS, AND THE WIDENING IS THE POINT. Until then clientFields()
// read exactly ONE object literal — the release-transition `extra` — so it could only
// ever see fields added at that one call site. A field added instead to
// logSuspendTransition()'s own send() literal (which is where anything measured ONCE
// PER SESSION belongs, since `extra` is per-transition) was invisible to it: the field
// would be computed, sent over the wire, dropped at the server allowlist, and this
// file would print PASS. That is the same fabricated-pass shape the header above
// condemns — occurring inside the tool written to condemn it, which is why the fix is
// to widen the covered surface rather than to name one more field.
//
// Covered surface is now the UNION of both places a client field can be born.
// `type` is excluded: it is the message discriminator the server matches on, not a
// diagnostic it logs.
// BUG-274 step 5 WIDENED IT AGAIN, for the same reason and one level up. The union
// above still named its call sites by marker, so it covered the release transition and
// the send() literal and nothing else — and a THIRD logSuspendTransition() call site
// (the barge-in suppression's end-of-turn line) would have been invisible in exactly
// the way the paragraph above describes. Rather than add a third marker, every
// logSuspendTransition({...}) literal in the bridge is now scanned, so a fourth call
// site is covered before it is written.
function transitionCallSiteKeys() {
  const keys = new Set();
  let at = BRIDGE.indexOf('logSuspendTransition({');
  let sites = 0;
  while (at !== -1) {
    sites += 1;
    const open = BRIDGE.indexOf('{', at);
    // Depth-matched rather than close-marker-matched: these literals are one level
    // deep and contain no nested objects today, and this keeps that from mattering.
    let depth = 0;
    let end = open;
    for (; end < BRIDGE.length; end++) {
      if (BRIDGE[end] === '{') depth += 1;
      else if (BRIDGE[end] === '}') { depth -= 1; if (depth === 0) break; }
    }
    // Anchored on `{` or `,` — NOT on plain whitespace, which also matches the second
    // colon of a ternary (`heldMs: x ? Date.now() - x : 0` reported `x` as a key).
    for (const k of BRIDGE.slice(open, end).match(/[{,]\s*([A-Za-z][A-Za-z0-9]*)\s*:/g) || []) {
      keys.add(k.replace(/[{,\s]/g, '').replace(':', ''));
    }
    at = BRIDGE.indexOf('logSuspendTransition({', end);
  }
  assert.ok(sites >= 3,
    `expected at least 3 logSuspendTransition({...}) call sites, found ${sites} — if one `
    + 'was removed, say so; if the call shape changed, this scanner is now blind');
  return [...keys];
}

function clientFields() {
  const fromExtra = objectLiteralKeys(
    'flushedFrames:', 'the release-transition payload must still be built here');
  const fromSend = objectLiteralKeys(
    "type: 'voice-capture-suspend'", 'the transition message must still be sent here');
  return [...new Set([...fromExtra, ...fromSend, ...transitionCallSiteKeys()])]
    .filter((k) => k !== 'type');
}

test('every diagnostic the client computes actually reaches the log line', () => {
  const allowed = serverAllowlist();
  const sent = clientFields();
  assert.ok(sent.length >= 8, 'sanity: the payload should carry the full diagnostic set');

  const dropped = sent.filter((k) => !allowed.has(k));
  assert.deepEqual(dropped, [],
    'these are computed, sent over the wire and THROWN AWAY at server/index.js\'s '
    + 'allowlist — the third occurrence of this exact bug, and the one that cost two '
    + 'live sessions of flushedRaw');
});

test("the fields BUG-273's own slices added are present by name", () => {
  // Named explicitly as well as derived, because the derivation above depends on the
  // shape of one object literal — if a refactor moves those fields somewhere the
  // parser cannot see, this test must fail loudly rather than pass on an empty list.
  const allowed = serverAllowlist();
  for (const field of ['flushedFrames', 'flushedZeroed', 'flushedRaw', 'bleedPeak', 'learnedFloor',
    // BUG-274 W1 Q5: the granted-vs-requested echoCancellation pair. Named as well as
    // derived because the derivation depends on the shape of two object literals, and
    // this is the datum the entire own-voice plan's premise rests on.
    'micEchoCancellation', 'micNoiseSuppression']) {
    assert.ok(allowed.has(field), field + ' must reach the log — a live session is judged on it');
  }
});

test("the cushion diagnostics are still VISIBLE to this scanner, not just allowed", () => {
  // Q3, and the reason this test is about `sent` rather than `allowed`. Every other
  // check here asks whether the server would keep a field. This one asks whether this
  // file can still SEE the client sending it — because the failure mode that nearly
  // shipped on 2026-08-20 was the opposite of the classic one: the fields were
  // spread into the payload from a helper's return literal (`...cushionStats()`),
  // which the scanner does not read. They would have been computed, sent, dropped at
  // the allowlist, and this file would have printed PASS on an empty `dropped` list —
  // the fabricated pass its own header condemns, produced by hiding the names rather
  // than by forgetting them.
  //
  // So: spelled-out keys are load-bearing, and this fails if anyone re-hides them.
  const sent = clientFields();
  for (const field of ['cushionMs', 'underruns', 'missedTurnEnds']) {
    assert.ok(sent.includes(field),
      field + ' is no longer visible as a literal key in a scanned payload — if it '
      + 'moved behind a spread or a computed name, this scanner is blind to it and '
      + 'the allowlist check above proves nothing about it');
  }
});

test('the pre-BUG-273 fields are still allowed — nothing was traded away', () => {
  const allowed = serverAllowlist();
  for (const field of ['ownVoiceGate', 'prerollFrames', 'prerollCap', 'heldMs',
    'framesDropped', 'framesZeroed', 'peakRms', 'bargeVetoed', 'bargeVetoTier', 'bleedFloor']) {
    assert.ok(allowed.has(field), field + ' was already load-bearing before this fix');
  }
});

test('the allowlist is still an allowlist — no passthrough', () => {
  // Q2: the mechanism is right and stays. A transcript must never reach a log line by
  // accident, and `Object.assign(fields, msg)` would let one. What was missing was a
  // check on the list, not the list.
  const at = SERVER.indexOf("'voice-capture-suspend'");
  const handler = SERVER.slice(at, SERVER.indexOf("logger.info('voice.capture-suspend'", at));
  assert.match(handler, /for \(const k of \[/, 'still an explicit list');
  assert.doesNotMatch(handler, /Object\.assign\(fields,\s*msg\)/);
  assert.doesNotMatch(handler, /\.\.\.msg/);
});
