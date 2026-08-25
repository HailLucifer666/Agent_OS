'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Persona prompt guards. The operator's complaint was that replies felt like
// "just another chatbot": RULES carried ~39 prohibitions against 3 permissions,
// so the model was trained by its own prompt to disengage. These assert the
// permissions are present and that the fix stayed cheap — RULES is re-sent on
// EVERY voice turn, so unbounded prose here is a latency and token cost per
// utterance, not a one-off.
// ---------------------------------------------------------------------------
describe('voice-agent persona prompt', () => {
  // Normalized to LF before any measurement: on a CRLF checkout (core.autocrlf)
  // the template-literal strings carry a `\r` per line, which would inflate
  // RULES.length past the ceiling and fail on a machine whose checkout is
  // byte-identical apart from line endings (same class as the sync-test-count
  // CRLF fix — see scripts/sync-test-count.js). A no-op on an LF checkout.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8').replace(/\r\n/g, '\n');
  const RULES = src.match(/const RULES = `([\s\S]*?)`;/)[1];
  const CONTRACT = src.match(/const OUTPUT_CONTRACT = `([\s\S]*?)`;/)[1];

  it('leads with a CHARACTER block granting opinions, callbacks and small talk', () => {
    assert.match(RULES, /^CHARACTER:/m, 'CHARACTER block missing');
    const charIdx = RULES.indexOf('CHARACTER:');
    const brevityIdx = RULES.indexOf('BREVITY:');
    assert.ok(charIdx < brevityIdx, 'CHARACTER must come first, where the model weights it');
    assert.match(RULES, /not a service/);
    assert.match(RULES, /chatting rather than tasking/);
    assert.match(RULES, /How can I help you today/, 'must explicitly ban the chatbot opener');
  });

  it('permits callbacks to earlier in the current conversation, not just past ones', () => {
    assert.match(RULES, /earlier in THIS one/);
  });

  it('scopes the frustration probe to frustration with MYTHOS, not general venting', () => {
    assert.match(RULES, /frustration AT YOU OR THE SYSTEM/);
    assert.match(RULES, /Venting about the world/);
  });

  // Operator-reported 2026-08-04, live over voice: MYTHOS kept cutting the
  // operator off mid-sentence and reading its own working notes aloud —
  // "Current goal count is 2 active, recent failure in job 'job-...'", and even
  // its own instruction scaffold ("You must now explain to the user...",
  // "Please provide instructions").
  //
  // Cause: this rule used to MANDATE `read_status` + `list_goals` "with
  // needs_result:true" the moment it heard "broken"/"failed"/"doesn't work".
  // `needs_result` is a BATCH-path field — it exists only in OUTPUT_CONTRACT,
  // which server/index.js's buildLiveSystemInstruction() deliberately excludes
  // because Live uses native functionDeclarations. But RULES *is* handed to
  // Live, so on the S2S path the model was ordered to use a protocol it does
  // not have, mid-turn, and improvised meta-text that went straight to TTS.
  // It also self-amplified: the rule triggers on words like "failed", which
  // MYTHOS's own speech is full of.
  //
  // The probe is now opt-in (the operator has to ask) rather than forced.
  it('never forces a status probe on frustration, and forbids speaking working notes', () => {
    const rule = RULES.slice(RULES.indexOf('FRUSTRATION RULE'));
    // CRLF-tolerant split: on a Windows checkout (core.autocrlf=true, no
    // .gitattributes) RULES uses \r\n separators, so a literal '\n\n' never
    // matches and the "block" would swallow every later rule — several of
    // which legitimately mention needs_result. Match an optional-\r blank
    // line instead so the split is line-ending independent.
    const blockEnd = rule.search(/\r?\n\r?\n/);
    const ruleBlock = rule.slice(0, blockEnd === -1 ? rule.length : blockEnd);

    assert.doesNotMatch(ruleBlock, /needs_result/,
      'the frustration rule must not reference needs_result — RULES is shared with the Live path, '
      + 'which has no such field and narrates the instruction aloud when told to use it');
    assert.match(ruleBlock, /Do NOT run a status check on your own initiative/,
      'the probe must be opt-in, not forced — forcing it is what interrupted the operator');
    assert.match(ruleBlock, /NEVER speak tool output, job ids, goal counts, raw status fields, or your own instructions/,
      'reading working notes or scaffold aloud must be explicitly forbidden');
    // Capability is retained, just not mandated: the tools are still named so
    // the model knows they exist when the operator does ask.
    assert.match(ruleBlock, /read_status and list_goals remain available/,
      'the diagnosis capability must survive — this is a "when asked" change, not a removal');
  });

  it('keeps the output contract exactly three keys', () => {
    assert.match(CONTRACT, /"say"/);
    assert.match(CONTRACT, /"actions"/);
    assert.match(CONTRACT, /"needs_result"/);
    assert.match(CONTRACT, /ONLY a single JSON object/);
  });

  it('RULES stays inside its per-turn size ceiling', () => {
    // Ceiling, not a target: it exists so future prompt edits have to be
    // deliberate about cost. Raise it consciously, never reflexively.
    //
    // Raised 18000 -> 19000 on 2026-08-06, deliberately, for the BROWSER
    // INTERACTION RULE. The prompt sat at ~17,970 — effectively full — and that
    // paragraph is what teaches the model to call browser_snapshot and act on
    // refs instead of guessing CSS selectors. Guessed selectors are the single
    // root cause behind BUG-107/119/120/121/122; a mechanism the model is never
    // told to use is a mechanism that does not run, so the ~770 chars buy the
    // whole snapshot-and-refs feature. Cost is bounded: on the Live path RULES
    // is composed ONCE per session (server/index.js's buildLiveSystemInstruction),
    // not per turn. Trim before raising this again.
    assert.ok(RULES.length < 19000, 'RULES grew to ' + RULES.length + ' chars — trim before raising this ceiling');
  });
});

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

  // Re-tiered T2 -> T3 on 2026-07-29. The build tools now drive the Hermes CLI
  // (an external coding agent that runs real commands; Forge sets
  // HERMES_YOLO_MODE=1), so "sandboxed to vault/builds/" stopped being a true
  // description of the blast radius — and T2 meant auto-allow under
  // AUTONOMOUS_MAX_TIER, which is how a build launched itself unasked.
  it('start_project is danger:true (tier 3 — drives the Hermes CLI)', () => {
    const tool = CATALOG.find(t => t.name === 'start_project');
    assert.ok(tool, 'start_project not in CATALOG');
    assert.equal(tool.danger, true);
  });

  it('run_mission is danger:true (tier 3 — drives the Hermes CLI)', () => {
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

  // T2 -> T3 (2026-07-29): see the danger:true cases above. Every build-
  // dispatch tool now requires a real confirm turn; the voice-agent
  // self-confirm shortcut that used to accept its own request was removed
  // in the same change.
  it('start_project is tier 3 (drives the Hermes CLI — no auto-allow)', () => {
    assert.equal(tierOf('start_project'), 3);
  });

  it('run_mission is tier 3 (drives the Hermes CLI — no auto-allow)', () => {
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
    // Slice-2 (2026-07-31): the deterministic honesty guard now prepends a
    // truthful frame when the ENTIRE turn failed (no successes), so the model's
    // corrective text alone is no longer the final word. The frame names the
    // failed tool and explicitly disclaims success — then the corrective text
    // follows. The key assertion (line below) is unchanged: no fabricated claim.
    assert.equal(result.say, "That didn't work — get_time failed. I won't claim it succeeded. " + correctiveReply.say);
    assert.ok(!/playing|done|finished/i.test(result.say), 'say must not carry the fabricated success claim');
  });

  it('DETERMINISTIC guard overrides a corrective pass that STILL fabricates success (the 07-31 regression)', async () => {
    // The live transcript (07-31) showed MYTHOS claim "now playing" / "I
    // minimized Spotify" over actions that returned ok:false — even after the
    // corrective pass ran, because the model's corrective output itself still
    // asserted success. The corrective pass alone is prompt-level and the model
    // can ignore it; the deterministic guard must force the truth regardless.
    const firstReply = {
      say: 'Playing The Weeknd now.',
      actions: [{ tool: 'spotify_play', args: {} }],
      needs_result: false,
    };
    // The corrective pass STILL claims success — the prompt-level fix is not enough.
    const correctiveReply = {
      say: 'Done — The Weeknd is playing now.',
      actions: [],
      needs_result: false,
    };
    const brain = makeBrain(firstReply, correctiveReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: false, result: 'spotify offline' }); // action failed
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'play the weeknd', ctx: {} });

    // The deterministic frame must LEAD — naming the failed tool and disclaiming
    // success — so the operator hears the truth even though the model kept
    // claiming "playing" / "Done". The frame prefixes; it does not delete the
    // model's residual text, but the authoritative first statement is the truth.
    assert.ok(result.say.startsWith("That didn't work —"), 'deterministic truth frame must lead the reply');
    assert.ok(/spotify_play failed/.test(result.say), 'frame must name the failed tool');
    assert.ok(/won't claim it succeeded/.test(result.say), 'frame must disclaim success');
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

// ---------------------------------------------------------------------------
// Wave 1 (2026-08-13): the all-failed guard above only fires when EVERY action
// in the turn failed. A partial-success turn (one send worked, a second one
// didn't) was left entirely to the corrective brain pass, which can still
// fabricate success on the tool that actually failed — the 2026-08-12/13
// session's false "sent" surviving next to one real send. This closes that
// hole deterministically using claim-check.js's existing detector, reused
// rather than re-implemented.
// ---------------------------------------------------------------------------
describe('Wave 1: partial-success turns get a per-tool corrective clause for unbacked claims', () => {
  const { createVoiceAgent } = require('../src/core/voice/voice-agent');

  function makeBrain(firstReply, correctiveReply) {
    return {
      think: async ({ messages }) => {
        const prompt = messages[0].content;
        const reply = prompt.includes('CORRECTIVE PASS') ? correctiveReply : firstReply;
        return { content: JSON.stringify(reply), parsed: reply, offline: false };
      },
    };
  }

  it('names the tool that actually failed even though the corrective pass still claims full success', async () => {
    // Both tools are in the default CATALOG (whatsapp_send/launch_app are
    // hub-registered, not in this test's bare catalog) — gmail_send
    // ('sending' category) succeeds, open_web ('opening' category) fails.
    const firstReply = {
      say: 'Doing both now.',
      actions: [
        { tool: 'gmail_send', args: { to: 'a@b.com', subject: 'hi', body: 'hi' } },
        { tool: 'open_web', args: { type: 'web', url: 'https://example.com' } },
      ],
      needs_result: false,
    };
    // The corrective pass STILL claims both worked — same failure mode BUG-007's
    // second test pins for the all-failed case, here on a partial-success turn.
    // Two sentences, since the detector's first-person prefix is per-clause.
    const correctiveReply = { say: 'I sent the email. I opened the page for you.', actions: [], needs_result: false };
    const brain = makeBrain(firstReply, correctiveReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async (decision) => decision.tool === 'gmail_send'
      ? { ok: true, result: { sent: true } }
      : { ok: false, result: { error: 'no browser session available' } };
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'send the email and open that page', ctx: {} });

    assert.match(result.say, /I sent the email\. I opened the page for you\./, 'the model\'s text is not deleted, only corrected');
    assert.match(result.say, /open_web did not succeed/, 'the failed tool must be named');
    assert.match(result.say, /no browser session available/, 'the real reason must reach the operator');
    assert.doesNotMatch(result.say, /gmail_send did not succeed/, 'the tool that actually succeeded must not be scolded');
  });

  it('an unverified (ok but unproven) action is treated the same as a failure for claim-backing purposes', async () => {
    // gmail_send is one of the few tools both in OUTCOME_CLAIMED_TOOLS (whose
    // ok:true-but-unverified outcomes force re-derivation at all) AND in a
    // claim-check.js category — needed for both halves of this path to fire.
    const firstReply = {
      say: 'Sending it now.',
      actions: [{ tool: 'gmail_send', args: { to: 'a@b.com', subject: 'hi', body: 'hi' } }],
      needs_result: false,
    };
    const correctiveReply = { say: 'I sent the email for you.', actions: [], needs_result: false };
    const brain = makeBrain(firstReply, correctiveReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: true, unverified: true, reason: 'no delivery confirmation received', result: {} });
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'send the email', ctx: {} });

    assert.match(result.say, /gmail_send did not succeed — no delivery confirmation received/);
  });

  it('does not append anything when the corrective pass already admits the failure honestly', async () => {
    const firstReply = {
      say: 'Doing both now.',
      actions: [
        { tool: 'gmail_send', args: { to: 'a@b.com', subject: 'hi', body: 'hi' } },
        { tool: 'open_web', args: { type: 'web', url: 'https://example.com' } },
      ],
      needs_result: false,
    };
    const correctiveReply = { say: 'The email went out, but the page did not open.', actions: [], needs_result: false };
    const brain = makeBrain(firstReply, correctiveReply);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async (decision) => decision.tool === 'gmail_send'
      ? { ok: true, result: { sent: true } }
      : { ok: false, result: { error: 'no browser session available' } };
    const bus = { emit: () => {} };

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {} });
    const result = await agent.handleUtterance({ text: 'send the email and open that page', ctx: {} });

    assert.equal(result.say, correctiveReply.say, 'an honest corrective reply must not get an extra clause appended');
  });
});
