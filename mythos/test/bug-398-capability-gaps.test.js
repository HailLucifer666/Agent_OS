'use strict';

// test/bug-398-capability-gaps.test.js — BUG-398 E3 and E5.
//
// E5 IS NOT A DEFECT, AND THAT IS THE FINDING. The dossier records it as "the
// HUD's media.js widget is unreachable because no tool requests a named widget
// kind", with MYTHOS saying "there isn't a specific music widget I can open"
// and the dossier calling that "wrong in substance; the truth is 'I have no
// tool that opens named widgets'".
//
// Both halves are wrong. `manage_widget` is tier 1, IS on the voice allowlist,
// and its synonym table maps "music", "music player", "now playing", "player"
// and "spotify" straight to the media widget. So the capability existed, was
// reachable by voice, and answered to the exact words the operator used. What
// happened was a FALSE CAPABILITY DENIAL — the same class as row 5's invented
// mechanisms, one step earlier: a confident statement about itself that was not
// true, made without calling anything.
//
// There is nothing to build, so this file pins what exists instead. A denial
// cannot be fixed in code; what can be fixed is a future refactor quietly
// breaking the route and making the denial retroactively correct.
//
// E3 — open_web's `browser: true` goes to whatever Windows has set as the
// default and cannot be pointed at a named browser. The operator asked for
// Chrome three times and got Brave three times, and nothing in the tool said
// why. Accepting a browser name here would mean duplicating the attach/switch
// machinery that browser_switch already owns, so the honest fix is the one the
// dossier's own second option names: state the limit, and point at the pair of
// tools that CAN target a browser.
//
// MUTATION PROOF — two probes, 2026-09-02, each verified applied:
//   (a) remove 'music player' from WIDGET_SYNONYMS → the E5 reachability test
//       fails on the operator's own phrasing while 'media' still resolves,
//       which is the point: the synonym is what made it reachable BY VOICE.
//       THE FIRST ATTEMPT AT THIS PROBE SILENTLY DID NOTHING — the pattern
//       carried a trailing ", " and that entry sits at the end of its line, so
//       nothing matched and the suite reported 9/9. Caught by re-counting the
//       string rather than by trusting the command, which is the only reason it
//       was not written down as a passing guard.
//   (b) strip the "OS DEFAULT" sentence from open_web's browser param → the E3
//       test fails; the tool goes back to silently sending Chrome to Brave.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('BUG-398 E5 — the media widget was always reachable by voice', () => {
  function widgetTools() {
    const emitted = [];
    const { buildTools } = require('../src/core/effectors/from-widgets');
    const built = buildTools({ bus: { emit: (t, p) => emitted.push({ t, p }) }, logger: { warn() {}, info() {} } });
    const byName = {};
    for (const tool of built.TOOLS) byName[tool.name] = tool;
    return { byName, emitted };
  }

  it('(a) opens on the operator\'s own words, not just the internal id', () => {
    // Verbatim from the session: the operator asked for the "music widget".
    for (const spoken of ['music', 'music player', 'now playing', 'player', 'spotify', 'media']) {
      const { byName, emitted } = widgetTools();
      const res = byName.manage_widget.fn({ action: 'open', name: spoken });
      assert.equal(res.ok, true, 'must resolve "' + spoken + '": ' + JSON.stringify(res.result));
      assert.deepEqual(res.result, { mode: 'open', targets: ['media'] },
        '"' + spoken + '" must resolve to the media widget');
      assert.equal(emitted.length, 1, 'and it must actually reach the HUD over the bus');
      assert.equal(emitted[0].t, 'ui.widget-command');
    }
  });

  it('spoken verb synonyms reach it too — "show", "bring back", "restore"', () => {
    for (const verb of ['open', 'show', 'restore', 'bring back']) {
      const { byName } = widgetTools();
      const res = byName.manage_widget.fn({ action: verb, name: 'music' });
      assert.equal(res.ok, true, verb + ' must be accepted: ' + JSON.stringify(res.result));
      assert.equal(res.result.mode, 'open');
    }
  });

  it('the tool is on the voice allowlist, or none of the above is reachable by speech', () => {
    // The half that makes this a capability rather than an API. Asserted
    // against the allowlist itself, not assumed.
    const live = fs.readFileSync(
      path.resolve(__dirname, '../src/core/voice/live-tools.js'), 'utf8');
    assert.match(live, /'manage_widget'/,
      'manage_widget must be voice-callable — the denial would otherwise be true');
  });

  it('and its description names the media widget, so the model can find it', () => {
    const { byName } = widgetTools();
    assert.match(byName.manage_widget.description, /\bmedia\b/,
      'a capability the description never mentions is one the model will deny having');
  });

  it('BOUNDS: an unknown widget name is still refused, and lists the real ones', () => {
    const { byName, emitted } = widgetTools();
    const res = byName.manage_widget.fn({ action: 'open', name: 'flux capacitor' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /Unknown widget/);
    assert.match(String(res.result), /media/, 'the refusal must enumerate what IS available');
    assert.equal(emitted.length, 0, 'and must not touch the HUD');
  });
});

