'use strict';

// effectors/from-browser.js — CA of app/lib/voice/tools-browser.js (10 tools). Function
// bodies verbatim; only re-pointing is `./browser-agent` -> `adapters/browser-agent`
// (untouched, re-pathed).

const browserAgent = require('../../../adapters/browser-agent');
const { effectorFromTool } = require('./adapter');
const evidenceModule = require('./evidence');
const { vaultRelativePath, vaultUrl } = require('./vault-url');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

// Set by registerFromBrowser() from ctx.config — used by requireOnline()'s lazy
// auto-connect fallback to find BROWSER_CDP_URL when the env var isn't set.
let config = null;
// REMEDIATION P1-7: set by registerFromBrowser() from ctx.fs — the vault
// fs-store, used to existence-check a /vault/... path before browser_navigate
// forwards it anywhere (same fs.exists() abstraction open_artifact uses).
let vaultFs = null;

// BUG-011 fix 1: lazy auto-connect. Previously this was synchronous and only ever
// reported OFFLINE — nothing ever called browserAgent.ensureOnline(), so browser
// tools stayed stuck OFFLINE forever even after running setup-chrome-debug.ps1.
// Now: if not ONLINE, try ensureOnline() (CDP connect, per adapters/browser-agent's
// own connect-then-launchLocal fallback) before giving up.
async function requireOnline() {
  let status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') {
    // Lazy bring-up: try a CDP connect to an already-running debug Chrome, then
    // fall back to launching one. Passing userDataDir is what actually arms
    // ensureOnline's launch fallback (adapter's launchLocal) — previously only
    // cdpUrl was passed, so ensureOnline could only connect and browser tools
    // stayed OFFLINE whenever no debug Chrome was already running. Safe here:
    // this runs mid-session when a browser tool is actually invoked, so voice/
    // mic init already holds the audio device (that is why boot stays
    // connect-only). launchLocal records the PID for BUG-029 orphan cleanup.
    try {
      await browserAgent.ensureOnline({
        cdpUrl: process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL),
        userDataDir: path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'MYTHOS', 'chrome-debug-profile'),
      });
    } catch { /* fall through to OFFLINE report below */ }
    status = browserAgent.getStatus();
    // BUG-106 fix (b)/(c): source browser identity from the live connection's
    // OWN mode, not just a value this module remembers from a previous call.
    // ensureOnline() either CONNECTED to an endpoint already running
    // (mode:'cdp' — we did not start it, so its identity is unconfirmed and
    // stays null/unknown, same as the "cannot confirm" refusal below already
    // handles) or LAUNCHED one itself (mode:'launched', via launchLocal's
    // chrome-first/edge-fallback — the same default path browser_launch_debug
    // uses for an unnamed request, so it earns the same 'chrome' label). Only
    // touch attachedBrowser when THIS call actually changed connectivity (we
    // are inside the `state !== 'ONLINE'` branch) — an adapter that was
    // already ONLINE has its identity left exactly as it was.
    if (status.state === 'ONLINE') {
      attachedBrowser = status.mode === 'launched' ? 'chrome' : null;
    }
  }
  if (status.state !== 'ONLINE') {
    return fail(`Browser automation is ${status.state}. ${status.hint || 'Run setup-chrome-debug.ps1 first.'}`);
  }
  return null;
}

// ---- Tool implementations ----

// BROWSER_PAGE_WAIT_MS (schema.js, default 8000): how long waitReady() waits
// for a selector to become visible before click/type/get_text. Read from config
// (set in registerFromBrowser) or env. Less than the adapter's page default so
// a missing element fails here with a clean message, not the raw 15s Playwright
// timeout. See waitReady() for why this replaced the scattered swallowed-catch
// waitForSelector(5000/4000) calls.
function pageWaitMs() {
  const fromConfig = config && config.BROWSER_PAGE_WAIT_MS;
  const n = Number(fromConfig || process.env.BROWSER_PAGE_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

// waitReady(page, selector) — single bounded pre-wait, returns true/false.
// Replaces the THREE swallowed-catch waitForSelector({timeout:5000/4000}) sites
// (click/type/fill_form) AND adds the pre-wait get_text never had. Why it
// exists: a lazy-hydrating SPA (YouTube's ytd-* custom elements upgrade async
// AFTER domcontentloaded) means a click right after navigate hits a not-yet-
// existing node. The old code's empty catch(_) silently swallowed that, then
// page.click rode the full 15s page default → 20s before an honest fail. One
// helper, one behaviour, no retry storm (the comment at the old :96 explicitly
// warned against silent retries; this preserves that — a single bounded wait).
async function waitReady(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: pageWaitMs(), state: 'visible' });
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Snapshot-and-refs (2026-08-06). The browser-interaction bug run — BUG-107,
// 119, 120, 121, 122 and predecessors — kept circling ONE root cause: the model
// drives the browser through GUESSED CSS selectors, and every fix so far
// (timeouts, ladders, retries) treats a symptom of that guess. Three external
// tools were evaluated and none is adoptable here (agent-browser is an external
// Rust daemon vs the portability rule and the BUG-029 orphan class; lightpanda
// has no Windows build, no rendering, and is AGPL-3.0 against the licensing
// gate; ego-lite is macOS-only). Their shared DESIGN is adoptable: snapshot the
// page as a semantic tree with deterministic refs, act on refs, verify.
//
// That needs no new dependency. playwright-core 1.61.1 (already in
// package.json) ships it as public API — verified in this repo's own installed
// copy, not assumed:
//   * page.ariaSnapshot({ mode: 'ai' }) yields a YAML a11y tree whose
//     interactable nodes carry [ref=eN] markers, AND inlines <iframe> subtrees
//     (types.d.ts: "Includes element references [ref=e2] ... Includes snapshots
//     of <iframe>s inside the target").
//   * page.locator('aria-ref=f1e3') resolves cross-frame by itself —
//     coreBundle's _jumpToAriaRefFrameIfNeeded() parses the f<seq>e<n> form and
//     switches to the owning frame. So iframe support (the single highest-value
//     item for job-application forms, which live in Greenhouse/Workday/Lever
//     embeds) is native rather than something we hand-roll over page.frames().
//
// Refs are only meaningful against the snapshot that minted them. The
// generation counter below is what turns "this ref is stale" into an explicit,
// agent-shaped error instead of a silent miss or — worse — a hit on whatever
// element inherited that ref after a re-render.
const SNAPSHOT_MAX_NODES = 200;
const SNAPSHOT_MAX_CHARS = 8000;

let snapshotGeneration = 0;
let snapshotRefs = new Set();
let snapshotPageUrl = null;

// Every ref Playwright emits, in the two shapes it uses: `e12` for the main
// frame, `f3e12` for a node inside the 3rd frame.
const REF_MARKER = /\[ref=([a-zA-Z0-9]+)\]/g;

function extractRefs(yaml) {
  const found = [];
  let m;
  REF_MARKER.lastIndex = 0;
  while ((m = REF_MARKER.exec(yaml)) !== null) found.push(m[1]);
  return found;
}

// Size discipline: this text goes back to Gemini Live inside a toolResponse, so
// an un-capped snapshot of a heavy page (YouTube's home is thousands of nodes)
// would blow the turn. When the tree does not fit, keep the lines that carry a
// ref — under mode:'ai' those ARE the interactable elements, i.e. exactly what
// a ref-based action can target — and say how many nodes were dropped. Silent
// truncation would read as "that's the whole page", which is the class of lie
// the evidence contract exists to prevent.
function capSnapshot(yaml) {
  const lines = yaml.split('\n');
  if (lines.length <= SNAPSHOT_MAX_NODES && yaml.length <= SNAPSHOT_MAX_CHARS) {
    return { text: yaml, truncated: false, omittedNodes: 0, keptNodes: lines.length };
  }
  const interactive = lines.filter((l) => l.includes('[ref='));
  const kept = interactive.slice(0, SNAPSHOT_MAX_NODES);
  let text = kept.join('\n');
  let charCapped = false;
  if (text.length > SNAPSHOT_MAX_CHARS) {
    text = text.slice(0, SNAPSHOT_MAX_CHARS);
    // Never hand back a half-written final line: a truncated `[ref=` marker is
    // a ref the model can read and cannot use.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline > 0) text = text.slice(0, lastNewline);
    charCapped = true;
  }
  return {
    text,
    truncated: true,
    charCapped,
    omittedNodes: lines.length - text.split('\n').length,
    keptNodes: text.split('\n').length,
  };
}

async function browser_snapshot({ screenshot } = {}) {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    if (typeof page.ariaSnapshot !== 'function') {
      // Honest degrade rather than a silent fall back to selector-guessing:
      // this repo pins playwright-core, so an absent API means the pin moved.
      return fail(
        'This browser build cannot produce an accessibility snapshot (page.ariaSnapshot is ' +
        'unavailable — playwright-core may have been downgraded). Use CSS selectors for now.'
      );
    }
    const raw = await page.ariaSnapshot({ mode: 'ai' });
    const capped = capSnapshot(String(raw || ''));
    const refs = extractRefs(capped.text);

    // Mint a new generation BEFORE returning: any ref handed out below belongs
    // to this generation and no earlier one.
    snapshotGeneration += 1;
    snapshotRefs = new Set(refs);
    snapshotPageUrl = page.url();

    const result = {
      snapshot: capped.text,
      generation: snapshotGeneration,
      refCount: refs.length,
      nodes: capped.keptNodes,
      truncated: capped.truncated,
      url: snapshotPageUrl,
      title: await page.title(),
    };
    // Surface a human-verification challenge in the snapshot itself. A model
    // that has to call a second tool to notice a CAPTCHA will sometimes not
    // call it, and then spends the turn clicking at a wall.
    const captchaMarkers = looksLikeCaptcha(capped.text + ' ' + snapshotPageUrl);
    if (captchaMarkers.length) {
      result.captchaDetected = true;
      result.captchaMarkers = captchaMarkers;
      result.captchaNote =
        'This page is showing a human-verification challenge. Do NOT try to solve or bypass it — ' +
        'ask the operator to complete it in the browser window and to tell you when to continue.';
    }
    if (capped.truncated) {
      result.omittedNodes = capped.omittedNodes;
      result.truncationNote =
        `This page is larger than one snapshot can carry. Showing the ${capped.keptNodes} ` +
        `interactable elements (the ones a ref can act on); ${capped.omittedNodes} other nodes ` +
        'were omitted. Scroll or narrow the page and snapshot again if what you need is missing.';
    }
    // ego-lite's combined capture: the picture and the semantic tree in one
    // result, so a model that wants both does not pay two round trips.
    if (screenshot) {
      const buf = await page.screenshot({ fullPage: false });
      result.screenshotBase64 = buf.toString('base64');
      result.screenshotKB = Math.round(buf.length / 1024);
    }
    return ok(result);
  }).catch(err => fail(err.message));
}

