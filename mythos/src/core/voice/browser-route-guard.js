'use strict';
// browser-route-guard.js — BUG-435: one real-browser route per turn.
//
// PURE ON PURPOSE. live-tool-adapter.js sits on its file-size ceiling
// (test/file-size-ratchet.test.js), and this is a decision worth its own test.
//
// THE INCIDENT, Audit 2026-09-10 09:37Z. "Open YouTube on Brave" produced, in
// ONE turn, `open_web({browser:true, url:"https://www.youtube.com",
// browserName:"brave"})` at :47 (handedToBrowser:true — the operator's normal,
// signed-in profile) and then `browser_launch_debug({browser:"brave"})` at :53
// (the cold, signed-out debug profile). Two Brave windows. The operator: "why did
// you open two YouTube? You opened in debug browser and in a default browser."
//
// THE CLASS is "two tools, one intent, prose only" (memory note of that name):
// nothing but description text separates "open it in your browser" from "open it
// in the browser I control", and the model took both. A description can be
// argued with; this guard cannot. Whichever route the turn took FIRST wins, and
// the other route is refused with the fact of what already happened, so the
// model can say so instead of opening a second window.
//
// DECIDED BY THE OPERATOR, 2026-09-10: a NAMED browser means the DEBUG browser.
// "Open YouTube on Brave" is a request for the browser MYTHOS controls, so
// open_web with browser:true AND a browserName is refused before dispatch and
// answered with the two calls that do it properly. The distinction is narrow on
// purpose: open_web browser:true with NO name ("open this in my browser") still
// goes to the operator's default browser, which is the active Stage 1 golden
// path in Plans/RESUME.md and is not touched. The remedy is a structured
// remedy() object rather than a sentence, because a tool taught in prose is the
// class test/remedy-prose-ratchet.test.js exists to stop growing.
//
// THE SET IS DERIVED FROM THE REASON, not from the two tools in the ticket. The
// reason is "a tool that puts a page in front of the operator in a real browser
// window". Operator route: open_web with browser:true (the newtab hand-off to
// the normal profile). Debug route: browser_launch_debug and browser_switch
// (they open the controlled window) AND browser_navigate (it puts a page in that
// window) — open_web browser:true followed by browser_navigate in one turn is the
// same two-windows outcome with a browser already attached from an earlier turn,
// and a guard keyed on the ticket's two names would be blind to it.
//
// GUARD ATTACKED BEFORE SHIPPING (2026-09-10): (1) the same route twice in a
// turn is allowed — two open_web browser:true calls for two URLs is a legitimate
// "open these two pages"; (2) open_web WITHOUT browser:true is a HUD card, not a
// browser route, and must not block a later debug launch; (3) the store this
// reads is the adapter's per-turn executedSignatures, which is cleared at every
// turnComplete, so the guard cannot carry a route across turns — pinned by the
// adapter-level test; (4) an unparseable signature is skipped rather than treated
// as a route (fail closed would refuse legitimate work on a logging artefact).

// THE STORE HAD TO CHANGE, AND THAT WAS A DEFECT IN THE FIRST VERSION OF THIS
// GUARD. It read the adapter's executedSignatures, which isDuplicateSignature
// fills for EVERY non-duplicate call it sees — before the leash, before this
// guard, before any dispatch. So a leash-denied open_web, or one this guard had
// just refused, still poisoned the turn: the following browser_launch_debug was
// told a browser "already opened" when nothing had. A signature store is a proxy
// for "a route was taken"; the route being taken is the thing to record. This
// memory holds routes only and has exactly one writer, at the adapter's single
// pre-dispatch call site, so the bad state cannot be represented rather than
// merely being detected.
function createRouteMemory() {
  const routes = new Map(); // route -> the call that took it
  return {
    note(name, args) {
      const route = browserRouteOf(name, args);
      if (route && !routes.has(route)) routes.set(route, { name, args: args || {} });
    },
    check(name, args) { return checkBrowserRoute(name, args, routes); },
    clear() { routes.clear(); },
    size: () => routes.size,
  };
}

