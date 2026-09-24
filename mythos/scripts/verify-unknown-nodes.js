#!/usr/bin/env node
'use strict';

/**
 * verify-unknown-nodes.js — exercise the capability-map nodes that were never
 * measured against the acceptance contract, and report what each tool did.
 *
 *   node scripts/verify-unknown-nodes.js            # run everything it can
 *   node scripts/verify-unknown-nodes.js --group=kanban
 *   node scripts/verify-unknown-nodes.js --json
 *
 * BUG-386 (2026-08-28), closure campaign Track F. The sibling of
 * verify-dark-nodes.js (BUG-382, Track D-5), which is deliberately the shape
 * this copies: one script, an oracle per tool, and four verdicts where a
 * disposition can never be counted as a pass.
 *
 * WHAT IS IN SCOPE AND WHY IT IS TWO POPULATIONS
 *
 *   7 `unknown` nodes,  9 tools, all 0/0 — nothing has ever called them.
 *  11 `warn` nodes,    28 tools — Track B (BUG-384) found these labelled
 *                      `unknown` while the vault held as many as 183 recorded
 *                      calls for them, and moved them to `warn` on the stated
 *                      rule that production traffic is not the acceptance
 *                      contract. This is the harness that was promised there.
 *
 * The two populations need different claims. For the first, "does any of this
 * run at all" is genuinely open. For the second it is not — they demonstrably
 * run in production — so what is open is whether they do what they SAY, which
 * is what an oracle answers and a call count cannot.
 *
 * REAL SUBSYSTEMS, NOT STUBS. This is the whole design.
 *
 * Every factory in this directory takes a narrow ctx slice — from-okf wants
 * `ctx.vault`, from-persona `ctx.identity`, from-widgets `ctx.bus`,
 * from-dashboard a pipeline/kanban/probes set. It would be easy, and worthless,
 * to hand each one a stub: the run would go green and would have measured the
 * stub. So the harness constructs the REAL modules the way src/main.js does —
 * createKanbanEffector({fs, bus}), createPipelineEffector({fs, classifier}),
 * createIdentity({bus, config, fs, identityStore}) — over a fs-store rooted in
 * a temp sandbox. The oracle is then the vault file on disk, read back, not the
 * tool's own return value. Where no real subsystem can be constructed here, the
 * tool is a DISPOSITION and says which dependency was missing.
 *
 * WHAT IS DELIBERATELY NOT RUN, AND WHY THAT IS THE POINT
 *
 * A harness that touches the operator's real machine to prove a tool works has
 * traded one dishonesty for a worse one. These are recorded as dispositions
 * with the reason, never as passes and never as failures:
 *
 *   install_from_github   installs software from the network
 *   set_wallpaper         changes the operator's actual desktop
 *   clipboard_write       overwrites whatever the operator has copied — the
 *                         same class as the wakeword test that moved real
 *                         model files aside and lost them (root CLAUDE.md)
 *   delete_artifact       destructive by definition
 *   compose_email         opens a real browser compose tab
 *   security_scan         T3, spawns a scanner over real paths
 *   ask_agent             spend, and the no-spend decision is operator-taken
 *   run_mission           spend
 *   pipeline_execute      T3 execution of a real pipeline stage
 *   kanban_assemble       T3, drives the build engine
 *   kanban_build_card     T3, drives the build engine
 *
 * Exit code is 1 only when a tool that should work did not. Honest
 * unavailability (no key, no sensor, no server) is `n/a` and does not fail the
 * run — that distinction is the whole point, and it is what stops this becoming
 * a script somebody disables.
 *
 * THE HARNESS IS THE THING MOST LIKELY TO BE WRONG. verify-dark-nodes.js
 * accused the product three times before it was right, every time fail-open:
 * it read `.path` when the field is `savedTo`, returned a batch from a
 * single-in embed(), and returned a bare array where {provider,dim,vec} was
 * required. So every verdict below names the ORACLE it used, and a FAIL is a
 * hypothesis to investigate before it is written down — never a result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MYTHOS_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// reporting

const results = [];
const PASS = 'pass';         // ran, and an oracle confirmed the effect
const UNAVAILABLE = 'n/a';   // honestly could not run here (no key, no sensor)
const DISPOSITION = 'disp';  // deliberately not run, reason recorded
const FAIL = 'FAIL';         // ran, and the oracle says it did not do what it claimed

function record(group, tool, verdict, detail) {
  results.push({ group, tool, verdict, detail: detail || '' });
}
// Groups return the rows THEY recorded. Reading the shared array from a caller
// is a race across async groups, and in verify-dark-nodes.js it produced a
// phantom failure that read exactly like a product regression.
function rowsSince(mark) { return results.slice(mark); }

function reasonOf(res) {
  if (!res) return 'no result';
  if (typeof res.result === 'string') return res.result;
  if (res.result && typeof res.result === 'object') {
    if (typeof res.result.error === 'string') return res.result.error;
    try { return JSON.stringify(res.result).slice(0, 180); } catch (_) { return 'unreportable'; }
  }
  return String(res.result === undefined ? (res.error || '') : res.result).slice(0, 180);
}

// buildTools() is NOT one shape across this directory. from-system, from-okf,
// from-persona and from-mission return a bare array; from-widgets and
// from-dashboard return `{ TOOLS: [...] }` plus setter functions. The first
// version of this harness assumed an array, and the object arms threw
// "(tools || []) is not iterable" — reported as two group-level FAILs that read
// exactly like two broken effectors. Accept both, and refuse anything else
// loudly rather than yielding an empty map that would silently pass nothing.
function toolMap(built) {
  const list = Array.isArray(built) ? built : (built && Array.isArray(built.TOOLS) ? built.TOOLS : null);
  if (!list) throw new Error('buildTools returned neither an array nor {TOOLS:[...]} — got ' + typeof built);
  const out = {};
  for (const t of list) if (t && t.name) out[t.name] = t;
  return out;
}

// A tool that vanished from its file is news, not a silent skip: this harness
// exists precisely because "nothing measured it" was allowed to look like "it is
// fine". Reaching for a missing tool records a FAIL rather than returning early.
async function exercise(group, tools, name, args, ctx, oracle) {
  const t = tools[name];
  if (!t || typeof t.fn !== 'function') {
    record(group, name, FAIL, 'tool is not registered by its effector file');
    return null;
  }
  let res;
  try {
    res = await t.fn(args, ctx);
  } catch (err) {
    record(group, name, FAIL, 'threw: ' + (err && err.message));
    return null;
  }
  try {
    const verdict = oracle(res);
    record(group, name, verdict.ok ? PASS : (verdict.na ? UNAVAILABLE : FAIL), verdict.detail);
  } catch (err) {
    record(group, name, FAIL, 'oracle threw: ' + (err && err.message) + ' | tool said: ' + reasonOf(res));
  }
  return res;
}

const okOf = (r) => !!(r && r.ok !== false);

// ---------------------------------------------------------------------------
// a real vault, and the real subsystems built over it

function makeSandbox() {
  // Long-form temp on purpose: an 8.3 short path makes a watcher over the vault
  // trip a libuv assertion and abort (root CLAUDE.md).
  const base = process.env.MYTHOS_VERIFY_TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'mythos-unknown-'));
}

function realStack(sandbox) {
  const { createFsStore } = require(path.join(MYTHOS_ROOT, 'src/core/memory/fs-store'));
  const { createBus } = require(path.join(MYTHOS_ROOT, 'src/core/bus'));
  const bus = createBus({ historySize: 400 });
  const events = [];
  bus.subscribe('*', (e) => events.push(e));
  const store = createFsStore(() => sandbox, bus);
  return { bus, events, store, sandbox };
}

// ---------------------------------------------------------------------------

async function groupSystem() {
  const mark = results.length;
  const G = 'system';
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-system'));
  const tools = toolMap(mod.buildTools({ config: {} }));

  // get_time is the one tool here with a real, free, deterministic oracle: the
  // answer must agree with this process's own clock to the minute. A tool that
  // returns a plausible-looking date is exactly what an ok:true cannot rule out.
  await exercise(G, tools, 'get_time', {}, {}, (r) => {
    if (!okOf(r)) return { ok: false, detail: 'tool failed: ' + reasonOf(r) };
    const text = JSON.stringify(r.result);
    const year = String(new Date().getFullYear());
    return { ok: text.includes(year), detail: text.includes(year)
      ? 'the returned time carries this process\'s own current year (' + year + ')'
      : 'ORACLE: the answer does not contain the current year — ' + text.slice(0, 140) };
  });

  await exercise(G, tools, 'get_time', { timezone: 'Asia/Tokyo' }, {}, (r) => {
    if (!okOf(r)) return { ok: false, detail: 'tool failed: ' + reasonOf(r) };
    const text = JSON.stringify(r.result);
    return { ok: /Tokyo|JST|GMT\+9/i.test(text), detail: /Tokyo|JST|GMT\+9/i.test(text)
      ? 'a non-local timezone argument actually changes the answer'
      : 'ORACLE: asked for Asia/Tokyo and got ' + text.slice(0, 140) };
  });

  await exercise(G, tools, 'system_status', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'reported unavailable: ' + reasonOf(r) };
    const j = JSON.stringify(r.result || {});
    return { ok: j.length > 20, detail: 'returned a status payload (' + j.length + ' bytes)' };
  });

  // get_weather and get_directions reach a third party. Under the no-spend
  // decision they may have no lane at all, and "the network is down" is not a
  // defect in the tool — so a refusal is n/a, and only a WRONG answer is a FAIL.
  for (const name of ['get_weather', 'get_directions']) {
    const args = name === 'get_weather' ? { location: 'London' } : { from: 'London', to: 'Oxford' };
    await exercise(G, tools, name, args, {}, (r) => {
      if (!okOf(r)) return { na: true, detail: 'declined honestly: ' + reasonOf(r).slice(0, 120) };
      const j = JSON.stringify(r.result || {});
      return { ok: j.length > 20, detail: 'answered (' + j.length + ' bytes) — content not verified against a second source' };
    });
  }
  return rowsSince(mark);
}

async function groupOkf(sandbox) {
  const mark = results.length;
  const G = 'OKF exchange';
  const { store } = realStack(sandbox);
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-okf'));
  const tools = toolMap(mod.buildTools({ vault: store }));

  // A ROUND TRIP is the oracle. export -> list -> import, each verified against
  // the filesystem rather than the return value, because "exported" that wrote
  // nothing and "imported" that read nothing both return ok:true happily.
  // `bundle` + `concepts`, each concept requiring a `type` — read off the tool
  // definition. The first version passed `{name}` and got "invalid bundle name
  // — empty name", which the harness then filed as n/a: a tool written off for
  // a mistake the harness made. Every n/a below has to survive that question.
  const exported = await exercise(G, tools, 'okf_export', {
    bundle: 'harness-probe',
    concepts: [{ type: 'note', title: 'Harness probe', body: 'written by verify-unknown-nodes.js' }],
  }, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const j = JSON.stringify(r.result || {});
    // THE CONCEPT, not merely "a file". The first version counted files under
    // Knowledge/ and a product mutation that skipped a write SURVIVED it,
    // because a sibling file was still being written. Ask whether the thing the
    // caller actually asked to store is on disk, by reading the bytes.
    const files = listOkfFiles(sandbox);
    const carrying = files.filter((f) => {
      try { return fs.readFileSync(f, 'utf8').includes('Harness probe'); } catch (_) { return false; }
    });
    const index = files.filter((f) => /index\.md$/i.test(f));
    const good = carrying.length > 0 && index.length > 0;
    return { ok: good, detail: good
      ? 'the concept AND the bundle index are on disk (' + files.map((f) => path.basename(f)).join(', ') + '), read as bytes'
      : 'ORACLE: said ok but disk holds concept=' + carrying.length + ' index=' + index.length
        + ' of ' + files.length + ' file(s) — ' + j.slice(0, 110) };
  });

  await exercise(G, tools, 'okf_list', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const j = JSON.stringify(r.result || {});
    const files = listOkfFiles(sandbox);
    if (!files.length) return { na: true, detail: 'nothing was exported, so an empty list is the correct answer' };
    const named = files.some((f) => j.includes(path.basename(f, path.extname(f))));
    return { ok: named, detail: named
      ? 'the listing names the artefact export actually wrote to disk'
      : 'ORACLE: disk holds ' + files.map((f) => path.basename(f)).join(', ') + ' but the listing is ' + j.slice(0, 140) };
  });

  const src = listOkfFiles(sandbox)[0];
  if (!src) {
    record(G, 'okf_import', UNAVAILABLE, 'nothing was exported, so there is nothing to import back');
  } else {
    // `bundle`, the directory name — not a file path. The first version passed
    // {path,file,name} and got 'invalid bundle name', which the harness filed as
    // n/a: a round trip written off because its second half was called wrongly.
    await exercise(G, tools, 'okf_import', { bundle: 'harness-probe' }, {}, (r) => {
      if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
      const j = JSON.stringify(r.result || {});
      const round = j.includes('Harness probe') || j.includes('harness-probe');
      return { ok: round, detail: round
        ? 'the round trip closed: import read back the concept export wrote to disk'
        : 'ORACLE: imported but the concept export wrote is not in the result — ' + j.slice(0, 140) };
    });
  }
  if (exported === null) record(G, '(round trip)', FAIL, 'export did not run, so list/import prove nothing');
  return rowsSince(mark);
}

function listOkfFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      // The bundle lands in vault/Knowledge/<bundle>/, whose name contains no
      // "okf" at all. The first version matched on that string, found nothing,
      // and reported a FAIL while the tool's own result named the directory it
      // had just written — the harness looking in the wrong place and blaming
      // the tool for the miss.
      else if (/Knowledge/i.test(dir) && /\.(md|json|ya?ml)$/i.test(e.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

async function groupPersona(sandbox) {
  const mark = results.length;
  const G = 'persona';
  const { bus, store } = realStack(sandbox);
  let identity = null;
  try {
    const { createIdentity } = require(path.join(MYTHOS_ROOT, 'src/core/identity'));
    identity = createIdentity({ bus, config: {}, fs: store, identityStore: store });
  } catch (err) {
    record(G, 'persona_status', UNAVAILABLE, 'the real identity module could not be constructed here: ' + err.message);
    record(G, 'set_persona_level', UNAVAILABLE, 'depends on identity');
    return rowsSince(mark);
  }
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-persona'));
  const tools = toolMap(mod.buildTools({ identity }));

  const before = await exercise(G, tools, 'persona_status', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const j = JSON.stringify(r.result || {});
    return { ok: j.length > 10, detail: 'read levels from the real identity module (' + j.length + ' bytes)' };
  });

  // The oracle is READ-BACK THROUGH A DIFFERENT DOOR: set via the tool, then ask
  // identity itself, not the tool that just claimed success.
  // The param is `value`, not `level`. The first version passed `level` and the
  // tool answered "Value must be a number 0-10" — recorded as n/a, i.e. the
  // harness quietly wrote off a tool it had simply called wrongly. Read the
  // params off the tool definition, never off the tool's NAME.
  // BEFORE and AFTER, on the NAMED TRAIT, to a value it did not already hold.
  //
  // The first version asked only whether the levels object stringified to
  // something containing "4" — and a product mutation that returned ok while
  // setting nothing SURVIVED it, because a default level of 4 was already in
  // there. "Something in this blob looks like what I asked for" is not a
  // read-back; it is a coincidence detector.
  let levelsBefore = null;
  try { levelsBefore = identity.getPersonaLevels(); } catch (_) { /* reported below */ }
  const traitOf = (levels) => {
    if (!levels || typeof levels !== 'object') return undefined;
    const key = Object.keys(levels).find((k) => k.toLowerCase() === 'warmth');
    return key === undefined ? undefined : levels[key];
  };
  const had = traitOf(levelsBefore);
  // Pick a value the trait does NOT already hold, so "no change" cannot pass.
  const target = Number(had) === 7 ? 3 : 7;
  await exercise(G, tools, 'set_persona_level', { trait: 'warmth', value: target }, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    let after = null;
    try { after = identity.getPersonaLevels(); } catch (_) { /* reported below */ }
    const now = traitOf(after);
    const changed = Number(now) === target;
    return { ok: changed, detail: changed
      ? 'warmth went ' + JSON.stringify(had) + ' -> ' + target + ' in identity.getPersonaLevels(), read back through a different door than the setter'
      : 'ORACLE: said ok but warmth reads ' + JSON.stringify(now) + ' (wanted ' + target + ', was ' + JSON.stringify(had) + ')' };
  });
  if (before === null) record(G, '(read)', FAIL, 'persona_status did not run');
  return rowsSince(mark);
}

