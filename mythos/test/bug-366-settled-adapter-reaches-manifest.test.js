'use strict';

// bug-366-settled-adapter-reaches-manifest.test.js
//
// BUG-366 — the capabilities manifest was corrected only when an adapter
// SUCCEEDED, so a failure could be left described as still-in-progress.
//
// The 2026-08-26 audit reported `browser-agent: CONNECTING` frozen permanently
// in the manifest and blamed a coincidence of constants: main.js scheduling its
// settle re-write at a literal 10000, the same value as browser-agent's own
// CONNECT_TIMEOUT_MS, so the write sampled the adapter at the instant its
// connect expired.
//
// THAT MECHANISM IS WRONG, and it is recorded here because it is a plausible
// story that survives reading the code and dies on measurement. With no debug
// Chrome on :9222 the connect fails with ECONNREFUSED in ~15ms, not 10s — the
// two timers never race. Pinned by the first test below.
//
// What actually produces a wrong manifest is three things together:
//   1. The immediate boot write can sample the adapter inside that ~15ms window,
//      because connect() sets CONNECTING synchronously and the browser step
//      (main.js:942) runs before the manifest step (:1056).
//   2. Nothing refreshed on the CONNECTING -> OFFLINE transition. Only the three
//      success paths did. So a mid-flight sample stood.
//   3. The settle timer is unref'd, so a process that exits first never corrects
//      the file at all.
//
// And the audit's evidence was an artefact of (3): `test/boot.test.js:17` points
// MYTHOS_VAULT_ROOT at the REPO vault and kills the boot 200ms after ALIVE, so
// `mythos/vault/Identity/capabilities.md` is test output, not system state. The
// packaged vault on the same machine, written by a long-lived boot, correctly
// read `browser-agent: OFFLINE (CDP connect failed: ... ECONNREFUSED
// 127.0.0.1:9222)` — state and reason both. Five test files deliberately share
// that repo-vault convention (one comments "identity-only — kept"), so it is
// documented here rather than unilaterally re-pointed.
//
// It still matters: from-memory.js reads the manifest back to answer "what can
// you do?", and a dev-mode session reads the repo vault. The fix is (2) — the
// correction now lands in ~15ms instead of waiting on a timer that may never
// fire.
//
// Run: cd mythos && node --test test/bug-366-settled-adapter-reaches-manifest.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const browserAgent = require('../adapters/browser-agent');
const capabilities = require('../src/core/identity/capabilities');

function fakeHub() {
  return { catalog() { return [{ name: 'list_goals', description: 'List all goals.', params: {} }]; } };
}

describe('BUG-366 — a settled adapter failure is fast and always carries its reason', () => {
  it('fails in well under the connect timeout, so the two timers never race', async () => {
    // This is the measurement that kills the audit's stated mechanism. Port 1 is
    // closed, which is the same condition as "no debug Chrome on 9222": the OS
    // refuses immediately rather than letting the handshake run to timeout.
    const started = Date.now();
    const ok = await browserAgent.connect('http://127.0.0.1:1');
    const elapsed = Date.now() - started;

    assert.equal(ok, false, 'connecting to a closed port must fail');
    assert.ok(elapsed < browserAgent.CONNECT_TIMEOUT_MS / 2,
      'a refused connect settles far inside the timeout (took ' + elapsed + 'ms of '
      + browserAgent.CONNECT_TIMEOUT_MS + 'ms) — so a write scheduled at the timeout '
      + 'is NOT what caught this adapter mid-flight');
  });

  it('leaves a settled failure reportable: OFFLINE with a real hint', async () => {
    // The audit also saw `hint: null` and filed it separately. It is the same
    // bug: connect() clears the hint on entry and only sets a real one on
    // settle, so a status sampled mid-attempt necessarily has no reason
    // attached. Once settled, a reason always exists.
    await browserAgent.connect('http://127.0.0.1:1');
    const st = browserAgent.getStatus();

    assert.equal(st.state, 'OFFLINE');
    assert.ok(st.hint, 'a settled failure must carry a hint');
    assert.match(st.hint, /CDP connect failed/);
  });

  it('exports CONNECT_TIMEOUT_MS so a consumer derives the value instead of restating it', () => {
    // The duplicated literal is a real defect even though it was not the cause:
    // two copies of one number go stale silently when either moves.
    assert.equal(typeof browserAgent.CONNECT_TIMEOUT_MS, 'number');
    assert.ok(browserAgent.CONNECT_TIMEOUT_MS > 0);
  });
});

describe('BUG-366 — the manifest renders a settled reason, and shows its absence', () => {
  it('renders the hint alongside the state when one is present', () => {
    const md = capabilities.generateMarkdown(fakeHub(), [
      { name: 'browser-agent', state: 'OFFLINE', hint: 'CDP connect failed: ECONNREFUSED 127.0.0.1:9222' },
    ]);
    assert.match(md, /- browser-agent: OFFLINE \(CDP connect failed: ECONNREFUSED 127\.0\.0\.1:9222\)/,
      'the reason is the whole value of refreshing on failure — it must reach the file');
  });

  it('renders a bare state with no reason when the hint is absent — the shape the audit read', () => {
    // Pinned as the CONTRAST, not as desired behaviour. This is exactly what a
    // manifest written mid-attempt looks like, and why it reads to an operator
    // (and to from-memory.js) as "connecting — yes, shortly".
    const md = capabilities.generateMarkdown(fakeHub(), [
      { name: 'browser-agent', state: 'CONNECTING', hint: null },
    ]);
    assert.match(md, /- browser-agent: CONNECTING\n/);
    assert.doesNotMatch(md, /- browser-agent: CONNECTING \(/,
      'a CONNECTING line has no reason to give, which is the tell that it is mid-flight');
  });
});

describe('BUG-366 — every settled browser outcome refreshes the manifest', () => {
  // Source-shape, because the invariant is a WIRING one: which callbacks call
  // refreshCapabilities. No unit test can see a missing call in a boot step, and
  // this repo's own notes say source assertions on main.js are the only
  // automated guard available for that.
  //
  // Deliberately counted inside a delimited block rather than matched against
  // exact text: a window pinned to specific lines breaks when a comment is
  // added, which has already cost this repo unrelated red tests. The invariant
  // is "three settled paths, three refreshes", not any particular phrasing.
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  function connectHandlerBlock() {
    const start = MAIN.indexOf('browserAgent.connect(');
    assert.ok(start > 0, 'the browser connect call must still exist');
    const end = MAIN.indexOf('startAutoConnect', start);
    assert.ok(end > start, 'the auto-connect poller must still follow it');
    return MAIN.slice(start, end);
  }

  it('refreshes on success, on a false result, and on a throw', () => {
    const block = connectHandlerBlock();
    const refreshes = (block.match(/refreshCapabilities\(\)/g) || []).length;
    assert.ok(refreshes >= 3,
      'the connect handler has three settled outcomes — ok, not-ok, and threw — and each must '
      + 'refresh the manifest; found ' + refreshes);
  });

  it('the settle re-write derives its delay from the adapter timeout', () => {
    assert.match(MAIN, /browserAgent\.CONNECT_TIMEOUT_MS/,
      'the settle delay must be derived from the adapter, not restated');
    assert.doesNotMatch(MAIN, /setTimeout\(\s*writeIt\s*,\s*\d+\s*\)/,
      'a hardcoded settle delay is a second copy of a constant that already exists');
  });
});
