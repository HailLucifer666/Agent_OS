'use strict';

// server/preview-isolation.js — a generated build runs in an opaque origin of
// its own, never as MYTHOS, and still loads its own files (2026-09-29 audit, B3c).
//
// THE DEFECT, measured 2026-09-30 in Electron 43.4.1 (a loopback server playing
// MYTHOS, a HUD page with a preload bridge, a build in an iframe): the build READ
// the HUD's document and REACHED its key-store bridge (window.parent.mythos.
// setSetting was a function), used localStorage as the HUD, and its fetch to /api
// carried the HUD's origin and session cookie and got a 200. /vault/builds is
// served from the HUD's own origin, and a build is model-written HTML — a web page
// the model read can steer what it writes.
//
// THE FIX, in two parts.
//   1. Every build response carries
//        Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads
//      with NO allow-same-origin, IN ADDITION to the server-wide policy. The
//      browser then gives the document an opaque origin wherever it is shown — the
//      HUD's iframe, its own tab through open_artifact, Electron's media window.
//      Measured with the header on: the HUD's document and bridge both throw
//      SecurityError, localStorage throws, self.origin is "null", and /api
//      receives Origin: null (refused by the cross-origin guard) with no cookie.
//      Popups inherit the sandbox; the top window cannot be navigated.
//   2. An opaque origin's OWN sub-requests are cross-site: measured, its app.js
//      arrived with Sec-Fetch-Site: cross-site and no cookie, and the real
//      cross-origin guard on /vault/builds refused it. So a browser NAVIGATION to
//      a build file (Sec-Fetch-Dest document/iframe/…) that has already passed
//      that guard and the auth is redirected once to /vault/p/<capability>/<path>.
//      The capability is an HMAC over what it covers and an expiry, and the page's
//      relative scripts, styles and images inherit it through the path, loading
//      with no cookie and no same-origin claim. Nothing else mints one. Requests
//      that are not navigations (tests, open_artifact's preflight) are served at
//      /vault/builds exactly as before, with the header.
//
// WHAT A CAPABILITY COVERS, and why it is no wider (independent review,
// 2026-09-30). A sandboxed page can always read its own address and send it
// anywhere by an image beacon — the sandbox does not limit outgoing requests — so
// a capability must be assumed to leak. It therefore covers ONE build (scopeOf),
// never the shelf a build sits on; its REAL path on disk must stay inside that
// build (a junction or symlink cannot widen it); and it lives 12 hours on a
// token-less install, where it grants nothing a local program lacks anyway, but
// one hour where a token guards the vault.
//
// No hosting change: the same URL, port and server, so LAN and Docker installs get
// exactly this. The secret is random per server start, so a restart retires every
// capability; the HUD simply navigates again.
//
// THE COST, stated. In an opaque origin a build has no same-origin storage
// (localStorage and IndexedDB throw, cookies are empty). Classic scripts,
// stylesheets, images and media loaded by tags still load. Anything the browser
// loads in CORS mode does NOT: <script type="module">, import(), the build's own
// @font-face fonts, crossorigin tags, fetch() and workers — /vault/p sends no
// Access-Control-Allow-Origin, deliberately, because with one any web page
// holding a leaked capability could read the bytes. Counted 2026-09-30: none of
// the 53 generated pages in the operator's two vaults uses localStorage, a module
// script, fetch() or a worker; the deliverable prompt asks for single-file HTML
// (agent-actions DELIVERABLE_PREAMBLE). A build that needs them breaks, by design.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readAccess = require('../effectors/read-access-policy');

const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const PREVIEW_CSP = 'sandbox ' + PREVIEW_SANDBOX;
// Token-less: long enough for a preview left open through a review. With a token:
// short, because there a capability is the only credential a leaked link carries.
const PREVIEW_TTL_MS = 12 * 60 * 60 * 1000;
const PREVIEW_TTL_TOKEN_MS = 60 * 60 * 1000;
const NAVIGATION_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);
// Where MYTHOS's own writers put multi-file builds: forge-validate and from-runner
// (projects/<slug>, engagements/<id>) and the installer (installs/<slug>).
const BUILD_CONTAINERS = new Set(['projects', 'engagements', 'installs']);
const CAPABILITY_IN_PATH = /\/vault\/p\/[1-9a-z][0-9a-z]{0,11}\.[df][1-9][0-9]?\.[A-Za-z0-9_-]{43}\//g;