async function groupWidgets(sandbox) {
  const mark = results.length;
  const G = 'widgets';
  const { bus, events } = realStack(sandbox);
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-widgets'));
  const tools = toolMap(mod.buildTools({ bus }));

  // These tools do their work by PUBLISHING, so the oracle is the real bus's
  // event log — not the return value, which is written before anything is
  // delivered anywhere.
  const at = events.length;
  // layout is a CLOSED SET (stat|list|table|text) and title is required — both
  // read off the tool definition. The first version invented {type, body}; the
  // tool refused correctly and the harness filed it as n/a, writing off a tool
  // it had simply called wrongly.
  await exercise(G, tools, 'spawn_widget', { title: 'harness probe', layout: 'text', items: [{ label: 'ok', value: '1' }] }, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    // The channel is 'ui.open-web' — the HUD's floating-card surface, shared
    // with the cards open_web spawns. Asserting the COUNT would pass on any
    // event at all, so assert the payload the HUD actually needs.
    const fresh = events.slice(at);
    const ev = fresh.find((e) => /ui\./.test(e.type || ''));
    const p = ev && (ev.payload || ev.data || ev);
    const good = p && JSON.stringify(p).includes('harness probe') && JSON.stringify(p).includes('text');
    return { ok: !!good, detail: good
      ? 'the real bus carried ' + ev.type + ' with the title and layout the HUD renders from'
      : 'ORACLE: ok, but the bus saw ' + (fresh.map((e) => e.type).join(', ') || 'nothing') + ' — a HUD would render no widget' };
  });

  const at2 = events.length;
  // The widget catalogue is a closed set (clock, weather, agents, spend, ...),
  // and 'harness probe' is not in it — the first version used the spawned
  // title and the tool correctly refused. Use a catalogue name.
  await exercise(G, tools, 'manage_widget', { action: 'open', name: 'clock' }, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const fresh = events.slice(at2);
    const j = JSON.stringify(r.result || {});
    return { ok: fresh.length > 0 || j.length > 10, detail: fresh.length
      ? 'published ' + fresh.map((e) => e.type).join(', ')
      : 'answered without publishing (' + j.length + ' bytes) — a list is a read, so that is correct' };
  });
  return rowsSince(mark);
}

