'use strict';

// test/bug-451-closure-writers.test.js — BUG-451 closure: provenance on EVERY durable writer.
//
// The first pass (bug-451-provenance.test.js, 2026-09-23) labelled two writers: the Lessons
// store and note_take. The ticket's own "Not covered" list and the 2026-09-24 attended run
// named the rest: (3) a consolidated semantic memory repeated the false cause, (4) the
// incident was written as fact with no provenance, (5) a spoken explanation was unlabelled.
//
// GATE B (derive the set from the reason). The reason is: "a durable record states a cause as
// fact without saying whether it was observed or inferred". Searching the code for every
// writer of prose into the vault gives this set (each is exercised below on a temp vault; no
// operator vault is read or written):
//   already covered      Lessons (lessons.js) · note_take (from-memory.js)
//   closed here          log_incident -> Incidents/*.jsonl · incident_status note
//                        semantic.write (the ONE choke point: remember, habit promoter,
//                        log_incident's semantic copy, conversation distillation, the
//                        consolidated-* distillation and the consolidated-* merge)
//                        episodic 'thought' (the cortex mull — a model-authored inference)
//                        the spoken healer/immune explanation (announcer honestCauseClause)
//   not this failure     skills (tool+args recipes), identity Learned Preferences (operator
//   class — see BUGS.md  preference lines), audit/episodic event ledgers (what ran, not why),
//                        goals/docs/builds (deliverables).
// READERS: planner (lessons, done in the first pass), recall (semantic + episodic snippets),
// the Live session-open facts composer (semantic.topic), list_incidents, the 'YOU NOTED
// EARLIER' thought injection, and the spoken explanation.
//
// RED FIRST, 2026-10-06, against b6d0af0c: see the table at the bottom of this file.
// MUTATIONS: table at the bottom of this file.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('fs');
const path = require('path');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createSemanticStore } = require('../src/core/memory/semantic');
const { createEpisodicStore } = require('../src/core/memory/episodic');
const { createLessonsStore } = require('../src/core/memory/lessons');
const { buildTools } = require('../src/core/effectors/from-memory');
const { provenanceOf } = require('../src/core/memory/provenance');

// Verbatim from the 2026-09-24 attended run (BUGS.md, BUG-451): a false limitation written as
// fact. `open_web` with browser:true does open links (BUG-459).
const FALSE_INCIDENT = 'Operator expects direct browser link opening; MYTHOS only offers dashboard rendering or app launch';
const SYMPTOM = 'browser_click on specific element refs fails repeatedly';
const CAUSE = 'Repeated browser_click failures suggest that the refs go stale due to page re-renders';
const silentLogger = { warn() {}, info() {}, error() {} };

const dirs = [];
afterEach(() => { while (dirs.length) cleanupVaultDir(dirs.pop()); });