// Shared by every ref-capable action below. Returns null when the ref is usable,
// or an agent-shaped failure that tells the model its NEXT MOVE — the
// agent-browser lesson: an error the model cannot act on is a dead end, and this
// repo has already paid for that twice (BUG-107's wrong-browser refusal, twice
// over). Never guesses: a ref we cannot vouch for is refused, not approximated.
function checkRef(ref) {
  if (snapshotGeneration === 0) {
    return fail(
      `ref "${ref}" cannot be used because no snapshot has been taken in this session. ` +
      'Call browser_snapshot first, then act on a ref from its output.'
    );
  }
  if (!snapshotRefs.has(ref)) {
    return fail(
      `ref "${ref}" is not in the latest snapshot (generation ${snapshotGeneration}) — it is ` +
      'either from an older snapshot or was never in one. Call browser_snapshot again and use a ' +
      'ref from the fresh output.'
    );
  }
  return null;
}

function refLocator(page, ref) {
  // 'aria-ref=f3e12' resolves inside frame 3 on its own (Playwright's
  // _jumpToAriaRefFrameIfNeeded) — do NOT hand-walk page.frames() here.
  return page.locator('aria-ref=' + ref);
}

// Invalidate outstanding refs whenever we know the page moved underneath them.
// A navigation re-renders everything, so every ref from the previous page is
// meaningless — better to force one extra snapshot than to let a ref resolve
// against a page the model has never seen.
function invalidateSnapshotRefs(reason) {
  if (snapshotRefs.size === 0) return;
  snapshotRefs = new Set();
  snapshotPageUrl = null;
  return reason;
}

// Phase 3 — the verify half of act-then-verify. After a ref action, read the
// page back and report what it says, as an oracle-backed `evidence` field
// rather than a bare ok:true. A full re-snapshot stays the model's explicit
// choice (call browser_snapshot again); charging every click for a second tree
// would make the common case expensive to prove the uncommon one.
//
// Every probe is individually guarded: a page object that cannot answer one
// question must not cost us the answers to the others, and an evidence capsule
// that throws would turn a successful click into a reported failure.
async function captureStateCapsule(page, ref) {
  const capsule = {};
  try { capsule.url = page.url(); } catch (_) {}
  try { capsule.title = await page.title(); } catch (_) {}
  if (ref) {
    // Did the thing we clicked survive the click? Both answers are informative:
    // a dismissed dialog SHOULD be gone, a toggled button should still be there.
    try { capsule.refStillPresent = (await refLocator(page, ref).count()) > 0; } catch (_) {}
  }
  if (typeof page.evaluate === 'function') {
    try {
      const dom = await page.evaluate(() => {
        const active = document.activeElement;
        const video = document.querySelector('video');
        return {
          focused: active ? {
            tag: active.tagName ? active.tagName.toLowerCase() : null,
            role: active.getAttribute ? active.getAttribute('role') : null,
            name: (active.getAttribute && (active.getAttribute('aria-label') || active.getAttribute('name'))) ||
              (active.textContent || '').trim().slice(0, 60) || null,
          } : null,
          // The video oracle the plan calls for: "is it actually playing" is a
          // property of the media element, not of the click that started it.
          // Only reported when the page HAS a video, so a normal page's capsule
          // stays small.
          video: video ? { playing: !video.paused, currentTime: video.currentTime, duration: video.duration } : null,
        };
      });
      if (dom && dom.focused) capsule.focused = dom.focused;
      if (dom && dom.video) capsule.video = dom.video;
    } catch (_) { /* a page that refuses evaluate still gives us url/title */ }
  }
  return capsule;
}

function describeCapsule(capsule) {
  const bits = [];
  if (capsule.url) bits.push('url ' + capsule.url);
  if (capsule.title) bits.push('title "' + capsule.title + '"');
  if (capsule.focused && capsule.focused.tag) {
    bits.push('focus on <' + capsule.focused.tag + '>' + (capsule.focused.name ? ' "' + capsule.focused.name + '"' : ''));
  }
  if (capsule.video) bits.push('video ' + (capsule.video.playing ? 'PLAYING' : 'paused'));
  if (capsule.refStillPresent === false) bits.push('the clicked element is no longer on the page');
  return bits.join('; ');
}

// NOTE ON SHAPE, and it is load-bearing: this returns the effector's WHOLE
// result — `{ok, unverified, evidence, result}` — not something to pass to
// ok(). Wrapping it (`ok(await withStateCapsule(...))`) buries `unverified` and
// `evidence` one level down inside `.result`, where dispatch-action and
// live-tool-adapter's evaluateOutcome do not look; the outcome then reads as a
// plain ok:true and the voice layer speaks an unproven action as done. That is
// the exact flattening the evidence contract exists to prevent, and it was
// briefly live here before this comment existed. Return it directly.
async function withStateCapsule(page, payload, ref) {
  const capsule = await captureStateCapsule(page, ref);
  const observed = describeCapsule(capsule);
  const result = Object.assign({}, payload, { url: capsule.url, state: capsule });
  if (!observed) {
    // No oracle answered. Say so rather than dressing the call's own return up
    // as proof — verifiedOk would (correctly) throw on an empty observation.
    return evidenceModule.unverified({ result },
      'the action was dispatched but the page reported nothing back, so I cannot confirm it changed anything');
  }
  return evidenceModule.verifiedOk({ result }, { oracle: 'page-state', observed });
}

// agent-browser's lesson, and this repo's own (BUG-107, whose dead-end refusal
// survived a fix because only one of two sites named a remedy): a failure the
// model cannot act on is a dead end. Every ref-action failure says what to do.
function refFailure(ref, verb, err) {
  const detail = (err && err.message) || String(err || 'unknown error');
  if (/aria-ref|resolve|not found|strict mode/i.test(detail)) {
    return `Could not ${verb} ref "${ref}": it no longer resolves on this page (${detail}). ` +
      'The page has probably re-rendered — call browser_snapshot again and use a fresh ref.';
  }
  if (/timeout|intercept|not visible|stable/i.test(detail)) {
    return `Could not ${verb} ref "${ref}": the element is on the page but not actionable (${detail}). ` +
      'Something may be covering it — call browser_dismiss_overlays, or snapshot again to see what is on top.';
  }
  return `Could not ${verb} ref "${ref}": ${detail}`;
}

// Test-only seam: the ref state is module-level (one browser, one operator), and
// tests need a known starting point without driving a real page.
function __resetSnapshotStateForTest() {
  snapshotGeneration = 0;
  snapshotRefs = new Set();
  snapshotPageUrl = null;
}
function __setSnapshotStateForTest(refs, generation) {
  snapshotRefs = new Set(refs || []);
  snapshotGeneration = generation === undefined ? 1 : generation;
}

async function browser_navigate({ url, newTab, browser }) {
  if (!url) return fail('URL is required.');
  // BUG-099: when the operator names a browser, drive THAT one or refuse. The
  // 2026-08-05 session asked for Brave four times and got Chrome every time,
  // narrated as success. Checked before requireOnline() so a mismatch never
  // launches or connects anything.
  const targetObjection = checkBrowserTarget(browser);
  if (targetObjection) return targetObjection;
  // REMEDIATION P1-7: a /vault/... path (or a mistaken file:///vault/... URL)
  // is not a real filesystem path on any machine — resolve it through the
  // same vault-url.js mapping open_artifact uses instead of forwarding it
  // verbatim into a file:// URL that page.goto then fails to load.
  let target = url;
  const relPath = vaultRelativePath(url);
  if (relPath !== null) {
    if (!vaultFs || typeof vaultFs.exists !== 'function' || !vaultFs.exists(relPath)) {
      return fail(`Artifact does not exist: ${url}. Call pipeline_status or job_status to get a real artifact path before navigating to one.`);
    }
    target = vaultUrl(relPath, config, { sign: true }); // BUG-317: a real browser sends no auth header
  }
  try { new URL(target); } catch { return fail(`Invalid URL: "${target}"`); }
  const guard = await requireOnline();
  if (guard) return guard;

  // newTab:true opens a genuinely new tab and loads url into it in one atomic
  // call. This exists so "open X in a new tab" can never be satisfied by
  // creating a blank tab without navigating it (the bug: browser_tabs(new) and
  // browser_navigate were two separate, droppable calls) — one tool call now
  // does both, so a stray blank tab can't be left behind.
  const runner = newTab ? browserAgent.withNewPage : browserAgent.withPage;
  return runner(async (page) => {
    // 'commit' resolves as soon as the network response is received and reading
    // starts — strictly less strict than the old 'domcontentloaded', so a slow
    // initial HTML no longer blocks. Then a BOUNDED best-effort networkidle
    // settle (3s, swallow) gives a lazy SPA (YouTube) a chance to hydrate its
    // custom elements before the brain's next click lands on a not-yet-existing
    // node. Fast/static pages ignore it (networkidle already true → instant).
    await _gotoWithRedirectRetry(page, target); // BUG-339: retry module owns the why
    try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch (_) {}
    // Every ref from the previous page is meaningless now. Drop them so a
    // leftover ref fails with "snapshot again" instead of resolving against a
    // page the model has never actually seen.
    invalidateSnapshotRefs('navigated');
    const title = await page.title();
    // `browser` is what MYTHOS can actually vouch for — 'unknown' when it
    // attached to a debug endpoint it did not start. Never say Brave on a guess.
    return ok({ url: page.url(), title, newTab: !!newTab, browser: attachedBrowser || 'unknown' });
  }).catch(err => fail(err.message));
}

