'use strict';

// test/engagement-detail-tabs.test.js — the engagement detail tabs do something.
//
// views/engagements.js rendered a role="tablist" of Spec / Plan / Execution /
// Verifications / Report buttons, and every pane renderer behind them
// (renderSpecTabContent, renderPlanTabContent, renderExecutionTabContent,
// renderVerificationsTabContent, renderReportTabContent) existed and was
// complete. renderTabContent() was never called and no listener was ever
// registered for .engag-detail-tab, so the buttons highlighted on hover and did
// nothing — a dead end for mouse and keyboard alike, and a pile of dead
// renderers behind it.
//
// resolveActiveTab is exported and tested directly for the same reason
// web-panel.js exports shouldAutoOpenOnStall (see bug-114's test): it is the one
// piece with real branching, and the HUD deliberately has no DOM harness. The
// wiring itself is asserted on the source, and stated as such.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VIEW = path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'engagements.js');

describe('resolveActiveTab', () => {
  let resolveActiveTab;
  before(async () => {
    ({ resolveActiveTab } = await import(pathToFileURL(VIEW).href));
  });

  it('keeps a tab that exists for this engagement', () => {
    for (const key of ['spec', 'plan', 'execution', 'verifications']) {
      assert.equal(resolveActiveTab({ status: 'EXECUTING' }, key), key);
    }
  });

  it('offers Report only once the engagement is COMPLETED', () => {
    assert.equal(resolveActiveTab({ status: 'COMPLETED' }, 'report'), 'report');
    assert.equal(resolveActiveTab({ status: 'EXECUTING' }, 'report'), 'spec',
      'Report does not exist mid-run, so asking for it must fall back to the first tab '
      + 'rather than render a panel with no tab selected');
  });

  it('falls back for an unknown or missing tab key', () => {
    assert.equal(resolveActiveTab({ status: 'EXECUTING' }, 'nope'), 'spec');
    assert.equal(resolveActiveTab({ status: 'EXECUTING' }, undefined), 'spec');
    assert.equal(resolveActiveTab({ status: 'EXECUTING' }, null), 'spec');
  });

  it('a COMPLETED engagement that had Report selected keeps it — no gratuitous reset', () => {
    // The fallback must trigger on absence, not on every render, or switching
    // to Report would bounce straight back to Spec on the next poll tick.
    assert.equal(resolveActiveTab({ status: 'COMPLETED' }, 'report'), 'report');
  });
});

describe('the tabs are wired (source-shape; the HUD has no DOM harness)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');

  it('the detail panel renders panes, not just the tab strip', () => {
    assert.match(src, /renderDetailHeader\(selected\)\s*\+\s*renderTabs\(selected, activeTab\)\s*\+\s*renderTabContent\(selected, activeTab\)/,
      'renderTabContent must actually be called — it was dead code alongside five dead pane renderers');
  });

  it('a click on a tab changes the active tab', () => {
    assert.match(src, /closest\('\.engag-detail-tab'\)/,
      'a delegated click handler must exist for the tab buttons');
    assert.match(src, /state\.activeTab = tab\.dataset\.tab;/);
  });

  it('the tablist honours the arrow keys it advertises with role="tablist"', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      assert.ok(src.includes(`'${key}'`), 'keyboard navigation must handle ' + key);
    }
    assert.match(src, /tabindex="\$\{selected \? '0' : '-1'\}"/,
      'roving tabindex: exactly one tab is in the tab order');
    assert.match(src, /focused\.focus\(\)/,
      'the newly selected tab must take focus, or the keyboard user is dropped after each re-render');
  });

  it('selection state is exposed to assistive tech, not just to CSS', () => {
    assert.match(src, /aria-selected="\$\{selected \? 'true' : 'false'\}"/,
      'every tab needs aria-selected, not only the first one');
    assert.match(src, /aria-controls="engag-panel-\$\{escapeAttr\(tab\.key\)\}"/);
    assert.match(src, /aria-labelledby="engag-tab-\$\{escapeAttr\(tab\.key\)\}"/);
    assert.match(src, /\$\{selected \? '' : ' hidden'\}/,
      'an inactive panel must be hidden from the accessibility tree, not only display:none');
  });

  it('picking a different engagement resets to its first tab', () => {
    assert.match(src, /state\.selectedId = item\.dataset\.id;[\s\S]{0,400}state\.activeTab = 'spec';/,
      'carrying the tab over would land on Report for an engagement that has none');
  });

  it('the tab list has one definition, not two that can drift', () => {
    const arrays = src.match(/\{ key: 'spec', label: 'Spec' \}/g) || [];
    assert.equal(arrays.length, 1,
      'renderTabs used to carry its own copy of the tab array alongside getTabs');
  });
});

describe('the unreachable engagement component tree is gone', () => {
  it('no orphaned view or component files remain', () => {
    const ui = path.join(__dirname, '..', 'ui', 'public', 'js');
    for (const rel of ['views/engagement-list.js', 'views/engagement-detail.js', 'components/engagement']) {
      const abs = path.join(ui, rel.split('/').join(path.sep));
      assert.equal(fs.existsSync(abs), false,
        rel + ' had zero importers — panel-registry.js only ever loaded views/engagements.js');
    }
  });

  it('the live view imports the shared safeHref instead of duplicating it', () => {
    const src = fs.readFileSync(VIEW, 'utf8');
    assert.match(src, /import \{ safeHref \} from '\.\.\/url\.js'/,
      'the tested copy and the rendering copy must be the same function');
    assert.doesNotMatch(src, /function safeHref\(/,
      'the local duplicate must be gone, not shadowing the import');
  });
});
