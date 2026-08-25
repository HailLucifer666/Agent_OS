'use strict';

// bug-273-b3-widget-render-ack.test.js — BUG-273 B3.
//
// THREE INCIDENTS on 2026-08-18, all the same shape: `news`, `flights` ("Kolkata to
// Bangalore"), and a generic *"Dashboard did not confirm display"*. The audit shows
// `open_web -> ok` with reason "the dashboard has not confirmed it rendered this"
// every time. BUG-272 T2 fixed only the `browser:true` branch; the dashboard branch
// was still unverified BY CONSTRUCTION, and openWebResult's own comment said so:
// "nothing here reads back from the HUD (no ui.open-web-consumed ack exists)".
//
// Now it does. The HUD is asked whether the widget mounted, and the answer has
// three distinct outcomes rather than one:
//   mounted        -> verifiedOk with the new `dashboard-render` oracle
//   did not mount  -> FAIL, naming why, so nobody is told to look at nothing
//   no answer      -> unverified, exactly as before
//
// Q8 — WHY THIS IS NOT BUG-273 B2's confirmedStep. B2 could honestly say "your
// browser was handed the URL" because openExternal resolving is an independently
// established fact. Here there was no confirmed step at all — nothing downstream
// reported back — so a partial claim would have been invented rather than observed.
// With a real ack the outcome stops being unverified altogether.
//
// Q5 — THE UNSET CASE IS THE OLD CASE, deliberately. A plain `node src/main.js`
// boot, or a HUD with no socket, has nothing to ask. A provider defaulted to
// "assume it worked" would rebuild this bug in the one configuration nobody tests,
// so an unset renderer keeps the original unverified wording verbatim.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const evidence = require('../src/core/effectors/evidence');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function build(renderer) {
  const built = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
  });
  if (renderer) built.setWidgetRenderer(renderer);
  return built;
}

function toolFn(name, renderer) {
  const built = build(renderer);
  const t = built.TOOLS.find((x) => x.name === name);
  assert.ok(t, name + ' must still be registered');
  return t.fn;
}

// type:'news' is the cheapest dashboard branch to drive: it needs no network, just
// a google-news URL, and it goes through openWebResult like every other one.
const NEWS = { type: 'web', url: 'https://news.google.com' };

describe('BUG-273 B3 — the dashboard-render oracle', () => {
  it('is registered, so verifiedOk will accept it', () => {
    assert.ok(evidence.ORACLES.includes('dashboard-render'),
      'verifiedOk THROWS on an unknown oracle by design — an unregistered name would '
      + 'turn every rendered widget into a crash rather than a confirmation');
  });

  it('still refuses an oracle with no observation', () => {
    assert.throws(() => evidence.verifiedOk({}, { oracle: 'dashboard-render', observed: '' }),
      /produced no observation/,
      'a HUD that answered with nothing is not evidence that anything rendered');
  });
});

describe('BUG-273 B3 — open_web reports what the dashboard actually did', () => {
  it('a mounted widget is VERIFIED, not unverified', async () => {
    const res = await toolFn('open_web', async () => ({ mounted: true, surface: 'floating widget' }))(NEWS);
    assert.equal(res.ok, true);
    assert.equal(res.unverified, false, 'this is the whole point: it is proven now');
    assert.equal(evidence.isVerified(res), true, 'so the HUD tick and the breaker can trust it');
    assert.equal(res.evidence.oracle, 'dashboard-render');
    assert.match(res.evidence.observed, /floating widget|news/,
      'the observation must name what the HUD reported, not echo the request');
  });

  it('a widget that did NOT mount is a FAILURE, naming why', async () => {
    const res = await toolFn('open_web',
      async () => ({ mounted: false, reason: 'the news widget failed to render: boom' }))(NEWS);
    assert.equal(res.ok, false,
      'an unverified success here is what told the operator to look at an empty dashboard');
    assert.match(String(res.result), /failed to render: boom/, 'the real reason must survive');
    assert.match(String(res.result), /do not tell the operator to look at it/i,
      'and the model must be told not to point at nothing');
  });

  it('SILENCE is unverified, not failure — they are different facts', async () => {
    // The 3s timeout in requestWidgetRender resolves null. A HUD that never answered
    // may well have rendered; claiming failure there is the mirror-image lie.
    const res = await toolFn('open_web', async () => null)(NEWS);
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.match(String(res.reason), /did not answer/);
    assert.doesNotMatch(String(res.reason), /did not render/,
      'no answer must not be reported as a refusal to render');
  });

  it('Q5 — with NO renderer wired, the old wording is kept verbatim', async () => {
    const res = await toolFn('open_web', null)(NEWS);
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.equal(res.reason, 'the dashboard has not confirmed it rendered this',
      'byte-identical to the pre-B3 behaviour — a plain node boot has nothing to ask');
  });

  it('a renderer that THROWS degrades to unverified rather than taking the tool down', async () => {
    const res = await toolFn('open_web', async () => { throw new Error('socket exploded'); })(NEWS);
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true, 'a broken ack channel must not fabricate either verdict');
  });

  it('marks the descriptor so dispatch-action does not render it a second time', async () => {
    const res = await toolFn('open_web', async () => ({ mounted: true }))(NEWS);
    assert.equal(res.result.renderDispatched, true,
      'BUG-166 was one open_web producing two players; this flag is what stops the '
      + 'ack path and the legacy bus relay from both rendering');
  });
});

