'use strict';

// effectors/from-spotify.js — Spotify desktop app control effector.
// Wraps the existing PC automation layer (launch_app, media_key, ui_elements, ui_click, ui_type)
// into a clean Spotify-specific API: play_track, search, play_pause, next, previous, volume.

const path = require('path');
const { effectorFromTool } = require('./adapter');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

// PC effectors will be injected via ctx in registerFromSpotify
let pcEffectors = null;

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
  const result = await pcEffectors.invoke('list_windows', {}, {});
  if (!result.ok) return fail(result.result);
  const windows = result.result.windows || [];
  const spotifyWindow = windows.find(w =>
    w.processName && w.processName.toLowerCase().includes('spotify')
  );
  if (!spotifyWindow) return fail('Spotify window not found. Is Spotify running?');
  return ok(spotifyWindow);
}

async function sendMediaKey(key) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  return pcEffectors.invoke('media_key', { key }, {});
}

async function findSpotifySearchBox(pid) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  const result = await pcEffectors.invoke('ui_elements', { pid, depth: 4 }, {});
  if (!result.ok) return fail(result.result);

  const elements = result.result.elements || [];
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
  if (!pcEffectors) return fail('PC effectors not initialized');
  return pcEffectors.invoke('ui_click', { pid, elementPath }, {});
}

async function typeText(pid, elementPath, text) {
  if (!pcEffectors) return fail('PC effectors not initialized');
  return pcEffectors.invoke('ui_type', { pid, elementPath, text }, {});
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

  const elements = resultsResult.result.elements || [];
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

async function spotify_volume({ direction }) {
  if (!direction) return fail('Direction required: up, down, or mute');
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
  // The first track is auto-focused in the results list.
  const searchUri = `spotify:search:${encodeURIComponent(query)}`;
  const searchResult = await launchSpotifyUri(searchUri);
  if (!searchResult.ok) return searchResult;

  // Wait for the search results page to fully render.
  await new Promise(r => setTimeout(r, 2500));

  // Send a real VK_RETURN keystroke (not Unicode char) — Chromium/Electron
  // apps like Spotify require a genuine virtual key, not a WM_CHAR event.
  // This plays the first focused track in the results list.
  return pcEffectors.invoke('send_key', { key: 'enter' }, {});
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

  const elements = resultsResult.result.elements || [];
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

async function spotify_status() {
  const windowResult = await getSpotifyWindow();
  if (!windowResult.ok) return ok({ running: false, reason: windowResult.result });

  // Could add screen_look to see what's playing
  return ok({
    running: true,
    pid: windowResult.result.pid,
    title: windowResult.result.title,
    processName: windowResult.result.processName
  });
}

// ---- Tool Catalog ----

const TOOLS = [
  {
    name: 'spotify_play_pause',
    description: 'Toggle play/pause on Spotify.',
    params: {},
    danger: false,
    fn: spotify_play_pause
  },
  {
    name: 'spotify_next',
    description: 'Skip to next track on Spotify.',
    params: {},
    danger: false,
    fn: spotify_next
  },
  {
    name: 'spotify_previous',
    description: 'Go to previous track on Spotify.',
    params: {},
    danger: false,
    fn: spotify_previous
  },
  {
    name: 'spotify_volume',
    description: 'Adjust Spotify volume.',
    params: { direction: 'string - up, down, or mute' },
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
    description: 'Check if Spotify is running and get window info.',
    params: {},
    danger: false,
    fn: spotify_status
  }
];

function registerFromSpotify(hub, ctx) {
  // Store PC effectors reference for delegation
  pcEffectors = ctx.effectors;

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