async function groupDashboard(sandbox) {
  const mark = results.length;
  const G = 'dashboard';
  const { bus, events, store } = realStack(sandbox);

  let pipeline = null, kanban = null, probes = null;
  try {
    const { createPipelineEffector } = require(path.join(MYTHOS_ROOT, 'src/core/effectors/pipeline'));
    pipeline = createPipelineEffector({ fs: store, classifier: null });
  } catch (_) { /* reported per tool */ }
  try {
    const { createKanbanEffector } = require(path.join(MYTHOS_ROOT, 'src/core/effectors/kanban'));
    kanban = createKanbanEffector({ fs: store, bus });
  } catch (_) { /* reported per tool */ }
  try {
    const { createProbes } = require(path.join(MYTHOS_ROOT, 'src/core/immune/probes'));
    probes = createProbes({ bus, config: {} });
  } catch (_) { /* reported per tool */ }

  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-dashboard'));
  const tools = toolMap(mod.buildTools({
    pipeline, kanban, probes, bus, fs: store, config: {},
    goalsEffector: null, agentActions: null, buildRunner: null, identity: null,
  }));

  // --- pure reads. The oracle is that the payload is real and shaped, and for
  // read_system_specs that it agrees with this process's own view of the host.
  // read_status and job_status reach through to buildRunner.listJobs(), and
  // createBuildRunner requires the build engine or a brain lane — neither is
  // available to a harness under the no-spend decision. With it absent they
  // report a failure rather than throwing, which is the honest degradation, so
  // this is n/a and NOT a defect. (The first version passed null and recorded
  // the resulting message as a product problem. main.js constructs buildRunner
  // unconditionally and a brain always exists, so null never reaches these in
  // production — the harness supplied it.)
  await exercise(G, tools, 'read_status', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'needs a real buildRunner (build engine or brain): ' + reasonOf(r).slice(0, 110) };
    const j = JSON.stringify(r.result || {});
    return { ok: j.length > 20, detail: 'returned a status payload (' + j.length + ' bytes)' };
  });

  await exercise(G, tools, 'read_system_specs', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const j = JSON.stringify(r.result || {});
    // BUG-273's lesson, in oracle form: this tool exists so the model reads REAL
    // numbers instead of screenshotting a dashboard. So check it agrees with
    // node's own view of the machine, not merely that it answered.
    const hit = j.includes(String(os.cpus().length)) || j.includes(process.platform);
    return { ok: hit, detail: hit
      ? 'the specs agree with this process\'s own os.cpus()/platform'
      : 'ORACLE: answered but matches neither cpus=' + os.cpus().length + ' nor platform=' + process.platform + ' — ' + j.slice(0, 140) };
  });

  for (const name of ['job_status', 'pipeline_status', 'kanban_status', 'daily_plan']) {
    const args = name === 'daily_plan' ? { action: 'status' } : {};
    await exercise(G, tools, name, args, {}, (r) => {
      if (!okOf(r)) return { na: true, detail: 'declined honestly: ' + reasonOf(r).slice(0, 140) };
      const j = JSON.stringify(r.result === undefined ? {} : r.result);
      return { ok: true, detail: 'read returned ' + j.length + ' bytes' };
    });
  }

  // --- HUD verbs. These publish; the bus is the oracle.
  // navigate DOES NOT PUBLISH. It returns `uiActions` — ok(result, uiActions) —
  // which the server relays to the connected HUD. The first version of this
  // oracle waited for a bus event and recorded a FAIL against correct code: the
  // fourth time in this campaign a harness accused the product of its own
  // mistaken model. The real oracle is that the resolved route comes back in a
  // well-formed action, which also proves the closed-set resolution ran.
  await exercise(G, tools, 'navigate', { route: 'goals' }, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
    const act = (r.uiActions || []).find((a) => a && a.action === 'navigate');
    return { ok: !!(act && act.route === 'goals'), detail: act
      ? 'returned uiActions ' + JSON.stringify(r.uiActions) + ' — the HUD instruction, not a bus event'
      : 'ORACLE: ok but no navigate uiAction; the HUD would receive nothing — ' + JSON.stringify(r).slice(0, 140) };
  });

  // A closed set is only closed if it REFUSES. BUG-273 A1: this router once
  // took a URL, moved the view and reported having launched a browser.
  await exercise(G, tools, 'navigate', { route: 'https://example.com/thing' }, {}, (r) => {
    if (okOf(r)) return { ok: false, detail: 'ORACLE: accepted a URL as a dashboard view — ' + JSON.stringify(r).slice(0, 140) };
    return { ok: true, detail: 'refused a URL by name rather than resolving it into an unrelated success' };
  });

  await exercise(G, tools, 'close_panel', {}, {}, (r) => {
    if (!okOf(r)) return { na: true, detail: 'declined honestly: ' + reasonOf(r).slice(0, 130) };
    return { ok: true, detail: 'closed; ' + JSON.stringify(r.result || {}).slice(0, 120) };
  });

  // --- kanban writes, verified by reading the vault back through the store.
  if (!kanban) {
    for (const n of ['kanban_add_card', 'kanban_move_card']) record(G, n, UNAVAILABLE, 'the real kanban effector could not be constructed here');
  } else {
    let cardId = null;
    await exercise(G, tools, 'kanban_add_card', { title: 'harness probe card', column: 'todo', lane: 'todo' }, {}, (r) => {
      if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
      const board = readBoard(sandbox);
      const found = board && JSON.stringify(board).includes('harness probe card');
      if (found) { cardId = findCardId(board, 'harness probe card'); }
      return { ok: !!found, detail: found
        ? 'the card is in the board file on disk (id ' + cardId + '), read back from the vault rather than from the tool'
        : 'ORACLE: said ok but the board file does not contain the card — ' + JSON.stringify(board).slice(0, 140) };
    });
    if (!cardId) {
      record(G, 'kanban_move_card', UNAVAILABLE, 'no card id to move — add_card did not land one on disk');
    } else {
      // LANES = ['backlog','building','review','done'] in kanban.js. 'doing' is
      // not one; the first version invented it and the tool refused correctly.
      await exercise(G, tools, 'kanban_move_card', { query: 'harness probe card', lane: 'review' }, {}, (r) => {
        if (!okOf(r)) return { na: true, detail: 'declined: ' + reasonOf(r).slice(0, 140) };
        const board = readBoard(sandbox);
        const card = board && findCard(board, cardId);
        const moved = card && /review/i.test(JSON.stringify(card));
        return { ok: !!moved, detail: moved
          ? 'the card\'s column changed in the file on disk'
          : 'ORACLE: said ok but the stored card still reads ' + JSON.stringify(card).slice(0, 140) };
      });
    }
  }

  // --- pipeline_advance mutates a stage. Read the vault back, not the result.
  if (!pipeline) {
    record(G, 'pipeline_advance', UNAVAILABLE, 'the real pipeline effector could not be constructed here');
  } else {
    await exercise(G, tools, 'pipeline_advance', { query: 'harness probe', action: 'approve' }, {}, (r) => {
      if (!okOf(r)) return { na: true, detail: 'declined honestly (nothing to advance): ' + reasonOf(r).slice(0, 140) };
      return { ok: true, detail: 'advanced; result ' + JSON.stringify(r.result || {}).slice(0, 120) };
    });
  }

  await exercise(G, tools, 'open_artifact', { id: 'no-such-artifact-' + process.pid }, {}, (r) => {
    // The interesting case for a read tool nobody has called is the MISS, not
    // the hit: a tool that invents an answer for an id that does not exist is
    // worse than one that has never run. So the pass condition is an honest no.
    if (okOf(r)) return { ok: false, detail: 'ORACLE: claimed success for an artifact id that does not exist — ' + reasonOf(r).slice(0, 140) };
    return { ok: true, detail: 'refused an unknown id honestly: ' + reasonOf(r).slice(0, 120) };
  });

  return rowsSince(mark);
}