function setPreviewHeaders(res) {
  res.setHeader('Cache-Control', 'no-cache');
  // APPENDED, never set: the server-wide policy (server/index.js setCspHeaders:
  // frame-ancestors 'self', object-src 'none', base-uri 'self') is already on the
  // response and must stay — both policies are enforced. Replacing it let any site
  // holding a leaked capability frame the build (review finding, 2026-09-30).
  res.append('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The capability rides in the page's own URL; never send it on as a Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// Path segments, decoded, or null for anything that is not a plain relative path
// (traversal, empty or dot segments, NUL, backslashes, a drive).
function segmentsOf(urlPath) {
  const raw = String(urlPath || '').split('?')[0].replace(/^\/+/, '');
  if (!raw) return null;
  const segs = raw.split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    let s;
    try { s = decodeURIComponent(segs[i]); } catch (_) { return null; }
    const last = i === segs.length - 1;
    if (s === '' && last) { out.push(''); continue; } // a trailing slash: the folder's index
    // A "/" INSIDE a decoded segment is refused too: "..%2Fapp2" decodes to
    // "../app2", which is not ".." yet climbs out of the capability's folder once
    // the segments are joined (found by this file's own test, 2026-09-30).
    if (!s || s === '.' || s === '..' || /[\/\\\0:]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

// A trailing slash names the folder's index.html.
function asFile(segs) {
  return segs[segs.length - 1] === '' ? segs.slice(0, -1).concat('index.html') : segs;
}

// What one capability covers, for the file a navigation named. Inside a build
// container: that whole build (projects/<slug>/…), so a page in a subfolder still
// reaches ../style.css. Everywhere else the builds folder is a SHELF of unrelated
// single-file deliverables side by side (agent-actions writes builds/<kind>/<name>;
// on 2026-09-30 pipeline/ held 14, kanban/ 11, refine/ 12), so there it covers the
// ONE file navigated to and nothing beside it. A layout not named here gets that
// narrow answer.
function scopeOf(fileSegs) {
  if (fileSegs.length >= 3 && BUILD_CONTAINERS.has(fileSegs[0].toLowerCase())) return { kind: 'd', segs: fileSegs.slice(0, 2) };
  return { kind: 'f', segs: fileSegs };
}

function createPreviewCapabilities(opts) {
  const o = opts || {};
  const secret = o.secret || crypto.randomBytes(32);
  const now = o.now || Date.now;
  const ttlMs = o.ttlMs || PREVIEW_TTL_MS;
  const sign = (kind, segs, exp) => crypto.createHmac('sha256', secret)
    .update('mythos-preview\n' + kind + '\n' + exp + '\n' + segs.join('/')).digest('base64url');

  // scope: { kind: 'd' (a folder: anything strictly inside it) | 'f' (exactly
  // this file), segs }. The kind and depth ride in the capability so the server
  // knows which leading segments of a later path were signed, and how.
  function mint(scope) {
    const exp = now() + ttlMs;
    return exp.toString(36) + '.' + scope.kind + scope.segs.length + '.' + sign(scope.kind, scope.segs, exp);
  }

  // { ok:true, kind, root } when `cap` was minted here, is unexpired, and covers
  // the file `fileSegs`. The expiry has no leading zero, so each capability has
  // exactly one spelling.
  function verify(cap, fileSegs) {
    const m = /^([1-9a-z][0-9a-z]{0,11})\.([df])([1-9][0-9]?)\.([A-Za-z0-9_-]{43})$/.exec(String(cap || ''));
    if (!m || !fileSegs) return { ok: false, reason: 'malformed' };
    const exp = parseInt(m[1], 36);
    if (!(exp > now())) return { ok: false, reason: 'expired' };
    const kind = m[2];
    const depth = Number(m[3]);
    if (kind === 'd' ? fileSegs.length <= depth : fileSegs.length !== depth) return { ok: false, reason: 'outside' };
    const want = Buffer.from(sign(kind, fileSegs.slice(0, depth), exp));
    const got = Buffer.from(m[4]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'signature' };
    return { ok: true, kind, root: fileSegs.slice(0, depth) };
  }

  return { mint, verify };
}

// A capability inside a URL MYTHOS reports — a browser tool's page.url() after it
// followed the redirect — would reach the model, the audit vault and vault-sync's
// git remote as a pass. The /vault/builds address of the same file mints a fresh
// one on the next navigation, so reporting that instead loses nothing.
function withoutCapability(url) {
  return typeof url === 'string' ? url.replace(CAPABILITY_IN_PATH, '/vault/builds/') : url;
}

const REFUSALS = {
  expired: 'This preview link has expired. Open the build again from MYTHOS.',
  outside: 'This file is outside the build this preview link was made for.',
};
const REFUSAL_OTHER = 'This preview link does not cover this file, or is not valid any more. Open the build again from MYTHOS.';

function isInside(root, p) {
  const r = path.relative(root, p);
  return !!r && !path.isAbsolute(r) && r.split(path.sep)[0] !== '..';
}

// 2026-10-05 security bundle: a build folder holds whatever the build engine, a
// cloned repo or a careless build put there. B2d's protected names (a .env in any
// spelling, keys.json, auth-sessions.json, key folders, browser profiles) are never
// served from it. Each [root, path] pair is judged only BELOW its root, so the
// vault's own location cannot trip a rule, and both the path as asked and the
// real one are judged, because a junction with an ordinary name can point at a
// key folder. Answered as "Not found." so a refusal does not confirm the file.
function isProtectedBuildFile(pairs) {
  return pairs.some(([root, p]) => !!(p && isInside(root, p) && readAccess.protectedReason(path.join(path.sep, path.relative(root, p)), {})));
}

// deps: { buildsDir, caps } -> { redirectNavigation, serve }
function createPreviewRoutes(deps) {
  const { buildsDir, caps } = deps;

  // Mounted on /vault/builds AFTER the cross-origin guard and the auth, BEFORE
  // the static files: only a request that is already allowed gets a capability.
  function redirectNavigation(req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !NAVIGATION_DESTS.has(req.headers['sec-fetch-dest'])) return next();
    const segs = segmentsOf(req.path);
    if (!segs) return next();
    // Only an existing FILE (or a folder's index) gets a capability. A folder named
    // without its trailing slash goes to the static handler, which adds the slash;
    // that navigation comes back here. A missing path mints nothing and the static
    // handler 404s it.
    const fileSegs = asFile(segs);
    let isFile = false;
    try { isFile = fs.statSync(path.join(buildsDir, ...fileSegs)).isFile(); } catch (_) { isFile = false; }
    if (!isFile) return next();
    const query = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    query.delete('exp'); query.delete('sig'); // the capability supersedes a signed link
    const qs = query.toString();
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, '/vault/p/' + caps.mint(scopeOf(fileSegs)) + '/' + fileSegs.map(encodeURIComponent).join('/') + (qs ? '?' + qs : ''));
  }

  // Mounted on /vault/p. The capability IS the authority here, so no cookie, no
  // bearer token and no same-origin claim is needed — the sandboxed page's own
  // sub-requests have none of them.
  function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return res.status(405).end(); }
    const all = segmentsOf(req.path);
    const fileSegs = all && all.length >= 2 ? asFile(all.slice(1)) : null;
    const v = fileSegs ? caps.verify(all[0], fileSegs) : { ok: false, reason: 'malformed' };
    if (!v.ok) return res.status(403).type('text/plain').send(REFUSALS[v.reason] || REFUSAL_OTHER);
    // The capability names a PATH; the disk decides where a path lands. A junction
    // or symlink inside the build (the engine can make one, a cloned repo can carry
    // one) would serve whatever it points at — measured by the review: a junction
    // to a sibling build served it. So the REAL path must stay inside the real
    // folder the capability covers (for one file: that file's own folder) and
    // inside the real builds folder.
    let buildsReal;
    let rootReal;
    let real;
    try {
      buildsReal = fs.realpathSync.native(buildsDir);
      rootReal = fs.realpathSync.native(path.join(buildsDir, ...(v.kind === 'd' ? v.root : fileSegs.slice(0, -1))));
      real = fs.realpathSync.native(path.join(buildsDir, ...fileSegs));
    } catch (_) {
      return res.status(404).type('text/plain').send('Not found.');
    }
    if (!isInside(rootReal, real) || !isInside(buildsReal, real)) return res.status(403).type('text/plain').send(REFUSALS.outside);
    if (isProtectedBuildFile([[buildsDir, path.join(buildsDir, ...fileSegs)], [buildsReal, real]])) return res.status(404).type('text/plain').send('Not found.');
    setPreviewHeaders(res);
    // Sent by its REAL path, relative to the real builds root, so the dotfile rule
    // judges only the part inside the vault (never a dot folder above it).
    res.sendFile(path.relative(buildsReal, real).split(path.sep).join('/'), { root: buildsReal, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode === 403 ? 403 : 404).type('text/plain').send('Not found.');
    });
  }

  // Mounted on /vault/builds before the gzip and static handlers (server/index.js),
  // which serve build files without the capability.
  function refuseProtected(req, res, next) {
    const segs = segmentsOf(req.path);
    // A path segmentsOf refuses (":", "..", NUL, a backslash, bad encoding) is never
    // a build file, and passing it on let express.static open "keys.json::$DATA",
    // NTFS's other name for keys.json (attacked 2026-10-05). Only the bare root goes on.
    if (!segs) return String(req.path || '').replace(/^\/+/, '') ? res.status(404).type('text/plain').send('Not found.') : next();
    const lexical = path.join(buildsDir, ...asFile(segs));
    let buildsReal = null;
    let real = null;
    try { buildsReal = fs.realpathSync.native(buildsDir); real = fs.realpathSync.native(lexical); } catch (_) { real = null; }
    if (isProtectedBuildFile([[buildsDir, lexical], [buildsReal, real]])) return res.status(404).type('text/plain').send('Not found.');
    return next();
  }

  return { redirectNavigation, serve, refuseProtected };
}

module.exports = {
  setPreviewHeaders, createPreviewCapabilities, createPreviewRoutes, segmentsOf, scopeOf, withoutCapability,
  PREVIEW_CSP, PREVIEW_SANDBOX, PREVIEW_TTL_MS, PREVIEW_TTL_TOKEN_MS, NAVIGATION_DESTS,
};