// BUG-121 — 2026-08-05: browser_click could not hit a YouTube video thumbnail.
// The old body was one bounded visible-wait and then a plain page.click, so an
// element that is in the DOM but never satisfies Playwright's actionability
// checks (YouTube's ytd-* custom elements hydrate late; a thumbnail can be
// attached and clickable-by-JS while still reported not-visible, or be covered
// by an overlay) had no path at all — it failed with "not visible" and stopped.
//
// A ladder, with every rung named in the result so the operator hears WHICH
// route worked rather than a bare success:
//   1. visible wait -> scrollIntoViewIfNeeded -> native page.click. Fully
//      verified: Playwright's actionability check IS the oracle.
//   2. attached wait -> el.click() in page context. A JS click bypasses
//      hit-testing, so it can "succeed" against a covered element that a real
//      user could never have clicked. That is a weaker oracle than rung 1, so
//      per the evidence contract this rung returns unverified:true with a
//      spoken-usable reason rather than a bare ok.
//   3. neither -> fail naming the selector and the rungs tried.
// No coordinate fallback in this pass — clicking blind screen coordinates in a
// browser has no oracle at all.
async function browser_click({ selector, ref }) {
  // The ref path is the primary mechanism now: it names an element the model
  // actually SAW in a snapshot, so there is nothing to guess and the ladder
  // below never has to run. The selector path is unchanged and stays as the
  // fallback for pages nobody snapshotted.
  if (ref) {
    const refProblem = checkRef(ref);
    if (refProblem) return refProblem;
    const guard = await requireOnline();
    if (guard) return guard;
    return browserAgent.withPage(async (page) => {
      // Native Playwright click on the resolved locator — the actionability
      // check (visible, stable, receives events, not covered) IS the oracle, so
      // this path never needs the unverified downgrade the JS-click rung takes.
      await refLocator(page, ref).click();
      return await withStateCapsule(page, { clicked: ref, via: 'ref-click' }, ref);
    }).catch(err => fail(refFailure(ref, 'click', err)));
  }

  if (!selector) return fail('Either ref (from browser_snapshot, preferred) or a CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const stagesTried = [];

    // Rung 1 — the real thing. waitReady is the same bounded visible-wait that
    // replaced the old swallowed-catch waitForSelector: no retry storm.
    stagesTried.push('visible-wait');
    if (await waitReady(page, selector)) {
      // A thumbnail below the fold is "visible" to Playwright's state check but
      // still needs scrolling before the click lands. Bounded and best-effort:
      // a scroll that cannot run must not lose us the click that would have.
      try { await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
      stagesTried.push('native-click');
      await page.click(selector);
      return ok({ clicked: selector, url: page.url(), via: 'native-click', stages: stagesTried });
    }

    // Rung 2 — attached but not actionable. This is the lazy-hydration case.
    stagesTried.push('attached-wait');
    let handle = null;
    try {
      handle = await page.waitForSelector(selector, { timeout: pageWaitMs(), state: 'attached' });
    } catch (_) { handle = null; }

    if (handle) {
      stagesTried.push('js-click');
      await handle.evaluate((el) => el.click());
      return {
        ok: true,
        unverified: true,
        reason: `clicked ${selector} from page script because it never became visibly actionable — ` +
          'a script click skips the checks that prove a real user could have hit it, so I cannot ' +
          'confirm the page reacted',
        result: { clicked: selector, url: page.url(), via: 'js-click', stages: stagesTried },
      };
    }

    return fail(
      `Could not click ${selector}: it never became visible within ${pageWaitMs()}ms and was not ` +
      `in the DOM to click from page script either. Tried: ${stagesTried.join(', ')}.`
    );
  }).catch(err => fail(err.message));
}

async function browser_type({ selector, text, clearFirst, ref }) {
  if (!text) return fail('Text is required.');
  if (ref) {
    const refProblem = checkRef(ref);
    if (refProblem) return refProblem;
    const onlineGuard = await requireOnline();
    if (onlineGuard) return onlineGuard;
    return browserAgent.withPage(async (page) => {
      const locator = refLocator(page, ref);
      // fill() replaces, type() appends — the same distinction the selector
      // path makes, kept identical so moving to refs changes targeting only.
      if (clearFirst) await locator.fill(String(text));
      else await locator.type(String(text));
      return await withStateCapsule(page, { typed: String(text).length, into: ref, via: 'ref-type' }, ref);
    }).catch(err => fail(refFailure(ref, 'type into', err)));
  }

  if (!selector) return fail('Either ref (from browser_snapshot, preferred) or a CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Same waitReady pre-wait as browser_click — fail cleanly if absent.
    if (!(await waitReady(page, selector))) {
      return fail(`Element not ready (not visible within ${pageWaitMs()}ms): ${selector}`);
    }
    if (clearFirst) await page.fill(selector, text);
    else await page.type(selector, text);
    return ok({ typed: text.length, into: selector, url: page.url() });
  }).catch(err => fail(err.message));
}

// ---- Phase 4: wait-for-element + form-fill ----

async function browser_wait_for({ selector, timeoutMs }) {
  if (!selector) return fail('CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;
  const timeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? Math.min(timeoutMs, 30000) : 10000;

  return browserAgent.withPage(async (page) => {
    try {
      await page.waitForSelector(selector, { timeout: timeout });
      // Confirm the element is actually present (waitForSelector resolves on visibility too).
      const count = await page.locator(selector).count();
      return ok({ selector: selector, present: true, matched: count, waitedMs: timeout });
    } catch (err) {
      // Honest fail on timeout — do NOT claim the element appeared.
      return fail('Element "' + selector + '" did not appear within ' + timeout + 'ms.');
    }
  }).catch(err => fail(err.message));
}

async function browser_fill_form({ fields }) {
  if (!fields || !Array.isArray(fields) || !fields.length) {
    return fail('fields array is required: [{ref, value}] (preferred) or [{selector, value}].');
  }
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Fill each field in sequence. A bad selector reports that field's failure
    // WITHOUT aborting the rest — a form with one missing field still fills the
    // others, and the result reports per-field outcome.
    const results = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      // A ref field takes the ref path; the per-field contract is unchanged, so
      // one stale ref costs its own field and not the whole form. Mixing refs
      // and selectors across fields is allowed on purpose — a snapshot may not
      // have reached every control on a long multi-step form.
      if (f && f.ref) {
        if (f.value === undefined || f.value === null) {
          results.push({ index: i, ref: f.ref, ok: false, error: 'missing value' });
          continue;
        }
        const refProblem = checkRef(f.ref);
        if (refProblem) {
          results.push({ index: i, ref: f.ref, ok: false, error: String(refProblem.result) });
          continue;
        }
        try {
          await refLocator(page, f.ref).fill(String(f.value));
          results.push({ index: i, ref: f.ref, ok: true });
        } catch (err) {
          results.push({ index: i, ref: f.ref, ok: false, error: refFailure(f.ref, 'fill', err) });
        }
        continue;
      }
      if (!f || !f.selector || f.value === undefined || f.value === null) {
        results.push({ index: i, selector: f && f.selector, ok: false, error: 'missing ref/selector or value' });
        continue;
      }
      try {
        // waitReady pre-wait per field (replaces the swallowed 4000ms catch).
        // A field that never appears reports its own failure WITHOUT aborting
        // the rest of the form (the per-field contract documented above).
        if (!(await waitReady(page, f.selector))) {
          results.push({ index: i, selector: f.selector, ok: false, error: 'field not visible within ' + pageWaitMs() + 'ms' });
          continue;
        }
        await page.fill(f.selector, String(f.value));
        results.push({ index: i, selector: f.selector, ok: true });
      } catch (err) {
        results.push({ index: i, selector: f.selector, ok: false, error: (err && err.message) || 'fill failed' });
      }
    }
    const filled = results.filter((r) => r.ok).length;
    return ok({ fields: results, filled: filled, total: fields.length, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_screenshot() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const buf = await page.screenshot({ fullPage: false });
    const b64 = buf.toString('base64');
    const title = await page.title();
    return ok({ base64: b64, width: page.viewportSize()?.width || 0, height: page.viewportSize()?.height || 0, title, url: page.url(), sizeKB: Math.round(buf.length / 1024) });
  }).catch(err => fail(err.message));
}

