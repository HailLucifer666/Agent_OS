'use strict';

// browser-effect.js — BUG-462: did a browser action have the effect it was FOR?
//
// 2026-09-24, attended run. The old withStateCapsule read url, title and focus
// AFTER an action and called any answer proof (oracle page-state). A page always
// has a url, so every ref click, type, key press and hover came back verified
// whatever happened — a check that could not fail (class 14), asking "did the
// page report something" instead of "did the thing happen" (gate E). The vault
// shows it directly: the PageDowns at 15:10:51 and 15:11:01 left url, title and
// video exactly as they were and were recorded verified.
//
// CORRECTED the same day, after reading the vault record: the ticket's headline
// case, browser_click f2e308 at 15:11:24, DID navigate — its own after-state was
// /watch?v=Gvx-DAzR-4k (title not yet updated). The page was back on the results
// page by 15:11:46 and nothing ever played; what sent it back is not established.
// So under this module that click is verified by the move, correctly. What was
// false at 15:11:33 was "It should be starting up now": a playback claim with no
// player playing, which is the claim checker's to judge (BUG-448 / BUG-460).
//
// The rule now: capture the state BEFORE the action, capture it again after, and
// judge the difference against what this kind of action is for. Four outcomes,
// kept distinct (evidence.js): verified (the intended change was observed),
// dispatched (unverified with a confirmedStep — the action was delivered, its
// effect is not observable or not claimed), unverified, and failed (mismatch —
// the readback contradicts the request).
//
// What does NOT count, on purpose: a title change alone (YouTube rewrites its
// title for notification counts), focus moving on a click, the clicked element
// disappearing (a re-render does that too), or any DOM churn. Those are reported
// as incidental so the model can read them, never promoted to proof.
//
// Split on purpose: judgeEffect() is pure — no page, no Playwright — so the whole
// action x before/after matrix is testable. capture() is the only part that
// touches a page, and every probe in it is guarded: a capsule that throws must
// not turn a delivered action into a reported failure.
//
// A field's CONTENTS never leave this module. A readback compares the typed text
// against the field and reports lengths and yes/no only: the field may be a
// password, and these results reach the model, the audit log and the vault.

const evidence = require('./evidence');

// How long a click or key press is given to START navigating before the "after"
// state is read. Unmeasured compromise, chosen 2026-09-24: YouTube's SPA pushes
// its /watch url on click, well inside this; a full navigation commits later but
// page.url() already reflects a committed one. A click that navigates nowhere
// pays the whole wait, so it is kept short.
const CLICK_SETTLE_MS = 800;
const SCROLL_EPSILON_PX = 2;
const SEEK_MIN_SECONDS = 5;
// A video counts as THE player only if it is the largest visible one and covers
// at least this share of the viewport. ATTACKED 2026-09-24: YouTube's results
// page carries a small inline <video> for hover previews — every capture of the
// 09-24 results page in the vault holds a paused one with no duration — and the
// first version of this judge counted any video changing state. Unmeasured on real pages;
// a thumbnail preview is a few percent of a 1080p viewport, a watch-page player
// tens of percent. It errs toward unverified: a small embedded player that really
// started reads as unknown, never a preview as success.
const MAIN_PLAYER_MIN_SHARE = 0.15;

// Runs inside the page (page.evaluate serialises it), so it may use only DOM.
function pageStateInPage() {
  const active = document.activeElement;
  // The LARGEST visible video, not the first one: a results page can hold a
  // hover-preview player ahead of anything the operator asked for.
  let video = null; let bestArea = -1;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area > bestArea) { bestArea = area; video = v; }
  }
  const viewport = Math.max(1, window.innerWidth * window.innerHeight);
  const doc = document.scrollingElement || document.documentElement;
  let inner = null;
  try {
    let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    while (el && el !== doc && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        inner = { key: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
        break;
      }
      el = el.parentElement;
    }
  } catch (_) { /* no layout yet */ }
  return {
    focused: active ? {
      tag: active.tagName ? active.tagName.toLowerCase() : null,
      role: active.getAttribute ? active.getAttribute('role') : null,
      name: (active.getAttribute && (active.getAttribute('aria-label') || active.getAttribute('name'))) ||
        (active.textContent || '').trim().slice(0, 60) || null,
    } : null,
    video: video ? { playing: !video.paused, currentTime: video.currentTime, duration: video.duration,
      muted: video.muted, src: video.currentSrc || video.src || null,
      share: Math.round((Math.max(0, bestArea) / viewport) * 1000) / 1000 } : null,
    fullscreen: !!document.fullscreenElement,
    scroll: doc ? { top: doc.scrollTop, height: doc.scrollHeight, client: doc.clientHeight } : null,
    inner: inner,
    docId: (window.performance && window.performance.timeOrigin) || null,
  };
}

