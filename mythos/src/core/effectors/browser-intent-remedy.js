'use strict';
// BUG-425 (2026-09-10): prose is never an argument value. The legacy batch
// voice path still serializes results as prose and is deliberately unchanged.
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
const { URL_SHAPED, looksLikeUrlOrDomain } = require('./open-external-route');
const { remedy } = require('./evidence');

// The remedy text, shared so the two call sites cannot drift into saying
// different things about the same mistake. Prose names the action; only the
// structured remedy carries the URL argument, so it cannot be pasted with advice.
function browserIntentRemedy(what, value) {
  const s = String(value || '').trim();
  const url = URL_SHAPED.test(s) ? (/^www\./i.test(s) ? 'https://' + s : s) : 'https://' + s;
  return { text: `That is a website, and ${what}. Use browser_navigate through the structured remedy.`,
    remedy: remedy('browser_navigate', { url }, "Open the website in the operator's real browser.") };
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

module.exports = { browserIntentRemedy, webTypeNeedsUrlRemedy, looksLikeUrlOrDomain };
