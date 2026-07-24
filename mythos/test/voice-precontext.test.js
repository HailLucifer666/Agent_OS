'use strict';

// Part B (pre-context brain upgrade) tests.
// Part 1 (B1): honest tool descriptions, sandbox-boundary denial messages,
// capability digest, KNOWN_DESKTOP_APPS drift guard.
// Part 2 (B2, appended after B1 lands): RULES additions + digest wiring
// through createVoiceAgent/buildPrompt/buildSystemContext.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fromPc = require('../src/core/effectors/from-pc');
const fromComputer = require('../src/core/effectors/from-computer');
const capabilities = require('../src/core/identity/capabilities');
const { createVoiceAgent, _internal } = require('../src/core/voice/voice-agent');

describe('B1: honest tool descriptions (no pid fabrication)', () => {
  const uiType = fromPc.TOOLS.find((t) => t.name === 'ui_type');
  const uiClick = fromPc.TOOLS.find((t) => t.name === 'ui_click');

  it('ui_type exists and no longer tells the model to pass a preceding-launch pid', () => {
    assert.ok(uiType, 'ui_type tool exists');
    assert.equal(/pass the pid returned by the preceding/i.test(uiType.description), false);
  });

  it('ui_type description tells the model to omit pid and never invent one', () => {
    assert.match(uiType.description, /OMIT/);
    assert.match(uiType.description, /NEVER invent/);
  });

  it('ui_click exists and no longer tells the model to pass a preceding-launch pid', () => {
    assert.ok(uiClick, 'ui_click tool exists');
    assert.equal(/pass the pid returned by the preceding/i.test(uiClick.description), false);
  });

  it('ui_click description tells the model to omit pid and never invent one', () => {
    assert.match(uiClick.description, /OMIT/);
    assert.match(uiClick.description, /NEVER invent/);
  });
});

describe('B1: honest sandbox-boundary denial messages', () => {
  it('write_file outside allowed roots names an allowed root in the failure message', () => {
    const result = fromComputer.write_file({ path: 'C:\\Windows\\System32\\denied-by-test.txt', content: 'x' });
    assert.equal(result.ok, false);
    const roots = fromComputer.allowedRoots();
    assert.ok(roots.length > 0, 'allowedRoots() returns at least one root');
    assert.ok(roots.some((r) => result.result.includes(r)), `denial message should name an allowed root: ${result.result}`);
  });

  it('create_folder outside allowed roots names an allowed root in the failure message', () => {
    const result = fromComputer.create_folder({ path: 'C:\\Windows\\System32\\denied-by-test-folder' });
    assert.equal(result.ok, false);
    const roots = fromComputer.allowedRoots();
    assert.ok(roots.some((r) => result.result.includes(r)), `denial message should name an allowed root: ${result.result}`);
  });
});

describe('B1: capability digest (summaryDigest)', () => {
  it('names roots/apps/adapters/providers when given all four, staying <= 5 lines', () => {
    const digest = capabilities.summaryDigest({
      apps: ['slack', 'discord', 'teams'],
      roots: ['C:\\Users\\test\\Documents'],
      adapters: { 'pc-child': true, browser: false },
      providerCount: 3,
    });
    assert.ok(digest.includes('slack'));
    assert.ok(digest.includes('discord'));
    assert.ok(digest.includes('teams'));
    assert.ok(digest.includes('C:\\Users\\test\\Documents'));
    assert.ok(digest.includes('pc-child ONLINE'));
    assert.ok(digest.includes('browser OFFLINE'));
    assert.ok(digest.includes('3'));
    const lines = digest.split('\n');
    assert.ok(lines.length <= 5, `digest should be <= 5 lines, got ${lines.length}`);
  });
});

describe('B1: KNOWN_DESKTOP_APPS drift guard', () => {
  it('every KNOWN_DESKTOP_APPS name appears in ps-automation.ps1 $script:KnownApps block', () => {
    const psPath = path.resolve(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
    const psText = fs.readFileSync(psPath, 'utf8');
    const startIdx = psText.indexOf('$script:KnownApps');
    const endIdx = psText.indexOf('function Handle-LaunchApp', startIdx);
    assert.ok(startIdx !== -1 && endIdx !== -1, '$script:KnownApps block located in ps-automation.ps1');
    const block = psText.slice(startIdx, endIdx);
    fromPc.KNOWN_DESKTOP_APPS.forEach((name) => {
      assert.ok(block.toLowerCase().includes(`'${name}'`), `${name} present in $script:KnownApps block`);
    });
  });
});

// ---------------------------------------------------------------------------
// B2: RULES additions (source scans) + capability-digest wiring through
// buildPrompt/buildSystemContext/createVoiceAgent.
// ---------------------------------------------------------------------------

describe('B2: RULES source-scans for the new paragraphs', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'),
    'utf8'
  );

  it('SEQUENCING RULE paragraph exists', () => {
    assert.match(src, /SEQUENCING RULE/);
  });

  it('SUCCESS RULE paragraph exists', () => {
    assert.match(src, /SUCCESS RULE/);
  });

  it('LIMITS RULE paragraph exists', () => {
    assert.match(src, /LIMITS RULE/);
  });

  it('INTRODUCTION RULE opener text is exact', () => {
    assert.match(src, /Allow me to introduce myself, I am Mythos/);
  });
});