async function browser_get_title() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const title = await page.title();
    return ok({ title, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_get_text({ selector } = {}) {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    let text;
    if (selector) {
      // waitReady pre-wait: previously get_text had NONE, so page.textContent
      // immediately rode the 15s page-default timeout on any not-yet-hydrated
      // SPA element (the operator's exact YouTube ytd-rich-item-renderer error).
      // Fail cleanly here with the selector named, not the raw Playwright timeout.
      if (!(await waitReady(page, selector))) {
        return fail('Element not ready (not visible within ' + pageWaitMs() + 'ms): ' + selector);
      }
      text = await page.textContent(selector);
      if (!text && selector) return fail('Element not found or empty for selector: ' + selector);
    } else {
      text = await page.textContent('body');
      if (!text && !selector) { text = await page.textContent('body'); }
      if (!text) return fail('No text content found on the page.');
    }
    // Truncate to avoid huge payloads
    const truncated = text.length > 4000;
    return ok({ text: text.substring(0, 4000), truncated, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_scroll({ direction }) {
  const dir = direction || 'down';
  if (!['up', 'down'].includes(dir)) return fail('Direction must be "up" or "down".');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const amount = dir === 'down' ? 600 : -600;
    await page.evaluate((y) => window.scrollBy(0, y), amount);
    return ok({ scrolled: dir, amount });
  }).catch(err => fail(err.message));
}

async function listTabs(pages) {
  return Promise.all(pages.map(async (p, i) => ({
    index: i,
    title: await p.title().catch(() => '(error)'),
    url: p.url(),
  })));
}

// Indexes are recomputed fresh every call and shift the instant any tab
// closes. `match` targets a tab by identity (title/url substring) instead of
// a position that may already be stale; every switch/close response also
// returns a fresh tabs list.
async function resolveTabIndex(pages, index, match) {
  if (typeof index === 'number') return { idx: index };
  if (match) {
    const needle = String(match).toLowerCase();
    for (let i = 0; i < pages.length; i++) {
      const title = await pages[i].title().catch(() => '');
      if (title.toLowerCase().includes(needle) || pages[i].url().toLowerCase().includes(needle)) return { idx: i };
    }
    return { idx: -1, error: `No open tab matches "${match}".` };
  }
  return { idx: null };
}

async function browser_tabs({ action, index, match }) {
  const act = action || 'list';
  const validActions = ['list', 'new', 'switch', 'close'];
  if (!validActions.includes(act)) return fail(`Invalid tab action: "${act}". Valid: ${validActions.join(', ')}`);
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page, ctx) => {
    const pages = ctx.pages();

    switch (act) {
      case 'list':
        return ok({
          tabs: await listTabs(pages),
          total: pages.length,
        });
      case 'new': {
        const newPage = await ctx.newPage();
        return ok({ index: pages.length, title: await newPage.title(), url: newPage.url() });
      }
      case 'switch': {
        const resolved = await resolveTabIndex(pages, index, match);
        if (resolved.error) return fail(resolved.error);
        const idx = resolved.idx != null ? resolved.idx : 0;
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        await pages[idx].bringToFront();
        return ok({ switched: idx, title: await pages[idx].title(), url: pages[idx].url(), tabs: await listTabs(ctx.pages()) });
      }
      case 'close': {
        const resolved = await resolveTabIndex(pages, index, match);
        if (resolved.error) return fail(resolved.error);
        const idx = resolved.idx != null ? resolved.idx : (pages.length - 1);
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        if (pages.length <= 1) return fail('Cannot close the last tab.');
        await pages[idx].close();
        const remaining = ctx.pages();
        return ok({ closed: idx, remaining: remaining.length, title: await remaining[0].title(), url: remaining[0].url(), tabs: await listTabs(remaining) });
      }
      default:
        return fail(`Unknown tab action: ${act}`);
    }
  }).catch(err => fail(err.message));
}

async function browser_go_back() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    return ok({ url: page.url(), title: await page.title() });
  }).catch(err => fail(err.message));
}

async function browser_evaluate({ script, expression, javascript, query }) {
  // BUG-011 fix 2: param aliasing — callers (voice/dashboard) sometimes send
  // "expression"/"javascript"/"query" instead of "script"; previously only
  // "script" was read, so those calls silently failed with a missing-arg error.
  const code = script || expression || javascript || query;
  if (!code) return fail('JavaScript expression is required (pass as script, expression, javascript, or query).');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Safety: wrap in try-catch on the browser side
    const result = await page.evaluate((code) => {
      try {
        const value = eval(code);
        return { value: String(value), ok: true };
      } catch (err) {
        return { error: err.message, ok: false };
      }
    }, code);

    if (result.ok) return ok({ value: result.value, url: page.url() });
    return fail(`Script error: ${result.error}`);
  }).catch(err => fail(err.message));
}

// BUG (on-demand launcher, Phase 6a): mirrors scripts/setup-chrome-debug.ps1's
// exact search order and launch flags so this tool and the manual script agree
// on where the debug browser lives. Chrome first, then Edge; portability rule
// (repo CLAUDE.md) — the profile dir is derived from process.env.LOCALAPPDATA,
// never a hardcoded path.
// BUG-099: Brave joined the list. The operator asked four times for YouTube in
// Brave; Brave opened (launch_app) but every browser_navigate drove Chrome,
// because this resolver knew only Chrome and Edge and the CDP endpoint is a
// single fixed port. Brave is Chromium, so it speaks the same CDP — nothing
// else in the browser stack needed to change.
const BROWSER_SUBPATHS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
};
// BUG-130 — Brave first when it is installed. The debug browser runs in a
// dedicated, empty profile (chrome-debug-profile), so the operator's own ad
// blocker — which lives in their real profile — has never applied to anything
// MYTHOS drives. On 2026-08-06 that meant sitting through YouTube ads on a
// page MYTHOS opened. Brave's Shields are part of the browser rather than an
// extension, so they are on in a fresh profile with nothing installed and no
// third-party code bundled into this repo (see the BYO note on
// BROWSER_EXTENSIONS below, and the licensing rules in the root CLAUDE.md).
// Chrome remains the fallback and an explicit browser:"chrome" still wins —
// this only changes which one is picked when the caller names none.
const BROWSER_SEARCH_ORDER = ['brave', 'chrome', 'edge'];
const BROWSER_ALIASES = {
  chrome: 'chrome', 'google chrome': 'chrome', 'google-chrome': 'chrome',
  brave: 'brave', 'brave browser': 'brave', 'brave-browser': 'brave',
  edge: 'edge', msedge: 'edge', 'microsoft edge': 'edge',
};

function normalizeBrowserName(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return BROWSER_ALIASES[key] || null;
}

// Every candidate derives from an environment root — repo portability rule, no
// hardcoded absolute paths in tracked files.
function browserCandidatePaths(name) {
  const wanted = name === undefined || name === null || name === ''
    ? BROWSER_SEARCH_ORDER
    : [normalizeBrowserName(name)].filter(Boolean);
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const out = [];
  for (const browserName of wanted) {
    const sub = BROWSER_SUBPATHS[browserName];
    if (!sub) continue;
    for (const root of roots) {
      if (root) out.push(path.join(root, ...sub));
    }
  }
  return out;
}

function findBrowserExecutable(name) {
  // BROWSER_EXECUTABLE lets an operator point at any Chromium build (a portable
  // install, a non-standard drive) without touching code — same BYO posture as
  // the API keys. Only honored when no specific browser was requested, since a
  // named request must resolve to THAT browser or fail.
  const override = process.env.BROWSER_EXECUTABLE;
  if (override && !name) {
    try { if (fs.existsSync(override)) return override; } catch { /* fall through */ }
  }
  const candidates = browserCandidatePaths(name);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Which browser MYTHOS itself put behind the CDP endpoint. null means "attached
// to something we did not launch" — an externally-started debug browser, which
// Brave and Chrome are indistinguishable in over CDP (Brave reports a plain
// `Chrome/<version>` product string on purpose). Unknown is reported as
// unknown; it is never assumed to be a match.
let attachedBrowser = null;

// Test seam only — production code sets this exclusively via a real launch.
function __setAttachedBrowserForTest(name) { attachedBrowser = name; }

function supportedBrowserList() { return BROWSER_SEARCH_ORDER.join(', '); }

// Returns null when the request is satisfiable, or a fail() when driving the
// attached browser would NOT be what the caller asked for. This is the whole
// BUG-099 honesty guarantee: silently navigating Chrome for a "in Brave"
// request, then describing it as Brave, is a fabricated success.
//
// BUG-106: attachedBrowser is a module-level flag that only reflects the LAST
// successful launch/connect — it says nothing about whether that browser is
// still the one behind the CDP endpoint right now. The operator can close it
// at any time; the adapter then drops to OFFLINE, and a later reconnect (the
// lazy bring-up in requireOnline(), or the background auto-connect poller) may
// attach to a DIFFERENT browser without ever telling this module. Clearing
// attachedBrowser here, before either check below, whenever the adapter is not
// ONLINE makes that stale window structurally impossible: whatever was
// attached before is gone, so nothing here can vouch for it anymore.
function checkBrowserTarget(requested) {
  const status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') attachedBrowser = null;

  if (requested === undefined || requested === null || requested === '') return null;
  const want = normalizeBrowserName(requested);
  if (!want) {
    return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);
  }
  if (!attachedBrowser) {
    return fail(`I cannot confirm which browser is attached to the debug port, so I will not claim to be driving ${want}. `
      + `Call browser_launch_debug with browser:"${want}" to start one I can vouch for.`);
  }
  if (attachedBrowser !== want) {
    return fail(`Browser control is attached to ${attachedBrowser}, not ${want}. `
      + `Call browser_switch with browser:"${want}" to close ${attachedBrowser} and switch (it calls browser_launch_debug for you) — `
      + `I will not navigate ${attachedBrowser} and call it ${want}.`);
  }
  return null;
}

