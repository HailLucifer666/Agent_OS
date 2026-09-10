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
function createRouteMemory(deps) {
  const routes = new Map(); // route -> the call that took it
  return {
    note(name, args) {
      const route = browserRouteOf(name, args);
      if (route && !routes.has(route)) routes.set(route, { name, args: args || {} });
    },
    // deps is carried, not read here: namedOperatorBrowser needs a browserOnline
    // reader and a test has to be able to supply one without a live CDP socket.
    check(name, args) { return checkBrowserRoute(name, args, routes, deps); },
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
function checkBrowserRoute(name, args, taken, deps) {
  const route = browserRouteOf(name, args);
  if (!route) return null;
  const named = namedOperatorBrowser(name, args, deps);
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
// signed-in window.
//
// THE FIRST VERSION OF THIS REFUSAL MADE THE BUG WORSE, and how it did is the
// reason for the shape below. Measured 2026-09-10 18:21Z: the operator said
// "open YouTube in Brave", browser_launch_debug ran and CONNECTED over CDP, and
// then open_web was refused four times by a remedy telling the model to call
// browser_launch_debug — the step it had just finished. Nothing navigated. No
// page opened at all, which is worse than the two windows this guard exists to
// prevent. Three faults, each fixed here:
//
// (1) IT WAS BLIND TO STATE, so its advice could already be satisfied. The next
//     call is now derived from whether the debug browser is attached: navigate
//     when it is, launch when it is not. Advice to redo a finished step is as
//     unfollowable as advice naming a tool that does not exist — the same class
//     BUG-099 and BUG-107 each fixed once (the reasoning is in live-tools.js's
//     allowlist comments). This was the third instance.
// (2) THE MESSAGE NAMED NO TOOL. Every refusal in this repo that actually moves
//     the model names its tool in the prose — checkBrowserTarget in
//     from-browser.js, browser-intent-remedy.js, close-window-guard.js. This one
//     put the tools only in structured fields, and the reason recorded at the
//     time was "a tool taught in a sentence is the debt the remedy ratchet
//     exists to stop growing".
//     THAT REASON WAS FALSE, and checking it is what found this. remedy-prose-
//     ratchet.test.js scans `src/core/effectors` only (its DIR const); this file
//     is in src/core/voice and has never been in its inventory. The prose was
//     withheld to satisfy a rule that does not reach this file — and even where
//     the rule does reach, it exempts prose sitting beside a `, remedy: remedy(`,
//     which this call site already had. A test was cited, not consulted.
//     The messages below still keep each tool-naming literal directly before its
//     `, remedy: remedy(` — that costs nothing and means the sentences stay
//     compliant if this module ever moves under the scanner.
// (3) `then:` WAS A FIELD NOTHING READS. live-session.js serialises the whole
//     response object, so it did reach the wire — but no consumer exists in this
//     repo and the model was never taught the key. An invented field that looks
//     like a contract is worse than no field, because it reads as coverage.
//     Deleted; the whole sequence is in the sentence now.
//
// DELIBERATELY NOT ADDED: memory of refusals, so a repeat gets a different
// answer. The four-refusal loop was caused by dead advice, not by repetition,
// and an answer that changes on the second ask is a new way to be wrong. A test
// pins that a repeat gets the SAME actionable advice.
function debugBrowserOnline() {
  // Lazily required, like remedy() below, so this module stays pure to require
  // and the adapter — which sits on its size ceiling — pays nothing.
  // Unreadable state answers "not attached": that sends the model to
  // browser_launch_debug, which returns alreadyOnline instead of opening a
  // second window, so the fail-safe direction costs nothing.
  try { return require('../../../adapters/browser-agent').getStatus().state === 'ONLINE'; } catch (_) { return false; }
}

function namedOperatorBrowser(name, args, deps) {
  const a = args || {};
  if (name !== 'open_web' || a.browser !== true) return null;
  const browserName = typeof a.browserName === 'string' ? a.browserName.trim() : '';
  if (!browserName) return null;
  const { remedy } = require('../effectors/evidence');
  const online = (deps && typeof deps.browserOnline === 'function' ? deps.browserOnline : debugBrowserOnline)();
  const why = 'A named browser means the one MYTHOS drives, so the page can be read and clicked afterwards.';
  const url = typeof a.url === 'string' ? a.url : '';
  const head = name + ' was NOT run: a named browser is the one MYTHOS drives, not the'
    + " operator's signed-in " + browserName + '. ';
  const seen = { priorTool: null, priorRoute: null, route: OPERATOR_ROUTE, debugBrowserOnline: online };
  if (online) {
    return { ...seen, response: { status: 'refused', reason: 'named-browser-is-the-debug-route',
      message: head + 'That browser is already open and attached, so call browser_navigate with the url.', remedy: remedy('browser_navigate', url ? { url } : {}, why, url ? [] : ['url']) } };
  }
  return { ...seen, response: { status: 'refused', reason: 'named-browser-is-the-debug-route',
    message: head + 'Call browser_launch_debug with that browser, then browser_navigate with the url.', remedy: remedy('browser_launch_debug', { browser: browserName }, why) } };
}

module.exports = { checkBrowserRoute, browserRouteOf, parseSignature, createRouteMemory, namedOperatorBrowser, OPERATOR_ROUTE, DEBUG_ROUTE };
