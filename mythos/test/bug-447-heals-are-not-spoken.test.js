'use strict';

// test/bug-447-heals-are-not-spoken.test.js
//
// BUG-447 (HIGH): in one 51-turn session 15 turns were started by the system and
// 15 were interrupted; most of the unprompted lines were heal announcements in log
// vocabulary — "Self-healed: cortex restart after a stall. Trigger: cortex-stall on
// tick-loop. Action taken: restart-cortex." — spoken over the operator's question.
//
// OPERATOR DECISION D5 (2026-09-23): a self-heal that SUCCEEDED is never spoken.
// Only what needs the operator is spoken, in one plain sentence. The heal is still
// recorded: health.healed reaches the HUD's health card (server/index.js) and the
// vault's anomaly row (immune/anomaly-detail.js) with its title, trigger and
// actions — so "what did you just fix?" still has an answer.
//
// THE REPAIR is a deletion: src/core/immune/announcer.js was the ONLY module that
// turned a successful heal (or a crash recovery) into speech. With it gone, nothing
// can speak one — a shape that cannot express the defect, rather than a guard that
// detects it.
//
// Also here: the greeting told a weeks-long user "Allow me to introduce myself".
// The prompt never said whether they had met; Identity/last-boot.json says so.
//
// RED FIRST, 2026-09-23, against ab1a585c: (1a) the announcer module existed and
// main.js constructed it; (5a)(5b) greetingRelationshipClause did not exist and
// (5c) the greeting prompt carried no such clause. The behavioural cases (1b)-(1d)
// are ADJACENT: they hold before and after, and pin that the remaining subscribers
// neither start speaking heals nor stop speaking what needs the operator.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBus } = require('../src/core/bus');
const { createDiagnostician } = require('../src/core/immune/diagnostician');
const { createHealer } = require('../src/core/immune/healer');
const { createExplainer } = require('../src/core/immune/explainer');

const SRC = path.join(__dirname, '..', 'src');

// The immune subscribers production keeps, on a real bus, with every speech
// request captured where server/index.js turns it into audio.
function chain() {
  const spoken = [];
  const healed = [];
  const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => { if (type === 'action.speak-requested') spoken.push(payload.text); return emit(type, payload); };
  const brain = { async think() { return { parsed: { remedy: 'none' }, content: '{"remedy":"none"}', offline: false }; } };
  const diag = createDiagnostician({ bus });
  // A lessons store, so the recurring-failure playbook really APPLIES (without one it
  // reports missing-dependency and the case below would test nothing).
  const memory = { lessons: { recordFailure: () => ({ ok: true, ref: 'lesson-447', count: 1, isNew: true }) } };
  const healer = createHealer({ bus, config: {}, memory });
  const explainer = createExplainer({ bus, brain, config: {}, memory: null, logger: { info() {}, warn() {} } });
  bus.subscribe('health.healed', (e) => healed.push(e.payload));
  diag.start(); healer.start(); explainer.start();
  return {
    bus, spoken, healed,
    settle: () => new Promise((r) => setTimeout(r, 300)),
    stop: () => { diag.stop(); healer.stop(); explainer.stop(); },
  };
}