function fieldStateInPage(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const hasValue = 'value' in el;
  return {
    tag: tag,
    value: hasValue ? String(el.value) : (el.isContentEditable ? String(el.textContent || '') : null),
    files: el.files ? Array.from(el.files).map((f) => f.name) : null,
  };
}

async function capture(page, spec) {
  const s = spec || {};
  const capsule = {};
  // B3c: a build's preview address carries a capability; report the file's
  // /vault/builds address instead (server/preview-isolation.js withoutCapability).
  try { capsule.url = require('../server/preview-isolation').withoutCapability(page.url()); } catch (_) {}
  try { capsule.title = await page.title(); } catch (_) {}
  if (s.ref && s.locator) {
    // Did the target survive? Informative either way, proof neither way.
    try { capsule.refStillPresent = (await s.locator.count()) > 0; } catch (_) {}
  }
  if (typeof page.evaluate === 'function') {
    try {
      const dom = await page.evaluate(pageStateInPage);
      if (dom) {
        for (const k of ['focused', 'video', 'scroll', 'inner', 'docId']) if (dom[k] !== undefined && dom[k] !== null) capsule[k] = dom[k];
        if (dom.fullscreen !== undefined) capsule.fullscreen = dom.fullscreen;
      }
    } catch (_) { /* a page that refuses evaluate still gives url/title */ }
  }
  if (s.field && s.locator && typeof s.locator.evaluate === 'function') {
    try { capsule.field = await s.locator.evaluate(fieldStateInPage); } catch (_) {}
  }
  return capsule;
}

function describeState(c) {
  const bits = [];
  if (c.url) bits.push('url ' + c.url);
  if (c.title) bits.push('title "' + c.title + '"');
  if (c.video) bits.push('video ' + (c.video.playing ? 'PLAYING' : 'paused'));
  return bits.join('; ');
}

function scrollDelta(before, after) {
  if (before.inner && after.inner && before.inner.key === after.inner.key) {
    const d = after.inner.top - before.inner.top;
    if (Math.abs(d) > SCROLL_EPSILON_PX) return d;
  }
  if (before.scroll && after.scroll) return after.scroll.top - before.scroll.top;
  return null;
}

function atBoundary(after, direction) {
  const m = after.inner || after.scroll;
  if (!m) return false;
  return direction === 'up' ? m.top <= SCROLL_EPSILON_PX : m.top + m.client >= m.height - SCROLL_EPSILON_PX;
}

// The facts a before/after pair can establish, kind-independent.
function changesBetween(before, after, extra) {
  const b = before || {}; const a = after || {};
  const popups = (extra && extra.popups) || [];
  const bv = b.video || null; const av = a.video || null;
  // share is absent only on hand-built states; a real capture always carries it.
  const isMain = (v) => !!v && (typeof v.share !== 'number' || v.share >= MAIN_PLAYER_MIN_SHARE);
  return {
    urlChanged: !!(b.url && a.url && b.url !== a.url),
    popup: popups.length > 0,
    docReplaced: !!(b.docId && a.docId && b.docId !== a.docId),
    videoAppeared: !bv && !!av,
    videoSwapped: !!(bv && av && bv.src && av.src && bv.src !== av.src),
    playingFlipped: !!(bv && av && bv.playing !== av.playing),
    mainPlayingFlipped: !!(bv && av && bv.playing !== av.playing && isMain(av)),
    titleChanged: !!(b.title && a.title && b.title !== a.title),
    focusChanged: JSON.stringify(b.focused || null) !== JSON.stringify(a.focused || null),
    refGone: b.refStillPresent === true && a.refStillPresent === false,
    scrollDelta: scrollDelta(b, a),
  };
}

