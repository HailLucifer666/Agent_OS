// url.js — the HUD's one URL-scheme gate.
//
// Every place the HUD turns an untrusted string into a live navigation target
// (window.open, an <a href>, an <iframe src>) has to answer the same question:
// is this an http(s) URL, or is it a javascript:/data:/file: payload dressed up
// as one? Four separate copies of this check had grown in views/web-panel.js,
// widgets/kinds/web-result.js, views/engagements.js and
// components/engagement/SpecPreviewCard.js — and app.js, which owns the
// window.open sink for the open_web tool, had none of them.
//
// This module is the shared one. Two of those copies are gone:
// SpecPreviewCard.js was deleted with the rest of the unreachable engagement
// component tree, and views/engagements.js now imports safeHref from here.
// views/web-panel.js and widgets/kinds/web-result.js still carry their own,
// and widgets/kinds/news.js grew one when its feed links were gated; migrating
// those three is a deliberate change, not a drive-by.

// Deliberately not a regex: this is a two-prefix test, and a literal regex for
// it is exactly the kind of escape-heavy line that gets silently mangled in
// transit. startsWith on a lowercased copy is unambiguous and does the same job.
function isHttpScheme(value) {
  const lower = value.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}
// Returns the trimmed URL when it is http(s), else null. Callers must treat
// null as "do not navigate" and render inert text (or refuse) instead of
// falling back to the raw input.
export function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return isHttpScheme(trimmed) ? trimmed : null;
}

// Like safeUrl, but also accepts a root-relative same-origin path ("/vault/…").
// The Forge preview iframe and the Pipeline artifact link both point at paths the
// server serves itself, so http(s)-only would reject every legitimate value —
// while a bare `javascript:`/`data:` string still has no leading slash and is
// still rejected. `//host` is refused too: that is protocol-relative, i.e. a
// different origin wearing a same-origin costume.
export function safeSameOriginUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (isHttpScheme(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return null;
  return trimmed.startsWith('/') ? trimmed : null;
}

// B3c (2026-09-29 audit): a generated build MYTHOS serves itself. The server
// already sends it a CSP sandbox without allow-same-origin
// (src/core/server/preview-isolation.js, PREVIEW_SANDBOX — this string is kept
// equal to it by test/preview-isolation.test.js); a frame showing one carries the
// same sandbox attribute as a second line. The path match is case-insensitive
// because Express mounts are.
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
export function isVaultBuildUrl(url, base) {
  try {
    const origin = new URL(base || location.href).origin;
    const u = new URL(String(url), base || location.href);
    return u.origin === origin && /^\/vault\/(builds|p)\//i.test(u.pathname);
  } catch {
    return false;
  }
}

// safeHref — the href variant. Same scheme test, but it returns the URL with
// any double quote already entity-escaped, because its one caller interpolates
// the result straight into href="..." inside a markdown renderer whose input
// has been through the textContent/innerHTML trick (which leaves `"` intact).
// LLM-authored spec markdown reaches that renderer, and `[x](" onmouseover=...)`
// is the exact payload this was written for on 2026-08-02.
//
// Moved here from components/engagement/SpecPreviewCard.js, which was deleted
// as unreachable: views/engagements.js carried a verbatim copy of this function
// while the tests pointed at the copy nothing rendered. One home, one test.
export function safeHref(url) {
  const safe = safeUrl(url);
  if (safe === null) return null;
  // ONLY the quote. Not escapeAttr: an href legitimately contains & in a query
  // string, and rewriting it to &amp; here would change the URL that callers
  // already treat as final.
  return safe.replace(/"/g, '&quot;');
}
// Escapes a string for TEXT position: & < > only, null/undefined -> "".
//
// E1 (2026-09-16): this function was defined SEVENTEEN times under ui/public/js
// with three different bodies — this one; String(s) with no null guard, which
// rendered the word "undefined"; and a textContent/innerHTML round trip that
// needs a document. One home now, next to escapeAttr, for the same reason its
// header gives: the engagements.js copy nothing rendered was where the tests
// pointed. Deliberately NOT escaping `"` — that is escapeAttr's job, and the
// distinction is what lets a reader see at the call site which position a
// value is going into. test/hud-escape-html.test.js pins one definition, no
// `="${escapeHtml(` anywhere, and an import in every caller.
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// Escapes a string for interpolation inside a double-quoted HTML attribute.
// The textContent/innerHTML trick used across the HUD escapes & < > and NOT
// `"`, so an attribute built from it can be broken out of; this closes that.
export function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
