'use strict';

// effectors/from-dashboard.js — CA of app/lib/voice/tools-dashboard.js (20 tools).
// Function bodies verbatim; re-pointed per the spec's mapping table:
//   - create_goal/list_goals/toggle_goal/delete_goal -> ctx.goalsEffector (effectors/goals.js)
//   - capture_idea/pipeline_* -> ctx.pipeline (effectors/pipeline.js)
//   - kanban_* -> ctx.kanban (effectors/kanban.js)
//   - pipeline_execute/kanban_assemble/kanban_build_card -> ctx.agentActions (effectors/agent-actions.js)
//   - read_status/job_status -> ctx.buildRunner.getJob/listJobs instead of orchestrator
//   - ask_agent's setAskAgentDispatch wiring is unchanged (still injected by whatever owns
//     Brain dispatch, now brain.think not reasoning.chat)
//
// SPEC/REALITY GAP (documented beyond the 13 enumerated ambiguities, same resolution
// style): read_status's provider-status half re-points to mythos's own immune/probes.js
// (ctx.probes.getStatus()) instead of NOVA's app/lib/probes.js (a different, NOVA-only
// module) since immune/probes.js is MYTHOS's real equivalent status aggregator.
//
// DEVIATION (same convention as from-project.js): this file receives its collaborators
// via `ctx` (constructed once in main.js's 'effectors' boot step) rather than bare NOVA
// singleton requires, matching every other P7 module's DI convention.

const { effectorFromTool } = require('./adapter');
const { reasonText } = require('../util/reason-text');
const { youtubeVideoId, OPEN_WEB_CODES } = require('../util/youtube-id');
const { ALL_ROUTES, SYNONYMS } = require('./routes');
const { web_search } = require('./web-search');
const { vaultRelativePath, vaultUrl, vaultAgeHours } = require('./vault-url');
const { visionThink } = require('./vision-call');
const evidence = require('./evidence');
// BUG-407: open_web(browser:true)'s hand-off, including the named-browser route.
const externalRoute = require('./open-external-route');
// BUG-113: surface open spoken commitments in read_status so "where are we
// on X" is answerable from state instead of memory.
const { listOpenCommitments } = require('./from-calendar');
// C1: job_status is the pull-side counterpart of the announcer's push-side
// fix — same defect (a review-failed or fallback-engine build reading as
// "done"), arriving by voice query instead of by proactive speech.
const { completionForJob } = require('./completion-status');

// The ONE fetcher. See web_fetch below for why this file no longer has its own.
const { web_fetch: sharedWebFetch } = require('./web-fetch');

function ok(result, uiActions) {
  return uiActions ? { ok: true, result, uiActions } : { ok: true, result };
}
// BUG-381: optional TYPED code beside the prose (which is unchanged, and is what
// the voice layer speaks). Codes and the measurement behind them: util/youtube-id.js.
function fail(reason, code) { return code ? { ok: false, result: reason, code: code } : { ok: false, result: reason }; }

// ---- browser-intent disambiguation (2026-08-14 session, cluster A1) ----
//
// Four tools in the Live allowlist can plausibly mean "open a website":
// open_web, navigate, browser_navigate and browser_launch_debug. Until now the
// ONLY thing separating them was prose in their descriptions, and the
// 2026-08-14 audit measured what that is worth: five identical failures in four
// minutes, every one `open_web({type:'web', query:'openai.com'})` answered with
// a bare "A URL is required for web embedding." — while open_web's description
// already said, in capitals, that it does NOT open a browser. One turn was
// worse: `navigate` (a HUD ROUTER) accepted the browsing intent, returned ok,
// and MYTHOS announced "I've launched the browser and am navigating to the
// OpenAI homepage" for a route change the operator could not see.
//
// The fix is the pattern checkBrowserTarget already proves works
// (from-browser.js, BUG-099/107): refuse, and name the remedy verbatim in the
// failure itself. A remedy arrives at the moment of the mistake, addressed to
// the call that failed — a description is read once per session and then
// competes with everything else in the catalogue.
//
// Deliberately NOT coerced into a url. Satisfying the wrong surface would hand
// the operator a HUD card while telling them Chrome had opened, which is the
// fabricated-success failure this whole session was about. The failure IS the
// information: the model picked the wrong surface.
//
// Narrow on purpose — see the tests. open_web's youtube/weather/search/flights/
// image types legitimately take a bare query, and navigate's real routes
// ('dashboard', 'kanban') must keep working; this only fires on an argument that
// is shaped like a URL or a bare domain and can therefore only have meant "go
// to this site".
// A bare domain: at least one dot, a 2+ char alphabetic TLD at the end, no
// spaces. 'openai.com' and 'news.ycombinator.com/best' match; 'kanban',
// 'weather in Delhi' and 'Tera Mera Rishta' do not.
//
// BUG-407: these two live in ./open-external-route.js and are IMPORTED here
// rather than defined twice. The browser:true branch moved into that module and
// its first draft carried its own copy of this rule — which is the shape this
// codebase keeps getting bitten by (two derivations of one fact, agreeing until
// they don't). One definition, two consumers, and the tests that pin the shape
// keep pinning it through this re-export.
const { URL_SHAPED, looksLikeUrlOrDomain } = externalRoute;

// The remedy text, shared so the two call sites cannot drift into saying
// different things about the same mistake. Always names browser_navigate AND
// the exact url: value to pass, so the next call needs no invention.
function browserIntentRemedy(what, value) {
  const s = String(value || '').trim();
  const url = URL_SHAPED.test(s) ? (/^www\./i.test(s) ? 'https://' + s : s) : 'https://' + s;
  return `"${s}" is a website, and ${what}. Call browser_navigate with url:"${url}" to open it in the operator's real browser. `
    + `If the operator asked for an at-a-glance card ON THE HUD instead, call open_web with url:"${url}" (not query).`;
}

// BUG-273 D2 — the sibling of browserIntentRemedy, for the branch the 2026-08-14
// fix did not reach.
//
// THE INCIDENT: *"News widget displayed but main HUD shows incorrect error
// message ('agent actions failed')"*, 2026-08-18. The HUD was right; it was
// reporting a different call four seconds later. From the audit, with real args:
//   11:44:01  open_web {query:"Kolkata to Bangalore", type:"search"}        -> ok
//   11:44:06  open_web {query:"distance Kolkata to Bangalore", type:"web"}  -> FAIL
//                       "A URL is required for web embedding."
//
// That bare string is the exact one the A1 comment above condemns and says was
// repeated five times in four minutes for want of a remedy. A1 guarded the branch
// where the query LOOKS like a domain; looksLikeUrlOrDomain() rejects anything
// containing whitespace, so a prose query fell through to the unguarded sibling and
// got the old string back.
//
// Q6 — SAME CLASS AS BUG-273 B1, four days apart: one remedy written, applied to
// one of the branches that needed it, the sibling left carrying the bare version.
// B1 was three narration paths with three different hedges; this is two refusal
// branches with two different remedies. Fixed the same way — a shared helper per
// case, and a test that enumerates the branches rather than the instance.
//
// Q7 — the remedy has to match what the model MEANT. It asked for "distance
// Kolkata to Bangalore": that is not a missing url, it is the wrong type. Demanding
// a url would send it back for something it does not have and never had. So prose
// gets pointed at type:"search" and a domain still gets pointed at
// browser_navigate — deliberately two different answers, pinned apart by
// test/bug-273-d2-prose-query-remedy.test.js.
function webTypeNeedsUrlRemedy(query) {
  const s = String(query || '').trim();
  if (!s) {
    return 'type:"web" embeds ONE direct https URL and needs url:. Nothing was passed to embed. '
      + 'If the operator wanted results for a topic rather than one specific page, call open_web '
      + 'with type:"search" and the topic in query: instead.';
  }
  return `type:"web" embeds ONE direct https URL and needs url:, and "${s}" is a search phrase, not a URL — `
    + `it is not guessed at. If the operator wanted results for that phrase, call open_web with `
    + `type:"search" and query:"${s}". If they wanted one specific page, pass its full https URL as url:.`;
}

// E5: bytes -> GB rounded to 2dp, for read_system_specs' human-readable fields.
function bytesToGB(bytes) {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}

// Finds the best case-insensitive substring match for `query` against a list of items,
// using `getText(item)` to extract the comparable text. Returns { item, index } or null.
function findByQuery(items, query, getText) {
  if (!query || !query.trim()) return null;
  const q = query.trim().toLowerCase();
  for (let i = 0; i < items.length; i += 1) {
    if (getText(items[i]).toLowerCase().includes(q)) return { item: items[i], index: i };
  }
  return null;
}

