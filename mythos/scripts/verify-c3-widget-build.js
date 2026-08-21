#!/usr/bin/env node
// Live verification for C3 (generative UI): a Hermes generation must come back
// as a widget SPEC validated against the registry's closed world — never as
// free HTML or an invented widget kind.
//
// This is the XSS-sensitive surface. The unit tests feed the validator crafted
// objects, which proves the validator but not that a real model reply survives
// it. Here a real Hermes call produces the candidate, and the result is checked
// against KNOWN_STATIC_KINDS / the dynamic shape independently.
//
// Also asserts the negative case that matters: markup-bearing candidates are
// rejected rather than sanitised, since the HUD's escapeHtml does not escape
// double quotes and attribute interpolation has been a break-out here before.
//
// Usage: node scripts/verify-c3-widget-build.js
// Exit 0 = generated specs are closed-world. Exit 1 = they are not.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (_) {}

const { createForgeRunner } = require(path.join(ROOT, 'src/core/effectors/forge-runner.js'));
const widgetSpec = require(path.join(ROOT, 'src/core/effectors/widget-spec.js'));

let tmpBase = os.tmpdir();
try { tmpBase = fs.realpathSync.native(tmpBase); } catch (_) {}
const vaultRoot = fs.mkdtempSync(path.join(tmpBase, 'mythos-c3-'));

// Minimal vault: runWidgetBuild only needs a scratch dir it can point the engine at.
const vault = {
  vaultPath: (rel) => path.join(vaultRoot, rel || ''),
  ensureDir: (abs) => { fs.mkdirSync(abs, { recursive: true }); },
};

