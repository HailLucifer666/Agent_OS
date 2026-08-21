'use strict';

// W6 step 2 — adapters/dsh-agent, DeepSeek Harness as MYTHOS's build engine.
//
// Every test below names the branch it traverses. Nothing here spawns dsh or
// calls a provider: the adapter's job is to decide correctly BEFORE spawning
// (which cwd, which model, which credential, which sandbox), and those decisions
// are the part a unit test can pin. The live paths — read-only answers and
// writes nothing, write path writes the named file — are verified against the
// running engine in the plan's step 5 and recorded in W6.14, because a green
// suite cannot tell you a child process booted (proven on this repo 2026-08-04).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dsh = require('../adapters/dsh-agent');
const lanes = require('../src/core/brain/lanes.default');

// A directory that certainly exists, for the cwd checks.
const REAL_DIR = os.tmpdir();

describe('dsh-agent — require() is side-effect-free', () => {
  it('reaches a definite state without probing, and spawns nothing at require time', () => {
    const status = dsh.getStatus();
    assert.ok(status.state === 'ONLINE' || status.state === 'OFFLINE');
    assert.equal(status.pinnedVersion, dsh.DSH_PINNED_VERSION);
  });

  it('exports exactly the four adapter-contract functions, and no Hermes-only stubs', () => {
    // W6-AD-8: delete, don't stub. Hermes exported providerSlots/describeSlot/
    // onProviderRotated/HERMES_ERROR_REPLY_RE because Hermes needed them — it
    // reports provider errors on stdout with exit 0 and a single 401 killed a
    // build. dsh's exit code is its oracle. An unused stub here would be a lie
    // about capability, so their ABSENCE is the assertion.
    for (const fn of ['probe', 'runTask', 'getStatus', 'scrubbedEnv']) {
      assert.equal(typeof dsh[fn], 'function', fn + ' must be exported');
    }
    for (const absent of ['providerSlots', 'describeSlot', 'onProviderRotated',
      'DSH_ERROR_REPLY_RE', 'HERMES_ERROR_REPLY_RE']) {
      assert.equal(dsh[absent], undefined,
        absent + ' must NOT exist on the dsh adapter (W6-AD-8: delete, do not stub)');
    }
  });
});

describe('dsh-agent — cwd is required and its absence is fatal (W6-AD-3)', () => {
  // dsh adopts its invoking directory as a WRITABLE workspace and loads that
  // directory's CLAUDE.md/AGENTS.md as agent instructions under a 65,536-byte
  // budget. This repo's two files total 41,412 bytes, so an inherited cwd hands
  // a build task MYTHOS's own operating rules plus write access to the repo.
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    it('refuses cwd = ' + JSON.stringify(bad), () => {
      assert.throws(() => dsh.requireCwd(bad), /cwd is required/);
    });
  }

  it('the refusal explains WHY, so nobody re-adds a cwd default', () => {
    try {
      dsh.requireCwd(null);
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /WRITABLE workspace/);
      assert.match(err.message, /CLAUDE\.md/);
    }
  });

  it('refuses a cwd that does not exist, rather than letting dsh resolve against nothing', () => {
    const missing = path.join(REAL_DIR, 'w6-definitely-not-here-' + process.pid);
    assert.throws(() => dsh.requireCwd(missing), /does not exist/);
  });

  it('returns an absolute path for a directory that does exist', () => {
    assert.equal(dsh.requireCwd(REAL_DIR), path.resolve(REAL_DIR));
  });

  it('runTask rejects before spawning anything when cwd is absent', async () => {
    await assert.rejects(() => dsh.runTask('do a thing', {}), /cwd is required/);
  });

  it('runTask still rejects an empty prompt first', async () => {
    await assert.rejects(() => dsh.runTask('', { cwd: REAL_DIR }), /prompt required/);
  });
});