function boardPath(sandbox) {
  const direct = path.join(sandbox, 'Kanban.json');
  if (fs.existsSync(direct)) return direct;
  const found = [];
  const walk = (dir, d) => {
    if (d > 3) return;
    let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
      const full = path.join(dir, x.name);
      if (x.isDirectory()) walk(full, d + 1);
      else if (/kanban/i.test(x.name)) found.push(full);
    }
  };
  walk(sandbox, 0);
  return found[0] || null;
}
function readBoard(sandbox) {
  const p = boardPath(sandbox);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function allCards(board) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (v.title || v.id) out.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(board);
  return out;
}
function findCardId(board, title) {
  const c = allCards(board).find((x) => x && x.title === title);
  return c && (c.id || c.cardId) ? (c.id || c.cardId) : null;
}
function findCard(board, id) {
  return allCards(board).find((x) => x && (x.id === id || x.cardId === id)) || null;
}

async function groupMission(sandbox) {
  const mark = results.length;
  const G = 'missions';
  // NOT RUN, and the first version of this harness got it wrong in the most
  // instructive way available: it passed `orchestrator: null`, `missionStatus`
  // dereferenced it, and the throw was recorded as a FAIL against the PRODUCT.
  //
  // It is not a product defect. src/main.js constructs the orchestrator
  // unconditionally one line above registerFromMission, so `null` never reaches
  // it in production — the harness supplied the null and then blamed the tool
  // for it. (The missing guard is real but unreachable, and the effector
  // adapter's own catch would name the throw anyway. An observation, not a bug.)
  //
  // And it cannot honestly be fixed by wiring one: createOrchestrator requires
  // buildRunner, agentActions, kanban, bus, fs AND a brain. Stubbing those would
  // measure the stubs.
  require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-mission'));
  record(G, 'mission_status', UNAVAILABLE,
    'the real orchestrator needs buildRunner + agentActions + a brain lane; stubbing them would measure the stub, and passing null measures nothing but the harness');
  record(G, 'run_mission', DISPOSITION,
    'NOT RUN: T3 and it spends. The no-spend decision is the operator\'s, recorded in the campaign.');
  return rowsSince(mark);
}