// BUG-115: MYTHOS drives the debug browser through a dedicated --user-data-dir
// (chrome-debug-profile / <name>-debug-profile) that has never had any
// extensions installed into it — the operator's ad blocker lives only in
// their REAL browser profile, so every debug-driven page is unfiltered.
// BROWSER_EXTENSIONS (env, semicolon-separated list of unpacked extension
// directory paths, documented in mythos/.env.example) lets the operator load
// their own extensions into the debug profile. Read directly via process.env,
// same BYO convention as BROWSER_EXECUTABLE above — no schema.js entry.
function parseBrowserExtensionsEnv() {
  const raw = process.env.BROWSER_EXTENSIONS;
  if (!raw || !raw.trim()) return [];
  return raw.split(';').map((p) => p.trim()).filter(Boolean);
}

// An unpacked extension directory has a manifest.json at its root — the one
// structural signal that distinguishes a real unpacked extension folder from
// any other directory (a .crx is a single packed file, not a directory, so it
// fails this check honestly instead of being silently "loaded").
function isUnpackedExtensionDir(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.existsSync(path.join(dir, 'manifest.json'));
  } catch { return false; }
}

// Validates every configured extension path BEFORE anything is spawned.
// Returns { ok:true, dirs } (dirs is [] when BROWSER_EXTENSIONS is unset/empty
// — unchanged default behavior) or { ok:false, error }. A missing or invalid
// path must fail LOUDLY here, not silently proceed with a blocker that never
// actually loaded — that silent-absence shape is exactly today's bug.
function resolveBrowserExtensions() {
  const configured = parseBrowserExtensionsEnv();
  if (!configured.length) return { ok: true, dirs: [] };
  for (const dir of configured) {
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path does not exist: ${dir}` };
    }
    if (!isUnpackedExtensionDir(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path is not an unpacked extension directory (no manifest.json found): ${dir}` };
    }
  }
  return { ok: true, dirs: configured };
}

// Chromium ignores --load-extension alone in current builds — it also needs
// --disable-extensions-except naming the same list, or the extension silently
// never loads (found live-verifying BUG-115: neither debug profile directory
// has ever had a Default/Extensions folder). Both flags take a single
// comma-separated path list when there is more than one extension.
function buildBrowserLaunchArgs(profileDir, extensionDirs) {
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
  ];
  if (extensionDirs && extensionDirs.length) {
    const joined = extensionDirs.join(',');
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }
  return args;
}

// Evidence-contract seam (repo rule: an effector result must carry an
// oracle-backed field, never a bare ok:true with no evidence). extensionsLoaded
// is exactly the dirs resolveBrowserExtensions() verified present on disk and
// passed to Chromium — [] when none were configured, never a guess and never
// "active" for a profile that loaded none.
function buildLaunchResult(browserName, status, profileDir, extensionDirs) {
  // BUG-345: fresh chrome/edge debug profiles load no extensions and have no Shields - say so on the result.
  const noBlocking = (!extensionDirs || !extensionDirs.length) && /chrome|edge/i.test(String(browserName));
  const result = { launched: true, browser: browserName, mode: status.mode, pageCount: status.pageCount, profileDir, extensionsLoaded: extensionDirs };
  if (noBlocking) result.caveat = 'No ad blocking is active in this fresh profile - pages will show ads. Ask for Brave, or set BROWSER_EXTENSIONS to a uBlock directory.';
  return result;
}

// BUG-140: poll interval and worst-case ceiling for waitForDebugPortReady(). The
// ceiling matches the old flat `setTimeout(r, 2000)` this replaces, so a
// never-ready port waits no longer than before — only the common case (port
// answers early) gets faster.
const COLD_START_POLL_INTERVAL_MS = 200;
const COLD_START_CEILING_MS = 2000;

// BUG-140: poll `probeFn` (returns a Promise<boolean>) every
// COLD_START_POLL_INTERVAL_MS, resolving true the moment it does, or false
// once COLD_START_CEILING_MS has elapsed. Never throws — probeFn is expected
// to have already swallowed its own errors (see call site).
async function waitForDebugPortReady(probeFn) {
  const deadline = Date.now() + COLD_START_CEILING_MS;
  for (;;) {
    if (await probeFn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, COLD_START_POLL_INTERVAL_MS));
  }
}

// On-demand debug-browser launcher (Phase 6a, user-approved). Boot never
// auto-launches Chrome (main.js's browser-automation step — launching a real
// browser at boot steals the mic/audio device on Windows) — this is the tool
// that turns that CDP-connect-only standby into an actually-online browser
// when the user asks for one, without touching the boot-time prohibition.
async function browser_launch_debug(args) {
  // BUG-099: an explicit browser name. Unsupported names fail before anything
  // is spawned — the model must not get a launched Chrome for a "brave" ask.
  const requested = args && args.browser;
  let want = null;
  if (requested !== undefined && requested !== null && requested !== '') {
    want = normalizeBrowserName(requested);
    if (!want) return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);
  }

  const status0 = browserAgent.getStatus();
  if (status0.state === 'ONLINE') {
    // One CDP port, one browser. If a different one already owns it, say so
    // instead of "launched" — the debug port cannot be shared.
    if (want && attachedBrowser && attachedBrowser !== want) {
      // BUG-107: name the remedy here too. checkBrowserTarget()'s refusal points
      // at browser_switch, but this branch is the one a model asked for a
      // different browser actually hits first — it calls browser_launch_debug,
      // not browser_navigate. "Close it first" is an instruction to the operator,
      // not something MYTHOS can act on, which is the dead end BUG-107 removed.
      return fail(`${attachedBrowser} already owns the debug port — one port, one browser. `
        + `Call browser_switch with browser:"${want}" to close ${attachedBrowser} and launch ${want} instead.`);
    }
    return ok({ alreadyOnline: true, browser: attachedBrowser || 'unknown' });
  }
  if (status0.state === 'CONNECTING') {
    // FIX-1: a connect is already in flight (poller tick or a concurrent
    // caller) — join it via ensureOnline()/connect()'s connectingPromise guard
    // instead of spawning a second Chrome process on top of it.
    const cdpUrl0 = process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) || 'http://127.0.0.1:9222';
    const joined = await browserAgent.ensureOnline({ cdpUrl: cdpUrl0 }).catch(() => false);
    if (joined) {
      const s = browserAgent.getStatus();
      return ok({ launched: false, mode: s.mode, pageCount: s.pageCount });
    }
    return fail('A browser connection attempt is already in progress and did not complete — try again in a moment.');
  }

  // BUG-115 (hoisted 2026-08-16): validate BEFORE anything machine-dependent —
  // before browser discovery, not just before the spawn. A bad/missing
  // BROWSER_EXTENSIONS path is a config error and must fail loudly with its
  // own message on ANY machine, browser installed or not; with validation
  // after findBrowserExecutable(), a browser-less machine (a fresh contributor
  // running the suite, a clean CI runner) surfaced "No supported browser
  // found" instead, and test/bug-115's loud-failure test failed there — the
  // same environment-dependent-test class as BUG-258. Discovery order between
  // the profile dir and the spawn is otherwise unchanged.
  const extensionsResult = resolveBrowserExtensions();
  if (!extensionsResult.ok) return fail(extensionsResult.error);
  const extensionDirs = extensionsResult.dirs;

  const exe = findBrowserExecutable(want);
  if (!exe) {
    return want
      ? fail(`No ${want} installation found. Install it, or set BROWSER_EXECUTABLE to its path.`)
      : fail(`No supported browser found (${supportedBrowserList()}). Install one, or set BROWSER_EXECUTABLE to its path.`);
  }

  // A named browser gets its own profile dir so switching browsers does not
  // hand Brave a profile Chrome wrote. Unnamed keeps the historical path.
  const profileDir = want && want !== 'chrome'
    ? path.join(process.env.LOCALAPPDATA, 'MYTHOS', want + '-debug-profile')
    : path.join(process.env.LOCALAPPDATA, 'MYTHOS', 'chrome-debug-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (err) { return fail(`Could not create debug profile directory: ${err.message}`); }

  const cdpUrl = process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) || 'http://127.0.0.1:9222';
  try {
    const child = spawn(exe, buildBrowserLaunchArgs(profileDir, extensionDirs), { detached: true, stdio: 'ignore' });
    child.unref();
    // BUG-029 (Phase 3 hardening): this detached spawn is the orphan risk.
    // Record the PID the same way launchLocal() does, so Start Agent OS.bat's
    // cleanup step catches it on the next boot if Windows swallows the
    // shutdown signal. Best-effort — recordLaunchedPid never throws.
    if (child && child.pid && typeof browserAgent.recordLaunchedPid === 'function') {
      browserAgent.recordLaunchedPid(child.pid);
    }
  } catch (err) {
    return fail(`Failed to launch browser: ${err.message}`);
  }

  // BUG-140: this used to be a flat, unconditional 2s sleep before the first CDP
  // connect attempt, regardless of how fast the debug port actually came up.
  // Poll instead — same COLD_START_CEILING_MS worst case as the old flat
  // wait, but returns as soon as the port answers. The probe IS
  // ensureOnline() itself (no separate reachability check exists in this
  // file to reuse): a refused connection fails fast (well under
  // COLD_START_POLL_INTERVAL_MS) rather than waiting out connect()'s own
  // 10s timeout, so polling it is cheap. On success the browser is already
  // connected, so the ensureOnline() call below is a no-op (state is
  // already ONLINE); on ceiling timeout, fall through exactly as before and
  // let ensureOnline()'s own timeout/retry report the failure.
  await waitForDebugPortReady(() => browserAgent.ensureOnline({ cdpUrl }).catch(() => false));

  const connected = await browserAgent.ensureOnline({ cdpUrl }).catch(() => false);
  if (!connected) return fail('Browser launched but CDP connect did not come online — it may still be starting; try again in a moment.');
  const status = browserAgent.getStatus();
  // BUG-099: record WHICH browser is behind the endpoint. This is the only
  // trustworthy source — over CDP, Brave reports a plain `Chrome/<version>`
  // product string, so a version probe cannot tell them apart.
  attachedBrowser = want || 'chrome';
  return ok(buildLaunchResult(attachedBrowser, status, profileDir, extensionDirs));
}