describe('B2: capability digest wiring through buildPrompt/buildSystemContext', () => {
  it('buildPrompt includes the digest text when capabilityDigest is supplied', () => {
    const digest = 'CAPABILITY SNAPSHOT (live — trust this over any assumption):\n- test line';
    const prompt = _internal.buildPrompt({ text: 'hello', history: [], toolResults: null, capabilityDigest: digest });
    assert.ok(prompt.includes(digest), 'prompt should include the supplied capability digest');
  });

  it('buildPrompt produces identical output to before when capabilityDigest is not supplied (no behavior change)', () => {
    const withoutDigestArg = _internal.buildPrompt({ text: 'hello', history: [], toolResults: null });
    const withExplicitUndefined = _internal.buildPrompt({ text: 'hello', history: [], toolResults: null, capabilityDigest: undefined });
    assert.equal(withoutDigestArg, withExplicitUndefined);
    // '- test line' is unique to the digest content used in the previous test —
    // its absence (not the bare phrase "CAPABILITY SNAPSHOT", which the LIMITS
    // RULE paragraph also mentions independent of any injected digest) proves
    // no digest block was appended when the param is omitted.
    assert.ok(!withoutDigestArg.includes('- test line'), 'no digest supplied means no digest block injected');
  });
});

describe('B2: sequencing behavior — launch_app result feeds ui_type without a fabricated pid', () => {
  // Mirrors the makeBrain pattern in test/voice-agent-tools.test.js's BUG-007
  // suite: detect which pass a brain.think() call belongs to by inspecting
  // the prompt for the marker the corresponding buildPrompt branch injects.
  // Here that marker is "TOOL RESULTS:", which only appears once the first
  // action's real result has come back.
  function makeSequencingBrain(launchReply, typeReply) {
    const calls = [];
    return {
      calls,
      think: async ({ messages }) => {
        const prompt = messages[0].content;
        const hasToolResults = prompt.includes('TOOL RESULTS:');
        calls.push(hasToolResults ? 'second' : 'first');
        const reply = hasToolResults ? typeReply : launchReply;
        return { content: JSON.stringify(reply), parsed: reply, offline: false };
      },
    };
  }

  it('emits launch_app alone with needs_result:true, then ui_type with pid omitted once the real pid is known', async () => {
    const launchReply = {
      say: 'Opening Notepad now.',
      actions: [{ tool: 'launch_app', args: { name: 'notepad' } }],
      needs_result: true,
    };
    const typeReply = {
      say: 'Typing now.',
      actions: [{ tool: 'ui_type', args: { text: 'hello' } }],
      needs_result: false,
    };
    const brain = makeSequencingBrain(launchReply, typeReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const bus = { emit: () => {} };
    // A fake hub so launch_app/ui_type are KNOWN tools (the legacy CATALOG
    // fallback used when no hub is passed does not include PC tools).
    const hub = {
      catalog: () => [
        { name: 'launch_app', description: 'Launch an application by name.', params: { name: 'string' } },
        { name: 'ui_type', description: 'Type text into the focused element.', params: { text: 'string', pid: 'number (optional)' } },
      ],
    };
    const dispatchCalls = [];
    const dispatch = async (decision) => {
      dispatchCalls.push(decision);
      if (decision.tool === 'launch_app') return { ok: true, result: { pid: 4242, name: 'notepad', launched: true } };
      if (decision.tool === 'ui_type') return { ok: true, result: { typed: true } };
      return { ok: true, result: {} };
    };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {}, hub });
    const result = await agent.handleUtterance({ text: 'open notepad and type hello', ctx: {} });

    assert.deepEqual(brain.calls, ['first', 'second'], 'brain must be consulted once per pass, launch_app then ui_type');
    assert.equal(dispatchCalls.length, 2, 'exactly two tool dispatches — launch_app then ui_type');
    assert.equal(dispatchCalls[0].tool, 'launch_app');
    assert.equal(dispatchCalls[1].tool, 'ui_type');
    assert.equal(dispatchCalls[0].args.pid, undefined, 'launch_app call carries no pid');
    assert.equal(dispatchCalls[1].args.pid, undefined, 'ui_type call must not carry a fabricated pid');
    assert.equal(result.say, typeReply.say);
  });
});