function incidentalOf(ch) {
  const out = [];
  if (ch.titleChanged) out.push('the title changed');
  if (ch.focusChanged) out.push('focus moved');
  if (ch.refGone) out.push('the element is no longer on the page');
  if ((ch.videoAppeared || ch.videoSwapped) && !ch.urlChanged) out.push('a video appeared on the page (it may be a hover preview)');
  if (ch.playingFlipped && !ch.mainPlayingFlipped) out.push('a small preview video changed state');
  return out;
}

function navigationProof(ch, after, extra) {
  const bits = [];
  if (ch.urlChanged) bits.push('the page moved to ' + after.url);
  if (ch.popup) bits.push('it opened a new tab (' + extra.popups.join(', ') + ')');
  if (ch.docReplaced && !ch.urlChanged) bits.push('the page loaded a new document');
  // A video appearing is never proof on its own (a hover preview does that); the
  // main player changing state is.
  if (ch.mainPlayingFlipped) bits.push('the video is now ' + (after.video.playing ? 'PLAYING' : 'paused'));
  return bits;
}

const SCROLL_KEYS = { PageDown: 'down', Space: 'down', ArrowDown: 'down', End: 'down', PageUp: 'up', ArrowUp: 'up', Home: 'up' };
const NOT_A_SCROLL_TARGET = ['input', 'textarea', 'select'];
// The next step is named in the prose AND carried as a structured remedy
// (refusals rule 1, src/core/CLAUDE.md): reading the page is always safe, and it
// is never "do it again" — an action whose effect is unknown is not repeated.
const SNAPSHOT_NEXT = 'browser_snapshot shows what the page looks like now.';
const SNAPSHOT_WHY = 'see what the page shows now before claiming the action worked or repeating it';

function verified(observed) { return { verdict: 'verified', observed: observed }; }
function notShown(reason, step) {
  return { verdict: 'unverified', reason: reason, confirmedStep: step, snapshotNext: reason.indexOf(SNAPSHOT_NEXT) !== -1 };
}

function judgeScroll(ch, after, direction, step) {
  if (ch.scrollDelta === null) return notShown('I could not read the scroll position, so I cannot confirm the page moved. ' + SNAPSHOT_NEXT, step);
  const moved = Math.abs(ch.scrollDelta) > SCROLL_EPSILON_PX;
  const right = direction === 'up' ? ch.scrollDelta < 0 : ch.scrollDelta > 0;
  if (moved && right) return verified('the page scrolled ' + direction + ' ' + Math.round(Math.abs(ch.scrollDelta)) + 'px');
  if (!moved && atBoundary(after, direction)) {
    return notShown('the page is already at the ' + (direction === 'up' ? 'top' : 'bottom') + ', so there was nothing further to scroll', step);
  }
  return notShown('the page did not move ' + direction + ' — the part that scrolls may be a panel the key did not reach. ' + SNAPSHOT_NEXT, step);
}

function judgePlayer(key, ch, before, after, step) {
  const bv = before.video; const av = after.video;
  if (!av) return notShown('there is no video on this page, so a player key had nothing to control', step);
  if (key === 'k') {
    return ch.playingFlipped ? verified('the video is now ' + (av.playing ? 'PLAYING' : 'paused'))
      : notShown('the video stayed ' + (av.playing ? 'playing' : 'paused') + ', so the key did not toggle it', step);
  }
  if ((key === 'j' || key === 'l') && bv && typeof bv.currentTime === 'number' && typeof av.currentTime === 'number') {
    const d = av.currentTime - bv.currentTime;
    if (key === 'l' ? d >= SEEK_MIN_SECONDS : d <= -SEEK_MIN_SECONDS) return verified('the video moved ' + Math.round(d) + 's');
    return notShown('the video position did not jump', step);
  }
  if (key === 'm' && bv && typeof bv.muted === 'boolean' && typeof av.muted === 'boolean') {
    return bv.muted !== av.muted ? verified('the video is now ' + (av.muted ? 'muted' : 'unmuted')) : notShown('the mute state did not change', step);
  }
  if (key === 'f' && typeof before.fullscreen === 'boolean' && typeof after.fullscreen === 'boolean') {
    return before.fullscreen !== after.fullscreen ? verified('fullscreen is now ' + (after.fullscreen ? 'on' : 'off')) : notShown('fullscreen did not change', step);
  }
  return notShown('the key reached the player, but nothing I can read shows whether it took effect', step);
}

