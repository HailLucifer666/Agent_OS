'use strict';

// provider-cooldown.js — stop paying a timeout for a provider that is gone.
//
// THE BUG THIS EXISTS FOR (measured 2026-08-26). A `web_search` call took 32.4
// seconds and answered the wrong thing. Twenty of those seconds were two
// DuckDuckGo rungs each burning a full 10s PROVIDER_TIMEOUT against a host this
// network cannot reach at all: html/lite.duckduckgo.com resolve to
// 20.204.244.192 through the local resolver AND through Cloudflare DoH (so not a
// DNS hijack), and TCP :443 blackholes — eight seconds, no RST. Every call paid
// that again.
//
// A suppression mechanism already existed and could not help. healer.js's
// `suppress-search-provider` playbook rests a provider for a flat **30 seconds**,
// in memory, reset every boot — built for a provider having a bad minute, not one
// that is permanently unreachable. Worse, it is driven by a `search-provider-failed`
// anomaly on the bus, and web-search.js's traceBus forwards `if (bus)`. The
// autonomous path and most callers pass no bus, so on those paths the playbook
// NEVER fires and the suppression never happens. An inert mechanism that reads
// as coverage.
//
// WHY THIS IS NOT A HARDCODED DISABLE LIST. The obvious fix — default
// WEB_SEARCH_DISABLED_PROVIDERS to 'ddg-html,ddg-lite' — encodes ONE machine's
// network into a tracked file, and MYTHOS is open source (see CLAUDE.md's
// portability rule). DuckDuckGo is reachable from most networks. So the rule is
// behavioural rather than geographic: whatever fails repeatedly steps aside for
// progressively longer, and whatever recovers is restored immediately by its
// first success. A machine where DDG works never triggers this at all; a machine
// where it is blocked stops paying for it after one call.
//
// The ladder is deliberately steep at the front. A provider that fails once is
// skipped for a minute — cheap to be wrong about, because the chain has other
// rungs and a genuine blip costs only that minute. It is the fourth consecutive
// failure that buys a day.
//
// Independent of healer.js's suppression on purpose: that one is the immune
// system's deliberate rest, this one is the chain's own memory of what just
// failed. web-search.js consults both, and reports them as different causes,
// because "the immune system is resting this" and "this has failed four times in
// a row" are different things to tell an operator.

// Consecutive-failure count -> how long to skip the provider. The last entry
// applies to every count beyond the table.
const DEFAULT_LADDER_MS = [
  60 * 1000,            // 1st failure — a minute. Assume a blip.
  5 * 60 * 1000,        // 2nd — five minutes.
  60 * 60 * 1000,       // 3rd — an hour.
  24 * 60 * 60 * 1000,  // 4th and beyond — a day.
];

function humanise(ms) {
  if (ms >= 60 * 60 * 1000) {
    const h = Math.round(ms / (60 * 60 * 1000));
    return h + (h === 1 ? ' hour' : ' hours');
  }
  if (ms >= 60 * 1000) {
    const m = Math.round(ms / (60 * 1000));
    return m + (m === 1 ? ' minute' : ' minutes');
  }
  return Math.max(1, Math.round(ms / 1000)) + 's';
}

// createProviderCooldown({ ladderMs, now }) -> cooldown
//
// `now` is injectable so a test can drive the clock without sleeping, but every
// method also works against the real clock — this repo has been bitten by a
// frozen fake clock hiding the very timer logic under test, so the default is
// real time and the fake is opt-in per test.
function createProviderCooldown(opts) {
  const o = opts || {};
  const ladder = Array.isArray(o.ladderMs) && o.ladderMs.length ? o.ladderMs.slice() : DEFAULT_LADDER_MS.slice();
  const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };

  // provider -> { count, until, lastError }
  const state = Object.create(null);

  function ttlFor(count) {
    const i = Math.min(Math.max(count, 1), ladder.length) - 1;
    return ladder[i];
  }

  // recordFailure(provider, error) -> { count, until, ttlMs }
  //
  // `error` is kept so the skip reason can name the ORIGINAL cause. A skip that
  // says only "cooling down" replaces one diagnosis with none — the operator
  // still needs to know it was a timeout, or a 429, or a 401.
  function recordFailure(provider, error) {
    if (!provider) return null;
    const prev = state[provider];
    const count = (prev && prev.count ? prev.count : 0) + 1;
    const ttlMs = ttlFor(count);
    state[provider] = {
      count: count,
      until: now() + ttlMs,
      lastError: error ? String(error).slice(0, 200) : (prev && prev.lastError) || null,
    };
    return { count: count, until: state[provider].until, ttlMs: ttlMs };
  }

  // A single success clears the whole ladder. Deliberate: a provider that
  // answers is working, and making it climb back down would keep punishing a
  // recovered endpoint for an outage that is over.
  function recordSuccess(provider) {
    if (provider) delete state[provider];
  }

  // reason(provider) -> null when the provider should be tried, else a string
  // naming why it is being skipped AND what originally went wrong.
  function reason(provider) {
    const entry = state[provider];
    if (!entry) return null;
    if (entry.until <= now()) {
      // Expired. Clear the deadline but KEEP the count, so a provider that is
      // still broken escalates on its next failure instead of restarting the
      // ladder at one minute forever. Only a success resets the count.
      state[provider] = { count: entry.count, until: 0, lastError: entry.lastError };
      return null;
    }
    const left = humanise(entry.until - now());
    const because = entry.lastError ? ' after ' + entry.lastError : '';
    return 'cooling down for ' + left + ' (' + entry.count
      + (entry.count === 1 ? ' consecutive failure' : ' consecutive failures') + because + ')';
  }

  // Read-only view, for tests and for a future health surface. Returns a copy so
  // a caller cannot mutate the cooldown's state by holding its snapshot.
  function snapshot() {
    const out = {};
    for (const k of Object.keys(state)) out[k] = Object.assign({}, state[k]);
    return out;
  }

  function reset() {
    for (const k of Object.keys(state)) delete state[k];
  }

  return {
    recordFailure: recordFailure,
    recordSuccess: recordSuccess,
    reason: reason,
    snapshot: snapshot,
    reset: reset,
  };
}

// An explicit operator override, for a provider known to be unavailable on this
// machine (a corporate proxy, a national block). Comma-separated provider KEYS —
// the same strings web-search.js gates on ('ddg-html', 'ddg-lite', 'jina',
// 'wikipedia', 'local-websearch', 'exa', 'exa-mcp', 'google-news-rss'), not the
// success-path source labels, which differ.
//
// Deliberately EMPTY by default, and it lives here beside the automatic ladder
// because the two are the same decision made twice: this one is the operator
// asserting a provider is gone, the ladder is the chain working it out. A
// default naming real providers would encode one machine's network into a
// tracked file, on an open-source project.
function disabledProviders(env) {
  return String((env || process.env).WEB_SEARCH_DISABLED_PROVIDERS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

module.exports = {
  disabledProviders: disabledProviders,
  createProviderCooldown: createProviderCooldown,
  DEFAULT_LADDER_MS: DEFAULT_LADDER_MS,
  _humanise: humanise,
};
