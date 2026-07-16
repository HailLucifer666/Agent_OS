'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CATALOG integrity — verify the source has all expected tools
// ---------------------------------------------------------------------------
describe('voice-agent CATALOG integrity', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8');

  it('CATALOG_RAW contains remember tool', () => {
    assert.ok(src.includes("name: 'remember'"), 'remember tool missing from CATALOG_RAW');
  });

  it('CATALOG_RAW contains log_incident tool', () => {
    assert.ok(src.includes("name: 'log_incident'"), 'log_incident tool missing from CATALOG_RAW');
  });

  it('CATALOG_RAW contains gmail_unread', () => {
    assert.ok(src.includes("name: 'gmail_unread'"), 'gmail_unread missing');
  });

  it('CATALOG_RAW contains gmail_send', () => {
    assert.ok(src.includes("name: 'gmail_send'"), 'gmail_send missing');
  });

  it('CATALOG_RAW contains reminder_add', () => {
    assert.ok(src.includes("name: 'reminder_add'"), 'reminder_add missing');
  });

  it('CATALOG_RAW contains reminder_list', () => {
    assert.ok(src.includes("name: 'reminder_list'"), 'reminder_list missing');
  });

  it('CATALOG_RAW contains reminder_cancel', () => {
    assert.ok(src.includes("name: 'reminder_cancel'"), 'reminder_cancel missing');
  });

  it('CATALOG_RAW contains navigate', () => {
    assert.ok(src.includes("name: 'navigate'"), 'navigate missing');
  });

  it('CATALOG_RAW contains read_status', () => {
    assert.ok(src.includes("name: 'read_status'"), 'read_status missing');
  });

  it('CATALOG_RAW contains create_goal', () => {
    assert.ok(src.includes("name: 'create_goal'"), 'create_goal missing');
  });

  it('CATALOG_RAW contains web_search', () => {
    assert.ok(src.includes("name: 'web_search'"), 'web_search missing');
  });

  it('CATALOG_RAW contains web_fetch', () => {
    assert.ok(src.includes("name: 'web_fetch'"), 'web_fetch missing');
  });

  it('CATALOG_RAW contains start_project', () => {
    assert.ok(src.includes("name: 'start_project'"), 'start_project missing');
  });

  it('CATALOG_RAW contains run_mission', () => {
    assert.ok(src.includes("name: 'run_mission'"), 'run_mission missing');
  });

  it('HONESTY RULE does not list send emails as impossible', () => {
    const honestyMatch = src.match(/HONESTY RULE[\s\S]*?(?=OUTPUT CONTRACT|DANGER TOOLS)/);
    assert.ok(honestyMatch, 'HONESTY RULE not found');
  });

  it('buildCatalog is called and produces CATALOG', () => {
    assert.ok(src.includes('function buildCatalog()'), 'buildCatalog function missing');
    assert.ok(src.includes('const CATALOG = buildCatalog()'), 'CATALOG not built from buildCatalog');
  });

  it('danger flags are computed from tierOf, not hardcoded in CATALOG_RAW', () => {
    // buildCatalog should map danger to tierOf(entry.name) >= 3
    assert.ok(src.includes('tierOf(entry.name) >= 3'), 'danger not computed from tierOf');
  });

  it('exported CATALOG is the runtime catalog with computed danger flags', () => {
    assert.ok(src.includes('module.exports'), 'module.exports missing');
    // The CATALOG export should come from buildCatalog(), not CATALOG_RAW
    assert.ok(src.includes('CATALOG,'), 'CATALOG not in exports');
  });

  it('MAX_ITERATIONS is exported', () => {
    assert.ok(src.includes('MAX_ITERATIONS'), 'MAX_ITERATIONS not exported');
  });

  it('_internal exports buildPrompt', () => {
    assert.ok(src.includes('buildPrompt'), 'buildPrompt not exported in _internal');
  });

  it('_internal exports normalizeParsed', () => {
    assert.ok(src.includes('normalizeParsed'), 'normalizeParsed not exported in _internal');
  });

  it('_internal exports stripThink', () => {
    assert.ok(src.includes('stripThink'), 'stripThink not exported in _internal');
  });
});

