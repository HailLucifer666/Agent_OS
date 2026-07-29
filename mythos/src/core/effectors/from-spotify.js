'use strict';

// effectors/from-spotify.js — Spotify desktop app control effector.
// Wraps the existing PC automation layer (launch_app, media_key, ui_elements, ui_click, ui_type)
// into a clean Spotify-specific API: play_track, search, play_pause, next, previous, volume.
//
// W2 (Phase 2 — Wiring Integrity): the T3 inner invokes this effector drives
// (ui_click, ui_type, click_at) used to go through raw pcEffectors.invoke() —
// breaker-gated but NO leash check, NO audit trail, NO goal context (task-957
// §24 W2). A T2 spotify_play was silently driving T3 effectors with zero
// traceability. The fix routes those three T3 inner invokes through
// dispatchAction (the shared dispatch surface, Anti-Drift invariant #1) so
// each one writes an audit line. spotify_play's own T2 authorization covers
// the chain — the inner calls do NOT re-trigger a confirm gate (that would
// make every "play me a song" popup a ui_click confirm, which is absurd);
// they only gain the audit + breaker + episodic recording. The T0/T1/T2
// inner invokes (list_windows, ui_elements, media_key, launch_app,
// focus_window, send_key) stay raw — reads shouldn't audit.

const path = require('path');
const { effectorFromTool } = require('./adapter');
const { dispatchAction } = require('./dispatch-action');
// BUG-026: cua-driver tool surface confirmed live against cua-driver-rs 0.8.3
// (2026-07-17) — see adapters/cua-driver/index.js header for the tool list.
// Direct require (not ctx-injected), matching from-pc.js's own pcChild require style.
const cuaDriver = require('../../../adapters/cua-driver');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

// PC effectors + dispatch ctx injected via registerFromSpotify ctx.
// dispatchCtx holds the {bus, memory, goals, config} needed by dispatchAction;
// it stays null in unit tests that only exercise the raw helpers (pre-W2 shape).
let pcEffectors = null;
let dispatchCtx = null;

// W2: route a T3 inner invoke through dispatchAction so it gets an audit line.
// Falls back to raw pcEffectors.invoke when dispatchCtx isn't configured (unit
// tests, or a partial boot), preserving the pre-W2 behavior in those contexts.
async function dispatchInner(tool, args) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  if (dispatchCtx && dispatchCtx.bus && dispatchCtx.memory) {
    try {
      return await dispatchAction(
        { tool, args },
        {
          effectors: pcEffectors,
          bus: dispatchCtx.bus,
          goals: dispatchCtx.goals || null,
          memory: dispatchCtx.memory,
          config: dispatchCtx.config || {},
          goalId: dispatchCtx.goalId || null,
          tier: dispatchCtx.tier || null,
          channel: 'spotify-inner',
        }
      );
    } catch (_) {
      // fall through to raw invoke — never break playback on a dispatch error
    }
  }
  return pcEffectors.invoke(tool, args, {});
}

async function launchSpotifyUri(uri) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  // Use Spotify URI scheme - works for both desktop and Windows Store versions
  return pcEffectors.invoke('launch_app', { name: uri }, {});
}

async function launchSpotify() {
  if (!pcEffectors) return fail('PC effectors not initialized');
  // Use Spotify URI scheme - works for both desktop and Windows Store versions
  return pcEffectors.invoke('launch_app', { name: 'spotify' }, {});
}

async function getSpotifyWindow() {
  if (!pcEffectors) return fail('PC effectors not initialized');
  // Cold-launched Spotify (Chromium) creates its window lazily — a single-shot
  // list_windows right after launch_app races it. Same retry/backoff the
  // cua-driver path uses (cuaPlayViaDriver below); keeps working when
  // cua-driver is OFFLINE.
  const ATTEMPTS = 4;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await pcEffectors.invoke('list_windows', {}, {});
    if (result.ok) {
      const windows = (result.result && result.result.windows) || [];
      const spotifyWindow = windows.find(w =>
        w.processName && w.processName.toLowerCase().includes('spotify')
      );
      if (spotifyWindow) return ok(spotifyWindow);
    }
    if (attempt < ATTEMPTS) await new Promise(r => setTimeout(r, 1200 + attempt * 400));
  }
  return fail('Spotify window not found after ' + ATTEMPTS + ' attempts. Is Spotify running?');
}