describe('BUG-447 — a heal that worked is never spoken (operator decision D5)', () => {
  test('(1a) the module that spoke successful heals is gone, and main.js builds nothing in its place', () => {
    assert.equal(fs.existsSync(path.join(SRC, 'core', 'immune', 'announcer.js')), false,
      'immune/announcer.js still exists — it is the one speaker of "Self-healed: …"');
    const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
    // Code, not prose: main.js's own comment names the deleted file on purpose.
    assert.doesNotMatch(main, /createAnnouncer\s*\(|require\(['"][^'"]*immune\/announcer/, 'main.js still constructs a heal speaker');
  });

  test('(1b) ADJACENT: a real heal on the real chain is applied, recorded, and produces no speech', async () => {
    const h = chain();
    // recurring-failure -> recurring-failure-record: a playbook that applies with no
    // external dependency (bug-162-healer-announce-detail.test.js drives the same one).
    h.bus.emit('health.diagnosed', { kind: 'recurring-failure', target: 'spotify_play', severity: 'major', evidence: { detail: 'kept failing' } });
    await h.settle();
    h.stop();
    assert.ok(h.healed.some((p) => p.outcome === 'applied'), 'fixture check: the heal was applied');
    const applied = h.healed.find((p) => p.outcome === 'applied');
    assert.ok(applied.title && applied.kind, 'the record keeps what was fixed — title and trigger reach the HUD and vault');
    assert.deepEqual(h.spoken, [], 'a successful heal reached speech: ' + JSON.stringify(h.spoken));
  });

  test('(1c) ADJACENT: a crash recovery is not spoken either', async () => {
    const h = chain();
    h.bus.emit('lifecycle.recovered', { resumedGoals: 0 });
    await h.settle();
    h.stop();
    assert.deepEqual(h.spoken, []);
  });

  test('(1d) ADJACENT: what NEEDS the operator is still spoken, once, in its own words', async () => {
    const h = chain();
    h.bus.emit('health.anomaly', { kind: 'gmail-reauth-required', target: 'gmail', needsOperator: true,
      // 2026-09-25: the sentence the real sensor now sends, and what is spoken (BUG-447).
      sayToOperator: 'Gmail has stopped working because its Google sign-in expired, and it needs you to sign in again.',
      reason: 'Gmail needs re-authorising: run the Google sign-in again.' });
    await h.settle();
    h.stop();
    assert.equal(h.spoken.length, 1, 'removing the heal speaker must not silence the operator\'s one real instruction');
    assert.match(h.spoken[0], /needs you to sign in again/);
  });
});

// Every listener to a heal or a crash recovery, named with what it does with it. A
// NEW listener — for example a heal speaker re-added inline, which (1a) cannot see —
// fails here and has to be read before it ships. Derived by scanning, not typed.
const HEAL_LISTENERS = {
  'server/index.js': ["subscribe('health.healed'", "subscribe('lifecycle.*'"], // HUD health card + episodic row; entity-state
  'src/core/immune/explainer.js': ["subscribe('health.healed'"],             // no-match path only: says what NEEDS the operator
};

// Code, not prose: the bus documents its own wildcard in a comment.
function stripLineComments(src) { return src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n'); }

test('(1e) every listener to a heal or a recovery is named — a new heal speaker cannot slip in unread', () => {
  const root = path.join(__dirname, '..');
  const re = /subscribe\((?:'(?:health\.healed|lifecycle\.recovered|health\.\*|lifecycle\.\*|\*)')/g;
  const found = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const hits = stripLineComments(fs.readFileSync(p, 'utf8')).match(re);
      if (hits) found[path.relative(root, p).split(path.sep).join('/')] = hits.sort();
    }
  })(path.join(root, 'src'));
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const hits = stripLineComments(fs.readFileSync(p, 'utf8')).match(re);
      if (hits) found[path.relative(root, p).split(path.sep).join('/')] = hits.sort();
    }
  })(path.join(root, 'server'));
  const expected = Object.fromEntries(Object.entries(HEAL_LISTENERS).map(([k, v]) => [k, v.slice().sort()]));
  assert.deepEqual(found, expected, 'a listener to heals/recoveries was added or removed — if it speaks, D5 forbids it');
});

describe('BUG-447 — the greeting knows whether they have met', () => {
  const briefing = () => require('../src/core/conversation/briefing');

  test('(5a) a returning operator: no introduction', () => {
    const clause = briefing().greetingRelationshipClause(Date.parse('2026-09-01T09:00:00Z'));
    assert.match(clause, /already know each other/);
    assert.match(clause, /Do NOT introduce yourself/);
  });

  test('(5b) a first boot: a one-line introduction is right', () => {
    const clause = briefing().greetingRelationshipClause(null);
    assert.match(clause, /first boot/);
    assert.match(clause, /introduce yourself/);
    assert.doesNotMatch(clause, /Do NOT/);
  });

  test('(5c) the boot greeting prompt carries the clause, fed by the previous-boot record', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const body = server.slice(server.indexOf('async function deliverBootGreeting'), server.indexOf("// Calendar reminders — proactive speech"));
    assert.ok(body.length > 0, 'fixture check: the greeting function was found');
    assert.match(body, /greetingRelationshipClause\(previousBootAt\)/, 'the greeting still cannot tell a first meeting from the hundredth');
  });
});

// MUTATION TABLE, 2026-09-23. Five probes, each applied (sha256 changed), run against
// this file, restored (sha256 equal):
//   M1  a heal speaker re-added INLINE in main.js, bypassing the deleted module  -> (1e)
//   M2  the explainer starts speaking applied heals too                           -> (1b)
//   M3  the greeting prompt drops the relationship clause                         -> (5c)
//   M4  the clause always says "first boot"                                       -> (5a)
//   M5  the explainer loses its voice (what needs the operator goes silent)      -> (1d)
// M1 is why (1e) exists: (1a) only sees the deleted module, and a speaker written
// somewhere else would have passed every other case here.
