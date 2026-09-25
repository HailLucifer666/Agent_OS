'use strict';
// action-semantics.js — what did one tool call DO, and to WHAT? B2b-2 of the Stage 1 repair
// campaign (2026-09-26), BUG-448. Pure: no IO, no clock. The Live adapter stamps every action
// row with describeAction(tool, args, result) as `act`, and claim-backing.js reads it.
//
// WHY. The claim checker backed a sentence by the NAME of the tool that ran. A replay of 2102
// Live turns (40 of main's 64 flags wrong; 29 of those about backing) showed what that costs:
//   - "Very well, launching Chrome now." retracted: browser_launch_debug was on no list;
//   - "Opening YouTube in a debug Brave window right now." is FALSE (only Brave launched, and
//     the YouTube open failed), so putting that tool on the list by name would silence it;
//   - "Closing the first tab on this browser for you now." retracted: browser_tabs was on no
//     list, and by name its `list` action would back it as well as its `close`.
// So a row now says what it did (`op`) and to what (`target`), read from its own arguments
// and result. The contract (rev 8 B2): listing tabs cannot back "closed a tab"; closing tab A
// cannot back closing tab B.
//
// OPS ARE DERIVED FROM THE TOOL NAME AND ITS ARGUMENTS, not typed per tool. BUG-398 row 7 and
// BUG-441 were both a hand-kept tool list missing the tool that really ran; a name rule
// covers the next open_* or *click* tool without an edit here. Anything no rule names is
// 'other', which backs only what it backed before this file existed (claim-backing.js).

const MAX_TARGET_CHARS = 240;
const MAX_VALUE_CHARS = 60;
// The arguments that name what a call acted ON, the short identity ones first so a long query
// cannot push them past the cap. A message body is not a target: for a send, `to` is. `text`
// is a target only for a click (see_and_click's label), never for typing.
const TARGET_ARGS = ['type', 'browser', 'browserName', 'name', 'app', 'to', 'match', 'key', 'action',
  'url', 'route', 'path', 'title', 'jobId', 'query', 'selector'];
const TAB_OPS = { close: 'close-tab', new: 'open-tab', switch: 'switch-tab' };

// First match wins. A rule is [name test, op or (args) => op].
const OP_RULES = [
  [/click/, 'click'],
  [/^media_key$/, (a) => (/play|pause|next|prev|stop/i.test(String(a.key || '')) ? 'play' : 'key')],
  [/key/, 'key'],
  [/_send$/, 'send'],
  [/^browser_tabs$/, (a) => TAB_OPS[String(a.action || '').toLowerCase()] || 'list-tabs'],
  // browser_switch "calls browser_launch_debug for you" (its own refusal text, from-browser.js).
  [/launch_debug$|^browser_switch$/, 'launch-browser'],
  [/(?:^|_)app_launch$|^launch_app$/, 'launch-app'],
  [/^open_web$|navigate$/, 'open-web'],
  [/^open_/, (a, tool) => 'open-' + tool.slice('open_'.length)],
  [/^close_|_close$/, 'close'],
  [/(?:^|_)(?:play|next|previous)(?:_|$)|media_control$/, 'play'],
  [/search/, 'search'],
];

function opOf(tool, args) {
  const name = String(tool || '');
  for (const [test, op] of OP_RULES) if (test.test(name)) return typeof op === 'function' ? op(args, name) : op;
  return 'other';
}

// B2b-3 (2026-09-26): what a PLAYER was observed doing, read from the result's own shape, so any
// tool whose result carries a reading supplies it and none is named here:
//   the browser capsule (BUG-462)  state.video.playing, with the page title and url   -> 'page'
//   media_status, spotify_status   playing, with title, artist and source            -> 'media'
//   spotify_play                   nowPlaying, read from Spotify's window title       -> 'media'
// spotify_play's nowPlaying counts as playing even unverified: its own note says "a click DID
// land and something is playing", just not what was asked. The page capsule is ONE sample taken
// a moment after the action, and YouTube often starts a second later: a paused sample is not
// proof it stayed paused, which is why the claim checker's correction says "not confirmed".
function playerOf(r) {
  const video = (r.state && r.state.video) || r.video;
  const cap = (parts) => parts.filter((p) => typeof p === 'string' && p).join(' ').slice(0, MAX_TARGET_CHARS);
  if (video && typeof video.playing === 'boolean') {
    return { source: 'page', playing: video.playing, what: cap([r.state && r.state.title, r.title, (r.state && r.state.url) || r.url]) };
  }
  if (typeof r.playing === 'boolean') return { source: 'media', playing: r.playing, what: cap([r.title, r.artist, r.source]) };
  if (typeof r.nowPlaying === 'string' && r.nowPlaying) return { source: 'media', playing: true, what: cap([r.nowPlaying]) };
  return null;
}

function describeAction(tool, args, result) {
  const a = args && typeof args === 'object' ? args : {};
  const r = result && typeof result === 'object' ? result : {};
  const op = opOf(tool, a);
  const parts = [];
  for (const key of TARGET_ARGS) if (a[key] !== undefined && a[key] !== null && typeof a[key] !== 'object') parts.push(String(a[key]).slice(0, MAX_VALUE_CHARS));
  if (op === 'click' && typeof a.text === 'string') parts.push(a.text.slice(0, MAX_VALUE_CHARS));
  // The launched browser is in the RESULT when the call named none (the default browser).
  if (op === 'launch-browser' && typeof r.browser === 'string') parts.push(r.browser);
  const act = { op, target: parts.join(' ').slice(0, MAX_TARGET_CHARS) };
  // A call that took a query searched, whatever else it did (spotify_play searches, then plays).
  if (typeof a.query === 'string' && a.query.trim()) act.searched = true;
  const player = playerOf(r);
  if (player) act.player = player;
  // A tab close's result names the REMAINING tab in title/url (from-browser.js browser_tabs),
  // so only the closed index is read from it.
  if (/-tab$/.test(op)) {
    const index = Number.isInteger(r.closed) ? r.closed : Number.isInteger(r.switched) ? r.switched : Number(a.index);
    if (Number.isInteger(index)) act.index = index;
  }
  return act;
}

module.exports = { describeAction, opOf };