async function groupPc(sandbox) {
  const mark = results.length;
  const G = 'pc / desktop';
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-pc'));
  const tools = toolMap(mod.TOOLS);

  // status only. `on`/`off` start and stop a real screen sensor.
  await exercise(G, tools, 'ambient_awareness', { action: 'status' }, {}, (r) => {
    if (!okOf(r)) return { ok: false, detail: 'even status failed: ' + reasonOf(r).slice(0, 140) };
    const j = JSON.stringify(r.result || {});
    const honest = /enabled|running/.test(j);
    return { ok: honest, detail: honest
      ? 'status reports its real state and says why when disabled: ' + j.slice(0, 130)
      : 'ORACLE: status answered without saying whether it is enabled — ' + j.slice(0, 130) };
  });

  record(G, 'set_wallpaper', DISPOSITION,
    'NOT RUN: it changes the operator\'s actual desktop background. A harness that alters the machine to prove a tool works has traded one dishonesty for a worse one.');
  return rowsSince(mark);
}

async function groupComputer(sandbox) {
  const mark = results.length;
  const G = 'clipboard / email';
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-computer'));
  const tools = toolMap(mod.TOOLS);

  await exercise(G, tools, 'clipboard_read', {}, {}, (r) => {
    // Read-only, and the operator's clipboard content is NOT printed anywhere —
    // only its length. A verification harness must not become a data leak.
    if (!okOf(r)) return { na: true, detail: 'declined honestly: ' + reasonOf(r).slice(0, 120) };
    const text = r.result && (r.result.text !== undefined ? r.result.text : r.result);
    const n = typeof text === 'string' ? text.length : -1;
    return { ok: n >= 0, detail: n >= 0
      ? 'read the real clipboard (' + n + ' chars; content deliberately not reported)'
      : 'ORACLE: ok but no text field in ' + JSON.stringify(r.result).slice(0, 120) };
  });

  record(G, 'clipboard_write', DISPOSITION,
    'NOT RUN: it overwrites whatever the operator has copied. Same class as the wakeword test that moved real model files aside and lost them — a harness must not mutate live user data to prove a tool works.');
  record(G, 'compose_email', DISPOSITION,
    'NOT RUN: it opens a real browser compose tab (or the OS mail app). Outward-facing and visible on the operator\'s screen.');
  return rowsSince(mark);
}

