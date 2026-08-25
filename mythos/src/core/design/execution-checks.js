'use strict';

// design/execution-checks.js — BUG-325. The verifier checked VOCABULARY; these
// checks read EXECUTION.
//
// WHAT WAS MEASURED, 2026-08-23. Same brief to MYTHOS and to Claude: five of
// this week's AI stories, premium dark digest landing page. Both resolved the
// same design system out of ui-ux-pro-max (Newsreader headings, Roboto body,
// accent #EC4899) and that block hands over the exact stylesheet import the page
// needs. Claude's page loaded 48 faces. MYTHOS's shipped artifact
// (vault/builds/kanban/ai-digest-compiled-by-mythos.html) declares
//
//     font-family: 'Roboto', sans-serif
//     font-family: 'Newsreader', serif
//
// and contains ZERO <link> tags and ZERO @import lines. Every glyph came from a
// fallback face, so every type decision above it was discarded. design/verify.js
// passed it: its DESIGN_ELEMENT_PATTERNS confirm a hero is MENTIONED, and no rule
// anywhere asked whether a named font was actually fetched.
//
// The immediately previous build of the same card
// (ai-digest-premium-dark-theme-editorial-a.html) DOES carry the Google Fonts
// link. So this is not a model that cannot do it — it is a model that sometimes
// does not, which is exactly the class of defect a rule catches and a prose
// instruction does not.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE MODULE. verify.js is the gate; this is parsing. Same
// split, and the same reason, as news-rung.js coming out of web-search.js: the
// parsing is worth unit-testing on its own inputs, and test/file-size-ratchet
// is one-directional. verify.js calls run() and turns the findings into its two
// existing tiers.
//
// WHAT IS DELIBERATELY *NOT* CHECKED HERE:
//
//   * Remote images. DELIVERABLE_PREAMBLE tells the model to fetch photographs
//     from picsum.photos, so a rule banning remote images would fail builds for
//     obeying the brief this same pipeline issues. grounding-check.js already
//     declined to ban that host for the same reason. Zero of the artifacts in
//     the vault today carry a remote <img> at all, so the rule would also have
//     an empty population.
//   * "Enough page". Measured on the two artifacts the operator compared: 6617
//     bytes for the ordinary page, 13833 for the good one. There is no line
//     between those two that is not invented, and inventing one is the
//     tuning-by-feel this work is explicitly not allowed to do. Only a STUB is
//     flagged, and only as a warning — see STUB_TEXT_CHARS.
//   * Whether the page looks good. That is the refine loop's job (it renders and
//     screenshots), and the OUTPUT CONTRACT in build-pack.js is where taste is
//     asked for. These checks answer yes/no questions about the source.
// ---------------------------------------------------------------------------

// Generic CSS families and faces that ship with the OS. Anything else is a
// webfont: naming it without loading it renders the page in whatever the browser
// falls back to.
//
// ROBOTO IS DELIBERATELY NOT IN THIS LIST even though it is the system face on
// Android. On Windows and macOS — where every build from this pipeline has been
// looked at — it is not installed, and it is one of the two faces the measured
// failure named. A face that is resident on one platform is still a webfont
// everywhere the operator can see it.
var GENERIC_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
];

var OS_FAMILIES = [
  'arial', 'arial black', 'helvetica', 'helvetica neue', 'georgia', 'times',
  'times new roman', 'courier', 'courier new', 'verdana', 'tahoma',
  'trebuchet ms', 'segoe ui', 'segoe ui emoji', 'segoe ui symbol', 'calibri',
  'cambria', 'consolas', 'candara', 'corbel', 'constantia', 'impact',
  'comic sans ms', 'palatino', 'palatino linotype', 'book antiqua', 'garamond',
  'lucida console', 'lucida sans unicode', 'ms gothic', 'menlo', 'monaco',
  'sf mono', 'apple color emoji', 'noto color emoji', 'symbol', 'webdings',
  'wingdings', '-apple-system', 'blinkmacsystemfont',
];

// A page whose entire visible text is shorter than this is a stub, not a
// landing page — a refusal, an error note, or a skeleton. Set from the smallest
// real artifact in the vault (the 6617-byte page carries ~1.4k of visible text),
// low enough that no measured build is near it. Warning only.
var STUB_TEXT_CHARS = 400;

