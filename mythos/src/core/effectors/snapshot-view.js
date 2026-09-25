'use strict';

// src/core/effectors/snapshot-view.js — turn a Playwright aria snapshot into a
// bounded list the voice model can actually use, and make the set of refs the
// browser tools will ACCEPT the same set the model was SHOWN. BUG-445, 2026-09-23.
// No Playwright and no module state: from-browser.js owns the registry, and this
// file owns the view and the words the registry refuses with.
//
// THE BUG. browser_snapshot capped the tree at 8,000 characters header-first (on
// YouTube ~3,400 went on the banner and the category chips), registered every
// ref in those 8,000 as valid, and then the voice adapter cut the JSON result at
// 4,000. The model saw one video; the tools accepted refs it was never shown; so
// it guessed one — `f5e1557`, one off the real title link — and clicked the
// SECOND video's container while the click reported ok. The cap had also dropped
// every `/url` line (they carry no ref), so no link said which video it was.
//
// THE SHAPE THAT REPLACES IT. The tree is parsed structurally, a modal dialog and
// the page's search box come first, then the MAIN landmark in page order, then
// the chrome (navigation, banner, footer). Links that point at the same URL
// collapse into ONE item, because a YouTube card is a thumbnail link, a title link
// and a channel link and "the third video" means the third distinct target. The
// list is cut by WHOLE ROWS to a character budget, never mid-row, and paged. The
// caller registers exactly the `ref` printed on each emitted row — nothing else.
//
// GRAMMAR, measured 2026-09-23 against playwright-core 1.62.1 (Chrome, mode:'ai'):
//   <2n spaces>- role ["name"] [attr]* [ref=R] [cursor=pointer][: inline text]
//   A name containing ':' or '#' makes the WHOLE entry a YAML single-quoted
//   scalar:  - 'link "First: video \"one\" #1" [ref=e8] [cursor=pointer]':
//   A link's target is a CHILD property line with no ref:  - /url: /watch?v=AAA
//   A link with no accessible name may have no ref at all:  - link:
//   Refs are e<n> in the main frame and f<k>e<n> inside a frame.
//
// ATTACK RECORD (rules/core.md §11), written where the next editor reads it:
//  1 What else matches? A page controls every name. A name such as
//    `Click [ref=f5e14]` is consumed by a quote-aware scanner BEFORE any bracket
//    is read, so it can never mint a ref; test (e) pins it.
//  2 Evidence hidden? Lines this parser cannot read are COUNTED (`unparsed`) and
//    reported, never guessed at or silently dropped.
//  3 Who reads it? The Live model, through the adapter's boundForModel(); the
//    rows are sized so that bound never has to cut them.
//  5 Constants: VIEW_CHARS leaves ~800 of the adapter's 4,000 for the header and
//    the paging note. MAX_NAME_CHARS keeps one hostile 10 KB name from owning a
//    page; the cut is inside the NAME value, never across a structural token.
//  8 Disposition: a heading that only wraps a link is dropped (the link carries
//    the same words and the target); a heading with its own text is kept.

const LANDMARKS = new Set(['main', 'banner', 'navigation', 'contentinfo', 'complementary', 'search', 'form', 'region']);
const DIALOGS = new Set(['dialog', 'alertdialog']);
const REF_RE = /^(?:f\d+)?e\d+$/;
// Emission order. A modal dialog is what the page is waiting on; the search box
// is two rows and "search for X" is the commonest first step on a video site;
// MAIN is what "the third video" means. Chrome comes after the items.
const REGION_ORDER = ['dialog', 'search', 'main', 'form', 'region', 'complementary', 'navigation', 'banner', 'contentinfo', 'page'];
const VIEW_CHARS = 3200;
const MAX_NAME_CHARS = 160;

