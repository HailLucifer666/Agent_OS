'use strict';

// test/bug-114-youtube-embed-stall-fallback.test.js — BUG-114.
//
// Incident: open_web(type:'youtube') produced YouTube player error 153
// ("video unavailable"/restricted) twice for the same track (incidents 6 and
// 11), even though from-dashboard.js's oEmbed pre-check (BUG-006) already ran
// and picked an oEmbed-embeddable candidate, and web-panel.js already has an
// onError postMessage listener wired to auto-open the real youtube.com tab.
//
// Diagnosis: oEmbed's 200 only proves the video is embeddable IN GENERAL — it
// says nothing about YouTube's per-request referrer/domain check, which is
// enforced when the /embed/<id> document itself is served, i.e. BEFORE the
// interactive IFrame Player API script initializes. Real-world reports of
// error 153 (https://til.simonwillison.net/youtube/fixing-153-embed,
// https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/) describe it
// as a static "video player configuration error" screen with no mention of a
// postMessage notification back to the parent — consistent with the failure
// happening at request/serve time, not inside the running player. Since the
// player's own JS API bridge never loads, it never posts onReady OR onError —
// web-panel.js's onError handler (ytHandler, web-panel.js:132-150) is correctly
// wired (origin check matches the youtube-nocookie.com embed URL
// from-dashboard.js constructs) but simply never receives anything to react
// to for this failure class.
//
// The ONLY thing that still fires for a silently-stalled embed is the 8s
// failTimer (web-panel.js originally line 106): `showFallback(false)` — the
// WEAK recovery (manual "Open in new tab" link), not the guaranteed auto-open
// used everywhere else this same fallback fires (the explicit onError path,
// and from-dashboard.js's own "no oEmbed-embeddable candidate" fallback).
// That is the actual gap: a YouTube embed that never reaches onReady within
// 8s is, in practice, never "still loading" — waiting longer doesn't help —
// so a timeout is exactly as conclusive as an explicit onError and deserves
// the same guaranteed remedy.
//
// This codebase has no DOM-test harness convention for view files (see
// dynamic-widget-spec-validation.test.js's header) — no jsdom dependency
// exists and none is added here. Following the two established alternatives
// instead: (1) the fix is expressed as a pure, DOM-free function
// (`shouldAutoOpenOnStall`, exported from web-panel.js like SpecPreviewCard.js
// exports safeHref) that is unit-tested directly, and (2) a source-shape
// assertion (same convention as test/electron-cursor-overlay.test.js, per
// mythos/CLAUDE.md's Electron section) proves the failTimer callback actually
// calls that function instead of a hardcoded `false` — so the fix can't quietly
// regress to "helper exists but isn't wired in."

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_PANEL_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'web-panel.js');
const MODULE_URL = pathToFileURL(WEB_PANEL_PATH).href;

async function loadShouldAutoOpenOnStall() {
  const mod = await import(MODULE_URL);
  return mod.shouldAutoOpenOnStall;
}

describe('BUG-114: a stalled YouTube embed (never reaches onReady/onError — the ' +
  'error-153/referrer-restriction failure shape) must auto-open the real ' +
  'youtube.com tab on timeout, the same guaranteed remedy explicit onError uses', () => {

  it('exports shouldAutoOpenOnStall as a pure function', async () => {
    const shouldAutoOpenOnStall = await loadShouldAutoOpenOnStall();
    assert.equal(typeof shouldAutoOpenOnStall, 'function',
      'web-panel.js must export a pure shouldAutoOpenOnStall(widgetType) helper');
  });

  it('returns true for widgetType "youtube" — a stall is conclusive, not a maybe', async () => {
    const shouldAutoOpenOnStall = await loadShouldAutoOpenOnStall();
    assert.equal(shouldAutoOpenOnStall('youtube'), true);
  });

  it('returns false for widgetType "web" — unrelated to BUG-114, keep existing manual-link behavior', async () => {
    const shouldAutoOpenOnStall = await loadShouldAutoOpenOnStall();
    assert.equal(shouldAutoOpenOnStall('web'), false);
  });

  it('returns false for an unrecognized widgetType (defensive default)', async () => {
    const shouldAutoOpenOnStall = await loadShouldAutoOpenOnStall();
    assert.equal(shouldAutoOpenOnStall('search'), false);
    assert.equal(shouldAutoOpenOnStall(undefined), false);
  });

  it('source-shape: the 8s failTimer must call showFallback(shouldAutoOpenOnStall(payload.widgetType)), not a hardcoded showFallback(false)', () => {
    const src = fs.readFileSync(WEB_PANEL_PATH, 'utf8');
    const failTimerMatch = src.match(/const failTimer = setTimeout\(\(\) => \{[^}]*\}, 8000\);/);
    assert.ok(failTimerMatch, 'expected to find the failTimer setTimeout(..., 8000) statement in web-panel.js');
    const failTimerLine = failTimerMatch[0];
    assert.match(failTimerLine, /showFallback\(shouldAutoOpenOnStall\(payload\.widgetType\)\)/,
      'failTimer must route its openTab decision through shouldAutoOpenOnStall(payload.widgetType), ' +
      'not a hardcoded showFallback(false) — otherwise a stalled youtube embed (error 153\'s failure ' +
      'shape) never gets the guaranteed auto-open remedy');
  });
});