describe('BUG-273 B3 — the wiring the ack depends on', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

  it('dispatch-action skips its bus relay for an already-dispatched render', () => {
    const s = read('src/core/effectors/dispatch-action.js');
    assert.match(s, /if \(!result\.result\.renderDispatched\) bus\.emit\('ui\.open-web'/,
      'without this guard the widget renders twice');
  });

  it('the other ui.open-web producers are deliberately untouched', () => {
    // from-pc.js and from-widgets.js emit the event directly and have no ack. That is
    // out of B3's scope, and the client's ackRender is a no-op without a reqId
    // precisely so those paths keep working rather than failing for want of an ack.
    for (const rel of ['src/core/effectors/from-pc.js', 'src/core/effectors/from-widgets.js']) {
      assert.match(read(rel), /bus\.emit\('ui\.open-web'/, rel + ' must still use the bus relay');
    }
    assert.match(read('ui/public/js/app.js'), /if \(!msg \|\| !msg\.reqId\) return;/,
      'ackRender must no-op on a relay frame that carries no reqId');
  });

  it('the server treats a missing `mounted` field as NOT mounted', () => {
    const s = read('server/index.js');
    assert.match(s, /mounted: msg\.mounted === true/,
      'a truthy check would let an older client or a malformed frame read as a '
      + 'confirmation, which is the exact class of bug B3 exists to close');
  });

  it('the server round-trip resolves null on timeout, like requestClosePanel', () => {
    const s = read('server/index.js');
    const start = s.indexOf('function requestWidgetRender');
    assert.notEqual(start, -1, 'the provider must exist');
    const body = s.slice(start, s.indexOf('function requestClosePanel', start));
    assert.match(body, /pendingWidgetRender\.delete\(id\); resolve\(null\)/,
      'a timeout is silence, and silence is unverified');
    assert.match(body, /broadcastAll\(\{ type: 'open-web', payload: payload, reqId: id \}\)/,
      'the reqId is what lets the HUD answer at all');
  });

  it('it is wired in main.js next to the three sibling providers', () => {
    assert.match(read('src/main.js'), /dashboardWiring\.setWidgetRenderer\(serverHandle\.requestWidgetRender\)/);
  });
});

describe('BUG-273 B3 — the HUD reports on its own DOM', () => {
  it('spawnWebWidget returns mounted:false when the descriptor is unusable', async () => {
    // spawnWebWidget is a closure inside mountWidgets(root, ctx) and needs a real DOM
    // to construct, so it cannot be called from here. The import is still worth doing:
    // it proves the module parses after the edit, which is the failure mode that a
    // green suite is otherwise blind to (a browser module is never loaded by node:test).
    const mod = await import(pathToFileURL(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'widget-host.js'),
    ).href);
    assert.equal(typeof mod.mountWidgets, 'function', 'the module must still parse and export mountWidgets');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'widget-host.js'), 'utf8',
    ).replace(/\r\n/g, '\n');
    assert.match(src, /if \(!payload \|\| !payload\.widgetType\) return \{ mounted: false/,
      'it used to `return;` here, which the caller could not distinguish from success');
  });

  it('a kind-module throw is reported as not-mounted while still showing the operator why', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'widget-host.js'), 'utf8',
    ).replace(/\r\n/g, '\n');
    assert.match(src, /replaceChildren\(failureNode\(err\)\)/,
      'the failure node stays — the operator should see the reason on screen');
    assert.match(src, /mountError = \(err && err\.message\) \|\| String\(err\)/,
      'but the ack must not call a failureNode a mount');
    assert.match(src, /if \(!document\.contains\(card\)\) return \{ mounted: false/,
      'containment is the one check a try/catch around the mount cannot make');
  });

  it('every client branch answers, including the popup-blocked one', () => {
    const s = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8',
    ).replace(/\r\n/g, '\n');
    const start = s.indexOf("subscribe(['open-web']");
    assert.notEqual(start, -1);
    const handler = s.slice(start, s.indexOf('\n});', start));
    // Five branches: no widgetType, newtab/news, youtube/web, dynamic, default.
    const acks = handler.match(/ackRender\(/g) || [];
    assert.ok(acks.length >= 5, `every branch must answer — found ${acks.length} ackRender calls`);
    assert.match(handler, /the browser blocked the new tab/,
      'window.open returns null on a blocked popup, and that used to be reported as success');
  });
});
