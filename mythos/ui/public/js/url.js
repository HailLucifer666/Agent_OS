// url.js — the HUD's one URL-scheme gate.
//
// Every place the HUD turns an untrusted string into a live navigation target
// (window.open, an <a href>, an <iframe src>) has to answer the same question:
// is this an http(s) URL, or is it a javascript:/data:/file: payload dressed up
// as one? Four separate copies of this check grew in views/web-panel.js,
// widgets/kinds/web-result.js, views/engagements.js and
// components/engagement/SpecPreviewCard.js — and app.js, which owns the
// window.open sink for the open_web tool, had none of them.
//
// This module is the shared copy. New call sites import it; the existing four
// keep their local copies until they are migrated deliberately, one at a time.

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