async function sendMediaKey(key) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  return pcEffectors.invoke('media_key', { key }, {});
}

async function findSpotifySearchBox(pid) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  const result = await pcEffectors.invoke('ui_elements', { pid, depth: 4 }, {});
  if (!result.ok) return fail(result.result);

  const elements = (result.result && result.result.elements) || [];
  // Find search box - typically an Edit control with "Search" in name/automationId
  const searchBox = elements.find(el =>
    el.type === 'Edit' && (
      (el.name && el.name.toLowerCase().includes('search')) ||
      (el.automationId && el.automationId.toLowerCase().includes('search'))
    )
  );
  if (!searchBox) return fail('Spotify search box not found in UI tree');
  return ok({ pid, elementPath: searchBox.path });
}

async function clickElement(pid, elementPath) {
  // W2: ui_click is T3 — route through dispatchAction so the inner invoke gets
  // an audit line (pre-W2 this was raw pcEffectors.invoke with no leash/audit).
  if (!pcEffectors) return fail('PC effectors not initialized');
  return dispatchInner('ui_click', { pid, elementPath });
}

async function clickAt(x, y) {
  // W2: click_at is T3 — route through dispatchAction for the audit trail.
  if (!pcEffectors) return fail('PC effectors not initialized');
  return dispatchInner('click_at', { x, y });
}

// Finds the play/pause control in a ui_elements tree by name/automationId,
// preferring an actual Button control type when more than one candidate matches.
// Returns the element (with its .rect) or null if nothing looks like a play control.
function findPlayControl(elements) {
  if (!Array.isArray(elements)) return null;
  const candidates = elements.filter(el => {
    if (!el || !el.rect || el.rect.width <= 0 || el.rect.height <= 0) return false;
    const name = (el.name || '').toLowerCase();
    const id = (el.automationId || '').toLowerCase();
    return name.indexOf('play') !== -1 || name.indexOf('pause') !== -1 ||
      id.indexOf('play') !== -1 || id.indexOf('pause') !== -1;
  });
  if (candidates.length === 0) return null;
  const button = candidates.find(el => (el.type || '').toLowerCase().indexOf('button') !== -1);
  return button || candidates[0];
}

async function typeText(pid, elementPath, text) {
  // W2: ui_type is T3 — route through dispatchAction for the audit trail.
  if (!pcEffectors) return fail('PC effectors not initialized');
  return dispatchInner('ui_type', { pid, elementPath, text });
}

// ---- cua-driver element-addressed play path (BUG-026, verified against 0.8.3) ----

function cuaSC(result) {
  return (result && typeof result === 'object' && result.structuredContent) || {};
}

function cuaErrText(result) {
  if (typeof result === 'string') return result;
  if (result && Array.isArray(result.content) && result.content[0] && result.content[0].text) {
    return result.content[0].text.slice(0, 300);
  }
  try { return JSON.stringify(result).slice(0, 300); } catch (_) { return 'unknown cua error'; }
}

function cuaQueryTerms(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
}