// BUG-107: the wrong-browser refusal above ("attached to Brave, not Chrome")
// used to be a dead end — correct and honest, then nothing. This is the
// remedy: disconnect the current browser, launch the requested one, and
// re-attach — in one call instead of "close Brave yourself, then ask again."
async function browser_switch(args) {
  const requested = args && args.browser;
  if (requested === undefined || requested === null || requested === '') {
    return fail('browser is required — name which browser to switch to (chrome, brave, or edge).');
  }
  const want = normalizeBrowserName(requested);
  if (!want) return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);

  const status = browserAgent.getStatus();
  if (status.state === 'ONLINE') {
    if (attachedBrowser === want) {
      return ok({ switched: false, alreadyOnline: true, browser: want });
    }
    if (!attachedBrowser) {
      // BUG-106 made attachedBrowser non-null EXACTLY when MYTHOS itself
      // launched the current browser. null here means we only ever CDP-
      // attached to something already running — closing that could kill the
      // operator's own browser window. Refuse honestly instead of silently
      // no-op'ing through browser_launch_debug's alreadyOnline branch, which
      // would otherwise report success without actually switching anything.
      return fail(`Browser control is attached to a browser MYTHOS did not launch, so I cannot confirm its identity or safely close it. `
        + `Close it yourself, then call browser_launch_debug with browser:"${want}".`);
    }
    // Only ever close a browser MYTHOS itself launched — reuses the same
    // disconnect() every other shutdown path uses, no second close mechanism.
    await browserAgent.disconnect();
  }

  attachedBrowser = null;
  // Route through the SAME launch logic browser_launch_debug already uses —
  // no second launch code path to keep in sync with it.
  return browser_launch_debug({ browser: want });
}

// ---------------------------------------------------------------------------
// Phase 5 — the rest of what a browser can do. Each of these is ref-capable,
// because a ref is the whole point: the model acts on an element it saw in a
// snapshot. Every one takes the same "ref preferred, selector as fallback"
// shape as browser_click, and reports the same page-state evidence.
// ---------------------------------------------------------------------------

// Resolve "ref or selector" to a locator once, so the four tools below cannot
// drift apart in how they target. Returns {locator, target, describe} or a
// failure to hand straight back.
async function resolveTarget(page, { ref, selector }, what) {
  if (ref) {
    const refProblem = checkRef(ref);
    if (refProblem) return { failure: refProblem };
    return { locator: refLocator(page, ref), target: ref, ref: ref };
  }
  if (!selector) {
    return { failure: fail(`Either ref (from browser_snapshot, preferred) or a CSS selector is required to ${what}.`) };
  }
  if (!(await waitReady(page, selector))) {
    return { failure: fail(`Element not ready (not visible within ${pageWaitMs()}ms): ${selector}`) };
  }
  return { locator: page.locator(selector), target: selector, ref: null };
}

// Upload — the job-application resume case, and the one tool here with real
// blast radius: it reads a file off the operator's disk and hands it to a web
// page. So the path is confined to directories the operator explicitly listed,
// checked lexically AND through realpath (a symlink planted inside an allowed
// directory must not smuggle a path out of it — the same discipline
// from-computer.js's resolveSandboxed already uses). With nothing configured it
// refuses and says how to configure it, rather than defaulting to somewhere
// convenient like the whole home directory.
function uploadRoots() {
  const raw = (config && config.BROWSER_UPLOAD_DIR) || process.env.BROWSER_UPLOAD_DIR || '';
  return String(raw).split(';').map((s) => s.trim()).filter(Boolean)
    .map((d) => d.replace(/%USERPROFILE%/gi, os.homedir()));
}

function resolveUploadPath(rawPath) {
  if (!rawPath || !String(rawPath).trim()) return { ok: false, reason: 'A file path is required.' };
  const roots = uploadRoots();
  if (!roots.length) {
    return { ok: false, reason:
      'No upload directory is configured, so I cannot send any file to a web page. Set ' +
      'BROWSER_UPLOAD_DIR in mythos/.env to the folder your documents live in (semicolon-separated ' +
      'for more than one), then ask again.' };
  }
  const resolved = path.resolve(String(rawPath).replace(/%USERPROFILE%/gi, os.homedir()));
  if (!fs.existsSync(resolved)) return { ok: false, reason: `No such file: ${resolved}` };

  // realpath both sides before comparing: it is the link-following check that
  // makes the containment test mean anything.
  let realFile;
  try { realFile = fs.realpathSync(resolved); } catch (_) { realFile = resolved; }
  const contained = roots.some((root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(path.resolve(root)); } catch (_) { return false; }
    const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return realFile === realRoot || realFile.startsWith(withSep);
  });
  if (!contained) {
    return { ok: false, reason:
      `"${rawPath}" is outside the folders I am allowed to upload from. I can only send files from: ` +
      roots.join('; ') + '.' };
  }
  return { ok: true, resolved: realFile };
}

async function browser_upload_file({ ref, selector, path: filePath }) {
  const sandboxed = resolveUploadPath(filePath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const t = await resolveTarget(page, { ref, selector }, 'upload a file');
    if (t.failure) return t.failure;
    await t.locator.setInputFiles(sandboxed.resolved);
    return await withStateCapsule(page,
      { uploaded: path.basename(sandboxed.resolved), from: sandboxed.resolved, into: t.target, via: 'set-input-files' },
      t.ref);
  }).catch(err => fail(t_err(ref, selector, 'upload to', err)));
}

// Shared failure phrasing for the ref-or-selector tools: a ref failure gets the
// agent-shaped remedy, a selector failure stays a plain named error.
function t_err(ref, selector, verb, err) {
  if (ref) return refFailure(ref, verb, err);
  return `Could not ${verb} ${selector}: ${(err && err.message) || err}`;
}

async function browser_select_option({ ref, selector, value, label }) {
  if (value === undefined && label === undefined) {
    return fail('Either value or label is required to choose an option.');
  }
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const t = await resolveTarget(page, { ref, selector }, 'select an option');
    if (t.failure) return t.failure;
    // Native <select> only. A custom dropdown is not a select element and must
    // NOT be forced through here — it is a ref click to open it and a second ref
    // click to choose, which the snapshot already exposes. Saying so in the
    // failure is what stops the model retrying this tool forever.
    const chosen = label !== undefined ? { label: String(label) } : { value: String(value) };
    const applied = await t.locator.selectOption(chosen);
    return await withStateCapsule(page,
      { selected: applied, on: t.target, via: 'select-option' }, t.ref);
  }).catch(err => fail(
    t_err(ref, selector, 'select an option on', err) +
    ' If this is a custom dropdown rather than a real <select>, click it open with browser_click and ' +
    'then click the option from a fresh snapshot.'
  ));
}

// Keys the model may press. An allowlist rather than free text: "press whatever
// string the model produced" is how a stray sequence ends up typed into a form,
// and every key a form flow actually needs is here.
const ALLOWED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  // BUG-174: the 2026-08-07 session asked to refresh a page and had no way to.
  // F5 is a non-character virtual key like Enter or Escape, so it needs no
  // text-field guard — but see RELOAD_KEYS: it is NOT delivered as a keystroke.
  'F5',
];

// BUG-174: a synthetic F5 keypress does nothing. Reload is handled by the
// browser chrome, not by the page's DOM, so page.keyboard.press('F5') sends a
// key event no one acts on — and would have reported a successful press with
// the page unchanged, which is precisely the "success it didn't earn" shape
// this repo keeps getting burned by. These names route to page.reload()
// instead, and the evidence is the URL that actually came back.
const RELOAD_KEYS = ['F5', 'Refresh', 'Reload'];

// 2026-08-06: the model wanted to pause a YouTube video with `k` — the player
// shortcut every video site shares — and had to fall back to hunting down the
// .ytp-play-button ref instead. These are the standard HTML5-player keys:
// k play/pause, m mute, f fullscreen, c captions, j/l seek back/forward 10s.
//
// They are single CHARACTERS, which is the one thing that made them unsafe to
// allow: pressed while a text field has focus they type rather than control,
// and "press whatever the model produced" typing into a form is exactly what
// ALLOWED_KEYS exists to prevent. So they are allowed with a focus guard —
// refused, with the reason, whenever the focused element would swallow them
// as input. The navigation keys keep their existing unguarded behaviour;
// Escape in a text field is normal and useful.
const PLAYER_KEYS = ['k', 'm', 'f', 'j', 'l', 'c'];

// document.activeElement at press time — the only thing that decides where a
// character key actually lands.
const FOCUSED_IS_TEXT_ENTRY_JS = `() => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  // Non-text inputs (button, checkbox, radio, submit, file, range...) do not
  // capture characters, so a player key is safe there.
  return ['text', 'search', 'url', 'email', 'password', 'tel', 'number', 'date',
          'datetime-local', 'month', 'week', 'time'].includes(type);
}`;

const TEXT_FIELD_REFUSAL =
  'the focused element is a text field — a single-character key would be TYPED into it, not sent to the ' +
  'player. Click the video (or its play button) first to move focus, then press the key.';