describe('dsh-agent — the model comes from the build lane, never a hardcoded vendor', () => {
  // W6.4, corrected by operator ruling 2026-08-21: W6 swaps the HARNESS. The
  // models stay the ones lanes.default.js ranks. "DeepSeek Harness" is a program
  // name, not an instruction to run DeepSeek's models.
  it('selects a model that is actually in BRAIN_TABLES.build', () => {
    let selected;
    try {
      selected = dsh.selectModel(null);
    } catch (err) {
      // A machine with no reachable build-lane credential is a legitimate state
      // (this is an open-source project with BYO keys), and the refusal must
      // name the lane rather than inventing a model.
      assert.match(err.message, /no reachable model in the build lane/);
      assert.match(err.message, /lanes\.default\.js/);
      return;
    }
    const lane = lanes.BRAIN_TABLES.build.prefs;
    const found = lane.find((p) => p.provider === selected.laneProvider && p.model === selected.model);
    assert.ok(found, 'selected ' + selected.laneProvider + '/' + selected.model
      + ' which is not an entry in BRAIN_TABLES.build');
  });

  it('honours the FIRST reachable lane entry, in lane order', () => {
    let selected;
    try { selected = dsh.selectModel(null); } catch { return; }
    const lane = lanes.BRAIN_TABLES.build.prefs;
    const chosenIndex = lane.findIndex((p) => p.provider === selected.laneProvider && p.model === selected.model);
    // Everything ahead of the chosen entry must have been rejected for a NAMED
    // reason. A silent skip is the failure mode this asserts against: it would
    // let a build quietly run on rank 5 while the log said nothing.
    assert.equal(selected.rejected.length, chosenIndex,
      'chose lane rank ' + chosenIndex + ' but named ' + selected.rejected.length + ' rejections');
  });

  it('refuses a provider pi-ai ships no catalog for, naming it — ollama is the real case', () => {
    // Deliberately unmapped: pi-ai ships no ollama catalog, so the route would
    // become a whole-provider declaration needing a guessed loopback port.
    assert.equal(dsh.PI_AI_CATALOG_ROUTES.ollama, undefined,
      'ollama must stay unmapped — a guessed port that half-works is worse than a named refusal');
    assert.throws(
      () => dsh.selectModel({ provider: 'ollama', model: 'hermes3:8b' }),
      /no pi-ai catalog route for provider "ollama"/
    );
  });

  it('refuses a model the installed pi-ai catalog does not describe', () => {
    // Otherwise pi-ai would serve it with GUESSED context and max-token sizes
    // (its documented defaults), i.e. a build running under invented limits.
    if (!process.env.MISTRAL_API_KEY) return;   // the credential gate fires first
    assert.throws(
      () => dsh.selectModel({ provider: 'mistral', model: 'codestral-that-does-not-exist' }),
      /does not describe/
    );
  });

  it('refuses a mapped provider whose credential is unset, naming the variable', () => {
    // Pick a route this machine is unlikely to hold, and skip if it does.
    const probe = { provider: 'deepseek', model: 'anything' };
    if (process.env.DEEPSEEK_API_KEY) return;
    assert.throws(() => dsh.selectModel(probe), /DEEPSEEK_API_KEY unset/);
  });

  it('every catalog route maps to an env var name, and none of them is a literal secret', () => {
    for (const [laneProvider, mapped] of Object.entries(dsh.PI_AI_CATALOG_ROUTES)) {
      assert.ok(mapped.route && typeof mapped.route === 'string', laneProvider + ' needs a route');
      assert.match(mapped.apiKeyEnv, /^[A-Z0-9_]+$/,
        laneProvider + '.apiKeyEnv must be an env var NAME, not a value');
    }
    // MYTHOS calls NVIDIA's hosted endpoint "nim"; pi-ai calls it "nvidia". A
    // regression here silently drops the whole NIM tail of every lane.
    assert.equal(dsh.PI_AI_CATALOG_ROUTES.nim.route, 'nvidia');
    assert.equal(dsh.PI_AI_CATALOG_ROUTES.nim.apiKeyEnv, 'NIM_API_KEY');
  });
});

