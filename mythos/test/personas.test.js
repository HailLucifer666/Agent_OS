'use strict';

// test/personas.test.js — the specialised agent seats actually get a brief.
//
// Until 2026-08-15 personas.js searched exactly one directory,
// mythos/vault/Personas/, which is GITIGNORED and did not exist. loadPersona()
// therefore returned null for every role on every machine, and each seat fell
// back to the global MYTHOS identity in total silence — nothing threw, no test
// failed, the reviewer simply reviewed as generic MYTHOS. That is the failure
// this file exists to make impossible to repeat, so the load-bearing test is
// not "the loader works" but "every role the CODE asks for has a file", derived
// from the source rather than from a list somebody has to remember to update.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const personas = require('../src/core/agents/personas');
const { createBrain } = require('../src/core/brain/index');
const chain = require('../src/core/brain/chain');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const REPO_PERSONAS_DIR = path.resolve(__dirname, '..', 'personas');

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('personas — every role the code asks for has a shipped default', function () {
  it('resolves every literal loadPersona(\'role\') in src/ to a real file', function () {
    // Derived from source on purpose. A hardcoded expectation here would pass
    // forever while a newly added seat silently got no brief — which is exactly
    // the bug, one level up.
    const roles = new Set();
    for (const file of walkJs(SRC_DIR, [])) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /loadPersona\(\s*'([a-z0-9-]+)'\s*\)/gi;
      let m;
      while ((m = re.exec(text)) !== null) roles.add(m[1]);
    }
    // pickBuilderPersona() returns these two by name rather than through a
    // literal loadPersona('...') call, so the scan above cannot see them.
    roles.add('frontend-builder');
    roles.add('backend-builder');

    assert.ok(roles.size >= 3, 'the scan found only ' + roles.size + ' roles — it has stopped seeing real call sites');
    const missing = [];
    for (const role of roles) {
      if (personas.loadPersona(role) === null) missing.push(role);
    }
    assert.deepEqual(missing, [],
      'these seats ask for a persona and would silently run as generic MYTHOS: ' + missing.join(', '));
  });

  it('pickBuilderPersona only ever names a role that exists', function () {
    const frontend = personas.pickBuilderPersona('Build a landing page', '');
    const backend = personas.pickBuilderPersona('Parse the CSV export', '');
    assert.equal(frontend, 'frontend-builder');
    assert.equal(backend, 'backend-builder');
    assert.ok(personas.loadPersona(frontend));
    assert.ok(personas.loadPersona(backend));
  });

  it('ships the defaults in a directory git actually tracks', function () {
    // vault/ is gitignored, so a persona authored there fixes one machine and no
    // clone — the open-source portability rule in the repo's CLAUDE.md.
    assert.ok(fs.existsSync(REPO_PERSONAS_DIR), 'mythos/personas/ must exist and be tracked');
    const files = fs.readdirSync(REPO_PERSONAS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.includes('reviewer.md'));
    assert.ok(files.includes('reality-checker.md'));
  });

  it('keeps the output contract out of the persona files', function () {
    // The JSON shape lives in review-rubric.js's preambles, which is what the
    // parser is written against. A persona restating it is a second source of
    // truth, and the failure mode is quiet: output that parses to nothing reads
    // as a seat that simply found no issues.
    for (const file of fs.readdirSync(REPO_PERSONAS_DIR).filter((f) => f.endsWith('.md'))) {
      if (file === 'README.md') continue;
      const text = fs.readFileSync(path.join(REPO_PERSONAS_DIR, file), 'utf8');
      assert.ok(!/"verdict"/.test(text), file + ' restates the JSON output contract — that belongs in the caller preamble');
      assert.ok(!/```json/.test(text), file + ' embeds a JSON block — that belongs in the caller preamble');
    }
  });
});

describe('personas — resolution order', function () {
  let tmpA, tmpB, originalOverride;

  beforeEach(function () {
    originalOverride = process.env.MYTHOS_PERSONAS_DIR;
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-personas-a-'));
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-personas-b-'));
    personas._resetCache();
  });

  afterEach(function () {
    if (originalOverride === undefined) delete process.env.MYTHOS_PERSONAS_DIR;
    else process.env.MYTHOS_PERSONAS_DIR = originalOverride;
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
    personas._resetCache();
  });

  it('the override wins over the shipped default', function () {
    fs.writeFileSync(path.join(tmpA, 'reviewer.md'), 'OVERRIDE REVIEWER');
    process.env.MYTHOS_PERSONAS_DIR = tmpA;
    personas._resetCache();
    assert.equal(personas.loadPersona('reviewer'), 'OVERRIDE REVIEWER');
  });

  it('falls through the override list first-match-wins, then to the default', function () {
    fs.writeFileSync(path.join(tmpB, 'reviewer.md'), 'SECOND ROOT');
    process.env.MYTHOS_PERSONAS_DIR = [tmpA, tmpB].join(path.delimiter);
    personas._resetCache();
    assert.equal(personas.loadPersona('reviewer'), 'SECOND ROOT', 'an empty first root must not end the search');
    personas._resetCache();
    // A role in NO override root still resolves from the tracked defaults.
    assert.ok(personas.loadPersona('backend-builder'));
  });

  it('reads the override fresh rather than at module load', function () {
    fs.writeFileSync(path.join(tmpA, 'reviewer.md'), 'FIRST');
    fs.writeFileSync(path.join(tmpB, 'reviewer.md'), 'SECOND');
    process.env.MYTHOS_PERSONAS_DIR = tmpA;
    personas._resetCache();
    assert.equal(personas.loadPersona('reviewer'), 'FIRST');
    process.env.MYTHOS_PERSONAS_DIR = tmpB;
    personas._resetCache();
    assert.equal(personas.loadPersona('reviewer'), 'SECOND');
  });

  it('lists personas without the README and without duplicates', function () {
    fs.writeFileSync(path.join(tmpA, 'reviewer.md'), 'x');
    fs.writeFileSync(path.join(tmpA, 'custom-seat.md'), 'y');
    process.env.MYTHOS_PERSONAS_DIR = tmpA;
    personas._resetCache();
    const listed = personas.listPersonas();
    assert.ok(listed.includes('custom-seat'));
    assert.ok(!listed.includes('README'), 'README.md is documentation, not a persona');
    assert.equal(listed.filter((r) => r === 'reviewer').length, 1, 'a role present in two roots must be listed once');
  });

  it('refuses a role name that could escape the persona directories', function () {
    // Roles reach loadPersona from literal call sites today, but a role string
    // is exactly the kind of value that later arrives from config or a model.
    assert.equal(personas.loadPersona('../../../package'), null);
    assert.equal(personas.loadPersona('..\\..\\package'), null);
    assert.equal(personas.loadPersona('a/b'), null);
    assert.equal(personas.loadPersona(''), null);
    assert.equal(personas.loadPersona(null), null);
  });

  it('a missing role is null, not a throw', function () {
    personas._resetCache();
    assert.equal(personas.loadPersona('no-such-seat'), null);
    // and stays null on the second call (the miss is cached, not re-stat'ed
    // on every build)
    assert.equal(personas.loadPersona('no-such-seat'), null);
  });
});

describe('personas — the brief actually reaches the model', function () {
  // personas.js resolving a file is only half of it. The other half is
  // brain/index.js's lane list, which is what BUG "Breakage 1" was about: the
  // reviewer and reality-checker seats moved to lane 'reasoning' on 2026-08-14,
  // and a lane that is not on that list ignores the persona argument silently.
  async function captureMessages(thinkOpts) {
    let captured = null;
    const orig = chain.complete;
    chain.complete = function (opts) {
      captured = opts.messages;
      const err = new Error('chain exhausted (test)');
      err.chainExhausted = true;
      return Promise.reject(err);
    };
    try {
      await createBrain({ bus: null, config: {} }).think(thinkOpts);
    } finally {
      chain.complete = orig;
    }
    return captured || [];
  }

  it('carries the reviewer persona into the system message on the reasoning lane', async function () {
    personas._resetCache();
    const persona = personas.loadPersona('reviewer');
    assert.ok(persona, 'precondition: the reviewer persona must resolve');
    const msgs = await captureMessages({
      lane: 'reasoning',
      persona,
      messages: [{ role: 'user', content: 'grade this' }],
    });
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(system.includes('You are the Reviewer'), 'the reviewer brief never reached the model');
  });

  it('carries the reality-checker persona too', async function () {
    personas._resetCache();
    const persona = personas.loadPersona('reality-checker');
    assert.ok(persona);
    const msgs = await captureMessages({
      lane: 'reasoning',
      persona,
      messages: [{ role: 'user', content: 'check this' }],
    });
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(system.includes('You are the Reality Checker'));
  });
});