function judgeField(intent, before, after, step) {
  const f = after.field;
  if (!f || f.value === null || f.value === undefined) {
    return notShown('the text was sent, but I could not read the field back to confirm it', step);
  }
  const text = String(intent.text === undefined ? '' : intent.text);
  const holds = intent.clearFirst ? f.value === text : f.value.indexOf(text) !== -1;
  if (holds) return verified('the field now contains the typed text (' + text.length + ' chars)');
  const b = before.field;
  if (b && b.value === f.value) {
    return { verdict: 'failed', expected: 'the field to contain the ' + text.length + '-char text',
      observed: 'the field did not change (' + f.value.length + ' chars)',
      error: 'I typed into the field but it did not change, so the text did not go in.' };
  }
  return notShown('the field changed but does not read back as the ' + text.length + '-char text I typed — the page may have reformatted it', step);
}

// judgeEffect(intent, before, after, extra) -> {verdict, observed|reason, confirmedStep?, incidental}
function judgeEffect(intent, before, after, extra) {
  const it = intent || {}; const b = before || {}; const a = after || {}; const x = extra || {};
  const ch = changesBetween(b, a, x);
  const incidental = incidentalOf(ch);
  const withIncidental = (res) => Object.assign(res, { incidental: incidental });
  const nav = navigationProof(ch, a, x);
  switch (it.kind) {
    case 'click': {
      if (nav.length) return withIncidental(verified(nav.join('; ')));
      const also = incidental.length ? ' (' + incidental.join(' and ') + ', which does not show it worked)' : '';
      return withIncidental(notShown('the click reached the element, but the page did not navigate, open a tab or change its video' + also +
        ', so I cannot confirm it did what it was for. ' + SNAPSHOT_NEXT,
        'the click was delivered to the element'));
    }
    case 'scroll':
      return withIncidental(judgeScroll(ch, a, it.direction === 'up' ? 'up' : 'down', 'the scroll was sent'));
    case 'key': {
      const key = String(it.key || '');
      const step = 'the ' + key + ' key was pressed';
      if (['k', 'j', 'l', 'm', 'f', 'c'].includes(key)) return withIncidental(judgePlayer(key, ch, b, a, step));
      // Navigation or a player change first: Space on a focused YouTube player
      // toggles playback rather than scrolling, and that is still the key working.
      if (nav.length) return withIncidental(verified(nav.join('; ')));
      const focusedTag = b.focused && b.focused.tag;
      if (SCROLL_KEYS[key] && !it.onElement && NOT_A_SCROLL_TARGET.indexOf(focusedTag) === -1) {
        return withIncidental(judgeScroll(ch, a, SCROLL_KEYS[key], step));
      }
      if (key === 'Tab' && ch.focusChanged) return withIncidental(verified('focus moved to the next control'));
      return withIncidental(notShown('the key was pressed, but nothing I can read changed. ' + SNAPSHOT_NEXT, step));
    }
    case 'back':
      if (nav.length) return withIncidental(verified(nav.join('; ')));
      return withIncidental(notShown('the page did not change, so there may be no earlier page in this tab', 'going back was requested'));
    case 'reload':
      if (ch.docReplaced) return withIncidental(verified('the page reloaded (a new document at ' + (a.url || 'the same url') + ')'));
      return withIncidental(notShown(b.docId && a.docId ? 'the page did not reload — it is still the same document'
        : 'I could not tell whether the page reloaded', 'the reload was requested'));
    case 'hover':
      // Plan, 2026-09-24: report the dispatch; verify only a hover effect that was
      // explicitly asked for. Nothing asks for one yet.
      return withIncidental(notShown('the pointer is over the element; a hover only sometimes reveals something. ' + SNAPSHOT_NEXT,
        'the pointer was moved over the element'));
    case 'type':
      return withIncidental(judgeField(it, b, a, 'the text was sent to the field'));
    case 'select': {
      const want = [].concat(it.expected || []).map(String);
      const got = a.field && a.field.value;
      if (got !== null && got !== undefined && want.indexOf(String(got)) !== -1) return withIncidental(verified('the list now shows the chosen option'));
      return withIncidental(notShown('the option was chosen, but the list does not read back as it', 'the option was sent to the list'));
    }
    case 'upload': {
      const files = (a.field && a.field.files) || [];
      if (files.indexOf(String(it.expected)) !== -1) return withIncidental(verified('the file input now holds ' + it.expected));
      return withIncidental(notShown('the file was handed to the input, but it does not read back as holding it', 'the file was handed to the input'));
    }
    default:
      throw new Error('judgeEffect: unknown intent kind ' + JSON.stringify(it.kind) + ' — name what the action is for');
  }
}