function cleanup() {
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
}

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}  ${detail}`);
}

// Candidates that must NEVER validate. The validator's contract is SHAPE —
// closed-world kind, known layout, bounded items. It is deliberately not an
// HTML sanitiser.
const MUST_REJECT = [
  ['raw html string', '<div onclick="steal()">hi</div>'],
  ['unknown kind', { kind: 'iframe', src: 'https://example.com' }],
  ['static kind with extra props', { kind: 'clock', html: '<b>x</b>' }],
  ['unknown layout', { kind: 'dynamic', title: 'ok', layout: 'iframe' }],
];

// Candidates the validator ACCEPTS by design, because neutralising them is the
// renderer's job, not the schema's. Recorded explicitly so the division of
// responsibility is asserted rather than assumed — if someone ever moves one of
// these strings into an attribute position, escapeHtml alone stops being enough
// (it does not escape double quotes; escapeAttr at dynamic.js:113 exists for
// exactly that case).
//
// Verified by reading every sink: items dynamic.js:52-96, footer :107, title
// widget-host.js:116 — all text positions, all escaped. The single attribute
// value is `cls`, which comes from toneClass()'s fixed whitelist.
const ACCEPTED_ESCAPED_DOWNSTREAM = [
  ['html in title', { kind: 'dynamic', title: '<img src=x onerror=alert(1)>', layout: 'stat' }],
  ['quote sequence in value', { kind: 'dynamic', title: 'ok', layout: 'stat', items: [{ label: 'a', value: '" onmouseover="x' }] }],
];

(async () => {
  console.log('C3 live verification — real Hermes widget build, scratch vault at ' + vaultRoot + '\n');

  // --- negative cases first: they need no provider call, so a provider outage
  // --- cannot make the security-relevant half of this script silently skip.
  let rejected = 0;
  const leaked = [];
  for (const [name, candidate] of MUST_REJECT) {
    const res = widgetSpec.validateWidgetSpec(candidate);
    if (res && res.ok) leaked.push(name);
    else rejected++;
  }
  record('out-of-world shapes are rejected', leaked.length === 0,
    leaked.length === 0 ? `${rejected}/${MUST_REJECT.length} rejected`
                        : `ACCEPTED: ${leaked.join(', ')}`);

  // Assert the split of responsibility explicitly: if the validator ever starts
  // rejecting these, the renderer's escaping has silently become load-bearing
  // in a different place and this note needs revisiting.
  const unexpectedlyRejected = ACCEPTED_ESCAPED_DOWNSTREAM
    .filter(([, c]) => { const r = widgetSpec.validateWidgetSpec(c); return !(r && r.ok); })
    .map(([n]) => n);
  record('markup strings pass the schema and are escaped at render', unexpectedlyRejected.length === 0,
    unexpectedlyRejected.length === 0
      ? 'validator is shape-only by design; sinks escaped (dynamic.js:52-107, widget-host.js:116)'
      : `now rejected by the schema: ${unexpectedlyRejected.join(', ')} — revisit the comment`);

  // The renderer's escape helper must keep escaping the three characters the
  // text-position sinks rely on. A regression here turns every accepted string
  // above into live markup.
  const rendererSrc = fs.readFileSync(
    path.join(ROOT, 'ui/public/js/widgets/kinds/dynamic.js'), 'utf8');
  const escapesAll = /replace\(\/&\/g[\s\S]*?replace\(\/</g.test(rendererSrc)
    && /&lt;/.test(rendererSrc) && /&gt;/.test(rendererSrc);
  record('renderer escapeHtml still escapes & < >', escapesAll,
    escapesAll ? 'all three replacements present' : 'escapeHtml has been weakened');

  // --- live case
  // Model output is nondeterministic, and one sample cannot distinguish
  // reliability from luck. Observed both outcomes for the same prompt: a clean
  // {"kind":"cores"} and a {"kind":"cores","title":...,"layout":...} that the
  // validator rejects, since static kinds take no props. Sample 3 times and
  // report the rate — a build that fails half the time on a reasonable request
  // is a real weakness even though each individual rejection is correct.
  const ATTEMPTS = 3;
  // W6: the engine is injected now, so this drives the real adapter explicitly
  // rather than relying on the runner to require one.
  const runner = createForgeRunner({ config: {}, vault, engine: require(path.join(ROOT, 'adapters/dsh-agent')) });
  const outcomes = [];
  let built = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await runner.runWidgetBuild('Show the current CPU core load as a compact stat widget.');
    const good = !!(r && r.ok !== false);
    outcomes.push(good ? 'ok' : String((r && r.reason) || 'failed'));
    if (good && !built) built = r;
  }
  const okCount = outcomes.filter(o => o === 'ok').length;
  record('widget build succeeds reliably', okCount >= 2,
    `${okCount}/${ATTEMPTS} attempts produced a valid spec — [${outcomes.join(', ')}]`);

  if (!built) {
    record('Hermes returned a usable widget spec', false,
      `no attempt validated; outcomes: ${outcomes.join(', ')}`);
  } else {
    const spec = built.spec || built;
    const kind = spec && spec.kind;
    const known = widgetSpec.KNOWN_STATIC_KINDS.includes(kind) || kind === 'dynamic';
    record('generated kind is in the closed world', known,
      known ? `kind='${kind}'` : `kind='${kind}' is not a registry kind`);

    // Re-validate independently of runWidgetBuild's own gate, so this cannot
    // pass by trusting the code under test.
    const revalidated = widgetSpec.validateWidgetSpec(spec);
    record('spec re-validates against widget-spec.js', !!(revalidated && revalidated.ok),
      revalidated && revalidated.ok ? 'clean' : `rejected: ${revalidated && revalidated.reason}`);

    // No markup anywhere in the returned spec, at any depth.
    const flat = JSON.stringify(spec);
    const hasMarkup = /<[a-zA-Z/!]/.test(flat);
    record('spec contains no markup', !hasMarkup,
      hasMarkup ? `found a tag-like sequence in ${flat.slice(0, 120)}` : 'no tag-like sequences');
  }

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.error('verification threw: ' + ((err && err.stack) || err));
  cleanup();
  process.exit(1);
});
