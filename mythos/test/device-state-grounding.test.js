'use strict';

// device-state-grounding.test.js — the entity must read device state back before
// asserting it, never answer from conversation memory.
//
// FROM A REAL SESSION, 2026-07-31. The entity logged its own correction as an
// incident: "User corrected my understanding of the state. 'SHE DON'T NEED TO
// KNOW' was playing, while 'COME DOWN' had only been selected in previous turns,
// not actively playing as I incorrectly stated."
//
// Nothing was broken mechanically. media_status and spotify_status both already
// declare needs_result:true, and voice-agent.js already FORCES a re-derive for
// any tool that declares it (P3-8). The gap was in the prompt: there were
// grounding rules for the outside world (WEB GROUNDING RULE), for artifact paths
// (ARTIFACT RULE) and for dependent calls (SEQUENCING RULE), but none for the
// state of the machine itself. So "what's playing?" was answered from what had
// been said three turns earlier — which is exactly as stale-prone as a web fact,
// because the user pauses things by hand and tracks end on their own.
//
// This pins the rule and the tools it names. It is a prompt-content test, in the
// same style as voice-agent-tools.test.js's HONESTY RULE assertions — the value
// is that deleting or hollowing out the rule fails loudly.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8');

describe('DEVICE STATE RULE', () => {
  test('the rule exists in the system prompt', () => {
    assert.ok(SRC.includes('DEVICE STATE RULE'),
      'the device-state grounding rule is gone — the entity will resume narrating '
      + 'playback from conversation memory (see this file’s header)');
  });

  test('it names the read-back tools for the state classes that actually drift', () => {
    const rule = SRC.match(/DEVICE STATE RULE[\s\S]*?(?=\r?\n\r?\nSKILLS RULE)/);
    assert.ok(rule, 'DEVICE STATE RULE block not found');
    const text = rule[0];
    for (const tool of ['media_status', 'spotify_status', 'list_windows', 'job_status', 'pipeline_status', 'list_goals']) {
      assert.ok(text.includes(tool), 'DEVICE STATE RULE must name ' + tool);
    }
    assert.match(text, /needs_result:true/, 'the rule must require needs_result:true');
  });

  test('it classes an unverified state claim as fabrication, matching the HONESTY RULE', () => {
    const rule = SRC.match(/DEVICE STATE RULE[\s\S]*?(?=\r?\n\r?\nSKILLS RULE)/)[0];
    assert.match(rule, /fabrication/i,
      'the rule must name the failure as fabrication, not phrase it as a mere preference');
    assert.match(rule, /HONESTY RULE/,
      'it should tie back to the HONESTY RULE so the two are enforced as one standard');
  });

  test('it tells the entity the tool wins over its own earlier claim', () => {
    const rule = SRC.match(/DEVICE STATE RULE[\s\S]*?(?=\r?\n\r?\nSKILLS RULE)/)[0];
    assert.match(rule, /tool is right/i,
      'the observed failure was the entity DEFENDING a stale claim, so the rule must '
      + 'state which side wins on a conflict');
  });
});

describe('the tools the rule depends on still declare needs_result', () => {
  // If these ever flip to false the rule becomes unenforceable: voice-agent only
  // forces a re-derive for tools whose catalog entry declares needs_result:true.
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };

  function realCatalog() {
    const { createEffectorHub } = require('../src/core/effectors/hub');
    const hub = createEffectorHub({ logger: quiet, bus: { emit() {}, subscribe() {} } });
    try { require('../src/core/effectors/from-pc').registerFromPc(hub, { pcChild: null, logger: quiet }); } catch { /* optional */ }
    try { require('../src/core/effectors/from-spotify').registerFromSpotify(hub, { logger: quiet }); } catch { /* optional */ }
    return hub.catalog();
  }

  test('media_status and spotify_status both force a re-derive', () => {
    const catalog = realCatalog();
    for (const name of ['media_status', 'spotify_status']) {
      const entry = catalog.find((c) => c.name === name);
      if (!entry) continue; // adapter not registered in this environment
      assert.equal(entry.needs_result, true,
        name + ' must declare needs_result:true or the DEVICE STATE RULE cannot be honoured');
    }
  });

  test('at least one of the two status tools is actually registered', () => {
    const catalog = realCatalog();
    const found = catalog.filter((c) => c.name === 'media_status' || c.name === 'spotify_status');
    assert.ok(found.length > 0, 'fixture guard: neither status tool registered, so the test above proved nothing');
  });
});