// Rank the play controls from a get_window_state elements array against the
// query. Spotify's search page exposes one "Play <label>" button per result
// row (tracks, playlists, albums, artists all mixed in one grid — confirmed
// live: no section info survives into the accessibility tree). Score = query
// terms matched in the label; ties break toward the SHORTER label (the bare
// canonical track beats "<something> — <track>" compilation/playlist cards).
// Selection alone cannot reliably separate a track from a same-named playlist,
// so the caller click-verifies each candidate in order (see cuaPlayViaDriver).
function rankCuaPlayCandidates(elements, query) {
  if (!Array.isArray(elements)) return [];
  const playButtons = elements.filter(e =>
    e && (e.role || '').toLowerCase() === 'button' && /^play\b/i.test(e.label || '')
  );
  const terms = cuaQueryTerms(query);
  if (!terms.length) return playButtons;
  return playButtons
    .map(b => ({
      b,
      score: terms.filter(t => (b.label || '').toLowerCase().includes(t)).length,
      len: (b.label || '').length
    }))
    .filter(s => s.score > 0)
    .sort((a, z) => (z.score - a.score) || (a.len - z.len))
    .map(s => s.b);
}

// Read Spotify's window title via cua-driver — when a track is playing the
// title becomes "Artist - Track", which makes it a cheap playback oracle.
async function cuaSpotifyWindowTitle() {
  const lw = await cuaDriver.invoke('list_windows', {});
  if (!lw.ok) return null;
  const wins = cuaSC(lw.result).windows || [];
  const w = wins.find(x => (x.app_name || '').toLowerCase().includes('spotify'));
  return w ? (w.title || null) : null;
}

// Full cua-driver play flow: find Spotify's window, front it (Chromium only
// exposes its accessibility tree once rendered — confirmed live: minimized
// Spotify returns a 1-element tree, fronted returns 350+), walk the tree with
// warm-up retries (Chromium builds the a11y tree lazily on first UIA query),
// click the play control by element_index (background delivery first; the
// driver returns a structured background_unavailable error for surfaces that
// need real input, in which case the SAME click is re-issued as foreground).
async function cuaPlayViaDriver(query) {
  const lw = await cuaDriver.invoke('list_windows', {});
  if (!lw.ok) return fail(`cua list_windows: ${cuaErrText(lw.result)}`);
  const wins = cuaSC(lw.result).windows || [];
  const w = wins.find(x => (x.app_name || '').toLowerCase().includes('spotify'));
  if (!w) return fail('cua: no Spotify window found');

  await cuaDriver.invoke('bring_to_front', { pid: w.pid, window_id: w.window_id });

  // Walk the tree until QUERY-MATCHED play buttons appear — not merely until the
  // tree is non-trivial. Two live-confirmed reasons a walk comes back useless:
  // (a) Chromium builds its accessibility tree lazily on the first UIA query
  // (minimized Spotify exposes 1 element, fronted 350+), and (b) back-to-back
  // searches can serve the PREVIOUS query's still-rendered results page for a
  // couple seconds — its buttons exist but don't match this query.
  let elements = [];
  let candidates = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 0 ? 1200 : 2000));
    const gws = await cuaDriver.invoke('get_window_state', {
      pid: w.pid, window_id: w.window_id, include_screenshot: false, max_elements: 5000
    });
    if (!gws.ok) continue;
    elements = cuaSC(gws.result).elements || [];
    candidates = rankCuaPlayCandidates(elements, query);
    if (candidates.length) break;
  }
  if (!elements.length) return fail('cua: empty accessibility tree from Spotify window');
  if (!candidates.length) return fail(`cua: no play control matching the query among ${elements.length} elements`);

  // Click-verify loop (confirmed live 2026-07-17): selection alone can pick a
  // same-named playlist over the track, so after each click the window title
  // ("Artist - Track" while playing) is checked against the query; a mismatch
  // moves on to the next-best candidate. Max 3 attempts keeps voice latency
  // bounded (~15s worst case) while self-correcting the playlist-vs-track case.
  const terms = cuaQueryTerms(query);
  // Strict-majority term match — anything laxer is fooled by the artist name
  // alone (live-confirmed twice: "Queen - Somebody To Love" passed for
  // "Bohemian Rhapsody Queen" at 1-of-3, and "The Weeknd - Cry For Me" passed
  // for "Starboy Weeknd" at 1-of-2, both because a same-named playlist started
  // a different song by the right artist). ceil(0.6n): 1→1, 2→2, 3→2, 4→3 —
  // the playing window title ("Artist - Track") carries both artist and track,
  // so a correct play always clears this bar.
  const requiredMatches = Math.max(1, Math.ceil(terms.length * 0.6));
  let lastClicked = null;
  for (const target of candidates.slice(0, 4)) {
    const clickArgs = { pid: w.pid, window_id: w.window_id, element_index: target.element_index };
    let click = await cuaDriver.invoke('click', clickArgs);
    // Escalate to foreground on either signal (confirmed live against Spotify):
    // (a) a structured background_unavailable error, or (b) an "ok" response
    // whose structuredContent says verified:false — Chromium silently DROPS
    // posted background clicks (Spotify's play buttons are hover-rendered DOM),
    // so an unverified background post means nothing happened. The foreground
    // SendInput click is what actually starts playback (SMTC-oracle proven).
    const bgUnverified = click.ok && cuaSC(click.result).verified === false;
    if (bgUnverified || (!click.ok && /background_unavailable/i.test(cuaErrText(click.result)))) {
      click = await cuaDriver.invoke('click', { ...clickArgs, delivery_mode: 'foreground' });
    }
    if (!click.ok) continue;
    lastClicked = target;

    await new Promise(r => setTimeout(r, 2500));
    const title = (await cuaSpotifyWindowTitle()) || '';
    const matched = terms.filter(t => title.toLowerCase().includes(t)).length;
    if (matched >= requiredMatches) {
      return ok({ clickedElement: target.label || null, verified: true, nowPlaying: title });
    }
  }
  if (!lastClicked) return fail('cua: every candidate click failed');
  // Clicked but the playing title never matched the query — report honestly
  // (BUG-007 discipline) instead of claiming the requested song is on.
  return ok({
    clickedElement: lastClicked.label || null,
    verified: false,
    note: 'clicked a play control but the playing title did not match the query'
  });
}

