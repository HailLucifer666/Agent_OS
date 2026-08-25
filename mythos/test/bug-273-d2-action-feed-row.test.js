'use strict';

// test/bug-273-d2-action-feed-row.test.js — BUG-273 D2, second half.
//
// THE INCIDENT: *"News widget displayed but main HUD shows incorrect error
// message ('agent actions failed')"*, 2026-08-18.
//
// The HUD was not showing an incorrect message. It was showing a correct message
// about a DIFFERENT call, and nothing in the Agent Actions feed said so. From the
// audit, with real args:
//
//   11:44:01  open_web {query:"Kolkata to Bangalore", type:"search"}       -> ok
//   11:44:06  open_web {query:"distance Kolkata to Bangalore", type:"web"} -> FAIL
//
// Two rows, same tool name, four seconds apart, one of them a real failure. There
// was no way to tell which row belonged to the widget the operator was looking
// at, so a truthful failure read as the HUD contradicting itself. The A1/A2
// barge-in work covers the second half of that incident (having to click to
// interrupt), and the 'propose_goal' half was not a mis-click at all — all 6
// calls that session carry actor:'cortex' in the audit and propose_goal is not
// even in the Live tool allowlist.
//
// Q1/PRIVACY — the obvious disambiguator is the arguments, and they must NOT go on
// screen. whatsapp_send's args carry the message text and the recipient's phone
// number, and this feed sits on a HUD that gets screenshotted and screen-shared.
// A clock is the smallest thing that separates two rows while putting no new
// information on screen at all.
//
// Q5 — the timestamp is the BUS EVENT's, relayed, not Date.now() at receipt.
// replayBuffers replays up to 200 historical rows when the backend-terminal panel
// subscribes; a client-side stamp would label all of session history with the
// moment the panel opened, which is a worse lie than having no clock.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let rowClock;

before(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'actions.js'),
  ).href);
  rowClock = mod.rowClock;
});

describe('BUG-273 D2 — rowClock', () => {
  it('renders HH:MM:SS for a real event timestamp', () => {
    // The exact ts of the 11:44:06 open_web failure, from the audit record
    // aud-562006af39ba. Asserted by SHAPE, not by value: the expected string is
    // local-time and would make this test fail in another timezone, which is a
    // property of the test machine and not of the code.
    const out = rowClock(1787053446779);
    assert.match(out, /^\d{2}:\d{2}:\d{2}$/, 'zero-padded wall clock, mono-width so rows align');
  });

  it('pads every field, so rows in a mono feed line up', () => {
    // A single-digit hour/minute/second unpadded would shift the tool name column
    // and make the feed harder to scan than it was before the clock existed.
    const out = rowClock(new Date(2026, 0, 2, 3, 4, 5).getTime());
    assert.equal(out, '03:04:05');
  });

  it('returns null rather than fabricating a time it does not have', () => {
    // An older server, or a row replayed from before the relay carried ts. A
    // placeholder clock on a row whose time is unknown is the same class of false
    // certainty this whole fix is about.
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, '1787053446779', {}]) {
      assert.equal(rowClock(bad), null, `rowClock(${JSON.stringify(bad)}) must be null`);
    }
  });
});

describe('BUG-273 D2 — the relay and the row builder agree', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const widgetSrc = fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'actions.js'), 'utf8',
  );

  it('the action relay sends the bus event ts, not a client-side stamp', () => {
    // Bounded by the relay's own last statement rather than the first '});' —
    // that first match lands inside the logger.warn() call above the payload and
    // cut the window before the field under test. Same brittle-source-window trap
    // this repo has paid for before: widen the window, never the invariant.
    const start = serverSrc.indexOf("bus.subscribe('action.*'");
    assert.notEqual(start, -1, 'the action relay must still exist');
    const end = serverSrc.indexOf("broadcastAll({ type: 'action'", start);
    assert.ok(end > start, 'the relay must still end by broadcasting the action');
    const block = serverSrc.slice(start, end);
    assert.match(block, /ts: e\.ts/,
      'the row time must come from the event, or a replayed history is stamped with "now"');
    // Anchored on the ASSIGNMENT, not on the substring 'Date.now()'. The first
    // version of this assertion was `doesNotMatch(block, /Date\.now\(\)/)` and it
    // failed on the comment above the field, which explains why Date.now() is
    // wrong here — a detector catching the prose that documents it. Exactly the
    // failure this repo keeps paying for, and the sibling
    // browser-intent-disambiguation.test.js records the same lesson.
    assert.doesNotMatch(block, /ts:\s*Date\.now\(\)/,
      'and must not be re-stamped at relay time either');
  });

  it('the row builder reads p.ts through rowClock and escapes the result', () => {
    assert.match(widgetSrc, /const clock = rowClock\(p\.ts\);/);
    assert.match(widgetSrc, /escapeHtml\(clock\)/,
      'this row builder has one rule — everything interpolated is escaped. An exception '
      + 'for a "safe" field is how the next unescaped field arrives.');
  });

  it('Q1 — the feed still renders NO arguments: whatsapp_send args are message text and a phone number', () => {
    const mount = widgetSrc.slice(widgetSrc.indexOf('export function mountActions'));
    assert.doesNotMatch(mount, /p\.args/,
      'arguments would disambiguate better and must stay off a screenshotted HUD');
    // The four fields the row is allowed to show, and nothing else.
    for (const field of [/p\.reason/, /p\.tool/, /p\.ts/]) assert.match(mount, field);
  });
});