const INTERACTIVE = new Set(['link', 'button', 'tab', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell']);
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
// Content that changes what the model should do next: a form error, a status
// line, a section title. Only emitted when it carries words.
const CONTENT = new Set(['heading', 'alert', 'status']);

function unquoteYamlSingle(s) {
  // YAML single-quoted scalar: the only escape is '' for '.
  return s.slice(1, -1).replace(/''/g, "'");
}

// Parse one entry body (after "- ", already unquoted).
// Returns { role, name, attrs: string[], ref, inline } or null for a non-entry.
function parseEntry(body) {
  const m = /^[A-Za-z/][\w/-]*/.exec(body);
  if (!m) return null;
  const role = m[0];
  let i = m[0].length;
  const skipWs = () => { while (body[i] === ' ') i++; };
  skipWs();
  let name = null;
  if (body[i] === '"') {
    i++;
    let out = '';
    while (i < body.length && body[i] !== '"') {
      if (body[i] === '\\' && i + 1 < body.length) { out += body[i + 1]; i += 2; continue; }
      out += body[i++];
    }
    if (body[i] !== '"') return null; // unterminated name: refuse the line, do not guess
    i++;
    name = out;
    skipWs();
  }
  const attrs = [];
  let ref = null;
  while (body[i] === '[') {
    const close = body.indexOf(']', i);
    if (close === -1) return null;
    const attr = body.slice(i + 1, close);
    if (attr.startsWith('ref=')) {
      const r = attr.slice(4);
      if (REF_RE.test(r)) ref = r;
    } else attrs.push(attr);
    i = close + 1;
    skipWs();
  }
  let inline = null;
  if (body[i] === ':') {
    const rest = body.slice(i + 1).trim();
    if (rest) inline = rest;
  }
  return { role, name, attrs, ref, inline };
}

function regionFor(role, name, parent) {
  if (DIALOGS.has(role)) return 'dialog';
  const inherited = parent ? parent.region : 'page';
  // Once inside main or a dialog, a nested landmark (a results `region`, a
  // pagination `navigation`) stays in page order with its surroundings.
  if (inherited === 'main' || inherited === 'dialog') return inherited;
  if (role === 'searchbox' || ((role === 'combobox' || role === 'textbox') && /search/i.test(name || ''))) return 'search';
  if (LANDMARKS.has(role)) return role;
  return inherited;
}

/**
 * parseSnapshot(yaml) -> { nodes, unparsed } with nodes in page order:
 *   { id, depth, role, name, ref, url, attrs, inline, region, inTablist, wrapsLink }
 * `url` is lifted from a `/url` child onto its parent.
 */
function parseSnapshot(yaml) {
  const lines = String(yaml || '').split(/\r?\n/);
  const nodes = [];
  const stack = []; // [{depth, node}]
  let unparsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = /^( *)- (.*)$/.exec(line);
    if (!m) { unparsed++; continue; }
    const depth = m[1].length / 2;
    let body = m[2];
    if (body.startsWith("'")) {
      // Quoted entry, optionally followed by ':' (it has children).
      const end = body.endsWith("':") ? body.length - 1 : body.length;
      if (end < 2 || body[end - 1] !== "'") { unparsed++; continue; }
      body = unquoteYamlSingle(body.slice(0, end)) + (end < body.length ? ':' : '');
    }
    const e = parseEntry(body);
    if (!e) { unparsed++; continue; }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : null;
    if (e.role.startsWith('/')) {
      // A property line (/url, /placeholder) belongs to its parent entry.
      if (parent && e.role === '/url') parent.url = body.slice(body.indexOf(':') + 1).trim();
      continue;
    }
    if (e.role === 'link') {
      for (const s of stack) if (s.node.role === 'heading') s.node.wrapsLink = true;
    }
    // Rows inside a tablist (YouTube's category chips sit INSIDE main) are
    // controls for the list, not items in it; they sort after the region's items.
    const inTablist = e.role === 'tablist' || (parent ? parent.inTablist : false);
    const node = { id: nodes.length, depth, role: e.role, name: e.name, ref: e.ref, url: null, attrs: e.attrs,
      inline: e.inline, region: regionFor(e.role, e.name, parent), inTablist, wrapsLink: false };
    nodes.push(node);
    stack.push({ depth, node });
  }
  return { nodes, unparsed };
}

function buildRows(nodes) {
  const rows = [];
  const byUrl = new Map();
  for (const n of nodes) {
    if (CONTENT.has(n.role)) {
      const text = n.name || n.inline;
      if (!text || (n.role === 'heading' && n.wrapsLink)) continue;
      rows.push({ region: n.region, role: n.role, name: text, ref: n.ref, sub: n.inTablist ? 1 : 0 });
      continue;
    }
    if (!n.ref || !INTERACTIVE.has(n.role)) continue;
    if (n.role === 'link' && n.url) {
      const key = n.region + '|' + n.url;
      const existing = byUrl.get(key);
      if (existing) {
        // Same target. Prefer the NAMED ref: it is the one whose words the
        // model reads, and a click on either lands on the same URL.
        if (!existing.name && n.name) { existing.name = n.name; existing.ref = n.ref; }
        continue;
      }
      const row = { region: n.region, role: 'link', name: n.name || null, url: n.url, ref: n.ref, sub: n.inTablist ? 1 : 0 };
      byUrl.set(key, row);
      rows.push(row);
      continue;
    }
    const state = n.attrs.filter((a) => a !== 'cursor=pointer').join(' ');
    rows.push({ region: n.region, role: n.role, name: n.name || null, url: n.url || undefined, ref: n.ref,
      sub: n.inTablist ? 1 : 0, state: state || undefined, value: VALUED.has(n.role) && n.inline ? n.inline : undefined });
  }
  const rank = (r) => { const k = REGION_ORDER.indexOf(r); return k === -1 ? REGION_ORDER.length : k; };
  // Stable: by region, tablist controls after items, then page order.
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.region) - rank(b.r.region) || a.r.sub - b.r.sub || a.i - b.i)
    .map((x) => x.r);
}