async function searchAndPlay({ query, pid }) {
  // Find and click search box
  const searchBoxResult = await findSpotifySearchBox(pid);
  if (!searchBoxResult.ok) return searchBoxResult;

  const { elementPath: searchBoxPath } = searchBoxResult.result;

  // Click search box to focus
  const clickResult = await clickElement(pid, searchBoxPath);
  if (!clickResult.ok) return clickResult;

  // Type search query
  const typeResult = await typeText(pid, searchBoxPath, query);
  if (!typeResult.ok) return typeResult;

  // Wait for results to load
  await new Promise(r => setTimeout(r, 1500));

  // Find first track result and click it
  const resultsResult = await pcEffectors.invoke('ui_elements', { pid, depth: 5 }, {});
  if (!resultsResult.ok) return resultsResult;

  const elements = (resultsResult.result && resultsResult.result.elements) || [];
  // Look for track items - typically ListItem or DataItem with track info
  const trackItems = elements.filter(el =>
    el.type === 'ListItem' || el.type === 'DataItem'
  );

  if (trackItems.length === 0) {
    // Fallback: just press Enter in search box to play first result
    const enterResult = await typeText(pid, searchBoxPath, '\r');
    return enterResult;
  }

  // Try to find best match using the full query
  const queryLower = query.toLowerCase();
  // Remove common filler words
  const queryWords = queryLower.split(' ').filter(w =>
    !['by', 'the', 'a', 'an', 'and', 'or', 'play', 'song', 'track'].includes(w)
  );

  // Score each track item by how many query words it contains
  let bestMatch = null;
  let bestScore = 0;

  for (const item of trackItems) {
    if (!item.name) continue;
    const nameLower = item.name.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (nameLower.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  // If we found a reasonable match, click it; otherwise play first result
  if (bestMatch && bestScore > 0) {
    return clickElement(pid, bestMatch.path);
  }

  // Fallback: press Enter to play first result
  const enterResult = await typeText(pid, searchBoxPath, '\r');
  return enterResult;
}

// ---- Spotify Tool Implementations ----

async function spotify_play_pause() {
  return sendMediaKey('play_pause');
}

async function spotify_next() {
  return sendMediaKey('next_track');
}

async function spotify_previous() {
  return sendMediaKey('prev_track');
}

// REMEDIATION P1-8: "reduce the volume to 20%" was not expressible — this
// only ever took a fixed up/down/mute step, so the voice agent compensated
// by spamming direction:'down' repeatedly and never actually converged on a
// target (see the 2026-07-29 audit). `level` (0-100) sets the exact system
// master volume via set_volume (real Core Audio API, see ps-automation.ps1's
// Get-AudioEndpointVolumeType) instead of guessing a step count.
async function spotify_volume({ direction, level }) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  if (level !== undefined && level !== null && level !== '') {
    const lvl = Number(level);
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 100) return fail(`level must be a number between 0 and 100 (got ${level})`);
    return pcEffectors.invoke('set_volume', { level: Math.round(lvl) }, {});
  }
  if (!direction) return fail('Either level (0-100) or direction (up, down, or mute) is required');
  const keyMap = { up: 'volume_up', down: 'volume_down', mute: 'volume_mute' };
  const key = keyMap[direction.toLowerCase()];
  if (!key) return fail(`Invalid direction: ${direction}. Use up, down, or mute`);
  return sendMediaKey(key);
}