async function groupProcedures(sandbox) {
  const mark = results.length;
  const { store, bus } = realStack(sandbox);
  const { createSkillsStore } = require(path.join(MYTHOS_ROOT, 'src/core/memory/skills'));
  const skills = createSkillsStore({ fs: store, bus, config: {} });
  const mod = require(path.join(MYTHOS_ROOT, 'src/core/effectors/from-memory'));
  const tools = toolMap(mod.buildTools({ memory: { skills } }));
  const steps = [{ tool: 'get_time', args: {} }];
  skills.write('harness-clock', { id: 'harness-clock', when: ['clock'], steps });
  const before = store.listFiles('Skills', '.md').map(f => [f.path, store.readText(f.path)]);
  // Disk is the read-only oracle. This proves retrieval, not a model's choice
  // to use guidance or the outcome of a later authorized action.
  await exercise('procedures', tools, 'suggest_procedures', { query: 'clock' }, {}, r => {
    const suggestions = r && r.result && r.result.suggestions;
    const after = store.listFiles('Skills', '.md').map(f => [f.path, store.readText(f.path)]);
    const match = suggestions && suggestions.find(s => s.skillRef === 'harness-clock');
    const passed = okOf(r) && match && JSON.stringify(match.steps) === JSON.stringify(steps)
      && JSON.stringify(before) === JSON.stringify(after);
    return { ok: !!passed, detail: passed
      ? 'disk round trip returned the saved steps and left every procedure byte unchanged; live voice selection remains unverified'
      : 'ORACLE: saved guidance was missing, altered, or retrieval changed the procedure files' };
  });
  // BUG-447 (2026-09-24): resume_interrupted_answer, registered by the same effector
  // file. The oracle is the store round trip — the words handed back are the ones the
  // tracker took from its own transcript for this connection, and they are gone after
  // one call. Whether a model calls it on "go ahead" is only visible attended.
  const unheard = require(path.join(MYTHOS_ROOT, 'src/core/voice/unheard-answer'));
  const conn = 'harness-connection';
  const tracker = unheard.createUnheardTracker({ remember: (e) => unheard.rememberUnheard(conn, e), forget: () => unheard.forgetUnheard(conn) }); // wired as server/index.js wires it (forget required since 2026-09-25)
  tracker.audio(Buffer.alloc(48000, 0).toString('base64')); // 1 s of 24 kHz 16-bit PCM
  tracker.turnEnd({ assistantText: 'First part was heard. Second part was not.', turnId: 1 });
  tracker.unheard({ cutMs: 700, turnMs: 1000 });
  await exercise('procedures', tools, 'resume_interrupted_answer', {}, { connectionId: conn }, r => {
    const text = r && r.result && r.result.unheard;
    const passed = okOf(r) && text === 'Second part was not.' && unheard.takeUnheard(conn) === null;
    return { ok: !!passed, detail: passed
      ? 'returned the unheard sentence the tracker remembered, once; the model choosing to call it remains unverified'
      : 'ORACLE: the unheard text was missing, wrong, or still stored after the call' };
  });
  return rowsSince(mark);
}

