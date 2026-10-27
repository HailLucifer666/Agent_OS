'use strict';

// test/preview-isolation.test.js — a generated build runs in an opaque origin of
// its own and still loads its own files (2026-09-29 audit, B3c).
//
// MEASURED FIRST, 2026-09-30, Electron 43.4.1 (a loopback server playing MYTHOS,
// a HUD page with a preload bridge and the real SameSite=Strict session cookie,
// the build in an iframe): with no header the build READ the HUD's document and
// REACHED its bridge (window.parent.mythos.setSetting was a function), used
// localStorage, and its fetch to /api carried the HUD's origin and cookie and got
// a 200. With the CSP sandbox both parent reads threw SecurityError, localStorage
// threw, self.origin was "null", /api got Origin: null and no cookie — and the
// build's own app.js arrived with Sec-Fetch-Site: cross-site and NO cookie, which
// the real cross-origin guard on /vault/builds REFUSED. That last measurement is
// why the capability path exists.
//
// These tests drive the REAL middleware (the server-wide CSP, copied from
// server/index.js's own source; the cross-origin guard; the redirect; the
// capability server; the static mount with the preview headers) in an express app
// over a temporary builds folder laid out like the real vault — a flat shelf of
// single-file deliverables beside multi-file projects — sending the headers a
// browser sends. server/index.js's wiring order is pinned from its source.
//
// The independent review (Opus 5.5, 2026-09-30) found that the first version of
// these tests passed only because every fixture folder held one file: the real
// vault keeps 14 deliverables side by side in pipeline/. The fixture below is that
// layout, plus a junction and a page in a project subfolder.
//
// Probes: see the probe record at the end of this file.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const iso = require('../src/core/server/preview-isolation');
const { createCrossOriginGuard, crossOriginRefusal } = require('../src/core/server/boot-guards');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
// The server-wide policy, taken from the server's own source so this test cannot
// drift from it: two routes, one answer.
const GLOBAL_CSP = /function setCspHeaders[\s\S]*?res\.setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(SERVER)[1];

let dir;
let base;
let server;
let clock = Date.now();
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b3c-'));
  for (const [rel, body] of [
    ['projects/proj/index.html', '<script src="app.js"></script>'], ['projects/proj/app.js', 'window.ran = 1;'],
    ['projects/proj/css/s.css', 'b{}'], ['projects/proj/docs/index.html', '<link rel="stylesheet" href="../css/s.css">'],
    ['projects/proj/.env', 'NOPE=1'], ['projects/other/secret.html', 'other project only'],
    ['pipeline/foo.html', 'foo deliverable'], ['pipeline/bar.html', 'bar deliverable'], ['pipeline/logo.png', 'png'],
    ['root.html', 'root'], ['root.js', 'root script'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  // A junction inside one project pointing at another (the build engine can make
  // one; a cloned repo can carry a symlink). Junctions need no privilege on Windows.
  fs.symlinkSync(path.join(dir, 'projects', 'other'), path.join(dir, 'projects', 'proj', 'j'), 'junction');
  const caps = iso.createPreviewCapabilities({ now: () => clock });
  const routes = iso.createPreviewRoutes({ buildsDir: dir, caps });
  const app = express();
  // The same order as server/index.js (pinned below): the server-wide CSP first,
  // then guard, redirect, static; /vault/p on its own.
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', GLOBAL_CSP); next(); });
  app.use('/vault/builds', createCrossOriginGuard({ allowedOrigins: new Set() }));
  app.use('/vault/builds', routes.redirectNavigation);
  app.use('/vault/p', routes.serve);
  app.use('/vault/builds', express.static(dir, { etag: true, lastModified: true, maxAge: 0, setHeaders: iso.setPreviewHeaders }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const NAV = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const SUB_FROM_SANDBOX = { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
const get = (p, headers) => fetch(base + p, { headers: headers || {}, redirect: 'manual' });
const capFor = async (p) => (await get(p, NAV)).headers.get('location');

describe('every build response is sandboxed, and keeps the server-wide policy', () => {
  test('both policies on /vault/builds and on /vault/p: the sandbox (NO allow-same-origin, no top navigation, no popup escape) AND frame-ancestors \'self\'', async () => {
    const loc = await capFor('/vault/builds/projects/proj/index.html');
    for (const p of ['/vault/builds/projects/proj/index.html', loc]) {
      const r = await get(p, p === loc ? NAV : {});
      assert.equal(r.status, 200, p);
      const policies = r.headers.get('content-security-policy').split(', ');
      assert.deepEqual(policies, [GLOBAL_CSP, iso.PREVIEW_CSP], 'appended, never replaced: frame-ancestors \'self\' still refuses another site framing the build');
      assert.match(GLOBAL_CSP, /frame-ancestors 'self'/);
      for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox', 'allow-storage-access']) assert.ok(!iso.PREVIEW_CSP.includes(forbidden), forbidden);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    }
  });

  test('the HUD\'s own frames carry the SAME sandbox as the header; the web panel gives a build none of the player\'s grants', () => {
    const url = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'url.js'), 'utf8');
    const m = /export const PREVIEW_SANDBOX = '([^']+)';/.exec(url);
    assert.ok(m);
    assert.equal(m[1], iso.PREVIEW_SANDBOX, 'two routes, one answer');
    const forge = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'forge.js'), 'utf8');
    assert.match(forge, /<iframe class="forge-preview" sandbox="\$\{PREVIEW_SANDBOX\}"/);
    const panel = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'web-panel.js'), 'utf8');
    const attr = /\$\{isBuild \? `sandbox="\$\{PREVIEW_SANDBOX\}"` : '(allow="[^']*" allowfullscreen)'\}/.exec(panel);
    assert.ok(attr, 'the web panel sandboxes a build, and only a build — YouTube needs its own origin and its grants');
    assert.match(attr[1], /clipboard-write/, 'the grants stay on the non-build branch');
    assert.equal((panel.match(/clipboard-write/g) || []).length, 1, 'and nowhere else: a build frame gets no clipboard or fullscreen grant');
    assert.equal((panel.match(/allowfullscreen/g) || []).length, 1);
  });

  test('isVaultBuildUrl: same-origin /vault/builds or /vault/p, any case; never another origin or path', async () => {
    const { isVaultBuildUrl } = await import('../ui/public/js/url.js');
    const B = 'http://127.0.0.1:4478/';
    for (const u of ['/vault/builds/x/index.html', '/VAULT/Builds/x.html', 'http://127.0.0.1:4478/vault/builds/a', '/vault/p/cap/x/index.html']) assert.equal(isVaultBuildUrl(u, B), true, u);
    for (const u of ['https://www.youtube.com/embed/x', '/vault/other', '//evil/vault/builds/x', 'javascript:alert(1)']) assert.equal(isVaultBuildUrl(u, B), false, u);
  });
});