const OPERATOR_ROUTE = 'operator-browser';
const DEBUG_ROUTE = 'debug-browser';

function browserRouteOf(name, args) {
  const a = args || {};
  if (name === 'open_web') return a.browser === true ? OPERATOR_ROUTE : null;
  if (name === 'browser_launch_debug' || name === 'browser_switch' || name === 'browser_navigate') return DEBUG_ROUTE;
  return null;
}

// live-tool-adapter.js records `${name}:${JSON.stringify(args)}` per dispatched
// call this turn. The name never contains ':' (tool names are snake_case
// identifiers), so the first ':' is the split.
function parseSignature(signature) {
  const s = String(signature || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  try { return { name: s.slice(0, i), args: JSON.parse(s.slice(i + 1)) }; } catch { return null; }
}

// Returns null when the call may proceed, else { priorTool, priorRoute, route,
// response } where response is the functionResponse body to hand the model.
// `taken` is a Map of route -> {name, args} from createRouteMemory. A Set of
// signature strings is still read, so the adapter-level tests written against
// the old store keep exercising the same logic.
function checkBrowserRoute(name, args, taken) {
  const route = browserRouteOf(name, args);
  if (!route) return null;
  const named = namedOperatorBrowser(name, args);
  if (named) return named;
  for (const entry of (taken && typeof taken.values === 'function' ? taken.values() : taken) || []) {
    const prior = typeof entry === 'string' ? parseSignature(entry) : entry;
    if (!prior || !prior.name) continue;
    const priorRoute = browserRouteOf(prior.name, prior.args);
    if (!priorRoute || priorRoute === route) continue;
    const priorArgs = prior.args || {};
    const what = priorRoute === OPERATOR_ROUTE
      ? `${prior.name} already handed ${priorArgs.url || 'the page'} to the operator's normal${priorArgs.browserName ? ' ' + priorArgs.browserName : ''} browser this turn`
      : `${prior.name} already opened the MYTHOS debug browser this turn`;
    const instead = priorRoute === OPERATOR_ROUTE
      ? 'The page is already open in front of the operator — say so. Do NOT also launch the debug browser; that is what opened two Brave windows on 2026-09-10. If the operator wants the browser you control instead, ask first.'
      : 'Use browser_navigate in the debug browser you already have. Do NOT also hand the URL to the operator\'s normal browser — that opens a second window.';
    return {
      priorTool: prior.name, priorRoute, route,
      response: {
        status: 'refused', reason: 'browser-route-conflict',
        message: `${name} was NOT run: ${what}. One real-browser route per turn. ${instead}`,
      },
    };
  }
  return null;
}

// A named browser is the debug route (operator decision 2026-09-10), so the
// operator-route call that names one is refused before it can hand the URL to a
// signed-in window. Answered with remedy() objects — validated against
// TIER_TABLE, so a renamed tool throws here instead of teaching the model a
// call that does not exist.
function namedOperatorBrowser(name, args) {
  const a = args || {};
  if (name !== 'open_web' || a.browser !== true) return null;
  const browserName = typeof a.browserName === 'string' ? a.browserName.trim() : '';
  if (!browserName) return null;
  const { remedy } = require('../effectors/evidence');
  const why = 'A named browser means the one MYTHOS drives, so the page can be read and clicked afterwards.';
  const url = typeof a.url === 'string' ? a.url : '';
  return {
    priorTool: null, priorRoute: null, route: OPERATOR_ROUTE,
    response: {
      status: 'refused', reason: 'named-browser-is-the-debug-route',
      message: name + ' was NOT run: a named browser is the browser MYTHOS controls, not the'
        + " operator's signed-in " + browserName + '.',
      remedy: remedy('browser_launch_debug', { browser: browserName }, why),
      then: remedy('browser_navigate', url ? { url } : {}, why, url ? [] : ['url']),
    },
  };
}

module.exports = { checkBrowserRoute, browserRouteOf, parseSignature, createRouteMemory, namedOperatorBrowser, OPERATOR_ROUTE, DEBUG_ROUTE };