function norm(name) {
  return String(name == null ? '' : name)
    .replace(/^\s*['"]|['"]\s*$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// BOTH SIDES ARE NORMALISED, and this is not defensive tidiness — the first
// run of these checks over the 25 artifacts in the vault flagged `system-ui`
// as an unloaded webfont. norm() collapses the hyphen to a space, so
// 'system ui' was compared against the literal 'system-ui' in the list and
// missed. Class 4 out of the audit list: the guard had the defect it exists to
// catch. Same for ui-sans-serif, ui-serif, ui-monospace and -apple-system.
function isSystemFamily(name) {
  var n = norm(name);
  if (!n) return true;
  var i;
  for (i = 0; i < GENERIC_FAMILIES.length; i++) {
    if (norm(GENERIC_FAMILIES[i]) === n) return true;
  }
  for (i = 0; i < OS_FAMILIES.length; i++) {
    if (norm(OS_FAMILIES[i]) === n) return true;
  }
  return false;
}

// ---- CSS custom properties -------------------------------------------------
// Claude's page writes `font-family:var(--serif)` with `--serif:'Newsreader',
// Georgia,...` on :root. Treating `var(--serif)` as a font NAME would accuse
// every well-organised page of naming a font it never loaded — the guard having
// the very defect it exists to catch. So the properties are resolved first, and
// one that cannot be resolved is skipped rather than guessed at.
var CUSTOM_PROP_RE = /(--[\w-]+)\s*:\s*([^;}]+)/g;

function customProps(css) {
  var out = Object.create(null);
  var m;
  CUSTOM_PROP_RE.lastIndex = 0;
  while ((m = CUSTOM_PROP_RE.exec(css))) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

var VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/;

// Resolve one font-family value to a list of family names, following var()
// through at most a few hops. Returns null when the value cannot be resolved —
// unknown is never treated as a finding.
function resolveFamilyValue(value, props, depth) {
  var v = String(value == null ? '' : value).trim();
  if (!v) return null;
  var hops = depth || 0;
  if (hops > 4) return null;
  var m = VAR_RE.exec(v);
  if (m) {
    var target = props[m[1]];
    if (target != null) return resolveFamilyValue(target, props, hops + 1);
    // A var() with a fallback list still tells us what will render.
    if (m[2]) return resolveFamilyValue(m[2], props, hops + 1);
    return null;
  }
  // A value that only PARTLY uses var() (e.g. `var(--x), serif`) is beyond what
  // this needs to understand; the var() half is resolved and the rest kept.
  var parts = v.split(',');
  var families = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    if (/^var\(/.test(p)) {
      var inner = resolveFamilyValue(p, props, hops + 1);
      if (inner) families = families.concat(inner);
      continue;
    }
    families.push(p.replace(/^['"]|['"]$/g, '').trim());
  }
  return families.length ? families : null;
}

// ---- what the page actually loads -----------------------------------------
// Three legitimate ways to get a face onto the page, all accepted:
//   a Google-Fonts-style URL with family= parameters (link or @import),
//   any stylesheet URL whose path simply contains the family name, and
//   a local @font-face declaring it.
var LINK_RE = /<link\b[^>]*>/gi;
var IMPORT_RE = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi;
var HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
var FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi;
var FAMILY_PARAM_RE = /[?&]family=([^&]*)/gi;

function familiesFromUrl(url) {
  var out = [];
  var u = String(url || '').replace(/&amp;/g, '&');
  var m;
  FAMILY_PARAM_RE.lastIndex = 0;
  while ((m = FAMILY_PARAM_RE.exec(u))) {
    // family=Newsreader:ital,opsz,wght@0,6..72,400  -> Newsreader
    // family=Times+New+Roman                        -> Times New Roman
    out.push(decodeURIComponent(m[1].split(':')[0]).replace(/\+/g, ' '));
  }
  return { families: out, url: u };
}

function loadedFonts(content) {
  var text = String(content == null ? '' : content);
  var loaded = [];           // normalised family names
  var urls = [];             // stylesheet URLs seen, for substring fallback
  var swapUrls = [];         // URLs carrying display=swap
  var m;

  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    var tag = m[0];
    if (!/rel\s*=\s*['"]?stylesheet/i.test(tag) && !/\bas\s*=\s*['"]?font/i.test(tag)) continue;
    var href = HREF_RE.exec(tag);
    if (!href) continue;
    var got = familiesFromUrl(href[1] || href[2] || '');
    urls.push(got.url);
    if (/display=swap/i.test(got.url)) swapUrls.push(got.url);
    loaded = loaded.concat(got.families.map(norm));
  }

  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    var got2 = familiesFromUrl(m[1]);
    urls.push(got2.url);
    if (/display=swap/i.test(got2.url)) swapUrls.push(got2.url);
    loaded = loaded.concat(got2.families.map(norm));
  }

  FONT_FACE_RE.lastIndex = 0;
  while ((m = FONT_FACE_RE.exec(text))) {
    var fam = /font-family\s*:\s*([^;]+)/i.exec(m[1]);
    if (fam) loaded.push(norm(fam[1]));
  }

  return { families: loaded.filter(Boolean), urls: urls, swapUrls: swapUrls };
}

function isLoaded(family, loaded) {
  var n = norm(family);
  if (!n) return true;
  if (loaded.families.indexOf(n) !== -1) return true;
  // A stylesheet URL that simply spells the family out (Adobe Fonts, a self-
  // hosted /fonts/Newsreader.css) counts. Compared on collapsed alphanumerics
  // so "Times+New+Roman" and "times-new-roman" both hit.
  var squashed = n.replace(/ /g, '');
  for (var i = 0; i < loaded.urls.length; i++) {
    if (loaded.urls[i].toLowerCase().replace(/[^a-z0-9]+/g, '').indexOf(squashed) !== -1) return true;
  }
  return false;
}

// ---- font-size arithmetic --------------------------------------------------
var FONT_FAMILY_DECL_RE = /font-family\s*:\s*([^;}"']*(?:"[^"]*"|'[^']*')?[^;}]*)/gi;
var RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
var FONT_SIZE_DECL_RE = /(?:^|[;{\s])font-size\s*:\s*([^;}]+)/i;
var HEADING_SEL_RE = /(?:^|[\s,>+~])h[1-3](?![\w-])/i;
var BODY_SEL_RE = /(?:^|[\s,])(?:body|html)(?![\w-])/i;

var DEFAULT_ROOT_PX = 16;

// px for an absolute length, null for anything context-dependent. em is
// deliberately null: its value depends on the parent chain, and guessing it is
// how a check starts producing findings it cannot defend.
function sizeToPx(value, rootPx) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return null;
  var clamp = /^clamp\(([\s\S]*)\)$/.exec(v);
  if (clamp) {
    // The desktop end of a fluid scale is the last argument. Split at the top
    // level so a nested calc() with commas does not confuse it.
    var args = splitTopLevel(clamp[1]);
    if (!args.length) return null;
    return sizeToPx(args[args.length - 1], rootPx);
  }
  var px = /^(-?[\d.]+)px$/.exec(v);
  if (px) return parseFloat(px[1]);
  var rem = /^(-?[\d.]+)rem$/.exec(v);
  if (rem) return parseFloat(rem[1]) * (rootPx || DEFAULT_ROOT_PX);
  var pt = /^(-?[\d.]+)pt$/.exec(v);
  if (pt) return parseFloat(pt[1]) * (96 / 72);
  return null;
}

function splitTopLevel(s) {
  var out = [];
  var depth = 0;
  var cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

var STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

// ONLY THE CONTENTS OF <style>. Running the rule regex over the whole document
// looked equivalent and was not: on
//
//     <!DOCTYPE html><html><head><link ...><style>h1{font-size:4rem}</style>
//
// the text before the first `{` is one long "selector" that contains both `html`
// and `h1`, so the same rule was read as the body rule AND the heading rule and
// the check reported "256px against 256px". Caught by its own test on the first
// run. Anything outside a <style> element is not CSS.
function stylesheet(content) {
  var text = String(content || '');
  var out = [];
  var m;
  STYLE_BLOCK_RE.lastIndex = 0;
  while ((m = STYLE_BLOCK_RE.exec(text))) out.push(m[1]);
  return out.join('\n');
}

// Every `selector { declarations }` pair, INCLUDING the ones nested inside
// @media — the regex cannot match a body containing a brace, so an at-rule's
// prelude is skipped and its inner rules are returned on their own. That is the
// behaviour wanted: heading size is the MAXIMUM declared anywhere, so a mobile
// override that shrinks the headline can never produce a finding.
function cssRules(content) {
  var out = [];
  var m;
  RULE_RE.lastIndex = 0;
  while ((m = RULE_RE.exec(stylesheet(content)))) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

function typeScale(content) {
  var rules = cssRules(content);
  var rootPx = DEFAULT_ROOT_PX;
  var i, size;
  // :root / html font-size sets the rem base before anything is measured in rem.
  for (i = 0; i < rules.length; i++) {
    if (!/(?:^|[\s,])(?::root|html)(?![\w-])/i.test(rules[i].selector)) continue;
    var rootDecl = FONT_SIZE_DECL_RE.exec(rules[i].body);
    if (!rootDecl) continue;
    size = sizeToPx(rootDecl[1], DEFAULT_ROOT_PX);
    if (size) rootPx = size;
  }
  var bodyPx = null;
  var headingPx = null;
  var headingSelector = null;
  for (i = 0; i < rules.length; i++) {
    var decl = FONT_SIZE_DECL_RE.exec(rules[i].body);
    if (!decl) continue;
    size = sizeToPx(decl[1], rootPx);
    if (size == null) continue;
    if (BODY_SEL_RE.test(rules[i].selector) && bodyPx == null) bodyPx = size;
    if (HEADING_SEL_RE.test(rules[i].selector) && (headingPx == null || size > headingPx)) {
      headingPx = size;
      headingSelector = rules[i].selector;
    }
  }
  return {
    rootPx: rootPx,
    bodyPx: bodyPx == null ? rootPx : bodyPx,
    bodyDeclared: bodyPx != null,
    headingPx: headingPx,
    headingSelector: headingSelector,
  };
}

// ---- is the page actually dark? -------------------------------------------
// verify.js's DESIGN_ELEMENT_PATTERNS satisfies a "dark theme" requirement with
// /dark/i — the WORD, anywhere in the file. Measured 2026-08-23: Claude's page
// for the dark-digest brief contains the word "dark" zero times and paints
// `body{background:var(--bg)}` with `--bg:#09090B`. It is as dark as a page
// gets, and MYTHOS's verifier hard-failed it for "missing required design
// element: dark.theme". Vocabulary again. So the requirement can also be
// satisfied by measuring the surface the page actually paints.
var NAMED_COLORS = { black: '#000000', white: '#ffffff' };
var BG_DECL_RE = /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;}]+)/i;

function parseColor(value, props, depth) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return null;
  var hops = depth || 0;
  if (hops > 4) return null;
  var varMatch = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/.exec(v);
  if (varMatch) {
    if (props[varMatch[1]] != null) return parseColor(props[varMatch[1]], props, hops + 1);
    if (varMatch[2]) return parseColor(varMatch[2], props, hops + 1);
    return null;
  }
  var hex = /#([0-9a-f]{3}|[0-9a-f]{6})\b/.exec(v);
  if (hex) {
    var h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  var rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) return [parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3])];
  for (var name in NAMED_COLORS) {
    if (new RegExp('(?:^|[\\s,])' + name + '(?:$|[\\s,;])').test(v)) {
      return parseColor(NAMED_COLORS[name], props, hops + 1);
    }
  }
  return null;
}

// Perceived lightness on 0..1. sRGB coefficients, no gamma correction: the only
// question asked of it is "near-black or not", and a threshold that far from the
// middle does not need the extra precision.
function lightness(rgb) {
  if (!rgb) return null;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

var DARK_MAX_LIGHTNESS = 0.28;

// { known, dark, lightness } — `known:false` when the page's surface colour
// cannot be read, which is never reported as a finding either way.
function pageDarkness(content) {
  var props = customProps(stylesheet(content));
  var rules = cssRules(content);
  // body wins over html/:root: it is the element that paints the viewport.
  var order = [/(?:^|[\s,])body(?![\w-])/i, /(?:^|[\s,])html(?![\w-])/i, /(?:^|[\s,]):root(?![\w-])/i];
  for (var o = 0; o < order.length; o++) {
    for (var i = 0; i < rules.length; i++) {
      if (!order[o].test(rules[i].selector)) continue;
      var decl = BG_DECL_RE.exec(rules[i].body);
      if (!decl) continue;
      var l = lightness(parseColor(decl[1], props, 0));
      if (l == null) continue;
      return { known: true, dark: l <= DARK_MAX_LIGHTNESS, lightness: l };
    }
  }
  return { known: false, dark: false, lightness: null };
}

function visibleTextLength(content) {
  return String(content || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

// The desktop floor for a hero headline, from build-pack.js's OUTPUT CONTRACT
// rule 2. Kept as one constant so the prompt and the gate cannot drift apart.
var HERO_MIN_PX = 40;
// A headline has to out-size body copy by this much to read as a headline.
var HERO_BODY_RATIO = 2;

var LANDING_RE = /\b(landing page|landing-page|home ?page|marketing page|digest|one.?pager)\b/i;

// run(content, spec) -> { issues: string[], warnings: string[] }
// issues are mechanical yes/no findings; build-runner feeds them back to the
// model and refuses to ship if a retry cannot clear them. Anything that depends
// on judgement, or that this parser could be wrong about, is a warning.
function run(content, spec) {
  var issues = [];
  var warnings = [];
  var text = String(content == null ? '' : content);
  // Only an HTML deliverable has fonts and a hero. A markdown document is a
  // legitimate output of this pipeline and must pass untouched.
  if (!/<html[\s>]|<!DOCTYPE html/i.test(text)) return { issues: issues, warnings: warnings };

  var props = customProps(text);
  var loaded = loadedFonts(text);
  var seen = Object.create(null);
  var m;
  FONT_FAMILY_DECL_RE.lastIndex = 0;
  while ((m = FONT_FAMILY_DECL_RE.exec(text))) {
    // A font-family inside @font-face DEFINES a face rather than requesting
    // one, and it is not filtered out here on purpose: loadedFonts() has
    // already recorded it, so isLoaded() answers true and it cannot produce a
    // finding. Filtering by position would need a real CSS parser to do
    // correctly; this arrives at the same answer without one.
    var families = resolveFamilyValue(m[1], props, 0);
    if (!families || !families.length) continue;
    var first = families[0];
    if (isSystemFamily(first)) continue;
    var key = norm(first);
    if (seen[key]) continue;
    seen[key] = true;
    if (loaded.families.indexOf(key) !== -1 || isLoaded(first, loaded)) continue;
    issues.push('font-family "' + first + '" is named but never loaded — add its ' +
      '<link rel="stylesheet"> or @import (with display=swap) to <head>. Without it the ' +
      'page renders in a fallback face and every type choice above it is discarded.');
  }
  // Loading without display=swap is a flash-of-invisible-text nicety, not a
  // broken page. Warning, so it is said once and never throws away a build.
  if (loaded.urls.length && !loaded.swapUrls.length) {
    warnings.push('the font stylesheet is loaded without display=swap — text is invisible until the face arrives');
  }

  var scale = typeScale(text);
  if (scale.headingPx != null) {
    if (scale.headingPx < scale.bodyPx * HERO_BODY_RATIO) {
      issues.push('the largest heading is ' + Math.round(scale.headingPx) + 'px against ' +
        Math.round(scale.bodyPx) + 'px body text (' + (scale.headingSelector || 'heading') +
        ') — a headline must be at least ' + HERO_BODY_RATIO + 'x body size. Use a clamp() scale.');
    } else if (LANDING_RE.test(String(spec || '')) && scale.headingPx < HERO_MIN_PX) {
      issues.push('the hero headline is ' + Math.round(scale.headingPx) + 'px — a landing page ' +
        'headline is at least ' + HERO_MIN_PX + 'px at desktop width. Use clamp() so it scales down on mobile.');
    }
  }

  if (LANDING_RE.test(String(spec || ''))) {
    var len = visibleTextLength(text);
    if (len < STUB_TEXT_CHARS) {
      warnings.push('the page carries only ' + len + ' characters of visible text — that is a stub, not a page');
    }
  }

  return { issues: issues, warnings: warnings };
}

// Perceived lightness of a single CSS colour string on 0..1, or null when it
// cannot be read. Public because design-system-prompt.js asks the same question
// about a palette's Background as this file asks about a rendered page, and two
// implementations of it would drift.
function colorLightness(value) {
  return lightness(parseColor(value, Object.create(null), 0));
}

module.exports = {
  run: run,
  pageDarkness: pageDarkness,
  colorLightness: colorLightness,
  DARK_MAX_LIGHTNESS: DARK_MAX_LIGHTNESS,
  // Exported for the unit tests: each of these is worth its own inputs.
  _norm: norm,
  _parseColor: parseColor,
  _stylesheet: stylesheet,
  _DARK_MAX_LIGHTNESS: DARK_MAX_LIGHTNESS,
  _isSystemFamily: isSystemFamily,
  _customProps: customProps,
  _resolveFamilyValue: resolveFamilyValue,
  _loadedFonts: loadedFonts,
  _sizeToPx: sizeToPx,
  _typeScale: typeScale,
  _visibleTextLength: visibleTextLength,
  _HERO_MIN_PX: HERO_MIN_PX,
  _HERO_BODY_RATIO: HERO_BODY_RATIO,
  _STUB_TEXT_CHARS: STUB_TEXT_CHARS,
};
