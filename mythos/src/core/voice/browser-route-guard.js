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
// WHAT IS DELIBERATELY NOT DECIDED HERE — and it is the operator's call, not a
// session's: which route a NAMED-browser request ("open YouTube on Brave") should
// mean. The ticket proposes preferring the debug browser; the active Stage 1
// golden path (Plans/RESUME.md) is spoken control of the operator's ALREADY
// SIGNED-IN browser, which is the other route. Until that is decided, a lone
// open_web browser:true and a lone browser_launch_debug are both allowed, and the
// test pins that so this guard cannot quietly become the decision.
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
function checkBrowserRoute(name, args, executedSignatures) {
  const route = browserRouteOf(name, args);
  if (!route) return null;
  for (const signature of executedSignatures || []) {
    const prior = parseSignature(signature);
    if (!prior) continue;
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

module.exports = { checkBrowserRoute, browserRouteOf, parseSignature, OPERATOR_ROUTE, DEBUG_ROUTE };