function vault() {
  const dir = tempVaultDir();
  dirs.push(dir);
  const bus = fakeBus();
  const fs = createFsStore(() => dir, bus);
  const semantic = createSemanticStore({ fs, config: {}, bus, logger: silentLogger });
  const episodic = createEpisodicStore({ fs, config: {}, bus, logger: silentLogger });
  const lessons = createLessonsStore({ fs, config: {}, bus, logger: silentLogger });
  return { dir, bus, fs, semantic, episodic, lessons };
}
const incidentLines = (dir) => {
  const d = path.join(dir, 'Incidents');
  return nodeFs.readdirSync(d).flatMap((f) => nodeFs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

describe('(4) incidents — log_incident writes the label with the record', () => {
  it('(a) the real false incident is stored as a hypothesis; an observation stays an observation', async () => {
    const v = vault();
    const tools = buildTools({ fs: v.fs, semantic: v.semantic, memory: { lessons: v.lessons } });
    const log = tools.find((t) => t.name === 'log_incident').fn;
    await log({ text: FALSE_INCIDENT });
    await log({ text: 'launch_app returned pid 0 for Notepad' });
    const rows = incidentLines(v.dir);
    assert.equal(rows[0].provenance, 'hypothesis', 'a claim about what MYTHOS cannot do is not an observation');
    assert.equal(rows[1].provenance, 'observation', 'ADJACENT: a plain report keeps its observed label');
  });

  it('(b) the same incident reaches the Lessons copy and the semantic copy labelled, not as fact', async () => {
    const v = vault();
    const tools = buildTools({ fs: v.fs, semantic: v.semantic, memory: { lessons: v.lessons } });
    await tools.find((t) => t.name === 'log_incident').fn({ text: FALSE_INCIDENT });
    const lessonFile = nodeFs.readdirSync(path.join(v.dir, 'Lessons'))[0];
    assert.match(nodeFs.readFileSync(path.join(v.dir, 'Lessons', lessonFile), 'utf8'), /"provenance":\["hypothesis"\]/);
    const hit = v.semantic.recall('MYTHOS dashboard rendering', {})[0];
    assert.ok(hit, 'the semantic copy is found');
    assert.match(hit.snippet, /unverified/i, 'recall shows the incident as unverified');
  });

  it('(c) list_incidents does not hand the model a hypothesis as a plain fact; a record written before labels existed is classified at read', async () => {
    const v = vault();
    const tools = buildTools({ fs: v.fs, semantic: v.semantic, memory: { lessons: v.lessons } });
    const log = tools.find((t) => t.name === 'log_incident').fn;
    await log({ text: FALSE_INCIDENT });
    await log({ text: 'launch_app returned pid 0 for Notepad' });
    // A pre-label record, byte shape of the real 09-24 line: no provenance field.
    v.fs.appendLine('Incidents/2026-09-24.jsonl', { id: 'inc-1-1', ts: 1, text: 'the stale resume happened because the operator meant Notepad', severity: 'warn', source: 'voice', status: 'open' });
    const res = tools.find((t) => t.name === 'list_incidents').fn({ status: 'open', limit: 10 });
    const byText = (frag) => res.result.incidents.find((i) => i.text.includes(frag));
    assert.match(byText('only offers').text, /unverified/i);
    assert.match(byText('stale resume').text, /unverified/i, 'legacy record: classified at read, file not edited');
    assert.doesNotMatch(byText('pid 0').text, /unverified/i, 'ADJACENT: the observed incident reads exactly as before');
    assert.equal(byText('only offers').provenance, 'hypothesis');
  });

  it('(d) a status note the model writes carries its label too', async () => {
    const v = vault();
    const tools = buildTools({ fs: v.fs, semantic: v.semantic, memory: { lessons: v.lessons } });
    await tools.find((t) => t.name === 'log_incident').fn({ text: 'launch_app returned pid 0 for Notepad' });
    await tools.find((t) => t.name === 'incident_status').fn({ status: 'resolved', query: 'pid 0', note: 'fixed because the MSIX stub exits' });
    const status = incidentLines(v.dir).find((r) => r.kind === 'status');
    assert.equal(status.noteProvenance, 'hypothesis');
  });
});

describe('(3) semantic memory — one choke point labels every fact', () => {
  it('(e) a cause-bearing fact is tagged in recall and in the session-open topic read; an observed fact is not', () => {
    const v = vault();
    v.semantic.write('browser-notes', [CAUSE, SYMPTOM], { confidence: 0.6, append: true, sources: ['x'] });
    const hit = v.semantic.recall('browser_click', {})[0];
    assert.match(hit.snippet, /unverified[^;]*suggest that/i);
    assert.doesNotMatch(hit.snippet, /unverified[^;]*fails repeatedly/i, 'ADJACENT: the observation is not tagged');
    const t = v.semantic.topic('browser-notes');
    assert.match(t.facts[0], /unverified/i);
    assert.equal(t.facts[1], SYMPTOM, 'the observed fact is returned byte for byte');
    assert.deepEqual(t.provenance, ['hypothesis', 'observation']);
  });

  it('(f) a caller cannot choose a label: "observation"/"verified" passed in is ignored', () => {
    const v = vault();
    v.semantic.write('forced', [CAUSE], { provenance: 'verified', sources: ['x'] });
    v.semantic.write('forced2', [CAUSE], { provenance: ['observation'], sources: ['x'] });
    assert.deepEqual(v.semantic.topic('forced').provenance, ['hypothesis']);
    assert.deepEqual(v.semantic.topic('forced2').provenance, ['hypothesis']);
  });

  it('(g) the label survives append, a forget of a different line, and reordering — it follows the fact, not its position', () => {
    const v = vault();
    v.semantic.write('mix', [SYMPTOM], { append: true, sources: ['x'] });
    v.semantic.write('mix', [CAUSE], { append: true, sources: ['x'] });
    v.semantic.write('mix', ['the build takes about two minutes'], { append: true, sources: ['x'] });
    v.semantic.forget('fails repeatedly');
    v.semantic.write('mix', ['the lockfile is checked in'], { append: true, sources: ['x'] });
    const t = v.semantic.topic('mix');
    assert.deepEqual(t.facts.map((f) => f.replace(/^\(unverified[^)]*\)\s*/i, '')),
      [CAUSE, 'the build takes about two minutes', 'the lockfile is checked in']);
    assert.deepEqual(t.provenance, ['hypothesis', 'observation', 'observation']);
  });

  it('(h) the operator\'s own saved words are not relabelled as MYTHOS guesses', () => {
    const v = vault();
    v.semantic.write('user-facts', ['I use dark mode because my eyes hurt'], { append: true, confidence: 0.9, sources: ['voice-explicit'] });
    assert.doesNotMatch(v.semantic.topic('user-facts').facts[0], /unverified/i);
    assert.equal(v.semantic.topic('user-facts').facts[0], 'I use dark mode because my eyes hurt');
  });

  it('(i) a file written before labels existed still loads, and is classified at read without being edited', () => {
    const v = vault();
    const legacy = '## consolidated-1\n\n<!-- {"id":"sem-1","ts":1,"confidence":0.6,"sources":["ep-1"]} -->\n- ' + CAUSE + '\n- ' + SYMPTOM + '\n';
    nodeFs.mkdirSync(path.join(v.dir, 'Semantic'), { recursive: true });
    nodeFs.writeFileSync(path.join(v.dir, 'Semantic', 'consolidated-1.md'), legacy);
    const t = v.semantic.topic('consolidated-1');
    assert.deepEqual(t.provenance, ['hypothesis', 'observation']);
    assert.equal(nodeFs.readFileSync(path.join(v.dir, 'Semantic', 'consolidated-1.md'), 'utf8'), legacy, 'reading never rewrites the operator\'s file');
  });

  it('(j) an inferred write (the consolidation path) is a hypothesis even when its words carry no cause marker — the 09-23 sentence', () => {
    const v = vault();
    const REAL = 'the browser_click recurring failure (rapid re-rendering) is resolved';
    v.semantic.write('consolidated-2', [REAL], { inferred: true, sources: ['ep-1'] });
    v.semantic.write('consolidated-3', [REAL], { sources: ['ep-1'] });
    assert.deepEqual(v.semantic.topic('consolidated-2').provenance, ['hypothesis']);
    assert.deepEqual(v.semantic.topic('consolidated-3').provenance, ['observation'], 'ADJACENT: the flag is opt-in, not a blanket');
  });
});

describe('(3) consolidation — a distilled memory inherits the doubt of what it was distilled from', () => {
  function memoryOver(dir, brain) {
    const { createMemory } = require('../src/core/memory');
    return createMemory({ config: { MYTHOS_VAULT_ROOT: dir, MYTHOS_NOTES_DIR: path.join(dir, 'Notes'), EPISODIC_RETENTION_DAYS: 30 }, bus: fakeBus(), logger: silentLogger, brain });
  }

  it('(k) episodic -> consolidated-*: a high-salience THOUGHT that guessed a cause makes the distilled fact a hypothesis, whatever the model wrote', async () => {
    const dir = tempVaultDir(); dirs.push(dir);
    const brain = { think: async () => ({ content: 'the browser_click recurring failure (rapid re-rendering) is resolved' }) };
    const memory = memoryOver(dir, brain);
    await memory.init();
    await memory.episodic.write({ kind: 'thought', summary: CAUSE, detail: { text: CAUSE }, salience: 0.9 });
    await memory.consolidate({});
    const topic = nodeFs.readdirSync(path.join(dir, 'Semantic')).find((f) => /^consolidated-/.test(f)).replace('.md', '');
    assert.deepEqual(memory.semantic.topic(topic).provenance, ['hypothesis']);
  });

  it('(l) ADJACENT: when nothing it was distilled from stated a cause, the distilled fact stays an observation', async () => {
    const dir = tempVaultDir(); dirs.push(dir);
    const brain = { think: async () => ({ content: 'the operator opened Spotify twice' }) };
    const memory = memoryOver(dir, brain);
    await memory.init();
    await memory.episodic.write({ kind: 'action', summary: 'open_app Spotify ok', salience: 0.9 });
    await memory.consolidate({});
    const topic = nodeFs.readdirSync(path.join(dir, 'Semantic')).find((f) => /^consolidated-/.test(f)).replace('.md', '');
    assert.deepEqual(memory.semantic.topic(topic).provenance, ['observation']);
  });

  it('(m) consolidated-* merge: one hypothesis among the inputs makes the merged topic a hypothesis; the merger cannot launder it', async () => {
    const dir = tempVaultDir(); dirs.push(dir);
    const brain = { think: async () => ({ parsed: { facts: ['the browser_click recurring failure (rapid re-rendering) is resolved', 'the operator opened Spotify twice'] } }) };
    const memory = memoryOver(dir, brain);
    await memory.init();
    memory.semantic.write('consolidated-1', [CAUSE], { sources: ['x'] });
    memory.semantic.write('consolidated-2', ['the operator opened Spotify twice'], { sources: ['x'] });
    memory.semantic.write('consolidated-3', ['the build takes two minutes'], { sources: ['x'] });
    await memory.consolidate({});
    const merged = nodeFs.readdirSync(path.join(dir, 'Semantic')).filter((f) => /^consolidated-/.test(f));
    assert.equal(merged.length, 1, 'the three inputs were merged into one topic');
    const t = memory.semantic.topic(merged[0].replace('.md', ''));
    assert.ok(t.provenance.every((p) => p === 'hypothesis'), 'every merged fact carries the doubt: ' + JSON.stringify(t.provenance));
  });
});

describe('episodic thoughts — the cortex mull is a model inference', () => {
  it('(n) a thought that states a cause is stored with its label and tagged in recall; a conversation turn is not touched', async () => {
    const v = vault();
    await v.episodic.write({ kind: 'thought', summary: CAUSE, detail: { text: CAUSE }, salience: 0.4 });
    await v.episodic.write({ kind: 'conversation', summary: 'operator: I left because the rain started', salience: 0.4 });
    const hit = v.episodic.recall('browser_click', { kind: 'thought' })[0];
    assert.equal(hit.record.provenance, 'hypothesis');
    assert.match(hit.snippet, /unverified/i);
    const talk = v.episodic.recall('rain', { kind: 'conversation' })[0];
    assert.equal(talk.record.provenance, undefined, 'ADJACENT: the operator\'s words are not MYTHOS\'s inference');
    assert.doesNotMatch(talk.snippet, /unverified/i);
  });

  it('(o) a caller cannot pre-label a thought as an observation', async () => {
    const v = vault();
    await v.episodic.write({ kind: 'thought', summary: CAUSE, provenance: 'observation', salience: 0.4 });
    assert.equal(v.episodic.recall('browser_click', { kind: 'thought' })[0].record.provenance, 'hypothesis');
  });

  it('(p) the "YOU NOTED EARLIER" injection labels a hypothesis thought (source shape — server/index.js is a closure, not importable)', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const at = src.indexOf("'YOU NOTED EARLIER");
    assert.ok(at > 0);
    assert.match(src.slice(at - 900, at), /labelText\(/, 'the thought text passes through labelText before it is injected');
  });
});

describe('(5) the spoken healer / immune explanation', () => {
  const { honestCauseClause, createConversationAnnouncer } = require('../src/core/conversation/announcer');

  it('(q) a reason that states a cause is spoken as a suspected cause, not as a reported fact', () => {
    assert.match(honestCauseClause({ reason: 'the token failed because the clock drifted' }), /Suspected cause \(not verified\): the token failed because the clock drifted/);
  });

  it('(r) ADJACENT: a measured reason and a missing reason are spoken exactly as before', () => {
    assert.equal(honestCauseClause({ reason: 'typed into the wrong window' }), ' Reported reason: typed into the wrong window.');
    assert.equal(honestCauseClause({}), ' I do not yet know the cause.');
  });

  it('(s) through the real announcer: the spoken anomaly line carries the doubt', () => {
    const spoken = [];
    const bus = fakeBus();
    const a = createConversationAnnouncer({ bus, brain: { think: async () => ({}) }, config: {}, speak: (t) => spoken.push(t) });
    const text = a._onHealthAnomaly ? a._onHealthAnomaly({ payload: { kind: 'provider-down', target: 'groq', reason: 'down due to a quota reset' } }, false) : null;
    assert.match(String(text || spoken[0]), /Suspected cause \(not verified\)/);
  });
});

describe('provenance.js — the capability-claim marker (the false incident carried no "because")', () => {
  it('(t) a claim about what MYTHOS cannot do is a hypothesis; an error quoted from a tool is not', () => {
    assert.equal(provenanceOf(FALSE_INCIDENT), 'hypothesis');
    assert.equal(provenanceOf('MYTHOS cannot open links in the debug browser'), 'hypothesis');
    assert.equal(provenanceOf('unable to find element e5 in the snapshot'), 'observation', 'ADJACENT: "unable to" in a quoted error stays an observation');
    assert.equal(provenanceOf('open_web returned ok but no window appeared'), 'observation');
  });
});

// ---------------------------------------------------------------------------------------------
// RED FIRST, 2026-10-06, against b6d0af0c (this file alone, no source change): 20 tests, 2 pass,
// 18 fail. The 2 that pass are the adjacent cases designed to pass on the old code too:
// (h) the operator's own saved words are not relabelled, (r) a measured reason is spoken as
// before. Every failure was an assertion on the missing label or tag (actual undefined / 'Reported
// reason: ...' / 'observation' where 'hypothesis' was expected); (k) and (m) reached the same
// point as a TypeError on the absent provenance array.
//
// MUTATIONS, 2026-10-06 (driver kept outside the tree; each probe is an exact-once string
// replacement, sha-checked before the run, restored from a byte copy and re-hashed after).
// 21 probes, 21 caught, 0 restore mismatches. Test letters that went red:
//   M1  provenanceOf ignores the capability-claim marker .......................... (a)(b)(c)(t)
//   M2  incident record written without its label ................................. (a)
//   M3  list_incidents shows the raw incident text ................................ (c)
//   M4  list_incidents trusts only the stored label (legacy record unclassified) .. (c)
//   M5  status note written without noteProvenance ................................ (d)
//   M6  sidecar forgets which facts are hypotheses (hyp: []) ...................... (b)(e)(f)(g)(j)(k)(m)
//   M7  recall snippet shows raw facts ............................................ (b)(e)
//   M8  topic() returns raw facts (Live session-open reader) ...................... (e)
//   M9  operator-stated facts relabelled by shape (ADJACENT guard) ................ (h)
//   M10 append drops the labels of earlier facts .................................. (g)
//   M11 opts.inferred ignored ..................................................... (j)(k)(m)
//   M12 legacy (unlabelled) file read as all-observation .......................... (i)
//   M13 step-3 distillation does not inherit doubt ................................ (k)
//   M14 consolidated-* merge forgets doubted inputs (laundering) .................. (m)
//   M15 thought not labelled at write ............................................. (n)(o)
//   M16 thought snippet shows raw text ............................................ (n)
//   M17 spoken explanation says "Reported reason" for a cause ..................... (q)(s)
//   M18 'YOU NOTED EARLIER' injection unlabelled .................................. (p)
//   M19 every episodic kind labelled (ADJACENT break) ............................. (n)
//   M20 caller can pre-label a thought ............................................ (o)
//   M21 labelled files re-classified by shape instead of the sidecar .............. (j)(k)(m)
// A probe that changes nothing looks exactly like a guard that works, so each run printed
// applied=true (the file's sha changed) beside its failure count.