async function browser_press_key({ key, ref, selector }) {
  const allKeys = ALLOWED_KEYS.concat(PLAYER_KEYS, RELOAD_KEYS.slice(1));
  if (!key) return fail('A key is required, one of: ' + allKeys.join(', ') + '.');
  const raw = String(key).trim();
  const match = allKeys.find((k) => k.toLowerCase() === raw.toLowerCase());
  if (!match) {
    return fail(`"${key}" is not a key I will press. Allowed: ${allKeys.join(', ')}. ` +
      'To enter text use browser_type.');
  }
  const isPlayerKey = PLAYER_KEYS.includes(match);
  const isReload = RELOAD_KEYS.some((k) => k.toLowerCase() === match.toLowerCase());
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // BUG-174: reload before anything else — ref/selector and the focus guard
    // are both meaningless for an action the page never sees.
    if (isReload) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return await withStateCapsule(page, {
        reloaded: true, via: 'page.reload',
        evidence: 'reloaded ' + page.url(),
      }, null);
    }
    if (isPlayerKey) {
      // Checked for the ref/selector path too: pressing on a located element
      // still delivers the character to whatever has focus if that element is
      // itself the text field.
      let focusedIsTextEntry = false;
      try {
        focusedIsTextEntry = await page.evaluate(FOCUSED_IS_TEXT_ENTRY_JS);
      } catch {
        // A page that cannot be evaluated (navigating, cross-origin edge) tells
        // us nothing about focus. Refuse rather than guess — a typed stray
        // character into an unknown field is the failure this guard exists for.
        return fail(`I could not check what has focus, so I did not press "${match}": ` + TEXT_FIELD_REFUSAL);
      }
      if (focusedIsTextEntry) {
        return fail(`I did not press "${match}" — ` + TEXT_FIELD_REFUSAL);
      }
    }
    // With a ref/selector the key goes to THAT element; without one it goes to
    // whatever currently has focus, which is the normal "I just typed, now
    // press Enter" case.
    if (ref || selector) {
      const t = await resolveTarget(page, { ref, selector }, 'press a key');
      if (t.failure) return t.failure;
      await t.locator.press(match);
      return await withStateCapsule(page, { pressed: match, on: t.target, via: 'ref-press' }, t.ref);
    }
    await page.keyboard.press(match);
    return await withStateCapsule(page, { pressed: match, on: 'focused element', via: 'keyboard-press' }, null);
  }).catch(err => fail(t_err(ref, selector, 'press a key on', err)));
}

async function browser_hover({ ref, selector }) {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const t = await resolveTarget(page, { ref, selector }, 'hover');
    if (t.failure) return t.failure;
    await t.locator.hover();
    // Hovering usually exists to REVEAL something, so the useful next step is
    // another snapshot. Say so rather than leaving the model to guess.
    const result = await withStateCapsule(page, { hovered: t.target, via: 'ref-hover' }, t.ref);
    result.result.hint = 'If this was meant to open a menu, call browser_snapshot again to see what appeared.';
    return result;
  }).catch(err => fail(t_err(ref, selector, 'hover over', err)));
}

// ---------------------------------------------------------------------------
// Phase 6 — obstacles. Cookie walls, newsletter modals and "Skip Ad" buttons
// are not a special class of thing: they appear in the accessibility snapshot
// exactly like every other control, so the PRIMARY mechanism is the model
// seeing one and clicking its ref. That keeps every dismissal in the audit
// trail, which a hidden auto-clicker firing on page load would not.
//
// This helper exists only for the boring 90%, and it is deliberately narrow:
// it clicks visible controls whose accessible NAME matches a bounded, curated
// list, and only inside a dialog/banner/alert container. "Click anything that
// looks like a close button, anywhere on the page" would eventually dismiss
// something the operator wanted.
// ---------------------------------------------------------------------------

// Matched case-insensitively against an element's accessible name, whole-string
// or as a leading phrase. One named constant, not a growing pile of regexes.
const DISMISSAL_NAMES = [
  // Consent walls
  'accept all', 'accept all cookies', 'accept cookies', 'i accept', 'agree',
  'i agree', 'allow all', 'got it', 'ok', 'understood', 'continue',
  // Newsletter / app-install modals
  'no thanks', 'not now', 'maybe later', 'dismiss', 'close', 'no, thanks',
  // Video pre-roll
  'skip ad', 'skip ads', 'skip', 'skip advertisement',
];

// Containers a dismissal may live in. Anything outside one of these is page
// content, and page content is the model's business, not this sweep's.
const DISMISSAL_CONTAINERS = ['dialog', 'alertdialog', 'banner', 'complementary'];

// Recognising a challenge is not the same as solving one, and MYTHOS does not
// solve them: a CAPTCHA is where automation stops and the operator takes over.
// That is a deliberate boundary — working around anti-bot checks is what gets
// an operator's real, logged-in accounts banned, and this browser IS their real
// logged-in browser.
// The marker list and its matcher live in util/captcha-markers.js (BUG-385):
// pure policy, exercisable without loading a browser effector. Re-exported
// below so existing callers and tests are unaffected by the move.
const { CAPTCHA_MARKERS, looksLikeCaptcha } = require('../util/captcha-markers.js');

async function browser_dismiss_overlays() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    if (typeof page.evaluate !== 'function') {
      return fail('This page cannot be inspected for overlays. Take a browser_snapshot and click the dismissal yourself.');
    }
    // One page.evaluate rather than a locator sweep: the whole point is a cheap
    // deterministic pass, and the DOM query is the cheap part. Every element it
    // clicks is returned, so the result says exactly what was dismissed —
    // "cleared the banner" with no list would be the un-auditable version.
    const clicked = await page.evaluate((cfg) => {
      const { names, containers } = cfg;
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
      };
      const accessibleName = (el) => (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el.textContent || '')
      ).trim().toLowerCase().replace(/\s+/g, ' ');
      const inContainer = (el) => {
        let node = el;
        while (node && node !== document.body) {
          const role = node.getAttribute && node.getAttribute('role');
          if (role && containers.includes(role)) return role;
          // A fixed/sticky full-width block is the un-roled version of the same
          // thing — the consent bar that never bothered with role="dialog".
          if (node.nodeType === 1) {
            const s = window.getComputedStyle(node);
            if ((s.position === 'fixed' || s.position === 'sticky') &&
                node.getBoundingClientRect().width > window.innerWidth * 0.6) {
              return 'fixed-overlay';
            }
          }
          node = node.parentElement;
        }
        return null;
      };
      const out = [];
      const candidates = document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]');
      for (const el of candidates) {
        if (out.length >= 5) break; // a page needing six dismissals needs a human
        const name = accessibleName(el);
        if (!name || name.length > 40) continue;
        if (!names.some((n) => name === n || name.startsWith(n + ' '))) continue;
        if (!isVisible(el)) continue;
        const container = inContainer(el);
        if (!container) continue;
        el.click();
        out.push({ name: name, container: container });
      }
      return out;
    }, { names: DISMISSAL_NAMES, containers: DISMISSAL_CONTAINERS });

    // Refs from before this sweep describe a page that just had things removed
    // from it. Force a fresh look rather than letting a stale ref resolve.
    if (clicked.length) invalidateSnapshotRefs('overlays-dismissed');

    const payload = {
      dismissed: clicked,
      count: clicked.length,
      url: page.url(),
    };
    if (!clicked.length) {
      // Not a failure — "there was nothing to dismiss" is a real, useful answer,
      // and reporting it as ok:false would make the model treat a clean page as
      // a broken tool. But it is not evidence of anything either.
      return evidenceModule.unverified({ result: payload },
        'I found no cookie banner, modal or skip button matching the ones I know how to dismiss. ' +
        'If something is still in the way, take a browser_snapshot and click it directly.');
    }
    return evidenceModule.verifiedOk({ result: payload }, {
      oracle: 'page-state',
      observed: 'dismissed ' + clicked.map((c) => `"${c.name}" (in ${c.container})`).join(', '),
    });
  }).catch(err => fail(err.message));
}

async function browser_check_captcha() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    if (typeof page.ariaSnapshot !== 'function') {
      return fail('This browser build cannot inspect the page for a challenge (page.ariaSnapshot unavailable).');
    }
    const tree = String(await page.ariaSnapshot({ mode: 'ai' }) || '');
    const markers = looksLikeCaptcha(tree + ' ' + page.url());
    if (!markers.length) {
      return ok({ captcha: false, url: page.url() });
    }
    // blocked, not failed: nothing went wrong, we have simply reached the line
    // this system does not cross. The message is written to be spoken.
    return ok({
      captcha: true,
      blocked: 'captcha',
      markers: markers,
      url: page.url(),
      message:
        'This page is showing a human-verification challenge (' + markers.join(', ') + '). ' +
        'I will not try to work around it — that is what gets real accounts banned, and this is ' +
        'your own logged-in browser. Solve it yourself in the window and tell me when to carry on.',
    });
  }).catch(err => fail(err.message));
}

// ---- Tool catalog ----