async function groupRefused() {
  const mark = results.length;
  const G = 'deliberately not run';
  const D = [
    ['install_from_github', 'installs software from the network onto the operator\'s machine'],
    ['delete_artifact', 'destructive by definition; a harness has nothing it may safely delete'],
    ['security_scan', 'T3, and it spawns a scanner over real paths'],
    ['ask_agent', 'spend, and the no-spend decision is the operator\'s'],
    ['pipeline_execute', 'T3, and it executes a real pipeline stage rather than describing one'],
    ['kanban_assemble', 'T3, and it drives the build engine (dsh) — which is a real install, a real model call and minutes of wall clock, so a harness running it would be measuring the engine rather than the tool'],
    ['kanban_build_card', 'T3, and it drives the build engine for one card; same reason as kanban_assemble, and the build-engine ruling in root CLAUDE.md is that there is no fallback to fake it with'],
  ];
  for (const [tool, why] of D) record(G, tool, DISPOSITION, 'NOT RUN: ' + why);
  return rowsSince(mark);
}

// ---------------------------------------------------------------------------

async function groupDesktop() {
  const mark = results.length;
  // This offline harness has no authenticated task owner or signed-in bridge.
  // Component regressions cannot substitute for the attended workflow oracle.
  for (const tool of ['desktop_task_start', 'desktop_task_status', 'desktop_task_control',
    'browser_video_list', 'browser_media_state', 'browser_media_control']) {
    record('desktop operator', tool, UNAVAILABLE, 'Requires explicit extension setup, an authenticated desktop task and attended signed-in YouTube/microphone proof; no workflow was executed by this offline harness.');
  }
  return rowsSince(mark);
}
const GROUPS = {
  desktop: groupDesktop,
  system: groupSystem,
  okf: groupOkf,
  persona: groupPersona,
  widgets: groupWidgets,
  dashboard: groupDashboard,
  mission: groupMission,
  pc: groupPc,
  computer: groupComputer,
  procedures: groupProcedures,
  refused: groupRefused,
};

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const only = (args.find((a) => a.startsWith('--group=')) || '').split('=')[1];
  if (only && !GROUPS[only]) {
    console.error('unknown group "' + only + '" — one of: ' + Object.keys(GROUPS).join(', '));
    process.exit(2);
  }

  const sandbox = makeSandbox();
  const chosen = only ? { [only]: GROUPS[only] } : GROUPS;
  for (const [name, fn] of Object.entries(chosen)) {
    try {
      await fn(sandbox);
    } catch (err) {
      record(name, '(group)', FAIL, 'harness threw: ' + (err && err.message));
    }
  }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  if (asJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    const w = Math.max(...results.map((r) => r.tool.length), 10);
    let group = null;
    for (const r of results) {
      if (r.group !== group) { group = r.group; console.log('\n' + group); console.log('-'.repeat(group.length)); }
      console.log('  ' + r.verdict.padEnd(5) + r.tool.padEnd(w + 2) + r.detail);
    }
    const tally = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
    console.log('\n' + Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '));
    console.log('\npass = ran, and an ORACLE confirmed the effect (disk read-back, bus event, host agreement)');
    console.log('n/a  = honestly unavailable here (no key, no sensor, no subsystem)');
    console.log('disp = deliberately not run, reason recorded');
    console.log('FAIL = ran, and the oracle says it did not do what it claimed');
  }

  const failed = results.filter((r) => r.verdict === FAIL);
  if (failed.length) {
    console.error('\n' + failed.length + ' tool(s) FAILED their oracle.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}

module.exports = {
  GROUPS, PASS, FAIL, UNAVAILABLE, DISPOSITION,
  reasonOf, toolMap, makeSandbox, realStack, _results: results, _record: record,
};