async function spotify_play({ query, trackId }) {
  // If trackId provided, use direct Spotify track URI (starts playing immediately)
  if (trackId) {
    return launchSpotifyUri(`spotify:track:${trackId}`);
  }

  if (!query) return fail('Either query or trackId is required');

  // spotify:search:<query> opens Spotify directly to search results page.
  const searchUri = `spotify:search:${encodeURIComponent(query)}`;
  const searchResult = await launchSpotifyUri(searchUri);
  if (!searchResult.ok) return searchResult;

  // Wait for the search results page to fully render.
  await new Promise(r => setTimeout(r, 2500));

  // Focus the Spotify window before doing anything else — otherwise a click
  // or keystroke can land on whatever window currently has OS focus instead
  // of Spotify. Best-effort: if the window can't be found or focus_window
  // itself fails, still fall through to the rest of the flow (matches the
  // prior fire-and-hope behavior), but carry the focus problem in the result
  // instead of hiding it.
  let focusWarning = null;
  const win = await getSpotifyWindow();
  if (win.ok) {
    const focusResult = await pcEffectors.invoke('focus_window', { pid: win.result.pid }, {});
    if (!focusResult.ok) focusWarning = `focus_window failed: ${focusResult.result}`;
  } else {
    focusWarning = `could not focus Spotify before playback: ${win.result}`;
  }

  // BUG-026 (5th attempt, 2026-07-17): cua-driver element-addressed click, fully
  // independent of the legacy ui_elements walk below. The driver walks Spotify's
  // real Chromium accessibility tree (with warm-up retries) and clicks the
  // per-track "Play <title> by <artist>" button by element_index — no pixel
  // guessing, no focus guessing. Adapter OFFLINE (binary absent) skips this
  // block entirely; any cua failure falls through to the click_at tier unchanged.
  if (cuaDriver.getStatus().state === 'ONLINE') {
    const cuaResult = await cuaPlayViaDriver(query);
    if (cuaResult.ok) {
      return ok({ ...cuaResult.result, method: 'cua-driver', focusWarning });
    }
    focusWarning = focusWarning
      ? `${focusWarning}; cua-driver path failed: ${cuaResult.result}`
      : `cua-driver path failed: ${cuaResult.result}`;
  }

  // BUG-026 (3rd attempt): the previous two fixes (focus+Enter, then
  // focus+Tab+Enter) both used keystrokes to *guess* which UI element has
  // focus — live testing showed Enter kept landing back in the search box
  // instead of a result tile. A pixel-coordinate click doesn't guess: walk
  // the UIA tree for the play/pause control's actual bounding rect and click
  // its center directly via click_at.
  if (win.ok) {
    const elementsResult = await pcEffectors.invoke('ui_elements', { pid: win.result.pid, depth: 6 }, {});
    if (elementsResult.ok) {
      const elements = (elementsResult.result && elementsResult.result.elements) || [];
      const playControl = findPlayControl(elements);
      if (playControl) {
        const cx = Math.round(playControl.rect.x + playControl.rect.width / 2);
        const cy = Math.round(playControl.rect.y + playControl.rect.height / 2);

        const clickResult = await clickAt(cx, cy);
        if (clickResult.ok) {
          const extra = (clickResult.result && typeof clickResult.result === 'object') ? clickResult.result : {};
          return ok({ ...extra, method: 'click_at', x: cx, y: cy, focusWarning });
        }
        // click_at failed — fall through to the keystroke fallback below,
        // carrying the failure reason instead of silently dropping it.
        focusWarning = focusWarning
          ? `${focusWarning}; click_at failed: ${clickResult.result}`
          : `click_at failed: ${clickResult.result}`;
      }
    }
  }

  // Fallback: no identifiable play control was found via ui_elements (or
  // ui_elements/click_at itself failed) — fall back to the prior keystroke
  // path (Tab off the search box, then Enter) rather than failing outright.
  // Same BUG-007 non-fabrication discipline as before: if send_key ultimately
  // fails too, this still surfaces ok:false rather than claiming success.
  const tabResult = await pcEffectors.invoke('send_key', { key: 'tab' }, {});
  let tabWarning = null;
  if (!tabResult.ok) tabWarning = `send_key(tab) failed: ${tabResult.result}`;

  // Send a real VK_RETURN keystroke (not Unicode char) — Chromium/Electron
  // apps like Spotify require a genuine virtual key, not a WM_CHAR event.
  const keyResult = await pcEffectors.invoke('send_key', { key: 'enter' }, {});
  const warnings = [focusWarning, tabWarning].filter(Boolean);
  if (warnings.length === 0) {
    if (!keyResult.ok) return keyResult;
    const extra = (keyResult.result && typeof keyResult.result === 'object') ? keyResult.result : {};
    return ok({ ...extra, method: 'keystroke_fallback' });
  }
  if (!keyResult.ok) return fail(`${keyResult.result} (also: ${warnings.join('; ')})`);
  const extra = (keyResult.result && typeof keyResult.result === 'object') ? keyResult.result : {};
  return ok({ ...extra, method: 'keystroke_fallback', focusWarning, tabWarning });
}