// The state handed back to the model. A field is reported by LENGTH and file
// COUNT only — its value never leaves this module (see the header).
function publicState(c) {
  if (!c.field) return c;
  const f = c.field;
  return Object.assign({}, c, { field: { tag: f.tag || null, length: typeof f.value === 'string' ? f.value.length : null,
    files: Array.isArray(f.files) ? f.files.length : null } });
}

// The effector's WHOLE result (see the shape note in from-browser.js): never wrap
// it in ok(), or `unverified` and `evidence` sink into .result where nothing reads.
function toResult(judgement, payload, after) {
  const result = Object.assign({}, payload, { url: after.url, state: publicState(after), effect: judgement.verdict });
  if (judgement.incidental && judgement.incidental.length) result.incidental = judgement.incidental;
  if (judgement.verdict === 'verified') {
    return evidence.verifiedOk({ result }, { oracle: 'page-state', observed: judgement.observed + (describeState(after) ? ' — ' + describeState(after) : '') });
  }
  if (judgement.verdict === 'failed') {
    return evidence.mismatch({ result }, { oracle: 'page-state', expected: judgement.expected, observed: judgement.observed, error: judgement.error });
  }
  const out = evidence.unverified({ result }, judgement.reason, { confirmedStep: judgement.confirmedStep });
  if (judgement.snapshotNext) out.remedy = evidence.remedy('browser_snapshot', {}, SNAPSHOT_WHY);
  return out;
}

async function settle(page, beforeUrl) {
  const waits = [];
  if (typeof page.waitForURL === 'function') {
    waits.push(page.waitForURL((u) => String(u) !== beforeUrl, { timeout: CLICK_SETTLE_MS, waitUntil: 'commit' }).catch(() => {}));
  }
  if (typeof page.waitForEvent === 'function') {
    waits.push(page.waitForEvent('popup', { timeout: CLICK_SETTLE_MS }).catch(() => {}));
  }
  if (waits.length) await Promise.race(waits);
}

// actWithEvidence(page, {intent, act, payload, ref?, locator?, field?, settle?})
// Captures before, runs `act`, lets a navigation start, captures after, judges.
// `intent` and `payload` may be functions, read AFTER the act, for facts only the
// act returns (selectOption's applied values).
async function actWithEvidence(page, spec) {
  const before = await capture(page, spec);
  const popups = [];
  const onPopup = (p) => { let u = '(new tab)'; try { u = require('../server/preview-isolation').withoutCapability(p.url()) || u; } catch (_) {} popups.push(u); };
  const canListen = typeof page.on === 'function' && typeof page.off === 'function';
  if (canListen) page.on('popup', onPopup);
  try {
    await spec.act();
    if (spec.settle) await settle(page, before.url);
  } finally {
    if (canListen) page.off('popup', onPopup);
  }
  const after = await capture(page, spec);
  const late = (v) => (typeof v === 'function' ? v() : v);
  return toResult(judgeEffect(late(spec.intent), before, after, { popups }), late(spec.payload), after);
}

// fill_form's per-field readback: true / false / null (could not read). Returns
// a boolean only — the value itself is never reported (see the header). Takes a
// THUNK so that even building the locator is inside the guard: a probe that
// cannot answer must not turn a field that was filled into a reported failure.
async function readsBack(locatorOf, value) {
  try { return (await locatorOf().inputValue()) === String(value); } catch (_) { return null; }
}

// The same guard for a selector's readback locator: null when the page cannot
// build one, which capture() then treats as "could not read the field back".
function fieldLocator(page, selector) {
  try { const l = page.locator(selector); return typeof l.first === 'function' ? l.first() : l; } catch (_) { return null; }
}

module.exports = { judgeEffect, actWithEvidence, readsBack, fieldLocator, capture, changesBetween, CLICK_SETTLE_MS, SCROLL_KEYS, _internal: { toResult } };