// UPDATED 2026-09-03 (BUG-407). This block used to assert that the description
// SAYS open_web "CANNOT choose" a browser and "cannot be pointed at a named
// one". Those were the honest words for a real limitation, and pinning them was
// right — E3 is the operator asking for Chrome three times and getting Brave
// three times with nothing in the tool explaining why.
//
// The limitation is gone: open_web now takes browserName and opens the named
// browser's real, logged-in profile. So the assertion could not be kept as it
// stood — a guard that requires a tool to describe a limit it no longer has
// forces the description to lie, which is the opposite of what E3 wanted.
//
// What is pinned instead is the SAME property, against the new contract: the
// description must still say that the bare browser:true goes to the OS default
// (so the model does not assume it can pick), and it must still name the route
// out. That route is now browserName rather than browser_switch. The false
// statements are also pinned as ABSENT, so nobody restores them from an old
// diff.
describe('BUG-398 E3 — open_web says which browser it uses, and how to name one', () => {
  function openWebTool() {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/core/effectors/from-dashboard.js'), 'utf8');
    const desc = src.match(/name: 'open_web', description: '((?:[^'\\]|\\.)*)'/);
    assert.ok(desc, 'open_web description must be findable');
    const param = src.match(/browser: 'boolean \(optional\)((?:[^'\\]|\\.)*)'/);
    assert.ok(param, 'the browser param description must be findable');
    const named = src.match(/browserName: 'string \(optional\)((?:[^'\\]|\\.)*)'/);
    assert.ok(named, 'the browserName param description must be findable');
    return { description: desc[1], browserParam: param[1], browserNameParam: named[1] };
  }

  it('(b) the browser param still states that ON ITS OWN it uses the OS default', () => {
    const { browserParam } = openWebTool();
    assert.match(browserParam, /DEFAULT/,
      'the operator asked for Chrome three times and got Brave three times, and '
      + 'nothing in the tool said why');
  });

  // DISPOSITION CHANGED 2026-09-11, and E3's principle is the reason it had to.
  //
  // E3 pinned that open_web must tell the model what to do when the operator
  // names a browser, because "a limit with no route out of it is where the model
  // improvises". It pinned that by requiring the description to point at
  // open_web's OWN browserName parameter — correct at the time.
  //
  // BUG-435 then moved the route: the operator decided (2026-09-10) that a named
  // browser means the browser MYTHOS drives, so the spoken path REFUSES
  // browserName. The 2026-09-10 guard shipped with these sentences left in place,
  // and the result on 2026-09-10 18:21Z was E3's own failure mode, exactly:
  // the description advertised a route the guard refused, the model took it four
  // times, and nothing opened. A limit with no route out of it.
  //
  // So the assertions below still pin E3's guarantee — the trigger condition is
  // stated, and there is a way out — they just no longer pin the destination
  // open_web itself can serve. What must NOT be lost is the pairing: naming the
  // limit without naming the exit is the defect both tickets are about.
  it('(b) states the trigger condition AND a route out of it — E3\'s rule, new destination', () => {
    const { browserParam, browserNameParam, description } = openWebTool();
    assert.match(browserParam + browserNameParam + description, /browserName/,
      'a limit with no route out of it is where the model improvises');
    assert.match(browserNameParam, /chrome, brave or edge/,
      'and the route must say what it accepts');
    assert.match(browserNameParam, /a named browser|they named a browser/,
      'the model needs the trigger condition, not just the capability');
    assert.match(browserNameParam, /REFUSED|BUG-435/,
      'and since 2026-09-11 the trigger says this route is the wrong one, or the model tries it');
  });

  it('the prose says it too, where a reader looks first', () => {
    const { description } = openWebTool();
    assert.match(description, /By default that is the OS DEFAULT browser/);
    assert.match(description, /NAMES? a browser/,
      'the case still has to be addressed in the prose, whatever the answer is');
    assert.match(description, /refuses it|WRONG/,
      'and the prose must say the answer is elsewhere — this is the sentence whose absence '
      + 'cost the 2026-09-10 18:21Z run, when it still said "pass browserName" while the guard refused it');
  });

  it('the superseded claims are GONE, not merely outranked by a newer sentence', () => {
    const { description, browserParam } = openWebTool();
    const both = description + ' ' + browserParam;
    assert.doesNotMatch(both, /cannot be pointed at a named one/,
      'BUG-407 made this false; a tool description that lies is worse than one that is silent');
    assert.doesNotMatch(both, /CANNOT choose one: there is no browser name to pass here/,
      'there is a browser name to pass now');
  });

  it('BOUNDS: the tool still does what it did — this is a description change only', () => {
    const { description } = openWebTool();
    // The pre-existing guidance has to survive: these sentences are what stop
    // open_web being reached for as a browser, which is its own logged defect.
    assert.match(description, /does NOT open a browser window/);
    assert.match(description, /use browser_navigate for "search the web"/);
    assert.match(description, /pass browser:true WITH url:/,
      'the newtab route is still the answer for a plain "open this site"');
  });
});
