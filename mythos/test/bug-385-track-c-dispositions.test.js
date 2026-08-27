'use strict';

// BUG-385 / closure campaign Track C — the three dispositions, and the two real
// defects that dispositioning them turned up.
//
// A DISPOSITION in this campaign is "a recorded deliberate non-change, when the
// behaviour is correct by design", and it needs three things: a code comment, a
// regression test locking it, and a map row that says so. This file is the
// second of those for all three items.
//
// The trap a disposition walks into is locking in behaviour that only LOOKS
// correct. C-1 is exactly that: the refusal policy ("MYTHOS never solves a
// CAPTCHA") was genuinely right and already pinned, so it would have been easy
// to record the disposition and move on — while the detector deciding WHAT IS a
// CAPTCHA flagged 6 of 6 ordinary pages and missed the real challenge text. The
// false-positive table below is therefore the centre of this file, not a
// flourish: it is the thing that was wrong, expressed as controls.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FROM_BROWSER = path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-browser.js');
const PS_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');

const fb = require(FROM_BROWSER);

// ---------------------------------------------------------------------------
// C-1. The refusal is right. What counts as a challenge was not.

// `looksLikeCaptcha` is fed the aria tree PLUS page.url(), so a URL is as much
// an input as prose. Every row here is a page a person browses on an ordinary
// day, and every one of them was flagged before this fix.
const ORDINARY = [
  ['vendor docs', '- heading "Workers KV" - link "Docs" | https://developers.cloudflare.com/workers/'],
  ['a site footer', '- contentinfo "Performance and security by Cloudflare" | https://example.com/blog'],
  ['a news article about the vendor', '- heading "Cloudflare outage explained" | https://news.ycombinator.com/item?id=1'],
  ['the vendor status page', '- heading "All systems operational" | https://www.cloudflarestatus.com/'],
  ['a Google account Security Checkup', '- heading "Security Checkup" - text "Security check up complete" | https://myaccount.google.com/security-checkup'],
  ['a bank help page', '- text "we run a security check on every login" | https://bank.example/help'],
  ['ordinary security settings', '- heading "Security settings" - link "Human Resources"'],
];

const CHALLENGES = [
  ['Google /sorry with a widget', '- iframe "reCAPTCHA" | https://google.com/sorry/index?continue=x'],
  ['Google /sorry with no widget in the tree', '- heading "About this page" | https://www.google.com/sorry/index?continue=x'],
  ['"Verifying you are human"', '- text "Verifying you are human. This may take a few seconds."'],
  ['"Checking your browser before accessing"', '- text "Checking your browser before accessing example.com"'],
  ['the challenge-platform path', '- iframe | https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate'],
  ['press and hold', '- button "Press and hold to confirm you are a human"'],
  ['an hCaptcha frame', '- iframe "hCaptcha" [ref=e1]'],
  ['the reCAPTCHA checkbox', '- checkbox "I am not a robot"'],
  ['"complete the security check"', '- text "Please complete the security check to access"'],
];

