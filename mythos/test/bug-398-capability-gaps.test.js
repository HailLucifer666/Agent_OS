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

describe('BUG-398 E3 — open_web says which browser it can and cannot use', () => {
  function openWebTool() {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/core/effectors/from-dashboard.js'), 'utf8');
    const desc = src.match(/name: 'open_web', description: '((?:[^'\\]|\\.)*)'/);
    assert.ok(desc, 'open_web description must be findable');
    const param = src.match(/browser: 'boolean \(optional\)((?:[^'\\]|\\.)*)'/);
    assert.ok(param, 'the browser param description must be findable');
    return { description: desc[1], browserParam: param[1] };
  }

  it('(b) the browser param states that it uses the OS default and cannot choose', () => {
    const { browserParam } = openWebTool();
    assert.match(browserParam, /DEFAULT/,
      'the operator asked for Chrome three times and got Brave three times, and '
      + 'nothing in the tool said why');
    assert.match(browserParam, /CANNOT choose/i);
  });

  it('(b) and points at the tools that CAN target a named browser', () => {
    const { browserParam } = openWebTool();
    assert.match(browserParam, /browser_switch/,
      'a limit with no route out of it is where the model improvises');
    assert.match(browserParam, /browser_navigate/);
  });

  it('the prose says it too, where a reader looks first', () => {
    const { description } = openWebTool();
    assert.match(description, /OS DEFAULT browser and cannot be pointed at a named one/);
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
