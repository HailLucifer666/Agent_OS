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
const { ALL_ROUTES, SYNONYMS } = require('./routes');
const { web_search } = require('./web-search');
const { vaultRelativePath, vaultUrl } = require('./vault-url');
// BUG-113: surface open spoken commitments in read_status so "where are we
// on X" is answerable from state instead of memory.
const { listOpenCommitments } = require('./from-calendar');

function ok(result, uiActions) {
  return uiActions ? { ok: true, result, uiActions } : { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
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
  const goals = ctx.goals; // BUG-113: raw GoalSystem, optional — commitment ledger read in read_status

  // ---- navigate ----

  function navigate({ route }) {
    try {
      const raw = String(route || '').trim().toLowerCase();
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

  // ---- open_web ----
  // Opens web content on the dashboard: YouTube videos (embed), weather cards,
  // search result cards, flight cards, or a general web page. The tool resolves
  // the content (search for YouTube video ID, geocode weather location, etc.)
  // and returns a payload the frontend renders as either an overlay panel
  // (YouTube/web — needs iframe) or a floating widget (search/weather/flights —
  // custom-rendered cards). No API keys needed: Exa MCP search + YouTube embed
  // URLs + Open-Meteo are all free.
  async function open_web({ type, query, url, title, location }) {
    try {
      // Fail loud on an unrecognized/omitted type. Previously this silently
      // defaulted to 'search', turning an ambiguous "open <url>" into a quiet
      // search widget instead of surfacing the misuse. Valid types only.
      var ALLOWED_TYPES = ['youtube', 'weather', 'search', 'flights', 'image', 'web'];
      var t = String(type || '').trim().toLowerCase();
      if (!t) {
        return fail('open_web requires a type. Use one of: ' + ALLOWED_TYPES.join('|') + '. To open or control the real browser, use browser_navigate or browser_tabs instead — open_web only renders content inside the MYTHOS dashboard.');
      }
      if (ALLOWED_TYPES.indexOf(t) === -1) {
        return fail('open_web type must be one of ' + ALLOWED_TYPES.join('|') + ' (got "' + t + '"). To open or control the real browser, use browser_navigate or browser_tabs instead.');
      }
      var q = String(query || '').trim();

      // YOUTUBE — search for the video, extract ID, build embed URL or route to new tab per config
      if (t === 'youtube') {
        if (!q) return fail('A search query is required for YouTube.');
        // maxResults 6 (was 3): most YouTube videos have embedding DISABLED by
        // the uploader, so we need several candidates to find one that will
        // actually play in the iframe.
        var ytRes = await web_search({ query: q + ' site:youtube.com', maxResults: 6, bus: ctx.bus });
        if (!ytRes.ok || !ytRes.result || !ytRes.result.results || !ytRes.result.results.length) {
          return fail('No YouTube videos found for "' + q + '".');
        }
        // Collect ALL candidate video IDs (in result order), not just the first.
        var candidates = [];
        for (var i = 0; i < ytRes.result.results.length; i++) {
          var r = ytRes.result.results[i];
          var idM = String(r.url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
          if (idM) candidates.push({ id: idM[1], title: r.title || (title || q) });
        }
        if (!candidates.length) return fail('Found results but could not extract a YouTube video ID. Try rephrasing.');

        // Check YOUTUBE_MODE config: 'newtab' opens in the external browser
        // (operator's own ad blocker); 'electron' (default) and the legacy
        // 'embed' alias both play inside the HUD's web panel, where the Electron
        // session blocker (electron/main.js) handles ads. Keep in sync with the
        // schema default in mythos/src/core/config/schema.js.
        var youtubeMode = (config && config.YOUTUBE_MODE) || 'electron';
        if (youtubeMode === 'newtab') {
          return ok({ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=' + candidates[0].id, title: candidates[0].title });
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
          return ok({ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=' + candidates[0].id, title: candidates[0].title });
        }
        // enablejsapi=1 is required for the player to postMessage onReady/
        // infoDelivery — without it, web-panel.js's success detection never
        // fires and its failTimer wrongly assumes every embed has failed.
        return ok({ widgetType: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/' + chosen.id + '?autoplay=1&rel=0&modestbranding=1&enablejsapi=1', title: chosen.title, videoId: chosen.id });
      }

      // WEATHER — geocode location, return the Open-Meteo URL for client-side fetch
      if (t === 'weather') {
        var loc = String(location || query || '').trim();
        if (!loc) return fail('A location is required for weather.');
        try {
          // Helper: try a single geocode attempt, return the result or null if no results found
          async function tryGeocode(searchLoc) {
            var geoRes = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(searchLoc));
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
              '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m';
            return ok({ widgetType: 'weather', weatherUrl: weatherUrl, title: 'Weather: ' + hit.name, location: hit.name });
          }

          // If network error on first attempt, fail immediately (don't retry on network failures)
          if (attempt1.error === 'network') return fail(attempt1.msg);

          // If zero results on first attempt, try stripping to just the city name (before first comma)
          if (attempt1.error === 'noresults' && loc.includes(',')) {
            var cityOnly = loc.split(',')[0].trim();
            var attempt2 = await tryGeocode(cityOnly);
            if (attempt2.ok) {
              var hit2 = attempt2.hit;
              var weatherUrl2 = 'https://api.open-meteo.com/v1/forecast?latitude=' + hit2.latitude + '&longitude=' + hit2.longitude +
                '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m';
              return ok({ widgetType: 'weather', weatherUrl: weatherUrl2, title: 'Weather: ' + hit2.name, location: hit2.name });
            }
            // If second attempt also has a network error, fail with that
            if (attempt2.error === 'network') return fail(attempt2.msg);
          }

          // Both attempts returned zero results, or there was no comma to retry on
          return fail('No location found for "' + loc + '".');
        } catch (e) { return fail('Weather lookup failed: ' + e.message); }
      }

      // FLIGHTS — search for flight info, return cards + Google Flights deep-link
      if (t === 'flights') {
        if (!q) return fail('A flight query is required (e.g., "New York to Tokyo").');
        var flightRes = await web_search({ query: 'flights ' + q, maxResults: 5, bus: ctx.bus });
        var cards = (flightRes.ok && flightRes.result && flightRes.result.results) ? flightRes.result.results.map(function(r) {
          return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 200) };
        }) : [];
        var deepLink = 'https://www.google.com/travel/flights?q=' + encodeURIComponent('flights ' + q);
        return ok({ widgetType: 'flights', cards: cards, deepLink: deepLink, title: 'Flights: ' + q, query: q });
      }

      // IMAGE — search for images, return URLs
      if (t === 'image') {
        if (!q) return fail('An image query is required.');
        var imgRes = await web_search({ query: q, maxResults: 6, bus: ctx.bus });
        var imgCards = (imgRes.ok && imgRes.result && imgRes.result.results) ? imgRes.result.results.map(function(r) {
          return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 150) };
        }) : [];
        return ok({ widgetType: 'image', cards: imgCards, title: title || q, query: q });
      }

      // WEB — direct URL embed (validate https scheme).
      // Sites that block framing (X-Frame-Options) get smart-routed instead:
      //   news.google.com  -> existing NEWS widget (server-side RSS)
      //   other blockers    -> open in new browser tab (no iframe attempt)
      if (t === 'web') {
        if (!url) return fail('A URL is required for web embedding.');
        var parsed = null;
        try { parsed = new URL(url); } catch (_) { return fail('Invalid URL: ' + url); }
        if (parsed.protocol !== 'https:') return fail('Only https: URLs can be embedded (security).');
        var host = parsed.hostname.toLowerCase();
        if (host === 'news.google.com' || host === 'www.news.google.com') {
          return ok({ widgetType: 'news', title: title || 'Google News' });
        }
        var NO_EMBED_DOMAINS = ['google.com','facebook.com','twitter.com','x.com',
          'instagram.com','github.com','linkedin.com','reddit.com'];
        for (var d = 0; d < NO_EMBED_DOMAINS.length; d++) {
          if (host === NO_EMBED_DOMAINS[d] || host.endsWith('.' + NO_EMBED_DOMAINS[d])) {
            return ok({ widgetType: 'newtab', url: url, title: title || parsed.hostname });
          }
        }
        return ok({ widgetType: 'web', embedUrl: url, title: title || parsed.hostname });
      }

      // SEARCH (default) — return search result cards
      if (!q) return fail('A search query is required.');
      var searchRes = await web_search({ query: q, maxResults: 6, bus: ctx.bus });
      if (!searchRes.ok || !searchRes.result || !searchRes.result.results || !searchRes.result.results.length) {
        return fail('No results found for "' + q + '".');
      }
      var searchCards = searchRes.result.results.map(function(r) {
        return { title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 200) };
      });
      return ok({ widgetType: 'search', cards: searchCards, title: title || q, query: q, source: searchRes.result.source });

      // Unreachable: the ALLOWED_TYPES guard at the top rejects all other types.
    } catch (err) {
      return fail('open_web failed: ' + err.message);
    }
  }

  // ---- open_artifact ----

  async function open_artifact({ path, title }) {
    try {
      if (!path || !String(path).trim()) {
        return fail('An artifact path is required.');
      }
      const rawPath = String(path).trim();
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
          return fail(`Artifact does not exist: ${rawPath}. Call pipeline_status or job_status to get a real artifact path before opening one.`);
        }
        targetUrl = vaultUrl(vaultRelPath, config);
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
      return ok({ opened: true, url: targetUrl, display });
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
      return ok({ status, recentJobs: jobs, openCommitments });
    } catch (err) {
      return fail(err.message);
    }
  }

  function job_status({ jobId }) {
    try {
      if (jobId) {
        const job = buildRunner.getJob(jobId);
        if (!job) return fail(`No job found with id ${jobId}.`);
        return ok({ job });
      }
      const jobs = buildRunner.listJobs();
      const last = jobs[jobs.length - 1] || null;
      return ok({ job: last });
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
  async function web_fetch({ url }) {
    try {
      if (!url || !String(url).trim()) return fail('A URL is required.');
      const raw = String(url).trim();
      if (!/^https?:\/\//i.test(raw)) return fail('URL must start with http:// or https://');
      const maxChars = 4000;
      var browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

      // Try direct fetch first — fast, no third-party dependency
      try {
        var controller = new AbortController();
        var timer = setTimeout(() => controller.abort(), 15000);
        var res = await fetch(raw, {
          signal: controller.signal,
          headers: { 'User-Agent': browserUA },
          redirect: 'follow',
        });
        clearTimeout(timer);
        if (res.ok) {
          var contentType = res.headers.get('content-type') || '';
          var body = await res.text();
          var text = body;
          if (contentType.includes('text/html')) {
            text = body
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
              .replace(/\s+/g, ' ').trim();
          }
          if (text && text.trim().length > 0) {
            var truncated = text.length > maxChars;
            return ok({
              url: raw,
              status: res.status,
              contentType: contentType.split(';')[0].trim(),
              content: text.slice(0, maxChars),
              truncated: truncated,
              totalLength: text.length,
              source: 'direct',
            });
          }
        }
      } catch (_) { /* Direct fetch failed — fall through to Jina */ }

      // Fallback: Jina Reader — prepend https://r.jina.ai/ to the URL
      try {
        var jinaController = new AbortController();
        var jinaTimer = setTimeout(() => jinaController.abort(), 15000);
        var jinaRes = await fetch('https://r.jina.ai/' + raw, {
          signal: jinaController.signal,
          headers: { 'Accept': 'text/plain' },
        });
        clearTimeout(jinaTimer);
        if (jinaRes.ok) {
          var jinaText = await jinaRes.text();
          if (jinaText && jinaText.trim().length > 0) {
            var jinaTruncated = jinaText.length > maxChars;
            return ok({
              url: raw,
              status: jinaRes.status,
              contentType: 'text/plain',
              content: jinaText.slice(0, maxChars),
              truncated: jinaTruncated,
              totalLength: jinaText.length,
              source: 'jina-reader',
            });
          }
        }
      } catch (_) { /* Jina also failed */ }

      return fail('Fetch failed: all providers returned empty or errored.');
    } catch (err) {
      return fail('Fetch failed: ' + err.message);
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

  // ---- camera_look (server-initiated) ----
  // Provider injected by server/index.js after WS is set up.
  let cameraFrameProvider = null;
  function setCameraFrameProvider(fn) {
    cameraFrameProvider = fn;
  }

  async function camera_look({ query }) {
    try {
      if (!cameraFrameProvider) return fail('Camera is not available — no dashboard is open or the camera is off.');
      var brain = (ctx && ctx.brain) || null;
      var b64 = await cameraFrameProvider();
      if (!b64) return fail('Camera is off or no dashboard is open.');
      if (!brain || typeof brain.think !== 'function') {
        return fail('Screenshot captured but no vision brain is available to describe it.');
      }
      var result = await brain.think({
        lane: 'vision',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: (query ? String(query).slice(0, 300) : 'Describe what is on this screen, briefly and concretely.') },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
          ]
        }],
        source: 'camera-look',
      });
      if (result.offline || !result.content) return fail('Vision providers are offline — cannot describe the camera view.');
      return ok({ description: String(result.content).trim().slice(0, 600) });
    } catch (err) {
      return fail(String(err.message || err));
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
    { name: 'navigate', description: 'Change the dashboard view/route.', params: { route: 'string' }, danger: false, fn: navigate },
    { name: 'close_panel', description: 'Close dashboard panel(s), floating widgets (search/weather/flights/image cards spawned by open_web), AND the Electron media window if one is open (e.g. a YouTube video that will not stop with standard playback controls). Pass all:true to close everything open, omit to close just the top-most one. Reports the real overlaysClosed/widgetsClosed/mediaWindowClosed counts.', params: { all: 'boolean (optional, default false)' }, danger: false, fn: close_panel },
    { name: 'open_web', description: 'Renders a card INSIDE the MYTHOS dashboard — this does NOT open a browser window and is NOT the user\'s browser. Despite the name, open_web never browses: use browser_navigate for "search the web", "look up", "open <site>", or anything the user expects to see in a real browser. Only use open_web when the user asked for an at-a-glance card ON THE HUD. Content is rendered in MYTHOS\'s own UI (dashboard overlay/widget, plus MYTHOS\'s own media window for the youtube/web types). type:"youtube" plays a SPECIFIC video (pass query — the song/topic to search; for "open YouTube" with no video in mind, use launch_app("youtube") instead). type:"weather" shows conditions (pass location). type:"search" shows search result cards (pass query). type:"flights" shows flight results (pass query like "NYC to Tokyo"). type:"image" shows image search results (pass query). type:"web" embeds a direct URL (pass url). search/weather/flights/image open as floating widgets. This is NOT the user\'s real/desktop browser — to open or control the actual browser use browser_navigate / browser_tabs instead.', params: { type: 'string - youtube|weather|search|flights|image|web', query: 'string (optional) - search query or topic', url: 'string (optional) - for type:web', location: 'string (optional) - for type:weather', title: 'string (optional) - custom title' }, danger: false, fn: open_web },
    { name: 'open_artifact', description: 'Open a build result in the system browser. Use this for /vault/builds/... paths instead of browser_navigate when browser automation is offline.', params: { path: 'string', title: 'string (optional)' }, danger: false, fn: open_artifact },
    { name: 'delete_artifact', description: 'Permanently delete a built artifact (the file + its pipeline card) by matching its title or filename. Destructive and irreversible.', params: { query: 'string - the artifact title or name to match' }, danger: true, fn: delete_artifact },
    // REMEDIATION P3-8: needs_result:true added to every status/check/list/
    // read-class tool below — previously dead metadata (adapter.js dropped
    // the field before it reached voice-agent.js), now actually enforced.
    { name: 'read_status', description: 'Read live status of all agents/providers and recent jobs.', params: {}, danger: false, fn: read_status, needs_result: true },
    { name: 'web_fetch', description: 'Fetch text content from a URL (real internet access). Returns the page text (HTML stripped, truncated to ~4000 chars). Use for research, news, documentation, or any real-time data.', params: { url: 'string - the http(s) URL to fetch' }, danger: false, fn: web_fetch, needs_result: true },
    { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets. Use for research, news, or any question requiring current data.', params: { query: 'string - the search query', maxResults: 'number (optional, default 5)' }, danger: false, fn: async function(args) { return web_search(Object.assign({}, args, { bus: ctx.bus })); }, needs_result: true },
    { name: 'job_status', description: 'Check the status of a build job (most recent if jobId omitted). Result includes the artifact path when done and researchStatus (grounded/skipped/not-required) indicating whether the build used live web research.', params: { jobId: 'string (optional)' }, danger: false, fn: job_status, needs_result: true },
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
    { name: 'camera_look', description: 'Capture a frame from the dashboard camera and describe what is visible. Use when you need to see the user, their environment, or objects they are showing.', params: { query: 'string (optional) — what specifically to look for' }, danger: false, fn: camera_look },
    { name: 'daily_plan', description: "Read today's plan, force an immediate re-brief, or quiet the planner for the rest of the day. action:\"status\" reads today's focus/check-ins/review. action:\"replan\" re-runs the morning brief right now. action:\"skip_today\" marks the day quiet — no further morning/check-in/evening firing today.", params: { action: 'string - status|replan|skip_today' }, danger: false, fn: daily_plan },
  ];

  return { TOOLS, setAskAgentDispatch, setCameraFrameProvider, setPlannerHandle, setClosePanelProvider, setMediaWindowCloser };
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
    setCameraFrameProvider: built.setCameraFrameProvider, setPlannerHandle: built.setPlannerHandle,
    setClosePanelProvider: built.setClosePanelProvider, setMediaWindowCloser: built.setMediaWindowCloser
  };
}

module.exports = { registerFromDashboard, buildTools };
