'use strict';

// BUG-459 — the tool text the voice model is SENT, not the copy the tests read.
//
// 2026-09-24, attended run. At 15:05:37 the operator asked "Can you open that link
// on my browser?" and MYTHOS answered "I don't have a tool to open links in your
// real browser window directly", then logged an incident against itself. At
// 15:09:53, asked to open YouTube and play the third video, it chose open_web
// type:"youtube" and said "I can't click that third video for you". Both were
// false: browser_launch_debug + browser_navigate opened the link at 15:06:42, and
// browser_snapshot + browser_click played the third video at 15:11:24.
//
// Why the existing guards could not see it (class 14). open-web-is-not-a-browser
// and bug-398's E3 block both read open_web's description in from-dashboard.js.
// The Live model never received that text: voice-agent.js's buildCatalogFromHub
// lets a CATALOG_RAW entry's description REPLACE the hub's, and CATALOG_RAW had
// its own open_web copy whose first sentence was "this does NOT open a browser
// window and is NOT your real browser" — with browser:true explained only later.
// The system prompt's BROWSER RULE added "open_web opens nothing". Measured
// against the real hub, that override is one of 46 (42 reach Live), and simply
// deleting it would have made things worse: the hub text was 1841 chars and
// toDeclaration silently cut every description at 1024, which dropped everything
// about browser:true and named browsers. think_deeply was already being cut.
//
// So this file asserts on what is EMITTED (buildFunctionDeclarations over a hub
// shaped exactly like adapter.js's describeMeta), over a tool set DERIVED from
// the code (sync-test-count's computeEffectorTools — the same set the effector
// count uses; on 2026-09-24 it matched a real boot of src/main.js tool for tool,
// 189 of 189, every unedited description byte-identical).
//
// Mutation probes (a)-(i) and their dated results are recorded in BUGS.md,
// BUG-459's Proof paragraph, and in the commit that added this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeEffectorTools } = require('../scripts/sync-test-count');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { buildCatalogFromHub, CATALOG, RULES } = require('../src/core/voice/voice-agent');
const { buildFunctionDeclarations, DEFAULT_ALLOWLIST, _internal } = require('../src/core/voice/live-tools');

const MAX = _internal.DESCRIPTION_MAX_CHARS;

// adapter.js:90's describeMeta shape — what hub.catalog() really returns.
function hubOf(tools) {
  return { catalog: () => tools.map((t) => ({ name: t.name, description: t.description, params: t.params, needs_result: !!t.needs_result })) };
}

function dashboardTools() {
  return buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
  }).TOOLS;
}

let derivedCache = null;
function derivedTools() {
  if (!derivedCache) derivedCache = computeEffectorTools().tools;
  return derivedCache;
}

function emittedOpenWeb() {
  const tools = dashboardTools();
  const { declarations } = buildFunctionDeclarations(hubOf(tools), {});
  const decl = declarations.find((d) => d.name === 'open_web');
  assert.ok(decl, 'open_web must be declared to Live');
  return { decl, hubText: tools.find((t) => t.name === 'open_web').description };
}

function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