async function spotify_search({ query }) {
  if (!query) return fail('Search query is required');

  const launchResult = await launchSpotify();
  if (!launchResult.ok) return launchResult;

  await new Promise(r => setTimeout(r, 2000));

  const windowResult = await getSpotifyWindow();
  if (!windowResult.ok) return windowResult;

  const pid = windowResult.result.pid;
  const searchBoxResult = await findSpotifySearchBox(pid);
  if (!searchBoxResult.ok) return searchBoxResult;

  const { elementPath: searchBoxPath } = searchBoxResult.result;

  const clickResult = await clickElement(pid, searchBoxPath);
  if (!clickResult.ok) return clickResult;

  const typeResult = await typeText(pid, searchBoxPath, query);
  if (!typeResult.ok) return typeResult;

  await new Promise(r => setTimeout(r, 1500));

  // Get search results
  const resultsResult = await pcEffectors.invoke('ui_elements', { pid, depth: 5 }, {});
  if (!resultsResult.ok) return resultsResult;

  const elements = (resultsResult.result && resultsResult.result.elements) || [];
  const tracks = elements
    .filter(el => el.type === 'ListItem' || el.type === 'DataItem')
    .slice(0, 10)
    .map(el => ({
      name: el.name,
      automationId: el.automationId,
      path: el.path
    }));

  return ok({ query, tracks, count: tracks.length });
}

