'use strict';

// BUG-163 — identity fabrication (operator incident 2026-08-07 04:00):
// asked who made it, MYTHOS answered "my records indicate I was developed by
// the Nexus Team" and then defended the claim. "Nexus" appears NOWHERE in the
// repo, the vault, or the prompts — the model invented a plausible developer
// because self.md carried no origin at all and nothing forbade filling that
// silence. Two fixes under test: identity now loads an Origin section (with a
// truthful default for every install of this open-source project) and folds
// it into persona(), and RULES gained an ORIGIN RULE forbidding invented
// attribution.
//
// BUG-164 rides in the same RULES edit: the operator's 04:22 incident —
// replies kept ending in re-proposals of completed/failed tasks ("Should we
// check the weather?") — is prompt behaviour, so the pin is a prompt pin.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentity } = require('../src/core/identity');
const { createIdentityStore } = require('../src/core/memory/identity');
const { RULES } = require('../src/core/voice/voice-agent');

async function identityOver(selfMd) {
  const dir = tempVaultDir();
  const bus = fakeBus();
  const config = {};
  const fs = createFsStore(() => dir, null);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = createIdentityStore({ fs, config, bus, logger });
  await store.init();
  fs.writeText('Identity/self.md', selfMd);
  const identity = createIdentity({ bus, config, fs, identityStore: store });
  await identity.init();
  return { identity, dir };
}

describe('BUG-163: origin reaches the prompt and cannot be invented', () => {
  const dirs = [];
  after(() => dirs.forEach(cleanupVaultDir));

  it('a self.md with an Origin section gets it into persona()', async () => {
    const { identity, dir } = await identityOver(
      '# Self\n\n## Purpose\nAssist.\n\n## Values\nHonesty.\n\n## Persona\nJARVIS\n\n## Origin\nCreated and operated by my operator. No company built me.\n');
    dirs.push(dir);
    const p = identity.persona();
    assert.match(p, /Origin \(the only truth about who made you\):/);
    assert.match(p, /Created and operated by my operator/);
  });

  it('a self.md with NO Origin section falls back to the truthful default — never an invented team', async () => {
    const { identity, dir } = await identityOver('# Self\n\n## Purpose\nAssist.\n\n## Persona\nJARVIS\n');
    dirs.push(dir);
    const p = identity.persona();
    assert.match(p, /Created and operated by your operator/);
    assert.match(p, /not recorded/i, 'absent detail must be stated as unrecorded, not filled in');
  });

  it('RULES carries the ORIGIN RULE, tied to self.md and forbidding invented attribution', () => {
    assert.match(RULES, /ORIGIN RULE:/);
    assert.match(RULES, /never attribute your creation to any company or team/i);
    assert.match(RULES, /not recorded rather than inventing/i);
  });
});

describe('BUG-164: suggestion restraint is pinned in RULES', () => {
  it('the restraint paragraph exists and covers both halves of the incident', () => {
    assert.match(RULES, /SUGGESTION RESTRAINT:/);
    assert.match(RULES, /unless the user asked what to do next/i,
      'no unsolicited task proposal suffix');
    assert.match(RULES, /already completed or failed this session/i,
      'no re-offering of finished or failed tasks — the exact behaviour the operator reported');
  });

  it('the RULES ceiling holds after the additions (trim paid for them)', () => {
    assert.ok(RULES.length < 19000, 'RULES grew to ' + RULES.length);
  });
});
