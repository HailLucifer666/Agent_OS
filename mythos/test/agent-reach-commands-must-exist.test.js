'use strict';

// Every `agent-reach <subcommand>` this repo invokes must be one the vendored
// skill actually documents.
//
// WHAT WAS BROKEN (found 2026-08-20). agent-actions.js carried an "A3: social
// research" block that shelled out to:
//
//     agent-reach reddit     --query <topic> --limit 2
//     agent-reach hackernews --query <topic> --limit 2
//
// Neither command exists, and neither ever did. The vendored skill at
// mythos/skills/agent-reach/ documents exactly five binary subcommands —
// doctor, configure, transcribe, install, check-update — and agent-reach is a
// ROUTING skill: it tells an agent to drive other tools. Reddit is reached
// through a separate `reddit` binary (`reddit search "query" -f yaml`, and it is
// login-backed). Hacker News is not a platform agent-reach covers at all.
//
// WHY IT WENT UNNOTICED, and why it would have got worse. The CLI is not
// installed, so `isAgentReachAvailable()` returned false and the block returned
// null — indistinguishable from "no social signals found". The remediation
// handoff's plan was to install the CLI and live-verify the injection. That
// would have made it WORSE, not better: `agent-reach --version` would then
// succeed, availability would flip to true, both invented commands would error,
// runAgentReach swallows any error to '', and the function would return null
// forever while reporting the capability as present. A fail-open that claims to
// work is worse than an honest absence.
//
// THE DISPOSITION. The block was removed rather than rewritten against the real
// commands. Writing code against documentation that cannot be executed here is
// precisely how the invented commands got written in the first place, and the
// real path needs an installed binary plus an interactive login before anything
// about it could be verified. Removing it is behaviour-preserving by
// construction: the function has never once returned a non-null value.
//
// This guard derives its truth from the VENDORED SKILL rather than from a list
// someone typed here, so it keeps working when the skill is updated.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SKILL_DIR = path.join(REPO, 'skills', 'agent-reach');

function readAllSkillText() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(md|txt)$/i.test(entry.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  })(SKILL_DIR);
  return out.join('\n');
}

function sourceFiles(rel) {
  const dir = path.join(REPO, rel);
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

describe('agent-reach: we only invoke subcommands the vendored skill documents', () => {
  it('the vendored skill is present (negative control)', () => {
    // Without this, every assertion below passes vacuously if the skill is ever
    // moved or removed.
    assert.ok(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), 'skills/agent-reach/SKILL.md must exist');
    const text = readAllSkillText();
    assert.match(text, /agent-reach doctor/, 'the skill must document at least the doctor command');
  });

  it('no source file shells out to an undocumented agent-reach subcommand', () => {
    const documented = readAllSkillText();
    const offences = [];

    for (const file of sourceFiles('src')) {
      const src = fs.readFileSync(file, 'utf8');
      // Match an execFile/spawn-style argument list whose command is
      // 'agent-reach', capturing the first argument — that argument is the
      // subcommand being invoked.
      const re = /['"]agent-reach['"]\s*,\s*\[\s*['"]([a-z][a-z-]*)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const sub = m[1];
        // A bare flag (--version, --help) is not a subcommand.
        if (sub.startsWith('-')) continue;
        if (!new RegExp('agent-reach\\s+' + sub + '\\b').test(documented)) {
          offences.push(path.relative(REPO, file) + ' invokes `agent-reach ' + sub
            + '`, which the vendored skill does not document');
        }
      }
    }

    assert.deepEqual(offences, [],
      'An agent-reach subcommand that does not exist fails silently — runAgentReach '
      + 'swallows the error — so it can never be caught at runtime.');
  });

  it('hackernews is not an agent-reach platform, and nothing claims it is', () => {
    // Named explicitly because it was the more egregious of the two: reddit at
    // least exists as a separate binary, whereas agent-reach covers no Hacker
    // News channel at any layer.
    const documented = readAllSkillText().toLowerCase();
    assert.ok(!/hacker\s?news/.test(documented),
      'if the skill gains a Hacker News channel, this test should be updated rather than deleted');

    for (const file of sourceFiles('src')) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!/['"]agent-reach['"]\s*,\s*\[\s*['"]hackernews['"]/.test(src),
        path.relative(REPO, file) + ' invokes a Hacker News channel agent-reach does not have');
    }
  });
});