// Spotify's window title is "Spotify"/"Spotify Free"/"Spotify Premium" while
// idle and becomes "Artist - Track" (literal " - " separator) the instant
// something plays — the same title oracle cuaPlayViaDriver's click-verify
// loop already relies on (cuaSpotifyWindowTitle above). running !== playing:
// Spotify can sit open and paused for hours.
function looksLikePlayingTitle(title) {
  const t = String(title || '').trim();
  if (!t || /^spotify(\s+(free|premium))?$/i.test(t)) return false;
  return t.indexOf(' - ') !== -1;
}

async function spotify_status() {
  const windowResult = await getSpotifyWindow();
  if (!windowResult.ok) return ok({ running: false, playing: false, reason: windowResult.result });

  const title = windowResult.result.title;
  return ok({
    running: true,
    playing: looksLikePlayingTitle(title),
    pid: windowResult.result.pid,
    title: title,
    processName: windowResult.result.processName
  });
}

// ---- Tool Catalog ----

const TOOLS = [
  {
    name: 'spotify_play_pause',
    description: 'Pause or resume Spotify playback. Use for "pause", "pause the music", "stop the song", "resume", "unpause", or "play" when no new track is named.',
    params: {},
    danger: false,
    fn: spotify_play_pause
  },
  {
    name: 'spotify_next',
    description: 'Skip to the next track on Spotify. Use for "next track", "skip", "next song", "skip this one".',
    params: {},
    danger: false,
    fn: spotify_next
  },
  {
    name: 'spotify_previous',
    description: 'Go back to the previous track on Spotify. Use for "previous track", "go back", "last song", "play that again".',
    params: {},
    danger: false,
    fn: spotify_previous
  },
  {
    name: 'spotify_volume',
    description: 'Adjust or set system volume (Spotify plays through the system output, same volume control). Prefer level for an exact target ("set volume to 20%", "reduce to 20"); use direction for relative nudges ("volume up", "louder", "mute").',
    params: {
      level: 'number (optional) - exact target volume 0-100, preferred when the user gives a percentage',
      direction: 'string (optional) - up, down, or mute; required only if level is omitted'
    },
    danger: false,
    fn: spotify_volume
  },
  {
    name: 'spotify_play',
    description: 'Play a specific track on Spotify. Provide either a search query (song name, artist) or a Spotify track ID.',
    params: {
      query: 'string (optional) - search query like "Bohemian Rhapsody Queen"',
      trackId: 'string (optional) - Spotify track ID like "3z8h0TU7ReDPLIbEnYhWZb"'
    },
    danger: false,
    fn: spotify_play
  },
  {
    name: 'spotify_search',
    description: 'Search Spotify for tracks/artists/albums and return results.',
    params: { query: 'string - search query' },
    danger: false,
    fn: spotify_search
  },
  {
    name: 'spotify_status',
    description: 'Check whether Spotify is running AND whether something is actually playing right now (playing:true/false, derived from the window title). Use this before ever claiming a song "is playing."',
    params: {},
    danger: false,
    fn: spotify_status,
    needs_result: true
  }
];

function registerFromSpotify(hub, ctx) {
  // Store PC effectors reference for delegation
  pcEffectors = ctx.effectors;
  // W2: capture the dispatch deps (bus, memory, goals, config) so inner T3
  // invokes can route through dispatchAction and leave an audit trail.
  // Older callers that omit these fall back to raw pcEffectors.invoke
  // (the pre-W2 behavior) — see dispatchInner above.
  dispatchCtx = {
    bus: ctx.bus || null,
    memory: ctx.memory || null,
    goals: ctx.goals || null,
    config: ctx.config || null,
  };

  for (let i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromSpotify,
  TOOLS,
  spotify_play_pause,
  spotify_next,
  spotify_previous,
  spotify_volume,
  spotify_play,
  spotify_search,
  spotify_status
};