// A sentence that tells the model open_web cannot put a page in a browser.
// Deliberately broad: the incident was a model reading exactly this and
// believing it. ATTACKED 2026-09-24 before shipping. The first version required
// the negation right before "open" and missed six crafted denials ("will not
// open a browser", "has no way to open a link in your browser", "cannot use it
// to open links", "is unable to open", "does not ever open", and the model's own
// 15:05:37 "I don't have a tool to open links"); this form catches those six
// and the two the first version already caught, 8 of 8, and among the 16 real
// sentences it reads flags only the first one, which names browser:true.
// Widening it flagged one true sentence, RULES' PLAYBACK HONESTY RULE ("Never
// SAY a video is ... opened ... browser"), where the negation governs saying,
// not opening — hence the say/claim/tell/report exclusion. Known bound: a
// denial with no "open" verb at all ("it is not a browser") is not matched.
const DENIES_OPENING = /\b(?:not|never|cannot|can'?t|won'?t|unable\s+to|no\s+way\s+to)\b(?!\s+(?:say|claim|tell|report)\b)[^.]{0,40}?\bopen(?:s|ed|ing)?\b[^.]*\bbrowser|\bopens\s+nothing\b|\b(?:no|don'?t\s+have\s+a)\s+tool\s+(?:to|that\s+can)\s+open\b/i;

describe('BUG-459 — the open_web text Live receives is the canonical one, whole', () => {
  it('(a) the emitted declaration IS the hub description, not a replacement and not cut', () => {
    const { decl, hubText } = emittedOpenWeb();
    assert.ok(hubText.length <= MAX,
      'open_web\'s description is ' + hubText.length + ' chars; toDeclaration cuts at ' + MAX
      + ' and the browser:true / named-browser sentences are the ones a cut removes first');
    assert.equal(decl.description, hubText,
      'the model must be sent the text the guards read — a CATALOG_RAW override replacing it is how '
      + 'BUG-459 got past two test files that were both green');
  });

  it('(b) no sentence denies opening a browser without naming browser:true — declaration AND prompt', () => {
    const { decl } = emittedOpenWeb();
    const promptLines = sentences(RULES).filter((s) => /open_web/.test(s));
    assert.ok(promptLines.length > 0, 'RULES must still mention open_web, or this check proves nothing');
    for (const s of sentences(decl.description).concat(promptLines)) {
      if (DENIES_OPENING.test(s)) {
        assert.match(s, /browser:true/,
          'this sentence tells the model open_web cannot open a browser, and does not name the flag '
          + 'that does. At 15:05:37 the model believed it: "' + s + '"');
      }
    }
    assert.ok(sentences(decl.description).some((s) => /browser:true[^.]*\b(?:hands|opens)\b[^.]*\breal browser/i.test(s)),
      'the description must SAY that browser:true puts the url in the operator\'s real browser');
  });

  it('(c) the self-capability snapshot line is not a denial either', () => {
    // identity/capabilities.js writes the first 160 chars of each description into
    // capabilities.md, which self_capabilities reads back to the model.
    const { hubText } = emittedOpenWeb();
    const line = hubText.split('\n')[0].slice(0, 160);
    if (DENIES_OPENING.test(line)) assert.match(line, /browser:true/, 'capabilities.md line: ' + line);
  });

  it('(d) every tool the description names is one the Live model can call', () => {
    const { decl } = emittedOpenWeb();
    const hubNames = new Set(derivedTools().map((t) => t.name));
    const allow = new Set(DEFAULT_ALLOWLIST);
    const named = [...new Set(decl.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [])].filter((n) => hubNames.has(n));
    assert.ok(named.length >= 4, 'expected the description to name its routes, found: ' + named.join(', '));
    for (const n of named) assert.ok(allow.has(n), n + ' is named in open_web\'s description but withheld from Live');
    for (const n of ['browser_launch_debug', 'browser_navigate', 'browser_snapshot', 'browser_click']) {
      assert.ok(named.includes(n), n + ' — the route that opened the link at 15:06:42 and played the third '
        + 'video at 15:11:24 — must be named');
    }
  });

  it('(e) "play the third video" is routed to the browser, and youtube says it cannot pick one', () => {
    const { decl } = emittedOpenWeb();
    const third = sentences(decl.description).find((s) => /third video/.test(s));
    assert.ok(third && /browser_navigate/.test(third), 'the golden-path request needs a route: ' + third);
    const yt = sentences(decl.description).find((s) => /type:"youtube"/.test(s));
    assert.ok(yt && /cannot pick/.test(yt),
      'type:"youtube" picks a video itself; a model that thinks it can choose "the third one" will try: ' + yt);
  });

  it('(f) the named-browser rule (BUG-435) now reaches Live — the override had dropped it', () => {
    const { decl } = emittedOpenWeb();
    assert.match(decl.description, /NAMES? a browser/);
    assert.match(decl.description, /BUG-435/);
  });
});

// The rest of the class. Deleting every override at once would change the text
// of 45 other tools the voice model reads, untested live — that is a rewrite, not
// this fix. So the set is frozen and can only shrink: a new CATALOG_RAW
// description for a hub tool fails here, and so does leaving a name on this list
// after its override is removed. Six of these currently match the hub word for
// word; they are listed anyway, because a second copy drifts whether or not it
// has yet.
const KNOWN_OVERRIDES = [
  'navigate', 'close_panel', 'read_status', 'read_system_specs', 'job_status', 'open_artifact',
  'delete_artifact', 'create_goal', 'list_goals', 'toggle_goal', 'delete_goal', 'capture_idea',
  'pipeline_status', 'pipeline_advance', 'pipeline_execute', 'kanban_status', 'kanban_add_card',
  'kanban_move_card', 'kanban_assemble', 'kanban_build_card', 'ask_agent', 'start_project',
  'run_mission', 'mission_status', 'build_project', 'revise_project', 'project_status', 'get_time',
  'get_weather', 'web_fetch', 'web_search', 'gmail_unread', 'gmail_read', 'gmail_send', 'gmail_draft',
  'remember', 'forget_fact', 'log_incident', 'reminder_add', 'reminder_list', 'reminder_cancel',
  'use_skill', 'spotify_play', 'spotify_search', 'spotify_play_pause', 'spotify_next',
  'spotify_previous', 'spotify_volume', 'spotify_status', 'send_key', 'media_status',
];

describe('BUG-459 — the override ratchet and the length cut, over the derived tool set', () => {
  it('(g) the set of voice-agent descriptions that replace a hub description can only shrink', () => {
    const hubNames = new Set(derivedTools().map((t) => t.name));
    assert.ok(hubNames.size > 100, 'derived tool set looks empty (' + hubNames.size + ') — this check would pass vacuously');
    const overrides = CATALOG.filter((e) => hubNames.has(e.name) && e.description).map((e) => e.name);
    const known = new Set(KNOWN_OVERRIDES);
    const added = overrides.filter((n) => !known.has(n));
    assert.deepEqual(added, [],
      'a CATALOG_RAW description now REPLACES the hub text for: ' + added.join(', ')
      + '. Put the wording in the hub registration instead — the voice model is sent the replacement.');
    const gone = KNOWN_OVERRIDES.filter((n) => !overrides.includes(n));
    assert.deepEqual(gone, [], 'these overrides are gone — remove them from KNOWN_OVERRIDES: ' + gone.join(', '));
    assert.ok(!overrides.includes('open_web'), 'open_web must never carry a voice-agent copy again');
  });

  it('(h) no description declared to Live is cut, across every derived tool', () => {
    const logs = [];
    const { truncated, declarations } = buildFunctionDeclarations(hubOf(derivedTools()), { log: (l) => logs.push(l) });
    assert.ok(declarations.length > 50, 'expected the real allowlisted catalog, got ' + declarations.length);
    assert.deepEqual(truncated, [], 'cut at ' + MAX + ' chars, so the model never reads the ending: ' + truncated.join(', '));
    assert.equal(logs.filter((l) => /were CUT/.test(l)).length, 0);
  });

  it('(i) a cut is reported by name, not silent — and the boundary itself is not a cut', () => {
    const allowlist = ['long_tool', 'exact_tool'];
    const tools = [
      { name: 'long_tool', description: 'x'.repeat(MAX + 1), params: {} },
      { name: 'exact_tool', description: 'y'.repeat(MAX), params: {} },
    ];
    const logs = [];
    const res = buildFunctionDeclarations(hubOf(tools), { allowlist, log: (l) => logs.push(l) });
    assert.deepEqual(res.truncated, ['long_tool']);
    assert.ok(logs.some((l) => /were CUT/.test(l) && /long_tool/.test(l) && !/exact_tool/.test(l)),
      'the log must name what was cut, and only that: ' + logs.join(' | '));
    assert.equal(res.declarations.find((d) => d.name === 'exact_tool').description.length, MAX);
  });

  it('ADJACENT: a deliberate voice-only wording still wins — the precedence was not flipped wholesale', () => {
    const merged = buildCatalogFromHub(hubOf(derivedTools()));
    const nav = merged.find((e) => e.name === 'navigate');
    const raw = CATALOG.find((e) => e.name === 'navigate');
    assert.ok(nav && raw);
    assert.equal(nav.description, raw.description,
      'navigate\'s route enum / "no news route" wording is a voice-channel decision and must keep reaching the model');
  });
});