const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate the browser to a URL. Set newTab:true to open it in a new tab instead of reusing the current one. If the user named a specific browser (Chrome, Brave, Edge), pass it as `browser` — the call then FAILS rather than driving a different one, and the response says which browser was actually used.', params: { url: 'string - the URL to navigate to', newTab: 'boolean (optional) - open in a new tab instead of the current one', browser: 'string (optional) - chrome, brave or edge; only when the user asked for a specific browser' }, danger: false, fn: browser_navigate, needs_result: true },
  { name: 'browser_snapshot', description: 'Read the page as an accessibility tree in which every interactable element carries a stable ref like [ref=e12]. THIS IS THE FIRST STEP for any browser interaction: take a snapshot, find the element you want in the tree, then pass its ref to browser_click / browser_type / browser_fill_form instead of guessing a CSS selector. Elements inside iframes (most job-application forms) are included automatically. Refs expire when the page changes — if one is rejected as stale, snapshot again.', params: { screenshot: 'boolean (optional) - also return a base64 PNG of the page alongside the tree' }, danger: false, fn: browser_snapshot, needs_result: true },
  { name: 'browser_click', description: 'Click an element on the page. Prefer ref (from browser_snapshot) — it targets the exact element with no guessing. Use selector only when no snapshot ref is available.', params: { ref: 'string (optional) - element ref from browser_snapshot, e.g. e12', selector: 'string (optional) - CSS selector, the fallback when no ref is available' }, danger: false, fn: browser_click },
  { name: 'browser_type', description: 'Type text into an input field. Prefer ref (from browser_snapshot) over a CSS selector. Set clearFirst to true to replace the existing content.', params: { ref: 'string (optional) - element ref from browser_snapshot, e.g. e12', selector: 'string (optional) - CSS selector, the fallback when no ref is available', text: 'string - text to type', clearFirst: 'boolean (optional) - clear field before typing' }, danger: false, fn: browser_type },
  { name: 'browser_screenshot', description: 'Take a screenshot of the current page. Returns base64 PNG.', params: {}, danger: false, fn: browser_screenshot, needs_result: true },
  { name: 'browser_get_title', description: 'Get the title and URL of the current page.', params: {}, danger: false, fn: browser_get_title, needs_result: true },
  { name: 'browser_get_text', description: 'Get the text content of the page or a specific element (CSS selector). Truncated at 4000 chars.', params: { selector: 'string (optional) - CSS selector, defaults to body' }, danger: false, fn: browser_get_text, needs_result: true },
  { name: 'browser_scroll', description: 'Scroll the page up or down by 600 pixels.', params: { direction: 'string - "up" or "down" (default: down)' }, danger: false, fn: browser_scroll },
  { name: 'browser_tabs', description: 'Manage browser tabs. Actions: list (default), new, switch (needs index), close (needs index). switch/close accept either index (indexes shift after any tab closes — re-list first if unsure) or match (substring of the target tab\'s title or URL; safer than a cached index). Every switch/close response includes a fresh tabs list.', params: { action: 'string (optional) - list, new, switch, close', index: 'number (optional) - tab index for switch/close', match: 'string (optional) - substring of the target tab\'s title or URL, an alternative to index for switch/close' }, danger: false, fn: browser_tabs, needs_result: true },
  { name: 'browser_go_back', description: 'Navigate back to the previous page in history.', params: {}, danger: false, fn: browser_go_back },
  { name: 'browser_wait_for', description: 'Wait for an element matching a CSS selector to appear on the page. Fails honestly if it does not appear within the timeout. Use before reading or interacting with a dynamically-loaded element.', params: { selector: 'string - CSS selector to wait for', timeoutMs: 'number (optional) - max wait in ms, default 10000, capped at 30000' }, danger: false, fn: browser_wait_for, needs_result: true },
  { name: 'browser_fill_form', description: 'Fill multiple form fields in one call. Pass fields:[{ref, value}] using refs from browser_snapshot (preferred), or [{selector, value}]. The two may be mixed. Each field is filled (replacing existing content); a bad ref or selector reports that field failure without aborting the rest.', params: { fields: 'array - [{ref: string, value: string}] or [{selector: string, value: string}]' }, danger: true, fn: browser_fill_form },
  { name: 'browser_dismiss_overlays', description: 'Clear the usual things that block a page: cookie-consent banners, newsletter or app-install modals, and "Skip Ad" buttons. Only clicks visible controls whose label matches a known dismissal phrase, and only inside a dialog, banner or fixed overlay — it reports exactly what it clicked. If something is still in the way afterwards, take a browser_snapshot and click it by ref.', params: {}, danger: false, fn: browser_dismiss_overlays, needs_result: true },
  { name: 'browser_check_captcha', description: 'Check whether the page is showing a human-verification challenge (reCAPTCHA, hCaptcha, Turnstile, "verify you are human"). MYTHOS never solves or bypasses these — when one is present, tell the operator and ask them to complete it in the browser window.', params: {}, danger: false, fn: browser_check_captcha, needs_result: true },
  { name: 'browser_upload_file', description: 'Attach a file from disk to a file-upload control on the page — the resume step of a job application. Target the upload control by ref from browser_snapshot (preferred) or CSS selector. Only files inside the operator-configured upload folder can be sent; anything else is refused.', params: { ref: 'string (optional) - ref of the file input from browser_snapshot', selector: 'string (optional) - CSS selector of the file input', path: 'string - path of the file to attach, inside the configured upload folder' }, danger: true, fn: browser_upload_file },
  { name: 'browser_select_option', description: 'Choose an option in a native dropdown (<select>) by value or visible label. For a custom (non-native) dropdown, click it open with browser_click and click the option from a fresh snapshot instead.', params: { ref: 'string (optional) - ref of the select element from browser_snapshot', selector: 'string (optional) - CSS selector of the select element', value: 'string (optional) - the option value attribute', label: 'string (optional) - the option text as shown to the user' }, danger: true, fn: browser_select_option },
  { name: 'browser_press_key', description: 'Press a single navigation, submit, refresh, or video-player key. Navigation/submit: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown. Refresh: F5 (or "Refresh"/"Reload") reloads the page - this performs a real page reload, not a keystroke, because browsers handle F5 outside the page. Video player (YouTube and most HTML5 players): k play/pause, m mute, f fullscreen, c captions, j back 10s, l forward 10s — these are refused if a text field has focus, so click the video first. Goes to the focused element by default, or to a specific element via ref/selector. Use browser_type to enter text.', params: { key: 'string - one of Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F5, Refresh, Reload, k, m, f, j, l, c', ref: 'string (optional) - ref of the element to press the key on', selector: 'string (optional) - CSS selector of that element' }, danger: true, fn: browser_press_key },
  { name: 'browser_hover', description: 'Hover the pointer over an element to reveal a hover menu or tooltip. Take a fresh browser_snapshot afterwards to see what appeared.', params: { ref: 'string (optional) - element ref from browser_snapshot', selector: 'string (optional) - CSS selector' }, danger: false, fn: browser_hover },
  { name: 'browser_evaluate', description: 'Run a JavaScript expression in the browser and return the result as a string.', params: { script: 'string - JavaScript expression to evaluate' }, danger: true, fn: browser_evaluate },
  { name: 'browser_launch_debug', description: 'Launch the debug-mode browser so browser control comes online. Use when the user asks to open/start the browser or a browser action fails with OFFLINE. Pass browser:"brave" (or chrome/edge) when the user named one — the debug port holds exactly one browser at a time.', params: { browser: 'string (optional) - chrome (default), brave or edge' }, danger: false, fn: browser_launch_debug },
  { name: 'browser_switch', description: 'Switch the debug browser to a different one (chrome, brave, or edge) when browser control is already attached to a different browser than the one requested. Disconnects the current MYTHOS-launched browser, launches the requested one, and re-attaches — the remedy for a "browser control is attached to X, not Y" refusal.', params: { browser: 'string - chrome, brave or edge to switch to' }, danger: false, fn: browser_switch },
];
const { gotoWithRedirectRetry: _gotoWithRedirectRetry } = require('./browser-goto-retry.js');
function registerFromBrowser(hub, ctx) {
  config = (ctx && ctx.config) || null;
  vaultFs = (ctx && ctx.fs) || null;
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromBrowser,
  _buildLaunchResult: buildLaunchResult, // tests (BUG-345 caveat)
  TOOLS,
  browser_navigate, browser_click, browser_type, browser_screenshot, browser_get_title,
  browser_get_text, browser_scroll, browser_tabs, browser_go_back, browser_evaluate,
  browser_launch_debug, browser_switch,
  browser_wait_for, browser_fill_form,
  // Snapshot-and-refs seams. capSnapshot/extractRefs are pure, so the size cap
  // and ref parsing are testable without a page at all.
  browser_snapshot, capSnapshot, extractRefs,
  SNAPSHOT_MAX_NODES, SNAPSHOT_MAX_CHARS,
  __resetSnapshotStateForTest, __setSnapshotStateForTest,
  // Phase 5 toolkit. resolveUploadPath is exported as its own seam: the upload
  // allowlist is the one security boundary in this file, and it must be
  // testable without a browser or a real page anywhere near it.
  browser_upload_file, browser_select_option, browser_press_key, browser_hover,
  resolveUploadPath, uploadRoots, ALLOWED_KEYS,
  // Phase 6. looksLikeCaptcha is pure, so the one boundary MYTHOS must never
  // cross is testable without a page.
  browser_dismiss_overlays, browser_check_captcha,
  looksLikeCaptcha, DISMISSAL_NAMES, DISMISSAL_CONTAINERS, CAPTCHA_MARKERS,
  // BUG-099 seams: pure helpers so the browser-target guarantee is testable
  // without requireOnline() launching a real browser on the test machine.
  findBrowserExecutable, browserCandidatePaths, normalizeBrowserName, checkBrowserTarget,
  __setAttachedBrowserForTest,
  // BUG-115 seams: pure helpers so the extension-loading guarantee is testable
  // without browser_launch_debug spawning a real browser on the test machine.
  parseBrowserExtensionsEnv, resolveBrowserExtensions, buildBrowserLaunchArgs, buildLaunchResult,
  // BUG-140 seam: the cold-start poll-until-ready loop, pure and testable without
  // spawning a real browser or waiting out the real ceiling.
  waitForDebugPortReady, COLD_START_POLL_INTERVAL_MS, COLD_START_CEILING_MS,
};