describe('a build\'s own files load through the capability path — and nothing else does', () => {
  test('MEASURED CASE: without it, the sandboxed page\'s own script is refused by the real guard', async () => {
    const r = await get('/vault/builds/projects/proj/app.js', SUB_FROM_SANDBOX);
    assert.equal(r.status, 403, 'exactly what the Electron probe showed: Sec-Fetch-Site cross-site, refused');
  });

  test('a navigation to a project page is redirected once to /vault/p/<capability>/…; the page and its own files load there', async () => {
    const r = await get('/vault/builds/projects/proj/index.html', NAV);
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.match(loc, /^\/vault\/p\/[1-9a-z][0-9a-z]*\.d2\.[A-Za-z0-9_-]{43}\/projects\/proj\/index\.html$/, 'a project: the capability covers the project folder');
    assert.equal((await get(loc, NAV)).status, 200);
    const capBase = loc.slice(0, loc.lastIndexOf('/') + 1);
    for (const f of ['app.js', 'css/s.css']) {
      assert.equal((await get(capBase + f, SUB_FROM_SANDBOX)).status, 200, f + ' loads as the sandboxed page\'s cross-site subresource');
    }
  });

  test('a page in a project SUBFOLDER still reaches ../ inside its project (Forge can preview docs/index.html)', async () => {
    const loc = await capFor('/vault/builds/projects/proj/docs/index.html');
    assert.match(loc, /\.d2\./);
    const css = loc.replace(/docs\/index\.html$/, 'docs/../css/s.css');
    // A browser resolves ../ before it asks, so the request it sends is:
    const resolved = new URL(css, 'http://x').pathname;
    assert.equal((await get(resolved, SUB_FROM_SANDBOX)).status, 200);
  });

  test('(F1) on a flat shelf the capability covers the ONE page navigated to: a sibling deliverable is refused', async () => {
    const loc = await capFor('/vault/builds/pipeline/foo.html');
    assert.match(loc, /^\/vault\/p\/[1-9a-z][0-9a-z]*\.f2\.[A-Za-z0-9_-]{43}\/pipeline\/foo\.html$/);
    assert.equal((await get(loc, NAV)).status, 200);
    const cap = loc.split('/')[3];
    for (const sib of ['bar.html', 'logo.png']) {
      const r = await get('/vault/p/' + cap + '/pipeline/' + sib, SUB_FROM_SANDBOX);
      assert.equal(r.status, 403, 'a leaked capability for foo.html must not read ' + sib);
      assert.doesNotMatch(await r.text(), /bar deliverable|png/);
    }
  });

  test('(F2) a project capability cannot read another project, climb out, reach dotfiles, or follow a junction out', async () => {
    const cap = (await capFor('/vault/builds/projects/proj/index.html')).split('/')[3];
    for (const p of ['/projects/other/secret.html', '/projects/proj/..%2Fother/secret.html', '/projects/proj/%2e%2e/other/secret.html', '/projects/proj/.env', '/projects/proj/j/secret.html']) {
      const r = await get('/vault/p/' + cap + p, SUB_FROM_SANDBOX);
      assert.ok(r.status === 403 || r.status === 404, p + ' -> ' + r.status);
      assert.doesNotMatch(await r.text(), /other project only|NOPE/, p);
    }
    const viaJunction = await get('/vault/p/' + cap + '/projects/proj/j/secret.html', SUB_FROM_SANDBOX);
    assert.equal(viaJunction.status, 403);
    assert.match(await viaJunction.text(), /outside the build/);
  });

  test('a forged, tampered, re-spelled or expired capability is refused; only GET and HEAD', async () => {
    const loc = await capFor('/vault/builds/projects/proj/index.html');
    const cap = loc.split('/')[3];
    const tampered = cap.slice(0, -1) + (cap.endsWith('A') ? 'B' : 'A');
    assert.equal((await get('/vault/p/' + tampered + '/projects/proj/app.js')).status, 403);
    assert.equal((await get('/vault/p/zzz.d2.' + 'A'.repeat(43) + '/projects/proj/app.js')).status, 403);
    assert.equal((await get('/vault/p/0' + cap + '/projects/proj/app.js')).status, 403, 'one spelling per capability');
    assert.equal((await fetch(base + loc, { method: 'POST' })).status, 405);
    clock += iso.PREVIEW_TTL_MS + 1000;
    try {
      const r = await get(loc);
      assert.equal(r.status, 403, 'expired');
      assert.match(await r.text(), /expired/, 'the refusal names the reason');
    } finally { clock -= iso.PREVIEW_TTL_MS + 1000; }
  });

  test('another website\'s navigation is refused BEFORE any capability is minted', async () => {
    const r = await get('/vault/builds/projects/proj/index.html', { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('location'), null);
  });

  test('ADJACENT: non-navigations are served as before (with the headers); a folder gets its slash first; a missing file mints nothing; a root file is its own scope', async () => {
    const plain = await get('/vault/builds/projects/proj/index.html');
    assert.equal(plain.status, 200, 'no Sec-Fetch-Dest (a test, open_artifact\'s preflight): served directly');
    assert.equal((await get('/vault/builds/projects/proj', NAV)).status, 301, 'a folder named without its slash: the static handler adds it');
    const slash = await capFor('/vault/builds/projects/proj/');
    assert.match(slash, /\/projects\/proj\/index\.html$/, 'a trailing slash names the folder\'s index');
    const missing = await get('/vault/builds/projects/proj/nope.html', NAV);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('location'), null);
    const root = await capFor('/vault/builds/root.html');
    assert.match(root, /\.f1\./);
    assert.equal((await get(root, NAV)).status, 200);
    assert.equal((await get('/vault/p/' + root.split('/')[3] + '/root.js', SUB_FROM_SANDBOX)).status, 403, 'a file at the builds root covers itself only');
  });

  test('the redirect keeps the page\'s own query and drops a signed link\'s exp and sig', async () => {
    const loc = await capFor('/vault/builds/projects/proj/index.html?exp=1&sig=abc&level=3');
    assert.match(loc, /\?level=3$/);
    assert.doesNotMatch(loc, /sig=|exp=/);
  });

  test('DISPOSITION (F3): /vault/p sends NO Access-Control-Allow-Origin, even to an opaque origin — a module script, fetch() or font of a build\'s own does not load, deliberately', async () => {
    const loc = await capFor('/vault/builds/projects/proj/index.html');
    const r = await get(loc.replace(/index\.html$/, 'app.js'), { origin: 'null', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'script' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'with one, any page holding a leaked capability could read the bytes');
  });

  test('a refusal says why: outside the build, expired, or not covered', async () => {
    const cap = (await capFor('/vault/builds/projects/proj/index.html')).split('/')[3];
    assert.match(await (await get('/vault/p/' + cap + '/projects')).text(), /does not cover this file|outside/);
    assert.match(await (await get('/vault/p/' + cap + '/projects/proj/j/secret.html')).text(), /outside the build/);
    assert.match(await (await get('/vault/p/' + cap + '/projects/other/secret.html')).text(), /does not cover this file/);
  });
});

describe('the pieces', () => {
  test('segmentsOf refuses traversal, empty and dot segments, NUL, backslashes and drive colons', () => {
    for (const p of ['/a/..%2Fb', '/a/..%2fb/c', '/a/b%2Fc', '/a/../b', '/a/%2e%2e/b', '/a//b', '/a/./b', '/a/b%00c', '/a/b%5Cc', '/C:/x', '/a/%E0%A4%A']) assert.equal(iso.segmentsOf(p), null, p);
    assert.deepEqual(iso.segmentsOf('/app1/css/s.css'), ['app1', 'css', 's.css']);
    assert.deepEqual(iso.segmentsOf('/app1/'), ['app1', ''], 'a trailing slash is the folder\'s index');
  });

  test('scopeOf: a whole build inside projects/engagements/installs (any case); exactly one file anywhere else', () => {
    assert.deepEqual(iso.scopeOf(['projects', 'p', 'docs', 'index.html']), { kind: 'd', segs: ['projects', 'p'] });
    assert.deepEqual(iso.scopeOf(['Engagements', 'e1', 'index.html']), { kind: 'd', segs: ['Engagements', 'e1'] });
    assert.deepEqual(iso.scopeOf(['installs', 'repo', 'README.html']), { kind: 'd', segs: ['installs', 'repo'] });
    for (const f of [['pipeline', 'a.html'], ['kanban', 'b.html'], ['projects', 'loose.html'], ['something-new', 'x', 'y.html'], ['root.html']]) {
      assert.deepEqual(iso.scopeOf(f), { kind: 'f', segs: f }, f.join('/') + ': an unknown or flat layout gets the narrow answer');
    }
  });

  test('a capability binds its kind, its scope and its expiry; one minted with another secret is refused', () => {
    let t = 1000;
    const caps = iso.createPreviewCapabilities({ now: () => t, ttlMs: 100 });
    const d = caps.mint({ kind: 'd', segs: ['projects', 'p'] });
    assert.equal(caps.verify(d, ['projects', 'p', 'x.js']).ok, true);
    assert.equal(caps.verify(d, ['projects', 'q', 'x.js']).ok, false);
    assert.equal(caps.verify(d, ['projects', 'p']).ok, false, 'the folder itself is not a file inside it');
    const f = caps.mint({ kind: 'f', segs: ['pipeline', 'a.html'] });
    assert.equal(caps.verify(f, ['pipeline', 'a.html']).ok, true);
    assert.equal(caps.verify(f, ['pipeline', 'b.html']).ok, false, 'one file means one file');
    assert.equal(caps.verify(f, ['pipeline', 'a.html', 'x']).ok, false);
    // The kind is signed: a folder capability re-labelled as a file one would
    // otherwise verify for the path of the folder itself (same segments, same expiry).
    assert.equal(caps.verify(d.replace('.d2.', '.f2.'), ['projects', 'p']).ok, false, 'the kind is signed');
    assert.equal(iso.createPreviewCapabilities({ now: () => t }).verify(d, ['projects', 'p', 'x.js']).ok, false, 'another server start, another secret');
    t = 1101;
    assert.equal(caps.verify(d, ['projects', 'p', 'x.js']).reason, 'expired');
  });

  test('an opaque origin\'s /api request (Origin: null) is refused by the guard', () => {
    assert.equal(crossOriginRefusal({ headers: { origin: 'null', host: '127.0.0.1:4478' } }, new Set()), 'origin');
  });

  test('server/index.js: guard and auth, then the redirect, then the static files; /vault/p on its own; a short lifetime when a token guards the vault', () => {
    const guard = SERVER.indexOf("app.use('/vault/builds', crossOriginGuard);");
    const auth = SERVER.indexOf("app.use('/vault/builds', require('../src/core/effectors/artifact-token').createArtifactAccess(");
    const redirect = SERVER.indexOf("app.use('/vault/builds', previewRoutes.redirectNavigation);");
    const cap = SERVER.indexOf("app.use('/vault/p', previewRoutes.serve);");
    const stat = SERVER.indexOf("app.use('/vault/builds', express.static(memory.fs.vaultPath('builds'), {");
    const csp = SERVER.indexOf('app.use(setCspHeaders);');
    for (const [n, v] of [['guard', guard], ['auth', auth], ['redirect', redirect], ['/vault/p', cap], ['static', stat], ['server-wide CSP', csp]]) assert.ok(v > 0, n + ' is mounted');
    assert.ok(guard < auth && auth < redirect && redirect < stat, 'only a request that is already allowed gets a capability, before the files are served');
    assert.ok(csp < cap && csp < stat, 'the server-wide policy is on the response before the preview policy is appended');
    assert.match(SERVER.slice(stat, stat + 300), /setHeaders: require\('\.\.\/src\/core\/server\/preview-isolation'\)\.setPreviewHeaders/);
    assert.match(SERVER, /createPreviewCapabilities\(\{ ttlMs: AUTH_TOKEN \? previewIsolation\.PREVIEW_TTL_TOKEN_MS : previewIsolation\.PREVIEW_TTL_MS \}\)/);
    assert.ok(iso.PREVIEW_TTL_TOKEN_MS < iso.PREVIEW_TTL_MS && iso.PREVIEW_TTL_TOKEN_MS <= 60 * 60 * 1000);
  });
});

describe('(F6) a capability never leaves MYTHOS in a URL it reports', () => {
  const CAP_URL = 'http://127.0.0.1:4478/vault/p/lz3k9a0.d2.' + 'A'.repeat(43) + '/projects/proj/index.html?level=3';

  test('withoutCapability reports the /vault/builds address of the same file; any other URL is untouched', () => {
    assert.equal(iso.withoutCapability(CAP_URL), 'http://127.0.0.1:4478/vault/builds/projects/proj/index.html?level=3');
    for (const u of ['https://example.com/vault/p/x', 'http://127.0.0.1:4478/vault/builds/a.html', '', undefined]) assert.equal(iso.withoutCapability(u), u);
  });

  test('the browser tools\' one exit (from-browser ok) applies it to url and to every tab', async () => {
    const agent = require('../adapters/browser-agent');
    const fb = require('../src/core/effectors/from-browser');
    const saved = { withPage: agent.withPage, getStatus: agent.getStatus };
    agent.getStatus = () => ({ state: 'ONLINE', hint: null });
    agent.withPage = async (fn) => fn({ title: async () => 'T', url: () => CAP_URL });
    try {
      const r = await fb.browser_get_title();
      assert.equal(r.ok, true);
      assert.equal(r.result.url, 'http://127.0.0.1:4478/vault/builds/projects/proj/index.html?level=3');
      assert.doesNotMatch(JSON.stringify(r), /\/vault\/p\//);
    } finally { Object.assign(agent, saved); }
  });

  test('the effect capsule every browser action reports (browser-effect capture) carries the /vault/builds address', async () => {
    const { capture } = require('../src/core/effectors/browser-effect');
    const capsule = await capture({ url: () => CAP_URL, title: async () => 'T', evaluate: async () => ({}) }, {});
    assert.equal(capsule.url, 'http://127.0.0.1:4478/vault/builds/projects/proj/index.html?level=3');
  });
});

// PROBE RECORD, 2026-09-30. 29 mutations, each applied as one exact replacement,
// its change confirmed by sha256, this file run, then restored from a byte copy
// and re-verified by sha256 (the tree was byte-identical afterwards). Every one
// turned at least one test here red; none was green.
//   Sandbox and headers: allow-same-origin added (P1); the preview policy SET over
//     the server-wide one (P2); no preview policy (P3); no Referrer-Policy (P20);
//     Access-Control-Allow-Origin: * added (P21, the F3 disposition test).
//   Redirect: never redirects (P4); a missing file mints (P13); a signed link's
//     exp/sig kept in the new URL (P14).
//   Capability: signature unchecked (P5); expiry unchecked (P6); a folder
//     capability covers the folder itself (P7); the kind not signed (P11); a
//     leading-zero re-spelling accepted (P12).
//   Scope: a shelf page's capability widened to its folder (P8, F1 — the sibling
//     deliverable test); a project page's narrowed to its own folder (P9, F5 — the
//     docs/../css test); the real-path check removed (P10) or kept for the builds
//     root only (P10b) — both F2, the junction test.
//   Serving: any method (P18); dotfiles served (P19); every refusal the same text
//     (P25, F9).
//   HUD: isVaultBuildUrl misses /vault/p (P15); the Forge frame unsandboxed (P16);
//     a build frame in the web panel given allowfullscreen (P17, F7).
//   Reported URLs: from-browser ok() not redacting (P22) and browser-effect's
//     capsule not redacting (P23), both F6; the token-install lifetime unwired in
//     server/index.js (P24).
//   Fixture probes, proving the tests watch the path production takes: the
//     server-wide CSP not mounted (P26 — the test that would have caught F4 now
//     fails without it); the cross-origin guard not mounted (P27); the junction
//     not created (P28 — the junction assertion expects "outside the build", so a
//     plain 404 is not enough).
