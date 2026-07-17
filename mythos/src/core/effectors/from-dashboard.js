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
// monitor_snapshot/kill_session re-point to effectors/collectors/abtop.js (ctx.abtop),
// copied verbatim from NOVA — see that file's header comment for why no MYTHOS-specific
// rewrite was invented for this NOVA-dashboard-only multi-agent-CLI-session concept.
//
// DEVIATION (same convention as from-project.js): this file receives its collaborators
// via `ctx` (constructed once in main.js's 'effectors' boot step) rather than bare NOVA
// singleton requires, matching every other P7 module's DI convention.

const { effectorFromTool } = require('./adapter');
const { ALL_ROUTES, SYNONYMS } = require('./routes');
const { web_search } = require('./web-search');

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
  const abtop = ctx.abtop;
  const config = ctx.config;
  const fs = ctx.fs;

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
  // Broadcasts a close-panel UI action — the dashboard closes the top panel
  // or all panels depending on the `all` flag.
  function close_panel({ all }) {
    try {
      return ok({ closed: true, all: Boolean(all) }, [{ action: 'close-panel', all: Boolean(all) }]);
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
      var t = String(type || 'search').trim().toLowerCase();
      var q = String(query || '').trim();

      // YOUTUBE — search for the video, extract ID, build embed URL or route to new tab per config
      if (t === 'youtube') {
        if (!q) return fail('A search query is required for YouTube.');
        var ytRes = await web_search({ query: q + ' site:youtube.com', maxResults: 3, bus: ctx.bus });
        if (!ytRes.ok || !ytRes.result || !ytRes.result.results || !ytRes.result.results.length) {
          return fail('No YouTube videos found for "' + q + '".');
        }
        // Extract video ID from the first youtube.com/watch?v= URL
        var videoId = null;
        var videoTitle = title || q;
        for (var i = 0; i < ytRes.result.results.length; i++) {
          var r = ytRes.result.results[i];
          var idM = String(r.url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
          if (idM) { videoId = idM[1]; if (r.title) videoTitle = r.title; break; }
        }
        if (!videoId) return fail('Found results but could not extract a YouTube video ID. Try rephrasing.');
        // Check YOUTUBE_MODE config: if 'newtab', skip embed and open in new tab instead
        var youtubeMode = (config && config.YOUTUBE_MODE) || 'embed';
        if (youtubeMode === 'newtab') {
          return ok({ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=' + videoId, title: videoTitle });
        }
        return ok({ widgetType: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=1&rel=0&modestbranding=1', title: videoTitle, videoId: videoId });
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

      return fail('Unknown web type: ' + t);
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
      if (rawPath.startsWith('/vault/') || rawPath.startsWith('vault/')) {
        const port = process.env.PORT || (config && config.MYTHOS_PORT) || 4478;
        const normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        targetUrl = `http://localhost:${port}${normalized}`;
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
      child.on('error', function() { /* best-effort open — surface nothing, the file may still be reachable via the returned url */ });
      child.unref();
      const display = title || rawPath;
      return ok({ opened: true, url: targetUrl, display }, [{ action: 'navigate', route: 'pipeline' }]);
    } catch (err) {
      return fail(`Could not open artifact: ${err.message}`);
    }
  }

  // ---- status / jobs ----

  async function read_status() {
    try {
      const status = probes ? await probes.getStatus() : null;
      const jobs = buildRunner.listJobs().slice(-5);
      return ok({ status, recentJobs: jobs });
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

  function pipeline_status() {
    try {
      return ok({ board: pipeline.listAll() });
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

  // ---- monitor ----

  function monitor_snapshot() {
    try {
      return ok(abtop.getState());
    } catch (err) {
      return fail(err.message);
    }
  }

  async function kill_session({ pid, agentCli }) {
    try {
      if (!pid || !agentCli) return fail('pid and agentCli are required.');
      await abtop.killSession({ pid: Number(pid), agentCli });
      return ok({ killed: true, pid });
    } catch (err) {
      return fail(err.message);
    }
  }

  const TOOLS = [
    { name: 'navigate', description: 'Change the dashboard view/route.', params: { route: 'string' }, danger: false, fn: navigate },
    { name: 'close_panel', description: 'Close dashboard panel(s). Pass all:true to close all open panels, omit to close just the top one.', params: { all: 'boolean (optional, default false)' }, danger: false, fn: close_panel },
    { name: 'open_web', description: 'Open web content on the dashboard. type:"youtube" plays a video (pass query — the song/topic to search). type:"weather" shows conditions (pass location). type:"search" shows search result cards (pass query). type:"flights" shows flight results (pass query like "NYC to Tokyo"). type:"image" shows image search results (pass query). type:"web" embeds a direct URL (pass url). YouTube and web open as full panels; search/weather/flights open as floating widgets.', params: { type: 'string - youtube|weather|search|flights|image|web', query: 'string (optional) - search query or topic', url: 'string (optional) - for type:web', location: 'string (optional) - for type:weather', title: 'string (optional) - custom title' }, danger: false, fn: open_web },
    { name: 'open_artifact', description: 'Open a build result in the system browser. Use this for /vault/builds/... paths instead of browser_navigate when browser automation is offline.', params: { path: 'string', title: 'string (optional)' }, danger: false, fn: open_artifact },
    { name: 'delete_artifact', description: 'Permanently delete a built artifact (the file + its pipeline card) by matching its title or filename. Destructive and irreversible.', params: { query: 'string - the artifact title or name to match' }, danger: true, fn: delete_artifact },
    { name: 'read_status', description: 'Read live status of all agents/providers and recent jobs.', params: {}, danger: false, fn: read_status },
    { name: 'web_fetch', description: 'Fetch text content from a URL (real internet access). Returns the page text (HTML stripped, truncated to ~4000 chars). Use for research, news, documentation, or any real-time data.', params: { url: 'string - the http(s) URL to fetch' }, danger: false, fn: web_fetch },
    { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets. Use for research, news, or any question requiring current data.', params: { query: 'string - the search query', maxResults: 'number (optional, default 5)' }, danger: false, fn: async function(args) { return web_search(Object.assign({}, args, { bus: ctx.bus })); } },
    { name: 'job_status', description: 'Check the status of a build job (most recent if jobId omitted). Result includes the artifact path when done and researchStatus (grounded/skipped/not-required) indicating whether the build used live web research.', params: { jobId: 'string (optional)' }, danger: false, fn: job_status },
    { name: 'create_goal', description: 'Create a new goal.', params: { text: 'string', category: 'string (optional)' }, danger: false, fn: create_goal },
    { name: 'list_goals', description: 'List all goals.', params: {}, danger: false, fn: list_goals },
    { name: 'toggle_goal', description: 'Toggle a goal done/undone by matching its text.', params: { query: 'string' }, danger: false, fn: toggle_goal },
    { name: 'delete_goal', description: 'Permanently delete a goal by matching its text.', params: { query: 'string' }, danger: true, fn: delete_goal },
    { name: 'capture_idea', description: 'Capture a new idea into the pipeline inbox.', params: { text: 'string' }, danger: false, fn: capture_idea },
    { name: 'pipeline_status', description: 'Read the pipeline board (capture/human-gate/execute/shipped).', params: {}, danger: false, fn: pipeline_status },
    { name: 'pipeline_advance', description: 'Approve or reject a pipeline card by matching its text.', params: { query: 'string', action: '"approve" | "reject"' }, danger: false, fn: pipeline_advance, dangerWhen: (args) => args && args.action === 'reject' },
    // pipeline_execute/kanban_assemble/kanban_build_card: re-tiered T3 -> T2
    // (confirmation-policy pass, sandboxed to vault/builds/) — danger:false
    // to stay consistent with tierOf(); see leash/tiers.js's T2 block comment.
    { name: 'pipeline_execute', description: 'Run the build agent for a pipeline card in the Execute stage.', params: { query: 'string' }, danger: false, fn: pipeline_execute },
    { name: 'kanban_status', description: 'Read the kanban board.', params: {}, danger: false, fn: kanban_status },
    { name: 'kanban_add_card', description: 'Add a new kanban card to a lane.', params: { title: 'string', lane: 'string (optional)' }, danger: false, fn: kanban_add_card },
    { name: 'kanban_move_card', description: 'Move a kanban card to a different lane by matching its title.', params: { query: 'string', lane: 'string' }, danger: false, fn: kanban_move_card },
    { name: 'kanban_assemble', description: 'Run the planner agent to break a goal into several kanban cards.', params: { goal: 'string' }, danger: false, fn: kanban_assemble },
    { name: 'kanban_build_card', description: 'Run the builder agent on a kanban card, producing a deliverable.', params: { query: 'string' }, danger: false, fn: kanban_build_card },
    { name: 'ask_agent', description: 'Ask a specific agent seat a question and get a short reply.', params: { seat: 'string', prompt: 'string' }, danger: false, fn: ask_agent },
    { name: 'monitor_snapshot', description: 'Read the live agent monitor snapshot (running CLI sessions).', params: {}, danger: false, fn: monitor_snapshot },
    { name: 'kill_session', description: 'Kill a running agent CLI session by PID. Irreversible.', params: { pid: 'number', agentCli: 'string' }, danger: true, fn: kill_session },
    { name: 'camera_look', description: 'Capture a frame from the dashboard camera and describe what is visible. Use when you need to see the user, their environment, or objects they are showing.', params: { query: 'string (optional) — what specifically to look for' }, danger: false, fn: camera_look },
  ];

  return { TOOLS, setAskAgentDispatch, setCameraFrameProvider };
}

function registerFromDashboard(hub, ctx) {
  const built = buildTools(ctx);
  for (var i = 0; i < built.TOOLS.length; i++) {
    hub.register(effectorFromTool(built.TOOLS[i]));
  }
  // Return the count AND the ask_agent dispatch injector so main.js can wire it.
  // Previously the injector was discarded here, leaving ask_agent permanently null.
  return { count: built.TOOLS.length, setAskAgentDispatch: built.setAskAgentDispatch, setCameraFrameProvider: built.setCameraFrameProvider };
}

module.exports = { registerFromDashboard, buildTools };