function bound(text) {
  return text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS) + '…' : text;
}

function emitRow(row, n) {
  const out = { n, role: row.role };
  if (row.name) out.name = bound(row.name);
  if (row.ref) out.ref = row.ref;
  if (row.url) out.url = bound(row.url);
  if (row.value) out.value = bound(row.value);
  if (row.region !== 'main') out.region = row.region;
  if (row.state) out.state = row.state;
  return out;
}

/**
 * buildSnapshotView(yaml, { maxChars, page }) ->
 *   { rows, refs, page, pages, totalRows, unparsed }
 * Rows are cut WHOLE to fit maxChars of serialized JSON (Unicode and escaping are
 * counted by measuring the serialized form itself). `refs` is exactly the refs
 * printed on the emitted rows: the set the caller must register, and no other.
 * Paging is deterministic for one yaml, so page N of one capture is stable.
 */
function buildSnapshotView(yaml, opts) {
  const o = opts || {};
  const maxChars = Number.isFinite(o.maxChars) && o.maxChars > 200 ? o.maxChars : VIEW_CHARS;
  const { nodes, unparsed } = parseSnapshot(yaml);
  const all = buildRows(nodes);
  const pages = [];
  let start = 0;
  while (start < all.length) {
    let size = 2; // "[]"
    let end = start;
    while (end < all.length) {
      const piece = JSON.stringify(emitRow(all[end], end + 1)).length + 1;
      if (size + piece > maxChars && end > start) break;
      size += piece;
      end++;
    }
    pages.push([start, end]);
    start = end;
  }
  if (!pages.length) pages.push([0, 0]);
  const pageNo = Math.min(Math.max(1, Math.floor(Number(o.page)) || 1), pages.length);
  const [a, b] = pages[pageNo - 1];
  const rows = all.slice(a, b).map((r, k) => emitRow(r, a + k + 1));
  const refs = rows.filter((r) => r.ref).map((r) => r.ref);
  return { rows, refs, page: pageNo, pages: pages.length, totalRows: all.length, unparsed };
}

// ---- the registry's words: paging, staleness, a page that moved ------------
// Refusals carry prose AND a remedy(), the house shape (src/core/CLAUDE.md,
// "Refusals"): the model reads the sentence; remedy() checks the tool exists.