describe('BUG-385 C-1 — a challenge is a challenge; a vendor is not', () => {
  for (const [label, page] of ORDINARY) {
    test(`does not cry captcha at ${label}`, () => {
      assert.deepStrictEqual(fb.looksLikeCaptcha(page), [],
        'this page was flagged before BUG-385, and browser_snapshot would have told the model '
        + 'to stop and ask the operator to solve a challenge that is not there');
    });
  }

  for (const [label, page] of CHALLENGES) {
    test(`recognises ${label}`, () => {
      assert.ok(fb.looksLikeCaptcha(page).length > 0, 'must recognise: ' + page);
    });
  }

  test('NO MARKER IS A BARE VENDOR NAME — the rule, not the two that were removed', () => {
    // Expressed as a rule so the next person adding a marker has to argue with
    // it. Naming only `cloudflare` and `security check` would be a denylist of
    // history: the next bad marker is a different vendor.
    for (const vendor of ['cloudflare', 'google', 'akamai', 'imperva', 'datadome', 'perimeterx', 'aws', 'fastly']) {
      assert.deepStrictEqual(fb.looksLikeCaptcha(vendor), [],
        `"${vendor}" on its own names a company, not a challenge, and appears on pages that have none`);
      assert.deepStrictEqual(fb.looksLikeCaptcha(`- contentinfo "Protected by ${vendor}" | https://${vendor}.com/pricing`), [],
        `a page that merely mentions ${vendor} is not a challenge`);
    }
  });

  test('detection never turns a page into a tool failure', () => {
    // The disposition proper. Both branches are ok:true — "we reached the line
    // this system does not cross" is an answer, not a fault, and reporting it
    // as ok:false would make the model treat a working boundary as a bug.
    const src = fs.readFileSync(FROM_BROWSER, 'utf8');
    const start = src.indexOf('async function browser_check_captcha');
    assert.notEqual(start, -1, 'browser_check_captcha not found — fix the extraction, do not delete the assertion');
    const body = src.slice(start, src.indexOf('\n// ---- Tool catalog', start));
    assert.ok(/blocked: 'captcha'/.test(body), 'the blocked payload is the handover signal');
    assert.ok(!/return fail\(['"]/.test(body.slice(body.indexOf('markers.length'))),
      'reaching a challenge must not be reported as a failure');
  });

  test('the boundary itself is structural and did not move', () => {
    // Tightening detection cannot open a safety hole, because the safety
    // property is the absence of a solver rather than the quality of a match.
    // Restated here so the two are never conflated in review.
    const src = fs.readFileSync(FROM_BROWSER, 'utf8');
    assert.ok(!/2captcha|anticaptcha|capsolver|solveCaptcha|bypassCaptcha/i.test(src),
      'MYTHOS must never acquire a CAPTCHA-solving path');
  });
});

// ---------------------------------------------------------------------------
// C-2. The ladder is exhausted. Every failure must still say what to do next.

function focusWindowBody() {
  // Comments stripped: this function's own comments quote the error strings and
  // name the rungs, so a scan that counts prose would pass on documentation
  // alone — the same defect as a guard that reads its own docs.
  const src = fs.readFileSync(PS_PATH, 'utf8');
  const start = src.indexOf('function Handle-FocusWindow');
  assert.notEqual(start, -1, 'Handle-FocusWindow not found — fix the extraction, do not delete the assertion');
  const next = src.indexOf('\nfunction ', start + 10);
  assert.notEqual(next, -1);
  return src.slice(start, next).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('BUG-385 C-2 — focus_window: exhausted ladder, honest failures', () => {
  test('the no-main-window failure names its recovery', () => {
    // 2 of focus_window's 6 recorded failures were this, and it was the only
    // class that told the caller nothing to do next — so the model retries the
    // same pid. The stale-pid failure beside it already named list_windows.
    const body = focusWindowBody();
    const line = body.split('\n').find((l) => l.includes('has no main window'));
    assert.ok(line, 'the no-main-window branch is gone — did the message change?');
    assert.match(line, /list_windows/,
      'every failure names the recovery: list_windows enumerates WINDOWED processes, '
      + 'so a pid missing from it settles the question');
    assert.match(line, /nothing was focused/,
      'and it must say that nothing happened, so a partial effect is never assumed');
  });

  test('THE LADDER HAS EXACTLY THREE RUNGS — no fourth may be added', () => {
    // Binding in root CLAUDE.md: the question of whether the foreground-lock
    // denial reproduces in real voice-driven use was CLOSED on 2026-08-17 and
    // the answer is yes. Windows is refusing deliberately; the alternatives are
    // unreliable or user-hostile. This is the disposition, as an assertion.
    const body = focusWindowBody();
    const rungs = body.match(/\$method\s*=\s*'[^']+'/g) || [];
    assert.deepStrictEqual(rungs, [
      "$method = 'attach-thread-input'",
      "$method = 'foreground-lock-timeout'",
      "$method = 'minimize-restore'",
    ], 'a fourth rung was added, or one was renamed. The ladder is exhausted — see root CLAUDE.md.');
  });

  test('the foreground-lock failure names all three rungs it tried', () => {
    const body = focusWindowBody();
    // Match the FAILURE string, not merely 'foreground-lock' — the first draft
    // did the latter and picked up `$method = 'foreground-lock-timeout'`, which
    // appears earlier and names only one rung, so the assertion failed against
    // correct code. An anchor that matches the wrong line is not a finding.
    const line = body.split('\n').find((l) => l.includes('blocked by the OS foreground-lock'));
    assert.ok(line, 'the foreground-lock failure message is gone or reworded');
    for (const rung of ['thread-attach', 'lock-timeout override', 'minimize/restore']) {
      assert.ok(line.includes(rung),
        `the refusal must name ${rung} — "it did not work" is not an answer anyone can act on`);
    }
  });

  test('the system-wide lock timeout is always restored', () => {
    // Rung 2 changes a MACHINE setting. A leak here degrades every application
    // on the operator's desktop, not just MYTHOS.
    const body = focusWindowBody();
    const restore = body.indexOf('SPI_SETFOREGROUNDLOCKTIMEOUT, 0, $savedTimeout');
    assert.notEqual(restore, -1, 'the saved timeout is never written back');
    const fin = body.lastIndexOf('} finally {', restore);
    assert.notEqual(fin, -1, 'the restore must sit in a finally, or a throw between rungs leaks it');
  });
});

// ---------------------------------------------------------------------------
// C-3. No tool exists, and nothing may quietly stand in for one.

describe('BUG-385 C-3 — video call has no tool, and no substitute', () => {
  const sync = require('../scripts/sync-test-count.js');
  const registered = Object.values(sync.computeEffectorTools().perFile).flat();

  test('no registered tool offers a video call', () => {
    assert.ok(registered.length > 150, `only ${registered.length} tools resolved — the enumeration broke`);
    const suspects = registered.filter((id) => /video|facetime|meet\b|zoom/i.test(id));
    assert.deepStrictEqual(suspects, [],
      'a video-call tool appeared. The `video call` map node records that none exists and that '
      + 'MYTHOS said so plainly rather than faking it — update the node before adding one.');
  });

  test('phone_call exists, is a VOICE call, and is withheld from the voice surface', () => {
    // The disposition is not "there is no call tool" — there is one, and a model
    // denied a tool does not always decline: it reaches for the nearest. This is
    // the assertion that has to be argued with before phone_call is promoted,
    // because on the voice surface it would become the nearest thing to "call
    // someone" for a request MYTHOS cannot fulfil.
    const liveTools = require('../src/core/voice/live-tools.js');
    assert.ok(registered.includes('phone_call'), 'phone_call is expected to exist');
    assert.ok(!new Set(liveTools.DEFAULT_ALLOWLIST).has('phone_call'),
      'phone_call is voice-withheld, which is why a spoken video-call request was declined '
      + 'honestly instead of being answered with a voice call');
  });
});