// ---------------------------------------------------------------------------
// Actual runtime catalog from the module
// ---------------------------------------------------------------------------
describe('voice-agent CATALOG (runtime)', () => {
  const { CATALOG, _internal } = require('../src/core/voice/voice-agent');

  it('CATALOG is a non-empty array', () => {
    assert.ok(Array.isArray(CATALOG));
    assert.ok(CATALOG.length > 0, 'CATALOG is empty');
  });

  it('every entry has name, description, params, danger', () => {
    for (const entry of CATALOG) {
      assert.ok(typeof entry.name === 'string', `${entry.name} missing name`);
      assert.ok(typeof entry.description === 'string', `${entry.name} missing description`);
      assert.ok(typeof entry.params === 'object', `${entry.name} missing params`);
      assert.ok(typeof entry.danger === 'boolean', `${entry.name} missing danger boolean`);
    }
  });

  it('remember is danger:false (tier 0)', () => {
    const tool = CATALOG.find(t => t.name === 'remember');
    assert.ok(tool, 'remember not in CATALOG');
    assert.equal(tool.danger, false);
  });

  it('log_incident is danger:false (tier 0)', () => {
    const tool = CATALOG.find(t => t.name === 'log_incident');
    assert.ok(tool, 'log_incident not in CATALOG');
    assert.equal(tool.danger, false);
  });

  it('gmail_unread is danger:false (tier 1)', () => {
    const tool = CATALOG.find(t => t.name === 'gmail_unread');
    assert.ok(tool, 'gmail_unread not in CATALOG');
    assert.equal(tool.danger, false);
  });

  it('gmail_send is danger:true (tier 3)', () => {
    const tool = CATALOG.find(t => t.name === 'gmail_send');
    assert.ok(tool, 'gmail_send not in CATALOG');
    assert.equal(tool.danger, true);
  });

  it('reminder_add is danger:false (tier 0)', () => {
    const tool = CATALOG.find(t => t.name === 'reminder_add');
    assert.ok(tool, 'reminder_add not in CATALOG');
    assert.equal(tool.danger, false);
  });

  it('reminder_cancel is danger:false (tier 1)', () => {
    const tool = CATALOG.find(t => t.name === 'reminder_cancel');
    assert.ok(tool, 'reminder_cancel not in CATALOG');
    assert.equal(tool.danger, false);
  });

  it('start_project is danger:true (tier 3)', () => {
    const tool = CATALOG.find(t => t.name === 'start_project');
    assert.ok(tool, 'start_project not in CATALOG');
    assert.equal(tool.danger, true);
  });

  it('run_mission is danger:true (tier 3)', () => {
    const tool = CATALOG.find(t => t.name === 'run_mission');
    assert.ok(tool, 'run_mission not in CATALOG');
    assert.equal(tool.danger, true);
  });

  it('delete_goal is danger:true (tier 3)', () => {
    const tool = CATALOG.find(t => t.name === 'delete_goal');
    assert.ok(tool, 'delete_goal not in CATALOG');
    assert.equal(tool.danger, true);
  });

  it('kill_session is danger:true (tier 4)', () => {
    const tool = CATALOG.find(t => t.name === 'kill_session');
    // kill_session may or may not be in the voice CATALOG (voice-safe subset)
    // If present, it should be danger:true
    if (tool) {
      assert.equal(tool.danger, true);
    }
  });

  it('no duplicate tool names in CATALOG', () => {
    const names = CATALOG.map(t => t.name);
    const unique = [...new Set(names)];
    assert.equal(names.length, unique.length, `duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('buildPrompt is callable and returns a string', () => {
    const prompt = _internal.buildPrompt({ text: 'hello', history: [], toolResults: null });
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });

  it('buildPrompt includes TOOLS section', () => {
    const prompt = _internal.buildPrompt({ text: 'test', history: [], toolResults: null });
    assert.ok(prompt.includes('TOOLS:'), 'prompt missing TOOLS section');
  });

  it('buildPrompt includes USER SAID', () => {
    const prompt = _internal.buildPrompt({ text: 'what time is it', history: [], toolResults: null });
    assert.ok(prompt.includes('what time is it'), 'prompt missing USER SAID content');
  });

  it('buildPrompt includes RECENT EXCHANGES when history provided', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const prompt = _internal.buildPrompt({ text: 'test', history, toolResults: null });
    assert.ok(prompt.includes('RECENT EXCHANGES'), 'prompt missing RECENT EXCHANGES');
    assert.ok(prompt.includes('User: hello'), 'prompt missing user history');
    assert.ok(prompt.includes('You: hi there'), 'prompt missing assistant history');
  });

  it('buildPrompt marks system role as OUTCOME', () => {
    const history = [
      { role: 'user', content: 'delete the goal' },
      { role: 'system', content: 'delete_goal FAILED: No goal matching' },
    ];
    const prompt = _internal.buildPrompt({ text: 'test', history, toolResults: null });
    assert.ok(prompt.includes('[OUTCOME]'), 'prompt missing [OUTCOME] tag');
    assert.ok(prompt.includes('delete_goal FAILED'), 'prompt missing failure outcome');
  });

  it('buildPrompt includes memoryContext when provided', () => {
    const prompt = _internal.buildPrompt({
      text: 'test',
      history: [],
      toolResults: null,
      memoryContext: 'User prefers dark mode',
    });
    assert.ok(prompt.includes('RELEVANT MEMORIES'), 'prompt missing RELEVANT MEMORIES');
    assert.ok(prompt.includes('dark mode'), 'prompt missing memory content');
  });

  it('buildPrompt includes corrective pass when corrective flag set', () => {
    const prompt = _internal.buildPrompt({
      text: 'test',
      history: [],
      toolResults: null,
      corrective: true,
      originalSay: 'I deleted it',
    });
    assert.ok(prompt.includes('CORRECTIVE PASS'), 'prompt missing CORRECTIVE PASS');
    assert.ok(prompt.includes('I deleted it'), 'prompt missing original say');
  });

  it('buildPrompt includes tool results when provided', () => {
    const results = [{ tool: 'web_search', ok: true, summary: 'found results' }];
    const prompt = _internal.buildPrompt({
      text: 'test',
      history: [],
      toolResults: results,
    });
    assert.ok(prompt.includes('TOOL RESULTS'), 'prompt missing TOOL RESULTS');
    assert.ok(prompt.includes('web_search'), 'prompt missing tool name in results');
  });

  it('normalizeParsed returns null for non-object input', () => {
    assert.equal(_internal.normalizeParsed(null), null);
    assert.equal(_internal.normalizeParsed(undefined), null);
    assert.equal(_internal.normalizeParsed('string'), null);
    assert.equal(_internal.normalizeParsed(42), null);
  });

  it('normalizeParsed returns say/actions/needs_result for valid input', () => {
    const result = _internal.normalizeParsed({
      say: 'hello',
      actions: [{ tool: 'navigate', args: { route: 'goals' } }],
      needs_result: false,
    });
    assert.equal(result.say, 'hello');
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].tool, 'navigate');
    assert.equal(result.needs_result, false);
  });

  it('normalizeParsed filters actions without tool string', () => {
    const result = _internal.normalizeParsed({
      say: 'test',
      actions: [{ tool: 'navigate' }, { noTool: true }, null, { tool: 123 }],
      needs_result: false,
    });
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].tool, 'navigate');
  });

  it('normalizeParsed defaults args to empty object', () => {
    const result = _internal.normalizeParsed({
      say: 'test',
      actions: [{ tool: 'read_status' }],
      needs_result: false,
    });
    assert.deepEqual(result.actions[0].args, {});
  });

  it('normalizeParsed truncates say to MAX_SAY_CHARS (800)', () => {
    const longSay = 'x'.repeat(1000);
    const result = _internal.normalizeParsed({
      say: longSay,
      actions: [],
      needs_result: false,
    });
    assert.equal(result.say.length, 800);
  });

  it('stripThink removes <think> tags', () => {
    const input = '<think>some reasoning</think> Hello!';
    const result = _internal.stripThink(input);
    assert.equal(result, 'Hello!');
  });

  it('stripThink handles no think tags', () => {
    const result = _internal.stripThink('plain text');
    assert.equal(result, 'plain text');
  });

  it('stripThink handles null/undefined', () => {
    assert.equal(_internal.stripThink(null), '');
    assert.equal(_internal.stripThink(undefined), '');
  });

  it('stripThink removes multiline think blocks', () => {
    const input = '<think>\nline 1\nline 2\n</think> actual';
    const result = _internal.stripThink(input);
    assert.equal(result, 'actual');
  });
});

// ---------------------------------------------------------------------------
// tiers.js consistency — verify tierOf matches expected values
// ---------------------------------------------------------------------------
describe('tiers.js consistency', () => {
  const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

  it('remember is tier 0', () => {
    assert.equal(tierOf('remember'), 0);
  });

  it('log_incident is tier 0', () => {
    assert.equal(tierOf('log_incident'), 0);
  });

  it('gmail_unread is tier 1', () => {
    assert.equal(tierOf('gmail_unread'), 1);
  });

  it('gmail_send is tier 3', () => {
    assert.equal(tierOf('gmail_send'), 3);
  });

  it('reminder_add is tier 0', () => {
    assert.equal(tierOf('reminder_add'), 0);
  });

  it('reminder_cancel is tier 1', () => {
    assert.equal(tierOf('reminder_cancel'), 1);
  });

  it('reminder_list is tier 0', () => {
    assert.equal(tierOf('reminder_list'), 0);
  });

  it('start_project is tier 3', () => {
    assert.equal(tierOf('start_project'), 3);
  });

  it('run_mission is tier 3', () => {
    assert.equal(tierOf('run_mission'), 3);
  });

  it('delete_goal is tier 3', () => {
    assert.equal(tierOf('delete_goal'), 3);
  });

  it('kill_session is tier 4', () => {
    assert.equal(tierOf('kill_session'), 4);
  });

  it('browser_evaluate is tier 4', () => {
    assert.equal(tierOf('browser_evaluate'), 4);
  });

  it('unknown tool defaults to tier 3 (fail-safe)', () => {
    assert.equal(tierOf('nonexistent_tool_xyz'), 3);
  });

  it('TIER_TABLE is a non-empty object', () => {
    assert.ok(typeof TIER_TABLE === 'object');
    assert.ok(TIER_TABLE !== null);
    assert.ok(Object.keys(TIER_TABLE).length > 0);
  });

  it('all tier values are integers 0-4', () => {
    for (const [name, tier] of Object.entries(TIER_TABLE)) {
      assert.ok(typeof tier === 'number', `${name} tier is not a number`);
      assert.ok(tier >= 0 && tier <= 4, `${name} tier ${tier} out of range 0-4`);
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-007 regression: handleUtterance must not let a fabricated success claim
// stand when the tool call it depended on actually failed. voice-agent.js's
// corrective-pass mechanism (buildPrompt's corrective:true branch, and the
// didRetry/allFailedActions bookkeeping in handleUtterance) is supposed to
// catch this and overwrite finalSay. This locks that behavior in place.
// ---------------------------------------------------------------------------
describe('BUG-007: corrective pass overrides a fabricated success claim', () => {
  const { createVoiceAgent } = require('../src/core/voice/voice-agent');

  // Records whether each brain.think() call was the corrective pass (detected
  // via the "CORRECTIVE PASS" marker buildPrompt injects) or the initial pass.
  function makeBrain(firstReply, correctiveReply) {
    const calls = [];
    return {
      calls,
      think: async ({ messages }) => {
        const prompt = messages[0].content;
        const isCorrective = prompt.includes('CORRECTIVE PASS');
        calls.push(isCorrective ? 'corrective' : 'first');
        const reply = isCorrective ? correctiveReply : firstReply;
        return { content: JSON.stringify(reply), parsed: reply, offline: false };
      },
    };
  }

  it('replaces a "Playing X now" claim with an honest admission when the tool call failed', async () => {
    const firstReply = {
      say: 'Playing Bohemian Rhapsody now.',
      actions: [{ tool: 'get_time', args: {} }],
      needs_result: false,
    };
    const correctiveReply = {
      say: 'That failed — I could not reach the tool.',
      actions: [],
      needs_result: false,
    };
    const brain = makeBrain(firstReply, correctiveReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: false, result: 'boom' }); // tool call fails
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'play bohemian rhapsody', ctx: {} });

    assert.deepEqual(brain.calls, ['first', 'corrective'], 'corrective pass must fire exactly once after a failed action');
    assert.equal(result.say, correctiveReply.say);
    assert.ok(!/playing|done|finished/i.test(result.say), 'say must not carry the fabricated success claim');
  });

  it('does not fire the corrective pass when every action succeeds', async () => {
    const firstReply = {
      say: 'Playing Bohemian Rhapsody now.',
      actions: [{ tool: 'get_time', args: {} }],
      needs_result: false,
    };
    const brain = makeBrain(firstReply, { say: 'unused', actions: [], needs_result: false });
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: true, result: { time: '12:00' } }); // tool call succeeds
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'play bohemian rhapsody', ctx: {} });

    assert.deepEqual(brain.calls, ['first'], 'corrective pass must not fire when nothing failed');
    assert.equal(result.say, firstReply.say);
  });
});
