'use strict';

// tool-call-restraint.test.js — BUG-255, BUG-257.
//
// On a rate-limited free tier, a tool call is not merely slow — it is TWO
// inference passes (call, then re-reason over the result) plus one scarce
// request against a per-minute budget. A measured live session reached for
// `think_deeply` 10 times out of 34 total tool calls, more than every other
// tool combined, on ordinary conversation. The tool itself was fast and
// healthy every time (471-1081ms, zero failures); the cost was the round-trips.
//
// The lever is the tool DESCRIPTION, because that is the only thing the model
// reads when deciding. The first wording named its failure modes but framed
// calling as the normal move: "comparing options with trade-offs, planning an
// approach, checking whether an argument holds" describes most of a
// conversation. These tests pin the restraint clauses so a later edit cannot
// quietly widen the invitation again — the same class of drift the repo
// already records for `open_web`'s query/url contract.
//
// Prose assertions are deliberately loose about wording and strict about the
// PROPERTY each clause carries: that answering is the stated default, that the
// cost is named, and that the trigger is a test the model can apply.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'core');

function toolDescription(file, toolName) {
  const src = fs.readFileSync(path.join(SRC, 'effectors', file), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes("name: '" + toolName + "'"));
  assert.ok(line, toolName + ' must still be registered in ' + file);
  const m = line.match(/description:\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(m, toolName + ' must carry a single-quoted description');
  return m[1];
}

describe('BUG-255: think_deeply invites restraint, not reflex', () => {
  const desc = toolDescription('from-computer.js', 'think_deeply');

  test('answering yourself is stated as the DEFAULT, not merely allowed', () => {
    assert.match(desc, /DEFAULT TO ANSWERING/i,
      'the default must be explicit and prominent — a buried "only when needed" reads as permission');
  });

  test('the cost is named, in terms the model can weigh', () => {
    assert.match(desc, /expensive|scarce|rate-limited/i, 'the description must say the call costs something');
    assert.match(desc, /wait|slow|doubl/i, 'and that the operator pays for it in latency');
  });

  test('the trigger is an applicable test, not a list of conversational topics', () => {
    assert.match(desc, /would otherwise GUESS|cannot name|cannot hold/i,
      'the model needs a self-check it can actually apply mid-turn');
  });

  test('the old broad invitations are gone', () => {
    // These three phrases are what made it fire on ordinary chat. Their
    // absence is the fix; if they return, so does the 10-of-34 behaviour.
    assert.equal(/planning an approach/i.test(desc), false);
    assert.equal(/checking whether an argument holds/i.test(desc), false);
    assert.equal(/comparing options with trade-offs/i.test(desc), false);
  });

  test('the genuine use case survives — this must not become a tool nobody calls', () => {
    assert.match(desc, /multi-step|trade-off/i,
      'a hard multi-step problem is still exactly what it is for');
    assert.match(desc, /web_search/, 'the lookup redirect must stay');
    assert.match(desc, /screen_look/, 'the screen redirect must stay');
    assert.match(desc, /context/, 'it still cannot see the conversation and must say so');
  });
});

describe('BUG-257: a failed Aether socket says what failed and where', () => {
  const src = fs.readFileSync(path.join(SRC, 'sensors', 'aether.js'), 'utf8');

  test('socket_error carries the url and an error code', () => {
    // Whole statement, not [^)]* — the payload itself contains parens
    // (String(code).slice(...)), so a paren-terminated match stops short.
    const m = src.match(/logger\.warn\('sensors\.aether\.socket_error'.*$/m);
    assert.ok(m, 'the socket_error warn must still exist');
    assert.match(m[0], /url:/, 'a reconnect storm is undiagnosable without the target url');
    assert.match(m[0], /code:/, 'ECONNREFUSED vs a TLS failure vs a wrong port are different bugs');
  });

  test('the error argument is actually received from the listener', () => {
    assert.match(src, /socket\.on\('error', function \(err\)/,
      'the handler must take the error it is meant to report');
  });

  test('the code is bounded so a pathological message cannot flood the log', () => {
    // Whole statement, not [^)]* — the payload itself contains parens
    // (String(code).slice(...)), so a paren-terminated match stops short.
    const m = src.match(/logger\.warn\('sensors\.aether\.socket_error'.*$/m);
    assert.match(m[0], /slice\(0,\s*\d+\)/, 'error text must be truncated');
  });
});