function buildTools(ctx) {
  const goalsEffector = ctx.goalsEffector;
  const pipeline = ctx.pipeline;
  const kanban = ctx.kanban;
  const agentActions = ctx.agentActions;
  const buildRunner = ctx.buildRunner;
  const probes = ctx.probes;
  const config = ctx.config;
  const fs = ctx.fs;
  // Optional: absent in tests, and vision-call.js degrades to no instrumentation
  // rather than throwing. It is the only logger this module uses.
  const logger = ctx.logger;
  // Wave 5 (2026-08-13) test seam — forwarded to visionThink's own chainFor
  // option. Only meaningful when ctx.brain IS the real production brain
  // facade (which queries the same registry internally); a fake brain in a
  // test has no relationship to that registry, so tests inject a stub here
  // rather than exercising the real one. Undefined in production — visionThink
  // defaults to the real registry.chainFor.
  const visionChainFor = ctx.visionChainFor;
  const goals = ctx.goals; // BUG-113: raw GoalSystem, optional — commitment ledger read in read_status
  // A4: identity module, optional — read_status surfaces its current persona
  // levels (same accessor persona_status uses, effectors/from-persona.js) so
  // "what's my humor level set at" is answerable without a separate tool.
  const identity = ctx.identity;
  // E5: injected like every other collaborator above (DI convention) so
  // read_system_specs' os.cpus()/loadavg() reads are deterministic in tests
  // instead of depending on the real host. ctx.os is absent in production —
  // falls back to the real module.
  const os = ctx.os || require('os');

  // ---- navigate ----

  function navigate({ route }) {
    try {
      const raw = String(route || '').trim().toLowerCase();
      // A1: this is a HUD ROUTER. At 17:33:32 on 2026-08-14 it took a URL, moved
      // the dashboard view, returned ok, and MYTHOS reported having launched a
      // browser. Refuse the browsing intent by name instead of resolving it into
      // an unrelated success — see looksLikeUrlOrDomain's comment.
      if (looksLikeUrlOrDomain(raw) && !ALL_ROUTES.includes(raw) && !SYNONYMS[raw]) {
        return fail(browserIntentRemedy('navigate only changes which MYTHOS dashboard view is showing — it cannot open a browser or load a page', route));
      }
      const resolved = ALL_ROUTES.includes(raw) ? raw : (SYNONYMS[raw] || null);
      if (!resolved || !ALL_ROUTES.includes(resolved)) {
        return fail(`"${route}" is not a known dashboard view.`);
      }
      return ok({ route: resolved }, [{ action: 'navigate', route: resolved }]);
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- close_panel ----
  // REMEDIATION P1-5: previously returned ok({closed:true}) unconditionally —
  // it never inspected what was actually open, and could not reach floating
  // widgets (search/weather/flights/image cards spawned by open_web) at all,
  // only overlay panels. Now it asks the connected dashboard(s) to close both
  // surfaces and awaits a real count back (closePanelProvider, injected via
  // setClosePanelProvider — same server-initiated request/ack shape as
  // camera_look's cameraFrameProvider), so `closed` reflects what the
  // dashboard actually reports rather than a guess.
  let closePanelProvider = null;
  function setClosePanelProvider(fn) {
    closePanelProvider = fn;
  }

  // Stage 5 (BUG-075) — the fix for "a German video played that could not be
  // stopped with standard playback controls". close_panel already means
  // "close whatever MYTHOS opened as UI"; this extends that same vocabulary
  // to the Electron media window (electron/main.js) instead of adding a
  // separate close_media_window tool. Injected via setMediaWindowCloser
  // (server/index.js's requestCloseMediaWindow — same request/ack shape as
  // closePanelProvider, just over the fork IPC channel instead of WS).
  let mediaWindowCloser = null;
  function setMediaWindowCloser(fn) {
    mediaWindowCloser = fn;
  }

  // BUG-272 T2 — open_web(browser:true)'s route to the operator's REAL browser
  // (server/index.js's requestOpenExternal → electron/main.js →
  // shell.openExternal). Same injected-setter shape as mediaWindowCloser above.
  //
  // Deliberately left null outside the Electron shell rather than defaulted to
  // something: "unset" is what lets open_web say "the desktop shell is not
  // running, so there is no browser to hand this to" instead of reporting a
  // success that nothing performed. A no-op default would rebuild the bug.
  let externalOpener = null;
  function setExternalOpener(fn) {
    externalOpener = fn;
  }

  // BUG-273 B3 — the dashboard render ack. Same injected-setter shape as the three
  // providers above, and left null for the same reason: outside a running HUD there
  // is nothing to ask, and "unset" must mean "I cannot confirm" rather than a
  // fabricated yes.
  let widgetRenderer = null;
  function setWidgetRenderer(fn) {
    widgetRenderer = fn;
  }

  async function close_panel({ all }) {
    try {
      if (!closePanelProvider) {
        return fail('No dashboard is connected to close panels on.');
      }
      const ack = await closePanelProvider(Boolean(all));
      if (!ack) {
        return fail('No dashboard client acknowledged the close request (it may be disconnected).');
      }
      const overlaysClosed = ack.overlaysClosed || 0;
      const widgetsClosed = ack.widgetsClosed || 0;
      // Best-effort: unset (not running under Electron) or nothing open both
      // report false, never an error — the panel/widget close above already
      // succeeded independently of whether a media window exists.
      let mediaWindowClosed = false;
      if (mediaWindowCloser) {
        try { mediaWindowClosed = Boolean(await mediaWindowCloser()); } catch (_) { mediaWindowClosed = false; }
      }
      return ok({
        closed: (overlaysClosed + widgetsClosed) > 0 || mediaWindowClosed,
        overlaysClosed, widgetsClosed, mediaWindowClosed, all: Boolean(all)
      });
    } catch (err) {
      return fail(err.message);
    }
  }

  // Wave 7 (2026-08-13): every open_web branch used to return a bare ok() —
  // resolving a search/geocode/video-id and handing the payload to the
  // client is not proof the dashboard actually rendered anything; nothing
  // here reads back from the HUD (no ui.open-web-consumed ack exists). Same
  // evidence contract dispatch-action.js enforces everywhere else: ok:true
  // is kept (this DID resolve real content), but honestly marked unverified
  // rather than a bare, unqualified success.
  // BUG-273 B3 — the ack the comment above says does not exist now does.
  //
  // Three incidents on 2026-08-18 were this exact gap: `news`, `flights` ("Kolkata
  // to Bangalore") and a generic "Dashboard did not confirm display", all of them
  // `open_web -> ok` carrying "the dashboard has not confirmed it rendered this".
  // BUG-272 T2 only ever fixed the browser:true branch; this is the dashboard one.
  //
  // Q8 — WHY THIS IS NOT ANOTHER confirmedStep (BUG-273 B2). B2 could honestly say
  // "your browser was handed the URL" because openExternal resolving is an
  // independently established fact. Here there was NO confirmed step at all —
  // nothing downstream reported back — so a partial claim would have been invented.
  // The fix had to be a real ack, and with one the outcome stops being unverified
  // altogether: it is verified, or it is a FAILURE.
  //
  // Q5 — WHEN THE RENDERER IS UNSET, behaviour is byte-identical to before, and
  // deliberately so. No HUD (a plain `node src/main.js` boot, or the socket down)
  // means nothing can confirm, and unverified is the honest answer. A default that
  // assumed success would rebuild this bug in the one configuration nobody tests.
  async function openWebResult(result, uiActions) {
    if (!widgetRenderer) {
      return evidence.unverified(ok(result, uiActions), 'the dashboard has not confirmed it rendered this');
    }
    // Marked BEFORE the round-trip. dispatch-action.js must not relay this
    // descriptor over the bus as well, or the widget renders twice — BUG-166 (one
    // open_web, two players of the same video) from the other direction.
    if (result) result.renderDispatched = true;
    var ack = null;
    try { ack = await widgetRenderer(result); } catch (_) { ack = null; }
    // Silence is unknown, not failed. Explicit noopener uncertainty follows the same rule.
    if (!ack) {
      return evidence.unverified(ok(result, uiActions),
        'the dashboard did not answer, so I cannot confirm it rendered');
    }
    if (ack.mounted === false && ack.unverified === true && typeof ack.reason === 'string' && ack.reason.trim()) {
      return evidence.unverified(ok(result, uiActions), ack.reason);
    }
    if (!ack.mounted) {
      return fail('the dashboard did not render this: ' + String(ack.reason || 'no reason given')
        + '. Nothing is on screen, so do not tell the operator to look at it.');
    }
    return evidence.verifiedOk(ok(result, uiActions), {
      oracle: 'dashboard-render',
      expected: String((result && result.widgetType) || 'widget'),
      observed: String(ack.surface || 'mounted') + ' — ' + String((result && result.widgetType) || 'widget'),
    });
  }

  // ---- open_web ----
  // Opens web content on the dashboard: YouTube videos (embed), weather cards,
  // search result cards, flight cards, or a general web page. The tool resolves
  // the content (search for YouTube video ID, geocode weather location, etc.)
  // and returns a payload the frontend renders as either an overlay panel
  // (YouTube/web — needs iframe) or a floating widget (search/weather/flights —
  // custom-rendered cards). No API keys needed: Exa MCP search + YouTube embed
  // URLs + Open-Meteo are all free.
  async function open_web({ type, query, url, title, location, browser, browserName }) {
    try {
      // Fail loud on an unrecognized/omitted type. Previously this silently
      // defaulted to 'search', turning an ambiguous "open <url>" into a quiet
      // search widget instead of surfacing the misuse. Valid types only.
      var ALLOWED_TYPES = ['youtube', 'weather', 'search', 'flights', 'image', 'web'];
      var t = String(type || '').trim().toLowerCase();
      if (!t) {
        return fail('open_web requires a type. Use one of: ' + ALLOWED_TYPES.join('|') + '. To open or control the real browser, use browser_navigate or browser_tabs instead — open_web only renders content inside the MYTHOS dashboard.', OPEN_WEB_CODES.BAD_REQUEST);
      }
      if (ALLOWED_TYPES.indexOf(t) === -1) {
        return fail('open_web type must be one of ' + ALLOWED_TYPES.join('|') + ' (got "' + t + '"). To open or control the real browser, use browser_navigate or browser_tabs instead.', OPEN_WEB_CODES.BAD_REQUEST);
      }
      var q = String(query || '').trim();

      // FIX-PLAN 3.3 (2026-08-17): the explicit in-tool route to the real
      // browser. Until now the only honest answer to "open this in my browser"
      // was the refusal's suggestion to call browser_navigate — a different
      // surface that needs a running debug browser — so the widget-vs-browser
      // ambiguity was the model's to guess (BUG-253: two 08-09 incidents of a
      // widget opening where the operator expected a browser window).
      // browser:true routes through the SAME newtab mechanism the NO_EMBED
      // domains use below, so the client's newtab branch opens the real
      // browser/electron window. Default unchanged: without the flag every
      // type keeps rendering in-dashboard exactly as before.
      // BUG-272 T2: this used to return widgetType:'newtab' + unverified, and
      // under the Electron shell that had ZERO working surfaces — the media
      // window refuses anything but youtube/web by design, and the HUD's
      // window.open fallback is denied unconditionally by setWindowOpenHandler.
      // It failed 7/7 in the 2026-08-17 session while reporting ok:true every
      // time, so the circuit breaker counted seven successes and the model
      // retried the identical dead call through turn 72. It now really hands the
      // URL over and FAILS when it cannot — no surface is a failure, not an
      // unverified success. That distinction is the whole of BUG-272 T2.
      //
      // BUG-407 moved the body into ./open-external-route.js and gave it a
      // browserName, so "open it in Chrome" reaches Chrome's real profile
      // instead of silently resolving to the OS default. Unnamed is unchanged.
      if (browser) {
        var target = externalRoute.resolveExternalTarget({ url: url, query: q, browserName: browserName });
        if (!target.ok) return fail(target.reason, OPEN_WEB_CODES.BAD_REQUEST);
        var handoff = await externalRoute.performExternalOpen(target, { externalOpener: externalOpener });
        if (!handoff.opened) {
          return fail('could not open ' + target.href + ' in your browser: ' + (handoff.reason || 'no reason given')
            + '. Use browser_navigate to drive a browser directly, or open it yourself.', OPEN_WEB_CODES.PROVIDER_ERROR);
        }
        // Handed to a browser process, which is not the same as "the operator
        // saw the page" — both routes resolve on ACCEPTANCE, not on render, so
        // the verdict stays unverified. BUG-273 B2 separated the two halves: the
        // hand-off IS confirmed and goes in confirmedStep, where the voice layer
        // may say it out loud, and `reason` narrows to the only unknown.
        return evidence.unverified(ok({
          widgetType: 'newtab', url: target.href, title: title || target.href,
          handedToBrowser: true, browser: handoff.browser || 'os-default',
          via: handoff.via, windowPidsMayBeStale: true,
        }), 'whether the page actually rendered in the browser',
        { confirmedStep: externalRoute.confirmedStepFor(handoff, target.href) });
      }

      // YOUTUBE — search for the video, extract ID, build embed URL or route to new tab per config
      if (t === 'youtube') {
        if (!q) return fail('A search query is required for YouTube.', OPEN_WEB_CODES.BAD_REQUEST);
        // maxResults 6 (was 3): most YouTube videos have embedding DISABLED by
        // the uploader, so we need several candidates to find one that will
        // actually play in the iframe.
        var ytRes = await web_search({ query: q + ' site:youtube.com', maxResults: 6, bus: ctx.bus });
        if (!ytRes.ok || !ytRes.result || !ytRes.result.results || !ytRes.result.results.length) {
          // BUG-293: both logged instances of this string were MUSIC requests
          // ("Starboy The Weeknd", "Pink Floyd Comfortably Numb Live"). Naming
          // spotify_play is the redirect; naming web_search would NOT be — this
          // branch just called it (line above), so pointing there is a loop.
          return fail('No YouTube videos found for "' + q + '" — the search chain returned no '
            + 'youtube.com results. If the operator wanted to LISTEN to music rather than watch a '
            + 'video, use spotify_play instead; open_web only resolves a video to embed on the HUD.', OPEN_WEB_CODES.NO_RESULTS);
        }
        // Collect ALL candidate video IDs (in result order), not just the first.
        var candidates = [];
        for (var i = 0; i < ytRes.result.results.length; i++) {
          var r = ytRes.result.results[i];
          var vid = youtubeVideoId(r.url);   // BUG-381: five URL shapes were unreadable
          if (vid) candidates.push({ id: vid, title: r.title || (title || q) });
        }
        if (!candidates.length) return fail('Found results but could not extract a YouTube video ID — the hits were not watch pages. Try a more specific title, or use spotify_play if the operator wanted to listen rather than watch.', OPEN_WEB_CODES.UNPLAYABLE);

        // Check YOUTUBE_MODE config: 'newtab' opens in the external browser
        // (operator's own ad blocker); 'electron' (default) and the legacy
        // 'embed' alias both play inside the HUD's web panel, where the Electron
        // session blocker (electron/main.js) handles ads. Keep in sync with the
        // schema default in mythos/src/core/config/schema.js.
        var youtubeMode = (config && config.YOUTUBE_MODE) || 'electron';
        if (youtubeMode === 'newtab') {
          return openWebResult({ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=' + candidates[0].id, title: candidates[0].title });
        }

        // Embeddability pre-check via YouTube's public oEmbed endpoint (no API
        // key): a 200 means the video allows embedding; 401/403/404 means it's
        // embed-disabled/private/removed and would show "Video unavailable" in
        // the iframe. Pick the FIRST embeddable candidate. This is the "smart
        // pick" that makes far more videos actually play in-dashboard.
        var chosen = null;
        for (var c = 0; c < candidates.length; c++) {
          try {
            var oembedUrl = 'https://www.youtube.com/oembed?url=' +
              encodeURIComponent('https://www.youtube.com/watch?v=' + candidates[c].id) + '&format=json';
            var oeRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(4000) });
            if (oeRes.ok) {
              chosen = candidates[c];
              try { var oeData = await oeRes.json(); if (oeData && oeData.title) chosen.title = oeData.title; } catch (_) {}
              break;
            }
          } catch (_) { /* network/timeout — try next candidate */ }
        }
        // If none of the candidates are embeddable, fall back to opening the
        // real YouTube page in a browser tab — it always plays there (no embed
        // restriction applies outside an iframe). This is the guaranteed
        // "alternate way".
        if (!chosen) {
          return openWebResult({ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=' + candidates[0].id, title: candidates[0].title });
        }
        // enablejsapi=1 is required for the player to postMessage onReady/
        // infoDelivery — without it, web-panel.js's success detection never
        // fires and its failTimer wrongly assumes every embed has failed.
        return openWebResult({ widgetType: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/' + chosen.id + '?autoplay=1&rel=0&modestbranding=1&enablejsapi=1', title: chosen.title, videoId: chosen.id });
      }

      // WEATHER — geocode location, return the Open-Meteo URL for client-side fetch
      if (t === 'weather') {
        var loc = String(location || query || '').trim();
        if (!loc) return fail('A location is required for weather.', OPEN_WEB_CODES.BAD_REQUEST);
        try {
          // Helper: try a single geocode attempt, return the result or null if no results found
          async function tryGeocode(searchLoc) {
            // Bounded for the same reason the YouTube oEmbed probe 30 lines above is:
            // an unbounded geocode on the Live path is permanent silence, not lateness.
            var geoRes = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(searchLoc), { signal: AbortSignal.timeout(8000) });
            if (!geoRes.ok) return { error: 'network', msg: 'Could not resolve location "' + searchLoc + '".' };
            var geoData = await geoRes.json();
            if (geoData.results && geoData.results.length) return { ok: true, hit: geoData.results[0] };
            return { error: 'noresults' };
          }

          // Try the full location string first
          var attempt1 = await tryGeocode(loc);
          if (attempt1.ok) {
            var hit = attempt1.hit;
            var weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + hit.latitude + '&longitude=' + hit.longitude +
              '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,cloud_cover,is_day';
            return openWebResult({ widgetType: 'weather', weatherUrl: weatherUrl, title: 'Weather: ' + hit.name, location: hit.name });
          }

          // If network error on first attempt, fail immediately (don't retry on network failures)
          if (attempt1.error === 'network') return fail(attempt1.msg, OPEN_WEB_CODES.PROVIDER_ERROR);

          // If zero results on first attempt, try stripping to just the city name (before first comma)
          if (attempt1.error === 'noresults' && loc.includes(',')) {
            var cityOnly = loc.split(',')[0].trim();
            var attempt2 = await tryGeocode(cityOnly);
            if (attempt2.ok) {
              var hit2 = attempt2.hit;
              var weatherUrl2 = 'https://api.open-meteo.com/v1/forecast?latitude=' + hit2.latitude + '&longitude=' + hit2.longitude +
                '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,cloud_cover,is_day';
              return openWebResult({ widgetType: 'weather', weatherUrl: weatherUrl2, title: 'Weather: ' + hit2.name, location: hit2.name });
            }
            // If second attempt also has a network error, fail with that
            if (attempt2.error === 'network') return fail(attempt2.msg, OPEN_WEB_CODES.PROVIDER_ERROR);
          }

          // Both attempts returned zero results, or there was no comma to retry on
          return fail('No PLACE matched "' + loc + '" — open_web resolves places and media, not weather. Use get_weather for conditions and forecasts; it takes the place name on its own, without the words "current weather" attached.', OPEN_WEB_CODES.NO_RESULTS);
        } catch (e) { return fail('Weather lookup failed: ' + e.message, OPEN_WEB_CODES.PROVIDER_ERROR); }
      }

      // FLIGHTS — search for flight info, return cards + Google Flights deep-link
      if (t === 'flights') {
        if (!q) return fail('A flight query is required (e.g., "New York to Tokyo").', OPEN_WEB_CODES.BAD_REQUEST);
        var flightRes = await web_search({ query: 'flights ' + q, maxResults: 5, bus: ctx.bus });
        var cards = (flightRes.ok && flightRes.result && flightRes.result.results) ? flightRes.result.results.map(function(r) {
          return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 200) };
        }) : [];
        var deepLink = 'https://www.google.com/travel/flights?q=' + encodeURIComponent('flights ' + q);
        return openWebResult({ widgetType: 'flights', cards: cards, deepLink: deepLink, title: 'Flights: ' + q, query: q });
      }

      // IMAGE — search for images, return URLs
      if (t === 'image') {
        if (!q) return fail('An image query is required.', OPEN_WEB_CODES.BAD_REQUEST);
        var imgRes = await web_search({ query: q, maxResults: 6, bus: ctx.bus });
        var imgCards = (imgRes.ok && imgRes.result && imgRes.result.results) ? imgRes.result.results.map(function(r) {
          return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 150) };
        }) : [];
        return openWebResult({ widgetType: 'image', cards: imgCards, title: title || q, query: q });
      }

      // WEB — direct URL embed (validate https scheme).
      // Sites that block framing (X-Frame-Options) get smart-routed instead:
      //   news.google.com  -> existing NEWS widget (server-side RSS)
      //   other blockers    -> open in new browser tab (no iframe attempt)
      if (t === 'web') {
        // A1: the exact call that failed five times on 2026-08-14 —
        // {type:'web', query:'openai.com'} with no url. The bare refusal it used
        // to get carried no remedy, so the model repeated it verbatim. Only the
        // 'web' type is guarded: youtube/weather/search/flights/image all take a
        // bare query legitimately and are handled above.
        if (!url && looksLikeUrlOrDomain(q)) {
          return fail(browserIntentRemedy('open_web renders a card inside the MYTHOS dashboard, and for type:"web" it needs url:, not query:', q), OPEN_WEB_CODES.BAD_REQUEST);
        }
        // BUG-273 D2: was a bare "A URL is required for web embedding." — the exact
        // string the A1 note above says a refusal must never be. See
        // webTypeNeedsUrlRemedy for why prose and a domain get different remedies.
        if (!url) return fail(webTypeNeedsUrlRemedy(q), OPEN_WEB_CODES.BAD_REQUEST);
        var parsed = null;
        try { parsed = new URL(url); } catch (_) { return fail('Invalid URL: ' + url, OPEN_WEB_CODES.BAD_REQUEST); }
        if (parsed.protocol !== 'https:') return fail('Only https: URLs can be embedded (security).', OPEN_WEB_CODES.BAD_REQUEST);
        var host = parsed.hostname.toLowerCase();
        if (host === 'news.google.com' || host === 'www.news.google.com') {
          return openWebResult({ widgetType: 'news', title: title || 'Google News' });
        }
        var NO_EMBED_DOMAINS = ['google.com','facebook.com','twitter.com','x.com', // BUG-228: youtu.be needs
          'instagram.com','github.com','linkedin.com','reddit.com','youtube.com','youtu.be','openai.com']; // its own entry — see BUGS.md
        for (var d = 0; d < NO_EMBED_DOMAINS.length; d++) {
          if (host === NO_EMBED_DOMAINS[d] || host.endsWith('.' + NO_EMBED_DOMAINS[d])) {
            return openWebResult({ widgetType: 'newtab', url: url, title: title || parsed.hostname });
          }
        }
        return openWebResult({ widgetType: 'web', embedUrl: url, title: title || parsed.hostname });
      }

      // SEARCH (default) — return search result cards
      if (!q) return fail('A search query is required.', OPEN_WEB_CODES.BAD_REQUEST);
      var searchRes = await web_search({ query: q, maxResults: 6, bus: ctx.bus });
      if (!searchRes.ok || !searchRes.result || !searchRes.result.results || !searchRes.result.results.length) {
        return fail('No results found for "' + q + '" — every search provider in the chain came back empty. This branch already ran web_search, so calling web_search will not help; say the search found nothing rather than answering from memory.', OPEN_WEB_CODES.NO_RESULTS);
      }
      var searchCards = searchRes.result.results.map(function(r) {
        return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 200) };
      });
      return openWebResult({ widgetType: 'search', cards: searchCards, title: title || q, query: q, source: searchRes.result.source });

      // Unreachable: the ALLOWED_TYPES guard at the top rejects all other types.
    } catch (err) {
      return fail('open_web failed: ' + err.message, OPEN_WEB_CODES.PROVIDER_ERROR);
    }
  }

  // ---- open_artifact ----

  // C5 (46-finding voice-session audit, 2026-08-12): MYTHOS called
  // pipeline_status four times, had the real artifact path in hand, and then
  // asked open_artifact to open two filenames that never existed — blaming
  // the pipeline for "erroneous data" it had itself fabricated. Two fixes:
  //   1. jobId resolves the path server-side (below) so the model never
  //      retypes a filename it was already given.
  //   2. A wrong `path` now fails with a message naming the real path(s)
  //      recorded on known jobs, instead of repeating advice ("call
  //      pipeline_status") the model had already followed.
  // Known artifacts come ONLY from buildRunner's own job records — never
  // from joining caller input onto a directory — so this cannot become a
  // path-traversal primitive.
  function knownArtifactPaths() {
    if (!buildRunner || typeof buildRunner.listJobs !== 'function') return [];
    return buildRunner.listJobs()
      .filter((j) => j && j.artifact && j.artifact.path)
      .sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0))
      .map((j) => j.artifact.path);
  }

  function unknownPathMessage(rawPath) {
    const known = knownArtifactPaths();
    if (!known.length) {
      return `Artifact does not exist: ${rawPath}. Call pipeline_status or job_status to get a real artifact path before opening one.`;
    }
    if (known.length === 1) {
      return `Unknown artifact path: ${rawPath}. Artifact does not exist. The most recent job's artifact is ${known[0]}.`;
    }
    // Several jobs have artifacts — naming just the newest would be a guess
    // as wrong as the model's own fabrication. List them all instead.
    return `Unknown artifact path: ${rawPath}. Artifact does not exist. Known job artifacts (most recent first): ${known.join(', ')}.`;
  }

  async function open_artifact({ path, jobId, title }) {
    try {
      let rawPath;
      if (jobId) {
        if (!buildRunner || typeof buildRunner.getJob !== 'function') {
          return fail('No build runner is available to resolve jobId.');
        }
        const job = buildRunner.getJob(jobId);
        if (!job) return fail(`No job found with id ${jobId}.`);
        if (!job.artifact || !job.artifact.path) {
          return fail(`Job ${jobId} has no artifact yet (status: ${job.status}).`);
        }
        rawPath = String(job.artifact.path).trim();
      } else {
        if (!path || !String(path).trim()) {
          return fail('An artifact path or jobId is required.');
        }
        rawPath = String(path).trim();
      }
      // Reject shell metacharacters — this path becomes part of a shell command
      // (cmd /c start on Windows, xdg-open on Linux). Without this, an LLM or
      // attacker who controls the path can inject commands (&, |, ;, backticks,
      // $() are all command separators/subshells). BUG-008: open_artifact is
      // tiered T2 (leash/tiers.js) and auto-allows on every dispatch path, voice
      // included — no confirm gate protects this call anywhere. This check (plus
      // shell:false + explicit argv below) is the only line of defense, so it
      // applies regardless of the caller.
      if (/[;&|`$()<>^]/.test(rawPath)) {
        return fail('Artifact path contains disallowed characters.');
      }
      let targetUrl = rawPath;
      // REMEDIATION P1-6/P1-7: shared resolver (vault-url.js) also used by
      // browser_navigate — one mapping from a vault-relative path to (a) an
      // existence-check-able relative path and (b) the URL the dashboard's
      // HTTP server serves it at, instead of two that could drift apart.
      const vaultRelPath = vaultRelativePath(rawPath);
      if (vaultRelPath !== null) {
        // REMEDIATION P1-6: check the file actually exists on disk BEFORE
        // reporting opened:true — previously this mapped any /vault/... path
        // straight to a URL and spawned the OS opener with no existence
        // check, so a fabricated slug ("opened:true" for a file that was
        // never built) looked identical to a real success.
        if (!fs || typeof fs.exists !== 'function' || !fs.exists(vaultRelPath)) {
          return fail(unknownPathMessage(rawPath));
        }
        // BUG-317: signed, because this URL is about to be handed to a browser
        // that sends no Authorization header.
        targetUrl = vaultUrl(vaultRelPath, config, { sign: true });
        // REMEDIATION P1-6 (incident 2026-07-29, live smoke-test): the file
        // existing on disk is not sufficient — this URL is only real if
        // THIS process's own HTTP server is actually listening and serving
        // it. The OS opener launching successfully says nothing about
        // whether the browser tab it opens will actually load — that
        // failure (ERR_CONNECTION_REFUSED) happens asynchronously in a
        // separate process this function can't observe. Pre-flight check
        // before ever spawning anything, so a server that isn't up gets an
        // honest failure instead of a fabricated opened:true.
        try {
          // BUG-317: preflight EXACTLY what the browser will send — no headers.
          // This used to attach `Authorization: Bearer <token>`, which made the
          // CHECK pass while the browser's own header-less request 401'd, so
          // open_artifact reported opened:true for a page the operator could not
          // open. The URL is signed above; if the signature is what admits it,
          // this request proves that, and if nothing admits it we find out here
          // instead of the operator finding out in the browser.
          const head = await fetch(targetUrl, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
          if (!head.ok) {
            return fail(`Artifact exists but the dashboard server returned ${head.status} for ${targetUrl}.`);
          }
        } catch (err) {
          return fail(`Artifact exists but the dashboard server is not reachable at ${targetUrl} (${err.message}).`);
        }
      }
      const platform = process.platform;
      let cmd;
      if (platform === 'win32') {
        cmd = ['cmd', '/c', 'start', '', targetUrl];
      } else if (platform === 'darwin') {
        cmd = ['open', targetUrl];
      } else {
        cmd = ['xdg-open', targetUrl];
      }
      // spawn (async), NOT spawnSync — spawnSync blocks the entire event loop
      // until the child exits, freezing the WS server and cortex tick. On Linux
      // xdg-open can block for seconds. shell:false — we pass an explicit argv
      // so no shell wrapping is needed; this is the injection-safe path.
      const { spawn } = require('child_process');
      const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', shell: false });
      // REMEDIATION P1-6: the spawn error was previously swallowed entirely
      // ("best-effort") — an opener that fails to even launch (missing OS
      // handler, bad path) still reported opened:true with no trace anywhere.
      // spawn's 'error' event fires asynchronously (after this function has
      // already returned its best-effort opened:true), so it can't change
      // this call's result — but it must not vanish either; log it as a
      // health anomaly so it is visible in the audit trail instead of silent.
      child.on('error', function(err) {
        if (ctx.bus && typeof ctx.bus.emit === 'function') {
          ctx.bus.emit('health.anomaly', { kind: 'open-artifact-spawn-failed', error: err.message, path: rawPath });
        }
      });
      child.unref();
      const display = title || rawPath;
      return ok({ opened: true, url: targetUrl, display, ageHours: vaultRelPath === null ? null : vaultAgeHours(vaultRelPath, fs) }); // BUG-319
    } catch (err) {
      return fail(`Could not open artifact: ${err.message}`);
    }
  }

  // ---- status / jobs ----

  async function read_status() {
    try {
      const status = probes ? await probes.getStatus() : null;
      const jobs = buildRunner.listJobs().slice(-5);
      // BUG-113: open commitments ("I'll check X") the operator can ask about
      // later — best-effort, never blocks status on a ledger read failure.
      let openCommitments = [];
      try { openCommitments = listOpenCommitments(goals) || []; } catch (_) {}
      // A4: report the persona store's actual current levels — never a
      // fabricated/default set. null when identity isn't available at all,
      // never a stand-in numbers object.
      let persona = null;
      if (identity && typeof identity.getPersonaLevels === 'function') {
        try { persona = identity.getPersonaLevels(); } catch (_) {}
      }
      return ok({ status, recentJobs: jobs, openCommitments, persona });
    } catch (err) {
      return fail(err.message);
    }
  }

  // E5: the model had no tool for "what are your specs" — screen_look
  // (from-pc.js) has no targeting param at all and always screenshots the
  // primary display, so it was never a targeting bug, it was a missing
  // capability. CPU/RAM facts already exist inside MYTHOS via os.cpus()/
  // totalmem()/freemem() (server/routes/system.js), but that endpoint is
  // DELIBERATELY STATEFUL (cpuDeltaPercent consumes an accumulated window —
  // see the comment block at the top of that file) so this tool does NOT
  // call it and does NOT reuse cpuDeltaPercent. It is a stateless read of
  // static/instantaneous os facts only.
  //
  // No CPU utilisation percentage is reported, ever: a single os.cpus() read
  // gives average-since-boot (times are cumulative counters since boot), which
  // looks like a live percent and is not one. Omitted rather than estimated.
  async function read_system_specs() {
    const cpus = os.cpus() || [];
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    // os.loadavg() returns [0,0,0] on Windows — a fake reading, not a real
    // one. Honest-inert contract: unavailable, never a plausible-looking
    // number.
    const loadavg = os.platform() === 'win32' ? 'unavailable' : os.loadavg();
    return ok({
      cpuModel: cpus[0] ? cpus[0].model : 'unavailable',
      logicalCores: cpus.length,
      arch: os.arch(),
      platform: os.platform(),
      osRelease: os.release(),
      totalMemoryBytes,
      totalMemoryGB: bytesToGB(totalMemoryBytes),
      freeMemoryBytes,
      freeMemoryGB: bytesToGB(freeMemoryBytes),
      processUptimeSeconds: process.uptime(),
      hostUptimeSeconds: os.uptime(),
      loadAverage: loadavg
    });
  }

  // C1: job.status (BUG-016) still means "the job ran to completion" — that
  // claim is unchanged and correct even when the review failed. completionStatus
  // is the separate "is this actually a finished, working build" fact the
  // announcer already derives (reviewVerdict + engine); job_status is the
  // on-demand/pull path for the same question the announcer answers by push,
  // so it gets the same derived field rather than leaving the model to infer
  // it from the raw job (which it was not doing — no prompt anywhere told it
  // reviewVerdict/engine mattered). A shallow copy — the live job record in
  // buildRunner's map is never mutated.
  function withCompletionStatus(job) {
    if (!job) return job;
    var completion = completionForJob(job);   // BUG-316 — see completion-status.js
    return Object.assign({}, job, { completionStatus: completion.status });
  }

  function job_status({ jobId }) {
    try {
      if (jobId) {
        const job = buildRunner.getJob(jobId);
        if (!job) return fail(`No job found with id ${jobId}.`);
        return ok({ job: withCompletionStatus(job) });
      }
      const jobs = buildRunner.listJobs();
      const last = jobs[jobs.length - 1] || null;
      return ok({ job: withCompletionStatus(last) });
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- goals ----

  function create_goal({ text, category }) {
    try {
      if (!text || !text.trim()) return fail('Goal text is required.');
      const list = goalsEffector.addGoal(text, category);
      return ok({ goals: list, stats: goalsEffector.stats() });
    } catch (err) {
      return fail(err.message);
    }
  }

  // V5 (Phase 4): propose_goal — the cortex SUGGESTS a goal without activating
  // it. Creates a status:'proposed' record that the operator accepts/rejects
  // via the dashboard. NOT in AUTONOMOUS_EXCLUDED (the whole point: the cortex
  // can propose but not mint active goals). The arbiter ignores proposals.
  function propose_goal({ text, category, reason, drive, priority }) {
    try {
      if (!text || !text.trim()) return fail('Goal text is required.');
      const proposals = goalsEffector.proposeGoal(text, category, { reason: reason, drive: drive, priority: priority });
      return ok({ proposals: proposals });
    } catch (err) {
      return fail(err.message);
    }
  }

  function list_goals() {
    try {
      return ok({ goals: goalsEffector.listGoals(), stats: goalsEffector.stats() });
    } catch (err) {
      return fail(err.message);
    }
  }

  // toggle_goal / delete_goal: re-fetch listGoals() fresh, right here, right before
  // acting — goal ids surfaced to the human (Goals.md rows) are matched by text, never
  // trusted from an earlier turn's context.
  function toggle_goal({ query }) {
    try {
      const current = goalsEffector.listGoals();
      const match = findByQuery(current, query, (g) => g.text);
      if (!match) return fail(`No goal matching "${query}" found.`);
      const list = goalsEffector.toggleGoal(match.item.id);
      return ok({ goals: list, toggled: match.item.text });
    } catch (err) {
      return fail(err.message);
    }
  }

  function delete_goal({ query }) {
    try {
      const current = goalsEffector.listGoals();
      const match = findByQuery(current, query, (g) => g.text);
      if (!match) return fail(`No goal matching "${query}" found.`);
      const list = goalsEffector.deleteGoal(match.item.id);
      // list.degraded means the bridge map was unreadable, so nothing was
      // removed. Claiming `deleted:` here would be a fabricated success (AD-4).
      if (list.degraded) {
        return fail(`Could not delete "${match.item.text}" — the goals bridge map is unreadable right now. Nothing was changed.`);
      }
      return ok({ goals: list, deleted: match.item.text });
    } catch (err) {
      return fail(err.message);
    }
  }

  // Delete a built artifact: find the shipped pipeline card whose title or
  // artifact name matches the query, delete the artifact file from disk, and
  // reject (remove) the card. Previously the model had no tool for this and
  // fell back to delete_goal (wrong store) which failed silently — then
  // claimed success anyway (the fabrication bug). This gives it the right tool.
  function delete_artifact({ query }) {
    try {
      if (!query || !String(query).trim()) return fail('An artifact name or title to match is required.');
      const board = pipeline.listAll();
      // Search all stages — an artifact may be in shipped or execute
      var allCards = [];
      Object.keys(board).forEach(function(stage) {
        allCards = allCards.concat(board[stage] || []);
      });
      var match = findByQuery(allCards, query, function(c) {
        var title = (c.artifact && c.artifact.title) || '';
        var name = (c.artifact && c.artifact.name) || '';
        return (c.text || '') + ' ' + title + ' ' + name;
      });
      if (!match) return fail('No built artifact matching "' + query + '" found.');
      var card = match.card || match.item;
      // Delete the artifact file from disk if it exists
      var deletedFile = null;
      if (card.artifact && card.artifact.path && fs) {
        try {
          // artifact.path is like /vault/builds/pipeline/foo.html — strip leading /vault/
          var relPath = String(card.artifact.path).replace(/^\/?vault\//, '');
          fs.removeFile(relPath);
          deletedFile = card.artifact.path;
        } catch (_) { /* best-effort — the card is still removed */ }
      }
      // Remove the pipeline card
      pipeline.reject(card.id);
      return ok({ deleted: card.artifact && card.artifact.title || card.id, fileRemoved: deletedFile });
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- pipeline ----

  // web_fetch: retrieve text content from a URL. Read-only, no side effects.
  // Gives the entity real internet access so the build agent can pull actual
  // content (e.g. real AI news) instead of hallucinating from training data.
  // Returns the response body as text, truncated to a sensible length. HTML
  // tags are stripped so the model sees readable text, not markup.
  // web_fetch: retrieve readable text from a URL. Direct fetch first (with
  // browser UA + naive HTML-to-text strip), falls back to Jina Reader if
  // direct fetch fails or returns nothing useful.
  // Delegates to effectors/web-fetch.js. This used to be a second, complete
  // copy of that fetcher — same browser UA, same Jina fallback, same 15s
  // bounds — with ONE difference: no SSRF guard at all. web-fetch.js checks
  // the target against loopback, RFC1918, link-local and the cloud metadata
  // endpoints, and resolves hostnames to catch DNS rebinding; this copy went
  // straight from "starts with http" to fetch(). And this is the copy that is
  // exposed to the model as the `web_fetch` tool (danger:false, tier 0), while
  // the guarded one was reachable only from the P22 research gate in main.js.
  // Found 2026-08-19 while writing web-fetch.js's first tests.
  //
  // The result shape is unchanged, `source` included, so nothing downstream
  // has to know this became one function instead of two.
  async function web_fetch(args) {
    try {
      const out = await sharedWebFetch({ url: args && args.url });
      return out.ok ? ok(out.result) : fail(out.error);
    } catch (err) {
      return fail('Fetch failed: ' + ((err && err.message) || String(err)));
    }
  }

  function capture_idea(args) { var text = (args && (args.text || args.idea) || '').trim();
    try {
      if (!text) return fail('Idea text is required.');
      const card = pipeline.capture(text);
      return ok({ card });
    } catch (err) {
      return fail(err.message);
    }
  }

  // REMEDIATION P0-2: a card only ever gets failure metadata written onto it
  // when the job's own run()/onFailed callback fires (agent-actions.js) — a
  // card whose job failed under an OLDER build without that hook (or whose
  // callback itself threw) is otherwise stuck reading as "still building"
  // forever, which is exactly how the 2026-07-29 audit's operator was told a
  // build was in progress 18 minutes after it had died. Cross-check every
  // execute-stage card's jobId against buildRunner's own job record — the
  // real source of truth — and self-heal the card if they disagree, instead
  // of trusting whatever was last written to the card.
  function reconcileExecuteCards(board) {
    if (!buildRunner || typeof buildRunner.getJob !== 'function') return board;
    var cards = board.execute || [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (!card.jobId || card.buildFailed) continue;
      var job = buildRunner.getJob(card.jobId);
      if (job && job.status === 'failed') {
        try {
          var updated = pipeline.moveCard(card.id, 'execute', {
            buildFailed: true, buildError: job.error || 'build failed'
          });
          cards[i] = updated;
        } catch (_) { /* best-effort — card may have been deleted meanwhile */ }
      }
    }
    return board;
  }

  function pipeline_status() {
    try {
      return ok({ board: reconcileExecuteCards(pipeline.listAll()) });
    } catch (err) {
      return fail(err.message);
    }
  }

  function findPipelineCardByQuery(query) {
    const board = pipeline.listAll();
    for (const stage of Object.keys(board)) {
      const match = findByQuery(board[stage], query, (c) => c.text || '');
      if (match) return { card: match.item, stage };
    }
    return null;
  }

  function pipeline_advance({ query, action }) {
    try {
      const found = findPipelineCardByQuery(query);
      if (!found) return fail(`No pipeline card matching "${query}" found.`);
      if (action === 'approve') {
        const card = pipeline.approve(found.card.id);
        return ok({ card, board: pipeline.listAll() });
      }
      if (action === 'reject') {
        pipeline.reject(found.card.id);
        return ok({ board: pipeline.listAll() });
      }
      return fail(`Unknown pipeline action "${action}".`);
    } catch (err) {
      return fail(err.message);
    }
  }

  function pipeline_execute({ query }, runCtx) {
    try {
      const found = findPipelineCardByQuery(query);
      if (!found) return fail(`No pipeline card matching "${query}" found.`);

      // Prevent duplicate builds: if card is already in execute with a running/queued job
      if (found.card.stage === 'execute' && found.card.jobId) {
        const job = buildRunner.getJob(found.card.jobId);
        if (job && (job.status === 'running' || job.status === 'queued')) {
          return fail('Build already in progress for this card. Wait for it to complete or fail before retrying.');
        }
      }

      // Phase 18: thread the cortex-active goal (if any) onto the enqueued job.
      const result = agentActions.executePipelineCard(found.card.id, runCtx && runCtx.goalId);
      return ok(result);
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- kanban ----

  function kanban_status() {
    try {
      return ok({ board: kanban.listBoard() });
    } catch (err) {
      return fail(err.message);
    }
  }

  function kanban_add_card({ title, lane }) {
    try {
      if (!title || !title.trim()) return fail('Card title is required.');
      const card = kanban.addCard(title, lane);
      return ok({ card, board: kanban.listBoard() });
    } catch (err) {
      return fail(err.message);
    }
  }

  // kanban ids are stable (never reindexed) — plain lookup-by-id via findByQuery on the
  // current board is sufficient; no staleness guard needed (see goals-effector for why
  // that guard IS needed there).
  function kanban_move_card({ query, lane }) {
    try {
      const board = kanban.listBoard();
      const match = findByQuery(board.cards, query, (c) => c.title || '');
      if (!match) return fail(`No kanban card matching "${query}" found.`);
      const card = kanban.moveCard(match.item.id, lane);
      return ok({ card, board: kanban.listBoard() });
    } catch (err) {
      return fail(err.message);
    }
  }

  function kanban_assemble({ goal }, runCtx) {
    try {
      const result = agentActions.assembleKanbanPlan(goal, runCtx && runCtx.goalId);
      return ok(result);
    } catch (err) {
      return fail(err.message);
    }
  }

  function kanban_build_card({ query }, runCtx) {
    try {
      const board = kanban.listBoard();
      const match = findByQuery(board.cards, query, (c) => c.title || '');
      if (!match) return fail(`No kanban card matching "${query}" found.`);
      const result = agentActions.buildKanbanCard(match.item.id, runCtx && runCtx.goalId);
      return ok(result);
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- ask_agent ----
  // dispatch is injected by whatever owns Brain dispatch — kept as a module-scoped
  // closure var (unchanged from NOVA's voice-agent.js wiring pattern), now over
  // brain.think() rather than reasoning.chat().
  let askAgentDispatch = null;
  function setAskAgentDispatch(fn) {
    askAgentDispatch = fn;
  }

  // ---- camera_look / camera_on (server-initiated) ----
  // Providers injected by server/index.js after WS is set up.
  let cameraFrameProvider = null;
  function setCameraFrameProvider(fn) {
    cameraFrameProvider = fn;
  }
  let cameraPowerProvider = null;
  function setCameraPowerProvider(fn) {
    cameraPowerProvider = fn;
  }

  // A WEBCAM FRAME HAS NO ORACLE, and that is the whole design constraint here.
  // screen_look can be cross-checked against OCR of the same screenshot (see
  // effectors/evidence.js) — which is the only thing that caught the vision model
  // inventing "the user is holding a small dog" on 2026-08-10. Nothing equivalent
  // exists for a camera frame: there is no second, independent reading of what a
  // room looks like.
  //
  // So this tool reports PROVENANCE instead of asserting fact. The note travels in
  // the result (the Live adapter passes results to the model through
  // truncateForModel) and is deliberately NOT routed through the adapter's
  // `unverified` channel: unverifiedNarration appends "Report only that it was
  // attempted", which is correct for an act that may not have landed and wrong for
  // a read — it would suppress the very description the operator asked for.
  const CAMERA_LOOK_PROVENANCE =
    'This is one vision model\'s reading of a SINGLE webcam frame and it cannot be '
    + 'verified. Say what it LOOKED LIKE, not what is true, and offer to look again.';

  // F4 (2026-08-15). The provenance note above was already here on 2026-08-14 and
  // did not stop two wrong descriptions being asserted as fact — "a mouse with a
  // bright green light" (there was none) and an object misidentified while its
  // colour context was right. The lane itself was healthy: 9 calls, 1 honest fail
  // (camera off), 8 ok, every vision.call 1.5-2.2s. The model was simply wrong,
  // confidently, and advisory prose loses to a confident model.
  //
  // So the model is asked to SCORE ITSELF, and the score changes what happens:
  //   high  -> answer directly. No second call, no added latency. This is the
  //            common path and it costs nothing over the previous behaviour.
  //   low   -> take a second frame ~1s later and assert only what the two
  //            readings agree on; report disagreement as uncertainty.
  // A self-reported confidence is not a measurement, and it is not treated as
  // one: it only decides whether to spend a second look. The provenance note
  // still ships on every path.
  //
  // Absent or unparseable score is treated as LOW for what gets SAID (hedge) but
  // does NOT trigger a second call — an unreliable tag must not silently double
  // the cost and latency of every camera_look.
  const CONFIDENCE_SUFFIX =
    ' End your answer with a final line of exactly "CONFIDENCE: HIGH" if you are sure '
    + 'of the specific objects you named, or "CONFIDENCE: LOW" if the frame is unclear, '
    + 'partially visible, or you are guessing at any of them.';
  const CONFIDENCE_RE = /\s*CONFIDENCE:\s*(HIGH|LOW)\s*\.?\s*$/i;
  // ~1s apart: long enough that the second frame is genuinely a new sample of the
  // scene (hand moved, focus settled, glare shifted) rather than a re-read of the
  // same instant, short enough that the operator does not notice a pause. Read
  // from ctx so tests can drive the branch without four seconds of real sleep;
  // there is deliberately no .env key, since nothing about this is per-machine.
  const SECOND_LOOK_DELAY_MS = (config && Number(config.CAMERA_SECOND_LOOK_DELAY_MS) >= 0)
    ? Number(config.CAMERA_SECOND_LOOK_DELAY_MS) : 1000;

  function splitConfidence(raw) {
    var text = String(raw || '').trim();
    var m = text.match(CONFIDENCE_RE);
    if (!m) return { text: text, confidence: 'unstated' };
    return { text: text.replace(CONFIDENCE_RE, '').trim(), confidence: m[1].toLowerCase() };
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function camera_look({ query }) {
    try {
      if (!cameraFrameProvider) return fail('Camera is not available — no dashboard is open or the camera is off.');
      var brain = (ctx && ctx.brain) || null;
      var b64 = await cameraFrameProvider();
      // Distinguish the two: "no dashboard" is unfixable by the operator right
      // now, "camera off" is one confirm away via camera_on. Saying so is what
      // stops the model reaching for screen_look instead.
      if (!b64) return fail('The camera is off (or no dashboard is open), so there is no frame to look at. Use camera_on to ask the operator to turn it on.');
      if (!brain || typeof brain.think !== 'function') {
        return fail('Camera frame captured but no vision brain is available to describe it.');
      }
      var basePrompt = query ? String(query).slice(0, 300)
        : 'Describe what is visible in this webcam frame, briefly and concretely.';
      var look = function(frame) {
        return visionThink(brain, {
          prompt: basePrompt + CONFIDENCE_SUFFIX,
          b64: frame,
          mime: 'image/jpeg', // camera.js captures JPEG (canvas.toDataURL('image/jpeg'))
          source: 'camera-look',
          timeoutMs: config && config.VISION_CALL_TIMEOUT_MS,
          attemptTimeoutMs: config && config.VISION_ATTEMPT_TIMEOUT_MS,
          logger: logger,
          chainFor: visionChainFor,
        });
      };
      var result = await look(b64);
      if (result.timedOut) return fail('The vision model did not answer in time — nothing was seen. Say so; do not describe anything.');
      // Wave 5 (2026-08-13): laneEmpty is the preflight failing fast — name the
      // real cause instead of the generic "offline" every other cause also sets.
      if (result.laneEmpty) return fail(result.reason || 'Vision lane is empty — cannot describe the camera view.');
      if (result.offline || !result.content) return fail('Vision providers are offline — cannot describe the camera view.');

      var first = splitConfidence(result.content);
      if (first.confidence !== 'low') {
        return ok({
          description: first.text.slice(0, 600),
          source: 'webcam (one frame)',
          // 'unverified-vision' is retained verbatim for the high/unstated path —
          // it is the value shipped since this tool existed and the model's
          // prompt-side handling of it is unchanged.
          confidence: 'unverified-vision',
          selfReported: first.confidence,
          note: CAMERA_LOOK_PROVENANCE,
        });
      }

      // F4 low-confidence path: a second frame, a second reading, and a spoken
      // form that is explicit about which of the two the operator is getting.
      // Every failure here degrades to the single reading rather than failing the
      // tool — one uncertain description is still better than none, and the
      // operator asked a question.
      var second = null;
      try {
        await sleep(SECOND_LOOK_DELAY_MS);
        var b64b = await cameraFrameProvider();
        if (b64b) {
          var r2 = await look(b64b);
          if (!r2.timedOut && !r2.offline && !r2.laneEmpty && r2.content) {
            second = splitConfidence(r2.content);
          }
        }
      } catch (err) {
        if (logger && logger.warn) logger.warn('camera-look.second-look-failed', { error: reasonText(err) });
      }

      if (!second) {
        return ok({
          description: first.text.slice(0, 600),
          source: 'webcam (one frame, second look unavailable)',
          confidence: 'unverified-vision',
          selfReported: 'low',
          note: 'The vision model reported LOW confidence in this reading and a second frame could not '
            + 'be taken. ' + CAMERA_LOOK_PROVENANCE + ' Say plainly that you are not sure.',
        });
      }

      return ok({
        description: first.text.slice(0, 600),
        secondLook: second.text.slice(0, 600),
        source: 'webcam (two frames, ~1s apart)',
        confidence: 'unverified-vision',
        selfReported: 'low',
        // The note has to reach the SPOKEN sentence, not just the tool result —
        // that is precisely why the previous, purely advisory note failed. It is
        // phrased as an instruction about what to say, not as metadata.
        note: 'The vision model reported LOW confidence, so two frames were read ~1s apart and BOTH '
          + 'readings are above. Say ONLY what both agree on as what you saw; where they disagree, say '
          + 'you could not tell. Do not merge them into one confident description. '
          + CAMERA_LOOK_PROVENANCE,
      });
    } catch (err) {
      return fail(reasonText(err));
    }
  }

  // Ask the operator's HUD to turn the camera on. T3 + NEVER_TRUSTABLE, so the
  // operator has already confirmed by the time this runs — a misheard utterance
  // cannot reach it. Reports the state the camera loop ACTUALLY reached; a
  // permission denial or a failed gesture-model load comes back as on:false with
  // the reason, never as a hopeful success.
  async function camera_on() {
    try {
      if (!cameraPowerProvider) return fail('Cannot reach a dashboard to turn the camera on — no UI is connected.');
      var res = await cameraPowerProvider();
      if (!res) return fail('No dashboard answered the request to turn the camera on.');
      if (!res.on) {
        return fail(res.reason
          ? 'The camera did not turn on: ' + String(res.reason).slice(0, 200)
          : 'The camera did not turn on.');
      }
      return ok({ camera: 'on', state: res.state || 'watching', evidence: 'the dashboard reported the camera loop is ' + (res.state || 'watching') });
    } catch (err) {
      return fail(reasonText(err));
    }
  }

  async function ask_agent({ seat, prompt }) {
    try {
      if (!askAgentDispatch) return fail('ask_agent is not wired up in this context.');
      if (!seat || !prompt || !prompt.trim()) return fail('seat and prompt are required.');
      const reply = await askAgentDispatch(seat, prompt);
      const capped = String(reply || '').slice(0, 600);
      return ok({ seat, reply: capped });
    } catch (err) {
      return fail(err.message);
    }
  }

  // ---- daily_plan (Phase 3 Jarvis upgrade — daily planning + accountability) ----
  // Injected after construction, same setter-injection pattern as
  // setAskAgentDispatch/setCameraFrameProvider above (and setScreenSensorHandle
  // in from-pc.js): main.js constructs the planner in a boot step AFTER the
  // 'leash' step that registers this file's tools, so the real instance can't
  // be a constructor dependency here.
  let plannerHandle = null;
  function setPlannerHandle(handle) {
    plannerHandle = handle;
  }

  async function daily_plan({ action }) {
    try {
      if (!plannerHandle) return fail('Daily planner is not available in this session.');
      const act = String(action || 'status').trim().toLowerCase();
      if (act === 'status') {
        return ok({ day: plannerHandle.status() });
      }
      if (act === 'replan') {
        const result = await plannerHandle.runMorning();
        return ok(result);
      }
      if (act === 'skip_today') {
        return ok({ day: plannerHandle.skipToday() });
      }
      return fail('Unknown action "' + action + '". Use status|replan|skip_today.');
    } catch (err) {
      return fail(err.message);
    }
  }

  const TOOLS = [
    // A1 (2026-08-14): leads with what it is NOT, because it was called with a
    // URL and reported as a browser launch. The code guard in navigate() is the
    // real mechanism — this only makes the first attempt likelier to be right.
    { name: 'navigate', description: 'Switch which MYTHOS dashboard VIEW is showing (e.g. dashboard, kanban, pipeline). This is a HUD router, NOT a browser and NOT a URL bar: it cannot open a website or load a page. For "open <site>" / "go to <url>" use browser_navigate instead.', params: { route: 'string - a dashboard view name, never a URL' }, danger: false, fn: navigate },
    { name: 'close_panel', description: 'Close dashboard panel(s), floating widgets (search/weather/flights/image cards spawned by open_web), AND the Electron media window if one is open (e.g. a YouTube video that will not stop with standard playback controls). Pass all:true to close everything open, omit to close just the top-most one. Reports the real overlaysClosed/widgetsClosed/mediaWindowClosed counts.', params: { all: 'boolean (optional, default false)' }, danger: false, fn: close_panel },
    { name: 'open_web', description: 'Renders a card INSIDE the MYTHOS dashboard — this does NOT open a browser window and is NOT the user\'s browser. Despite the name, open_web never browses: use browser_navigate for "search the web", "look up", "open <site>", or anything the user expects to see in a real browser. Only use open_web when the user asked for an at-a-glance card ON THE HUD. Content is rendered in MYTHOS\'s own UI (dashboard overlay/widget, plus MYTHOS\'s own media window for the youtube/web types). type:"youtube" plays a SPECIFIC video (pass query — the song/topic to search; for "open YouTube" with no video in mind, use launch_app("youtube") instead). type:"weather" shows conditions (pass location). type:"search" shows search result cards (pass query). type:"flights" shows flight results (pass query like "NYC to Tokyo"). type:"image" shows image search results (pass query). type:"web" embeds a direct URL and requires url: — a domain in query: is REFUSED, not guessed at (that call failed five times in one 2026-08-14 session). search/weather/flights/image open as floating widgets. This is NOT the user\'s real/desktop browser — but you do NOT have to switch tools for a plain "open this site in my browser": pass browser:true WITH url: and open_web itself routes through its newtab mechanism to the real browser window (the same route frame-blocking sites get). By default that is the OS DEFAULT browser, which on this machine may not be the one the operator means — if they NAMED a browser (\"open it in Chrome\"), pass browserName:\"chrome\" as well and it opens in the normal logged-in profile of that browser (BUG-407; before that fix a named request silently opened the default, and BUG-398 E3 records the operator asking for Chrome three times and getting Brave every time). For full browsing control (tabs, navigation of an attached session) use browser_navigate / browser_tabs instead.', params: { type: 'string - youtube|weather|search|flights|image|web', query: 'string (optional) - search query or topic', url: 'string (optional) - for type:web, or the target when browser:true', location: 'string (optional) - for type:weather', title: 'string (optional) - custom title', browser: 'boolean (optional) - open the url in the REAL browser window via the newtab route instead of rendering a dashboard card. On its own it goes to whichever browser Windows has set as DEFAULT.', browserName: 'string (optional) - chrome, brave or edge. Only meaningful with browser:true. Opens the url in THAT browser using the operator\'s normal profile (logged in, their extensions), by handing the url to the browser executable - not the signed-out MYTHOS debug profile. Pass it whenever the operator named a browser; omit it for a plain "open this in my browser".' }, danger: false, fn: open_web },
    { name: 'open_artifact', description: 'Open a build result in the system browser. Use this for /vault/builds/... paths instead of browser_navigate when browser automation is offline. Prefer jobId (from pipeline_status/job_status) over path — it resolves the real artifact path server-side, so you never have to retype a filename. A wrong path fails with the real path(s) named in the error.', params: { path: 'string (optional if jobId given)', jobId: 'string (optional) - resolves the path from the job record instead of retyping it', title: 'string (optional)' }, danger: false, fn: open_artifact },
    { name: 'delete_artifact', description: 'Permanently delete a built artifact (the file + its pipeline card) by matching its title or filename. Destructive and irreversible.', params: { query: 'string - the artifact title or name to match' }, danger: true, fn: delete_artifact },
    // REMEDIATION P3-8: needs_result:true added to every status/check/list/
    // read-class tool below — previously dead metadata (adapter.js dropped
    // the field before it reached voice-agent.js), now actually enforced.
    { name: 'read_status', description: 'Read live status of all agents/providers and recent jobs, plus open spoken commitments and the current persona levels.', params: {}, danger: false, fn: read_status, needs_result: true },
    { name: 'read_system_specs', description: 'Read THIS machine\'s hardware/OS facts: CPU model, core count, total/free memory (bytes and GB), arch, platform, OS release, and process/host uptime. This is how you answer "what are your specs" / "how much RAM do you have" / "what CPU is this" — do NOT use screen_look for that, it only screenshots whatever is on the display and cannot read hardware facts. Never returns a CPU usage percentage (a single reading cannot give one honestly) and reports load average as unavailable on platforms where the OS does not provide a real one.', params: {}, danger: false, fn: read_system_specs, needs_result: true },
    { name: 'web_fetch', description: 'Fetch text content from a URL (real internet access). Returns the page text (HTML stripped, truncated to ~4000 chars). Use for research, news, documentation, or any real-time data.', params: { url: 'string - the http(s) URL to fetch' }, danger: false, fn: web_fetch, needs_result: true },
    { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets. Use for research, news, or any question requiring current data.', params: { query: 'string - the search query', maxResults: 'number (optional, default 5)' }, danger: false, fn: async function(args) { return web_search(Object.assign({}, args, { bus: ctx.bus })); }, needs_result: true },
    { name: 'job_status', description: 'Check the status of a build job (most recent if jobId omitted). Result includes the artifact path when done and researchStatus (grounded/skipped/not-required) indicating whether the build used live web research. job.status only means the job ran to completion, NOT that it is a finished/working build — always check completionStatus ("done" vs "needs-work") before telling the operator a build is done; "needs-work" means the review rejected it or a fallback engine produced it, even though job.status reads "done".', params: { jobId: 'string (optional)' }, danger: false, fn: job_status, needs_result: true },
    { name: 'create_goal', description: 'Create a new goal.', params: { text: 'string', category: 'string (optional)' }, danger: false, fn: create_goal },
    { name: 'propose_goal', description: 'Propose a new goal for operator acceptance (does NOT auto-activate — creates a status:proposed goal the operator accepts via the dashboard).', params: { text: 'string', category: 'string (optional)', reason: 'string (optional — why this goal is worth pursuing)', drive: 'string (optional — curiosity or user-service, default curiosity)', priority: 'number (optional 0..1)' }, danger: false, fn: propose_goal },
    { name: 'list_goals', description: 'List all goals.', params: {}, danger: false, fn: list_goals, needs_result: true },
    { name: 'toggle_goal', description: 'Toggle a goal done/undone by matching its text.', params: { query: 'string' }, danger: false, fn: toggle_goal },
    { name: 'delete_goal', description: 'Permanently delete a goal by matching its text.', params: { query: 'string' }, danger: true, fn: delete_goal },
    { name: 'capture_idea', description: 'Capture a new idea into the pipeline inbox.', params: { text: 'string' }, danger: false, fn: capture_idea },
    { name: 'pipeline_status', description: 'Read the pipeline board (capture/human-gate/execute/shipped).', params: {}, danger: false, fn: pipeline_status, needs_result: true },
    { name: 'pipeline_advance', description: 'Approve or reject a pipeline card by matching its text.', params: { query: 'string', action: '"approve" | "reject"' }, danger: false, fn: pipeline_advance, dangerWhen: (args) => args && args.action === 'reject' },
    // pipeline_execute/kanban_assemble/kanban_build_card: re-tiered T3 -> T2
    // (confirmation-policy pass, sandboxed to vault/builds/) — danger:false
    // to stay consistent with tierOf(); see leash/tiers.js's T2 block comment.
    { name: 'pipeline_execute', description: 'Run the build agent for a pipeline card in the Execute stage.', params: { query: 'string' }, danger: false, fn: pipeline_execute },
    { name: 'kanban_status', description: 'Read the kanban board.', params: {}, danger: false, fn: kanban_status, needs_result: true },
    { name: 'kanban_add_card', description: 'Add a new kanban card to a lane.', params: { title: 'string', lane: 'string (optional)' }, danger: false, fn: kanban_add_card },
    { name: 'kanban_move_card', description: 'Move a kanban card to a different lane by matching its title.', params: { query: 'string', lane: 'string' }, danger: false, fn: kanban_move_card },
    { name: 'kanban_assemble', description: 'Run the planner agent to break a goal into several kanban cards.', params: { goal: 'string' }, danger: false, fn: kanban_assemble },
    { name: 'kanban_build_card', description: 'Run the builder agent on a kanban card, producing a deliverable.', params: { query: 'string' }, danger: false, fn: kanban_build_card },
    { name: 'ask_agent', description: 'Ask a specific agent seat a question and get a short reply.', params: { seat: 'string', prompt: 'string' }, danger: false, fn: ask_agent },
    // The two descriptions below, and screen_look's in from-pc.js, are a matched
    // set: on 2026-08-10 the model answered "what am I holding?" from a DESKTOP
    // SCREENSHOT because nothing told it these are different eyes. Each now says
    // what it is NOT, and names the other by name.
    { name: 'camera_look', description: 'Look through the WEBCAM: capture one frame from the operator\'s camera and describe what is visible in the room — the operator themselves, their face, their surroundings, or an object they are holding up to the camera. This is NOT the computer screen; for anything displayed on the screen use screen_look instead. Requires the camera to be on — if it is off, use camera_on first. A single frame cannot be verified, so report what it LOOKED like and offer to look again.', params: { query: 'string (optional) — what specifically to look for' }, danger: false, fn: camera_look },
    { name: 'camera_on', description: 'Ask the operator to turn their WEBCAM on, so camera_look can see. Use this when the operator asks whether you can see them and the camera is off. The operator must confirm, and they may decline — report honestly whether the camera actually came on. Does not capture or describe anything by itself.', params: {}, danger: true, fn: camera_on },
    { name: 'daily_plan', description: "Read today's plan, force an immediate re-brief, or quiet the planner for the rest of the day. action:\"status\" reads today's focus/check-ins/review. action:\"replan\" re-runs the morning brief right now. action:\"skip_today\" marks the day quiet — no further morning/check-in/evening firing today.", params: { action: 'string - status|replan|skip_today' }, danger: false, fn: daily_plan },
  ];

  return { TOOLS, setAskAgentDispatch, setCameraFrameProvider, setCameraPowerProvider, setPlannerHandle, setClosePanelProvider, setMediaWindowCloser, setExternalOpener, setWidgetRenderer };
}

function registerFromDashboard(hub, ctx) {
  const built = buildTools(ctx);
  for (var i = 0; i < built.TOOLS.length; i++) {
    hub.register(effectorFromTool(built.TOOLS[i]));
  }
  // Return the count AND the ask_agent dispatch injector so main.js can wire it.
  // Previously the injector was discarded here, leaving ask_agent permanently null.
  return {
    count: built.TOOLS.length, setAskAgentDispatch: built.setAskAgentDispatch,
    setCameraFrameProvider: built.setCameraFrameProvider,
    setCameraPowerProvider: built.setCameraPowerProvider, setPlannerHandle: built.setPlannerHandle,
    setClosePanelProvider: built.setClosePanelProvider, setMediaWindowCloser: built.setMediaWindowCloser, setExternalOpener: built.setExternalOpener,
    setWidgetRenderer: built.setWidgetRenderer
  };
}

module.exports = { registerFromDashboard, buildTools };