// Same document = same address with the #fragment ignored. A fragment change is
// a scroll; anything else (YouTube's home -> /watch) is a different page whose
// elements the old refs never described.
function sameDocument(a, b) {
  const strip = (u) => String(u || '').split('#')[0];
  return strip(a) === strip(b);
}

const HEADER_TEXT_CHARS = 300;
// What the rows must leave for everything else in the result: the paging keys and
// note (~450), and boundForModel's own reserve for its `_bounded` note when it
// strips a screenshot (~250). Get this wrong and the adapter trims ROWS whose refs
// are already registered — the BUG-445 shape again, one layer down. Pinned by the
// hostile-header test in test/bug-445-….
const RESULT_RESERVE = 700;

function snapshotHeader({ generation, url, title, captchaMarkers }) {
  const cut = (s) => { const t = String(s || ''); return t.length > HEADER_TEXT_CHARS ? t.slice(0, HEADER_TEXT_CHARS) + '…' : t; };
  const header = { generation, url: cut(url), title: cut(title) };
  if (captchaMarkers && captchaMarkers.length) {
    header.captchaDetected = true;
    header.captchaMarkers = captchaMarkers.slice(0, 8);
    header.captchaNote =
      'This page is showing a human-verification challenge. Do NOT try to solve or bypass it — ' +
      'ask the operator to complete it in the browser window and to tell you when to continue.';
  }
  return header;
}

// The row budget: the model's whole budget less the header and the reserve.
function viewCharsFor(header) {
  const { DEFAULT_BUDGET } = require('../voice/model-result');
  return Math.max(800, DEFAULT_BUDGET - JSON.stringify(header).length - RESULT_RESERVE);
}

function pagingFields(v, generation) {
  if (v.pages <= 1 && !v.unparsed) return {};
  const first = v.rows.length ? v.rows[0].n : 0;
  const last = v.rows.length ? v.rows[v.rows.length - 1].n : 0;
  const out = {};
  const parts = [`Items ${first}-${last} of ${v.totalRows}, page ${v.page} of ${v.pages}. Only refs printed on a page you have read can be acted on.`];
  if (v.page < v.pages) {
    out.nextPage = { page: v.page + 1, generation };
    parts.push(`The next items are on page ${v.page + 1}: pass that page and generation ${generation} to browser_snapshot.`);
  }
  if (v.unparsed) parts.push(`${v.unparsed} line(s) of the page could not be read and are not listed.`);
  out.note = parts.join(' ');
  return out;
}

function refusal(text, why) {
  const { remedy } = require('./evidence');
  return { ok: false, result: text, remedy: remedy('browser_snapshot', {}, why) };
}

function continuationRefusal({ page, generation, current, hasCapture, moved }) {
  const why = 'Pages of a snapshot are only meaningful against the capture they were cut from.';
  if (!hasCapture || !current) {
    return refusal(`There is no page ${page} to show: this page has not been read yet. Read it with browser_snapshot and no page first.`, why);
  }
  if (generation !== undefined && generation !== null && Number(generation) !== current) {
    return refusal(`Page ${page} of snapshot ${generation} is gone: the page was read again since (now snapshot ${current}), and its refs replaced those. Read it fresh with browser_snapshot and no page.`, why);
  }
  if (moved) {
    return refusal(`The browser has left the page that snapshot ${current} described (${moved.from} -> ${moved.to || 'no address'}). Read the new page with browser_snapshot and no page.`, why);
  }
  return null;
}

function pageMovedRefusal(ref, moved) {
  return refusal(`ref "${ref}" belongs to ${moved.from}, but the browser is now on ${moved.to || 'a page that reports no address'}, so it describes nothing that is there. Read the new page with browser_snapshot and pick a ref from that.`,
    'Refs belong to the page they were read from, and this page has changed since.');
}

module.exports = { parseSnapshot, buildSnapshotView, VIEW_CHARS, sameDocument, snapshotHeader, viewCharsFor, pagingFields,
  continuationRefusal, pageMovedRefusal, _parseEntry: parseEntry };