describe('dsh-agent — scrubbedEnv forwards one credential and nothing else key-shaped', () => {
  it('never passes process.env wholesale', () => {
    const env = dsh.scrubbedEnv({});
    // A canary that exists in every shell but has no business in a build child.
    const suspicious = Object.keys(env).filter((k) => /(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(k));
    assert.deepEqual(suspicious, [], 'unexpected credential-shaped keys forwarded: ' + suspicious.join(','));
  });

  it('forwards EXACTLY the one referenced credential when asked', () => {
    if (!process.env.MISTRAL_API_KEY) return;
    const env = dsh.scrubbedEnv({ apiKeyEnv: 'MISTRAL_API_KEY' });
    const creds = Object.keys(env).filter((k) => /(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(k));
    assert.deepEqual(creds, ['MISTRAL_API_KEY'],
      'exactly one provider credential must reach the child; got ' + creds.join(','));
    assert.equal(env.MISTRAL_API_KEY, process.env.MISTRAL_API_KEY);
  });

  it('throws rather than forwarding a name that resolves to nothing', () => {
    // A reference that silently resolves to undefined would fail deep inside dsh
    // as MISSING_CREDENTIAL, minutes later, with no mention of MYTHOS's choice.
    assert.throws(
      () => dsh.scrubbedEnv({ apiKeyEnv: 'MYTHOS_W6_NO_SUCH_KEY_' + process.pid }),
      /which is unset/
    );
  });

  it('hard-disables telemetry and deletes its two companions', () => {
    // dsh's shipped base bundle has NO redaction rule, so an enabled export can
    // carry message text, tool arguments and results, and workspace paths.
    const saved = {
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE,
      DSH_TELEMETRY_OTLP_URL: process.env.DSH_TELEMETRY_OTLP_URL,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
    };
    try {
      // The DSH_ passthrough would otherwise forward these straight back in,
      // which is exactly why the adapter deletes them AFTER the passthrough.
      process.env.DSH_TELEMETRY_MODE = 'otlp';
      process.env.DSH_TELEMETRY_OTLP_URL = 'http://example.invalid/v1/traces';
      process.env.DSH_TELEMETRY_DISABLED = '';
      const env = dsh.scrubbedEnv({});
      assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
      assert.equal(env.DSH_TELEMETRY_MODE, undefined);
      assert.equal(env.DSH_TELEMETRY_OTLP_URL, undefined);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('pins DSH_HOME away from the operator profile, derived from the environment (AD-7)', () => {
    const home = dsh.mythosDshHome();
    assert.ok(path.isAbsolute(home));
    assert.match(home, /MYTHOS/);
    const env = dsh.scrubbedEnv({});
    assert.equal(env.DSH_HOME, home);
  });

  it('MYTHOS_DSH_HOME overrides it, so a packaged install can relocate the profile', () => {
    const saved = process.env.MYTHOS_DSH_HOME;
    try {
      process.env.MYTHOS_DSH_HOME = path.join(REAL_DIR, 'w6-dsh-home-override');
      assert.equal(dsh.mythosDshHome(), process.env.MYTHOS_DSH_HOME);
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_DSH_HOME; else process.env.MYTHOS_DSH_HOME = saved;
    }
  });
});

describe('dsh-agent — autoApprove is intent; the sandbox enforces it', () => {
  // hermes-runner passed `env: { HERMES_WRITE_SAFE_ROOT, HERMES_YOLO_MODE }` —
  // a generic caller naming another program's environment variables. Under dsh
  // the same two ideas are structural: the invoking directory IS the workspace
  // root, and the permission preset decides whether writing is possible at all.
  // So "do not write" stops being a sentence in a prompt and becomes a sandbox.
  it('absent/false autoApprove selects the read-only preset', () => {
    assert.equal(dsh.scrubbedEnv({}).DSH_PERMISSION_MODE, 'read-only');
    assert.equal(dsh.scrubbedEnv({ autoApprove: false }).DSH_PERMISSION_MODE, 'read-only');
  });

  it('true autoApprove selects workspace-write, and NEVER danger-full-access', () => {
    const env = dsh.scrubbedEnv({ autoApprove: true });
    assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write');
    // dsh's third preset also sets approval:never. MYTHOS must not reach for it:
    // it is the one mode that leaves the workspace boundary behind.
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js'), 'utf8');
    assert.equal(/DSH_PERMISSION_MODE\s*=\s*[^;]*danger-full-access/.test(src), false,
      'the adapter must never assign danger-full-access to DSH_PERMISSION_MODE');
  });

  it('an inherited DSH_PERMISSION_MODE cannot override MYTHOS\'s choice', () => {
    const saved = process.env.DSH_PERMISSION_MODE;
    try {
      process.env.DSH_PERMISSION_MODE = 'danger-full-access';
      assert.equal(dsh.scrubbedEnv({}).DSH_PERMISSION_MODE, 'read-only');
      assert.equal(dsh.scrubbedEnv({ autoApprove: true }).DSH_PERMISSION_MODE, 'workspace-write');
    } finally {
      if (saved === undefined) delete process.env.DSH_PERMISSION_MODE; else process.env.DSH_PERMISSION_MODE = saved;
    }
  });

  it('runTask refuses writeRoot without autoApprove — the task could not write its own directory', async () => {
    await assert.rejects(
      () => dsh.runTask('write a file', { cwd: REAL_DIR, writeRoot: REAL_DIR }),
      /read-only sandbox/
    );
  });

  it('runTask refuses a writeRoot that is not the cwd, rather than silently dropping it', async () => {
    const other = fs.mkdtempSync(path.join(REAL_DIR, 'w6-other-'));
    try {
      await assert.rejects(
        () => dsh.runTask('write a file', { cwd: REAL_DIR, writeRoot: other, autoApprove: true }),
        /writeRoot must equal cwd/
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('dsh-agent — the generated overlay is a CATALOG route', () => {
  // The single most expensive thing learned in W6 step 1. A hand-declared
  // `api: openai-completions` + `baseURL` route forces OpenAI shaping, which
  // sends the system prompt in a `developer` role, which Mistral rejects with
  // `422 union_tag_invalid` — and compat.supportsDeveloperRole:false was INERT
  // at both route and model level. Omitting `api` keeps each catalog model's own
  // protocol (mistral-conversations for Mistral). This test is the guard that
  // stops the next reader "fixing" it back.
  const selected = { laneProvider: 'mistral', route: 'mistral', model: 'codestral-latest', apiKeyEnv: 'MISTRAL_API_KEY' };

  it('declares no api and no baseURL', () => {
    const handle = dsh.writeOverlay(selected);
    try {
      const yml = fs.readFileSync(handle.file, 'utf8');
      assert.equal(/^\s*api:/m.test(yml), false,
        'an explicit `api` forces a protocol and reintroduces the developer-role 422');
      // Anchored to a YAML KEY, not the word: the overlay's own header explains
      // why these two are absent, and a bare /baseURL/ matched that explanation.
      assert.equal(/^\s*baseURL:/m.test(yml), false,
        'an explicit baseURL turns the catalog route into a whole-provider declaration');
    } finally {
      dsh.cleanupOverlay(handle);
    }
  });

  it('sets agent-default-model, because declaring a route does not SELECT it', () => {
    // dsh's headless runner reads ctx.agentDefaultModel. Without this entry the
    // route sits unused and every request goes to the base config's default —
    // measured, and it cost a whole spike run.
    const handle = dsh.writeOverlay(selected);
    try {
      const yml = fs.readFileSync(handle.file, 'utf8');
      assert.match(yml, /- id: agent-default-model/);
      assert.match(yml, /provider: mistral/);
      assert.match(yml, /model: codestral-latest/);
    } finally {
      dsh.cleanupOverlay(handle);
    }
  });

  it('keys the provider layer by plugin id `llm-pi-ai`, not `llm`', () => {
    // Patch entries match the base composition BY ID and dsh-base calls this
    // plugin llm-pi-ai. Keyed `llm`, the overlay loads cleanly and changes
    // nothing — the worst kind of wrong.
    const handle = dsh.writeOverlay(selected);
    try {
      assert.match(fs.readFileSync(handle.file, 'utf8'), /- id: llm-pi-ai/);
    } finally {
      dsh.cleanupOverlay(handle);
    }
  });

  it('omits `models`, so the route keeps serving the whole installed catalog', () => {
    const handle = dsh.writeOverlay(selected);
    try {
      assert.equal(/^\s*models:/m.test(fs.readFileSync(handle.file, 'utf8')), false);
    } finally {
      dsh.cleanupOverlay(handle);
    }
  });

  it('writes a credential REFERENCE and never a secret', () => {
    if (!process.env.MISTRAL_API_KEY) return;
    const handle = dsh.writeOverlay(selected);
    try {
      const yml = fs.readFileSync(handle.file, 'utf8');
      assert.match(yml, /apiKeyEnv: MISTRAL_API_KEY/);
      assert.equal(yml.includes(process.env.MISTRAL_API_KEY), false,
        'the overlay must never contain the key VALUE');
    } finally {
      dsh.cleanupOverlay(handle);
    }
  });

  it('lives outside the repo and is removed after use', () => {
    const handle = dsh.writeOverlay(selected);
    const repoRoot = path.resolve(__dirname, '..', '..');
    assert.equal(path.resolve(handle.file).startsWith(repoRoot + path.sep), false,
      'a generated overlay inside the repo would carry a machine path into a tracked tree (AD-7)');
    dsh.cleanupOverlay(handle);
    assert.equal(fs.existsSync(handle.file), false, 'cleanupOverlay must remove the file');
  });
});

describe('dsh-agent — probe reports what it looked at, not just what it concluded', () => {
  it('getStatus separates state, evidence and lastTaskFailure', async () => {
    await dsh.probe(true);
    const status = dsh.getStatus();
    assert.ok(status.state === 'ONLINE' || status.state === 'OFFLINE');
    if (status.state === 'OFFLINE') {
      // Honest degradation with a fix, per BUG-244 ruling A: no engine means the
      // BUILD fails, not that boot fails, and the message must say how to fix it.
      assert.match(status.hint, /dsh/i);
      assert.equal(status.evidence, 'none');
    } else {
      // The hermes adapter's F5 lesson: ONLINE from a version banner is not the
      // same claim as ONLINE from a completed task, and a log must be able to
      // tell them apart.
      assert.match(status.evidence, /^version-(printed-and-matched-pin|probe-timed-out-assumed-present)$/);
    }
  });

  it('an OFFLINE runTask names the install command and the model the lane would have used', async () => {
    const status = dsh.getStatus();
    if (status.state !== 'OFFLINE') return;   // installed here; nothing to assert
    await assert.rejects(
      () => dsh.runTask('build something', { cwd: REAL_DIR }),
      (err) => {
        assert.match(err.message, /OFFLINE/);
        assert.match(err.message, /setup-dsh\.js --install/);
        assert.match(err.message, /build lane/);
        return true;
      }
    );
  });

  it('the version pin is asserted, not assumed', () => {
    // dsh is a developer preview whose README promises breaking changes, so a
    // measurement taken against an unexpected version is not attributable.
    assert.match(dsh.DSH_PINNED_VERSION, /^\d+\.\d+\.\d+(-rc\.\d+)?$/);
    let entry = null;
    try { entry = dsh.resolveDshEntry(); } catch (err) {
      assert.match(err.message, /not installed project-local|version mismatch|bin/);
      return;
    }
    assert.ok(fs.existsSync(entry));
    assert.equal(dsh.getStatus().pinnedVersion, dsh.DSH_PINNED_VERSION);
  });
});
