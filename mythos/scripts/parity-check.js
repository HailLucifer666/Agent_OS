#!/usr/bin/env node
'use strict';

// scripts/parity-check.js — prove, mechanically, that this MYTHOS is configured
// the way it is supposed to be.
//
// WHY THIS EXISTS, in the operator's own words: "every time I launch a new app I
// have to go through the whole list again." On 2026-08-11 a freshly installed
// MYTHOS.exe logged four incidents in under two minutes — volume oscillating
// between 100% and 15%, Spotify playing a live cut, Tier-1/2 approval prompts
// with autonomy configured not to need them, and a dead wake word — all of which
// had been fixed and verified over two months of the Electron dev run. A
// file-by-file hash comparison then showed all 409 files under mythos/** in the
// install were byte-identical to the working tree. The code was never the
// problem. Runtime CONFIGURATION and VAULT STATE were, and nothing anywhere could
// be asked about either.
//
// So this script asks. Run it against the dev run and against the installed app;
// the two reports must match. Every check is a machine-checked fact with a name,
// and the exit code is non-zero with a named list on any failure — so a future
// build is verified by running one command instead of by re-testing every feature
// by hand.
//
// Usage:
//   node scripts/parity-check.js                       # attach to 127.0.0.1:4478
//   node scripts/parity-check.js --port 4478 --json
//   node scripts/parity-check.js --token <MYTHOS_AUTH_TOKEN>
//
// It ATTACHES to a running server rather than booting one, on purpose: the whole
// question is what THIS install resolved at boot, and a fresh in-process boot
// would answer with its own environment instead.

const http = require('http');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 4478;
const DEFAULT_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 8000;

// The keys whose value in the install MUST match the dev run, because each one is
// traceable to one of the four incidents or to the voice path itself. This is the
// list that would have caught all of it.
const PARITY_KEYS = [
  // Incident 1 (volume oscillation) and the whole voice path: dev's .env is the
  // only place that ever set these, and the packaged build had no way to receive
  // them. Live being ON is what keeps the run off the ducking path entirely.
  'VOICE_S2S_ENABLED',
  'VOICE_TTS_PROVIDER',
  'VOICE_TTS_CHAIN',
  // Incident 4 (dead wake word).
  'WAKEWORD_ENABLED',
  // Incident 3 (approval prompts) — the config half of the ceiling.
  'AUTONOMOUS_MAX_TIER',
  // The ducking hysteresis added the same day. If Live is somehow off, these are
  // what stop the loop, so their values are part of parity too.
  'DUCK_MIN_HOLD_MS',
  'DUCK_COOLDOWN_MS',
];

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: DEFAULT_HOST, json: false, token: process.env.MYTHOS_AUTH_TOKEN || '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--port') { out.port = Number(argv[i + 1]); i += 1; }
    else if (arg === '--host') { out.host = String(argv[i + 1]); i += 1; }
    else if (arg === '--token') { out.token = String(argv[i + 1]); i += 1; }
  }
  return out;
}

function getJson(host, port, urlPath, token) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.get({ host, port, path: urlPath, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: parsed, raw: body.slice(0, 400) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: null, raw: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, body: null, raw: err.message }));
  });
}

// A check is {name, ok, detail}. `ok:null` means INDETERMINATE — the same honesty
// rule the HUD's own probes follow: a server that did not answer is not evidence
// of a misconfiguration, and reporting it as a failure would train the operator
// to ignore this script.
function check(name, ok, detail) {
  return { name, ok, detail: detail === undefined ? '' : String(detail) };
}

async function runChecks(opts) {
  const { host, port, token } = opts;
  const checks = [];

  const settings = await getJson(host, port, '/api/config/settings', token);
  if (!settings.ok || !settings.body) {
    checks.push(check('server-reachable', false,
      `GET /api/config/settings -> ${settings.status || 'no response'} ${settings.raw}`
      + (settings.status === 401 ? ' (pass --token, or MYTHOS_AUTH_TOKEN in the environment)' : '')));
    return checks; // nothing else can be asserted without this
  }
  checks.push(check('server-reachable', true, `${host}:${port}`));

  const byName = new Map((settings.body.keys || []).map((k) => [k.name, k]));

  // ---- 1. effective value + origin for every parity-critical key ----------------
  // The ORIGIN is as much the point as the value. A key that is right by accident
  // (the schema default happens to match) is not the same fact as a key the
  // operator set, and only the origin distinguishes them.
  for (const name of PARITY_KEYS) {
    const row = byName.get(name);
    if (!row) { checks.push(check(`key:${name}`, false, 'not reported by /api/config/settings')); continue; }
    const atDefault = row.origin === 'default';
    checks.push(check(`key:${name}`, !atDefault,
      `${row.value} (origin: ${row.origin})`
      + (atDefault ? ' — at its schema DEFAULT, which is what a packaged install with no config.json looks like' : '')));
  }

  // The install's whole failure was "config.json does not exist and nothing said
  // so". Count what each layer actually contributed.
  const origins = {};
  for (const row of settings.body.keys || []) origins[row.origin] = (origins[row.origin] || 0) + 1;
  const fromFile = (origins['config.json'] || 0) + (origins['.env'] || 0);
  checks.push(check('config-source-present', fromFile > 0,
    `${fromFile} key(s) come from a config file (config.json: ${origins['config.json'] || 0}, `
    + `.env: ${origins['.env'] || 0}); env: ${origins.env || 0}, derived: ${origins.derived || 0}, `
    + `default: ${origins.default || 0}`));
  checks.push(check('settings-file', Boolean(settings.body.file), settings.body.file || 'no settings file path reported'));

  // ---- 2. the autonomy ceiling, and where it came from --------------------------
  // Incident 3. leash/index.js gates on Math.min(config, boundaries), so an
  // effective ceiling BELOW the configured one means something clamped it — which
  // on the install was a missing Identity/boundaries.md being read as malformed.
  const autonomy = settings.body.autonomy || {};
  if (autonomy.effective === null || autonomy.effective === undefined) {
    checks.push(check('autonomy-ceiling', null, 'the server did not report an autonomy snapshot'));
  } else {
    checks.push(check('autonomy-ceiling', autonomy.effective === autonomy.configCeiling,
      `effective ${autonomy.effective} vs configured ${autonomy.configCeiling} `
      + `(boundaries.md: ${autonomy.boundariesCeiling}, source: ${autonomy.source})`));
    checks.push(check('autonomy-source', autonomy.source === 'file',
      `${autonomy.source}`
      + (autonomy.source === 'malformed-failsafe' ? ' — boundaries.md is present but unparseable; the ceiling is clamped to 1' : '')
      + (autonomy.source === 'absent-config-ceiling' ? ' — no Identity/boundaries.md; seeding it did not run or could not write' : '')));
  }

  // ---- 3. wake word + Silero weights, as files -----------------------------------
  // Incident 4. modelsPresent is a live statSync across every model directory
  // (core/setup/model-paths.js), so this is on-disk fact, not a remembered flag.
  const wake = await getJson(host, port, '/api/config/wakeword', token);
  if (!wake.ok || !wake.body) {
    checks.push(check('wakeword-models', null, `GET /api/config/wakeword -> ${wake.status} ${wake.raw}`));
  } else {
    checks.push(check('wakeword-models', wake.body.modelsPresent === true,
      wake.body.modelsPresent ? 'all three .onnx weights present' : 'weights missing — run the wizard\'s Components step'));
    // The flag and the files must agree. deriveWakewordDefaults turns the flag on
    // when the weights exist, so a disagreement means someone set it by hand
    // against the evidence.
    checks.push(check('wakeword-armed', wake.body.enabled === true && wake.body.modelsPresent === true,
      `enabled=${wake.body.enabled}, modelsPresent=${wake.body.modelsPresent}`));
  }

  const { findModelFile } = require(path.join(__dirname, '..', 'src', 'core', 'setup', 'model-paths.js'));
  const silero = findModelFile('silero', 'silero_vad.onnx');
  checks.push(check('silero-model', Boolean(silero), silero ? `${silero.file} (${silero.size}B)` : 'not found in any model directory'));

  // ---- 4. the TTS chain resolves to a provider that exists HERE ------------------
  // The install spoke with the flat browser voice while dev used Gemini, because
  // the chain's default is '' -> 'edge', edge-tts is deliberately not bundled, and
  // kokoro needs models that are not shipped either. So "a chain is configured" is
  // not the check; "the first link can actually speak on this machine" is.
  const chainRow = byName.get('VOICE_TTS_CHAIN');
  const chain = String((chainRow && chainRow.value) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const googleKey = byName.get('GOOGLE_API_KEY');
  const resolvable = [];
  for (const link of chain) {
    if (link === 'gemini') { if (googleKey && googleKey.set) resolvable.push('gemini'); continue; }
    if (link === 'piper') { if (findModelFile('piper', '') || piperHasVoice()) resolvable.push('piper'); continue; }
    // edge-tts is BYO by licence (LGPLv3, deliberately not bundled) and kokoro
    // needs mythos/models. Neither can be asserted from here without a real call,
    // so they are listed as present-but-unverified rather than claimed.
  }
  checks.push(check('tts-chain-resolvable', resolvable.length > 0,
    `chain [${chain.join(', ') || 'empty'}] — verifiable providers on this machine: `
    + `[${resolvable.join(', ') || 'none'}]`));

  // ---- 5. the server is actually alive ------------------------------------------
  // '/health', NOT '/api/health' — the liveness route is mounted outside the /api
  // namespace (server/index.js) precisely so it works before authentication. This
  // check asked for the wrong path on its first live run and reported a 404 as a
  // failure, which is the sort of thing a parity check exists to have caught in
  // itself before the operator relies on it.
  const health = await getJson(host, port, '/health', token);
  checks.push(check('health', Boolean(health.ok), health.ok ? 'ok' : `GET /health -> ${health.status} ${health.raw}`));

  // ---- 6. the vault holds the identity that shapes behaviour ---------------------
  // The install's vault was a second, empty brain: no boundaries.md (which caused
  // incident 3), no operator profile or style, no contacts, none of the 8 learned
  // skills. Checked as files, in the vault this server actually opened.
  const vaultRoot = resolveVaultRootFromSettings(byName);
  if (!vaultRoot) {
    checks.push(check('vault-identity', null, 'the server did not report MYTHOS_VAULT_ROOT'));
  } else {
    checks.push(check('vault-root', dirExists(vaultRoot), vaultRoot));
    for (const rel of ['Identity/boundaries.md', 'Identity/operator-profile.txt', 'Identity/operator-style.txt', 'Contacts/contacts.json']) {
      const file = path.join(vaultRoot, rel);
      const size = fileSize(file);
      checks.push(check(`vault:${rel}`, size > 0, size > 0 ? `${size}B` : 'missing or empty'));
    }
    const skills = countMarkdown(path.join(vaultRoot, 'Skills'));
    checks.push(check('vault:Skills/*.md', skills > 0, `${skills} learned skill(s)`));
  }

  // ---- 7. every adapter's state, and the tools that depend on it -----------------
  // BUG-360 (2026-08-26). This script's whole premise is that a packaged install
  // can be byte-identical to the dev tree and still behave differently — and
  // ADAPTERS are the largest such surface, because each one gates a whole family
  // of tools and each resolves an external binary at boot. Until now nothing here
  // asked about them, and the cost was measurable: android-child sat OFFLINE
  // because nothing ever resolved the adb that setup-android.js had already
  // installed, so all 14 phone_* tools were withheld from the model as
  // UNAVAILABLE — for weeks, with every check in this file passing.
  //
  // Read from capabilities.md rather than a new HTTP route, deliberately. That
  // file is written by the running server at boot from adapterStatuses(), so it is
  // this install's own answer rather than a fresh in-process guess — the same
  // reason this script attaches instead of booting. It also means no new
  // authenticated surface exists just to be tested.
  //
  // THE CATCH, and the guard for it: capabilities.md is a BOOT SNAPSHOT and
  // survives the process that wrote it. A manifest older than the current server
  // describes a DIFFERENT run, so believing it would be worse than not asking.
  // Anything older than this server's own uptime is reported INDETERMINATE, never
  // as a pass or a fail.
  const manifest = vaultRoot ? readCapabilityManifest(path.join(vaultRoot, 'Identity', 'capabilities.md')) : null;
  const uptimeSec = health.ok && health.body && typeof health.body.uptime === 'number' ? health.body.uptime : null;
  for (const c of adapterChecks(manifest, uptimeSec, Date.now())) checks.push(c);

  // ---- 8. the wizard's components, as the server itself reports them --------------
  // The first-run wizard installs these; a fresh machine that skipped or failed a
  // step looks exactly like a working one until the feature is used.
  const components = await getJson(host, port, '/api/setup/components', token);
  if (!components.ok || !components.body || !Array.isArray(components.body.components)) {
    checks.push(check('components', null, `GET /api/setup/components -> ${components.status} ${components.raw}`));
  } else {
    for (const c of components.body.components) {
      // available:false means this machine cannot install it at all (no key, no
      // network, unsupported platform) and the server says why. Not installed AND
      // not available is a fact about the machine, not a parity failure.
      const ok = c.installed === true ? true : (c.available === false ? null : false);
      checks.push(check(`component:${c.id}`, ok,
        c.installed ? 'installed'
          : c.available === false ? `not installed, and not installable here — ${c.unavailableReason || 'no reason given'}`
            : 'NOT installed — run the wizard\'s Components step'));
    }
  }

  // ---- 8b. the HUD survives a deep link, from wherever this install sits --------
  // BUG-363 (found by a third session, 2026-08-26). res.sendFile() defaults to
  // dotfiles:'ignore', and send applies that to EVERY SEGMENT OF THE ABSOLUTE
  // PATH — not just the part below a root. So an install living under any
  // dot-directory (a worktree in .claude/worktrees/, a user install under
  // ~/.config) gets NotFoundError for a file that is plainly there.
  //
  // WHY NOTHING NOTICED, and why this check is worth its four lines: express.static
  // is NOT affected, because its dotfiles rule runs on the REQUEST path relative to
  // its own root. So `/` keeps serving index.html and ONLY DEEP LINKS 404. The HUD
  // looks perfectly healthy on the screen the operator actually opens. It presented
  // as one test failing in a worktree while passing in the main checkout on the
  // identical commit — one variable, where the tree sits on disk.
  //
  // That is exactly the class this whole script exists for: identical code, two
  // installs, different behaviour. It is asked over HTTP against THIS server rather
  // than reasoned about from the path, because the question is what this install
  // does, not what its directory name looks like.
  const deep = await getJson(host, port, '/parity-check-deep-link-probe/a/b', token);
  // getJson only parses JSON; the HUD is HTML, so a 200 arrives with body:null.
  // Status is the whole assertion — 200 means the SPA fallback answered.
  checks.push(check('spa-deep-link', deep.status === 200,
    deep.status === 200
      ? 'an unknown deep path serves the HUD'
      : `GET /parity-check-deep-link-probe/a/b -> ${deep.status || 'no response'} — the SPA fallback `
        + 'is not answering. If this install sits under a dot-directory, this is BUG-363: '
        + 'res.sendFile dot-checks every segment of an absolute path. Deep links and reloads '
        + 'of any HUD route are 404ing while "/" looks fine.'));

  // ---- 9. adb, specifically, because it is the one that was silently unresolved ---
  // Asked as a FILE question, not a config one. ANDROID_ADB_BIN sitting at its
  // 'adb' default is not a misconfiguration any more — resolution now searches
  // both install locations — so the only meaningful question is whether a binary
  // was actually found.
  try {
    const setupAndroid = require(path.join(__dirname, 'setup-android.js'));
    const found = setupAndroid.findInstalledAdb();
    const searched = setupAndroid.androidSearchDirs();
    checks.push(check('adb-resolved', Boolean(found),
      found ? found : `no adb in any of: ${searched.join(', ')} (nor on PATH) — run node mythos/scripts/setup-android.js --install`));
  } catch (err) {
    checks.push(check('adb-resolved', null, `could not ask setup-android.js: ${err && err.message}`));
  }

  return checks;
}

// Adapters whose OFFLINE state is a real failure rather than an expected
// degraded mode. Deliberately short: browser-agent is OFFLINE until the debug
// browser is launched (by design, see browser_launch_debug), cua-driver and
// android-child are optional binaries, and mcp-client depends on configured
// servers. pc-child is the one that must always be up — it is the desktop
// automation surface every ui_* tool sits on, and nothing else can substitute.
const REQUIRED_ONLINE_ADAPTERS = ['pc-child'];

// adapter -> the tool-name prefix it gates. Used only to catch the
// online-but-no-tools contradiction; an adapter absent from this map is skipped
// rather than assumed to gate nothing.
const ADAPTER_TOOL_PREFIXES = [
  ['android-child', 'phone_'],
];

// Pure so it can be tested without a server, a vault, or a particular machine:
// hand it a parsed manifest, the server's uptime and a clock reading, get the
// checks back. `nowMs` is a parameter for the same reason — a freshness rule
// tested against a frozen clock the test controls proves nothing about the
// branch that fires when time actually passes.
function adapterChecks(manifest, uptimeSec, nowMs) {
  const out = [];
  const fresh = manifest && uptimeSec !== null && uptimeSec !== undefined
    ? (nowMs - manifest.mtimeMs) / 1000 <= uptimeSec + MANIFEST_FRESHNESS_SLACK_SEC
    : null;

  if (!manifest) {
    out.push(check('adapters', null, 'no Identity/capabilities.md in the vault this server reported'));
    return out;
  }
  if (fresh === false) {
    out.push(check('adapters', null,
      `capabilities.md is older than this server's ${Math.round(uptimeSec)}s uptime — it describes a previous boot, `
      + 'so its adapter states are not evidence about this one'));
    return out;
  }
  if (manifest.adapters.length === 0) {
    out.push(check('adapters', false, 'capabilities.md has no "## Adapters" section — the manifest format changed'));
    return out;
  }

  for (const adapter of manifest.adapters) {
    // OFFLINE is not automatically a failure: browser-agent is OFFLINE by design
    // until the debug browser is launched, and cua-driver is an optional binary.
    // Reporting those as failures is how a check gets ignored. What IS asserted
    // for every adapter is that an OFFLINE one carries a REASON — an adapter that
    // is off with no explanation is the exact shape BUG-360 hid in.
    if (REQUIRED_ONLINE_ADAPTERS.includes(adapter.name)) {
      out.push(check(`adapter:${adapter.name}`, adapter.online,
        adapter.online ? 'ONLINE' : `OFFLINE — ${adapter.reason || 'NO REASON GIVEN'}`));
    } else {
      out.push(check(`adapter:${adapter.name}`, adapter.online || Boolean(adapter.reason),
        adapter.online ? 'ONLINE'
          : `OFFLINE (optional) — ${adapter.reason || 'NO REASON GIVEN: an adapter must always say why it is off'}`));
    }
  }

  // The consequence check. An adapter's state only matters through the tools it
  // gates, and buildCapabilitySnapshot withholds a tool whose adapter is offline
  // — so the model is told the tool does not EXIST rather than that it failed.
  // That is why BUG-360 read as a missing feature for weeks instead of as a bug.
  for (const [adapterName, toolPrefix] of ADAPTER_TOOL_PREFIXES) {
    const adapter = manifest.adapters.find((a) => a.name === adapterName);
    if (!adapter) continue;
    const count = manifest.tools.filter((t) => t.startsWith(toolPrefix)).length;
    out.push(check(`adapter-tools:${adapterName}`, adapter.online ? count > 0 : true,
      `${adapterName} is ${adapter.online ? 'ONLINE' : 'OFFLINE'} and the manifest lists ${count} ${toolPrefix}* tool(s)`
      + (adapter.online && count === 0 ? ' — an online adapter whose tools are all withheld is the BUG-360 signature' : '')));
  }
  return out;
}

// A boot snapshot may legitimately be a little older than `uptime` reports
// (the manifest is written during boot, before uptime starts being measured from
// the same instant). Slack rather than an exact comparison, so this cannot fail
// on a rounding difference.
const MANIFEST_FRESHNESS_SLACK_SEC = 120;

// Parse the boot-written capability manifest. Format is fixed by whoever writes
// it in src/main.js: a '## Adapters' section of '- name: STATE (reason)' lines,
// and tool lines of '- tool_name — description'. Returns null if absent, so the
// caller reports INDETERMINATE rather than inventing a failure.
function readCapabilityManifest(file) {
  let raw;
  let mtimeMs;
  try {
    raw = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch { return null; }

  const adapters = [];
  const tools = [];
  let inAdapters = false;
  // Split on \r?\n: this file is written by the app but read on a machine whose
  // other vault files are operator-edited and CRLF, and a literal \n split has
  // silently returned defaults here before.
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inAdapters = /^##\s+Adapters\s*$/i.test(line); continue; }
    // The trailing group is NOT required to close its parenthesis, and that is
    // not defensive padding — a real line in this manifest reads:
    //   - browser-agent: OFFLINE (CDP connect failed: browserType.connectOverCDP:
    // and stops there, because the underlying error string contains a newline and
    // the writer emits it into a line-oriented format unescaped. Demanding a ')'
    // made this parser report "NO REASON GIVEN" for an adapter that gave a
    // perfectly good reason — the guard reproducing the exact defect it was added
    // to catch. The multi-line reason itself is a (small, separate) flaw in the
    // manifest writer in src/main.js; it is left alone here rather than fixed
    // in passing, and this parser tolerates both shapes.
    const entry = /^-\s+([A-Za-z0-9_-]+):\s+(ONLINE|OFFLINE)\b\s*(.*)$/.exec(line);
    if (inAdapters && entry) {
      const reason = String(entry[3] || '').trim().replace(/^\(/, '').replace(/\)$/, '').trim();
      adapters.push({ name: entry[1], online: entry[2] === 'ONLINE', reason });
      continue;
    }
    const tool = /^-\s+([a-z][a-z0-9_]*)\s+—/.exec(line);
    if (tool) tools.push(tool[1]);
  }
  return { adapters, tools, mtimeMs };
}

function resolveVaultRootFromSettings(byName) {
  const row = byName.get('MYTHOS_VAULT_ROOT');
  return row && row.value ? String(row.value) : null;
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
function fileSize(file) {
  try { const st = fs.statSync(file); return st.isFile() ? st.size : 0; } catch { return 0; }
}
function countMarkdown(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
}
// A piper voice is any .onnx in the resolved voices directory; piper-child.js
// applies the same rule.
function piperHasVoice() {
  try {
    const { userDataModelsDir } = require(path.join(__dirname, '..', 'src', 'core', 'setup', 'model-paths.js'));
    const roots = [];
    const user = userDataModelsDir();
    if (user) roots.push(path.join(user, 'piper'));
    roots.push(path.join(__dirname, '..', 'models', 'piper'));
    if (process.env.PIPER_MODEL_DIR) roots.unshift(process.env.PIPER_MODEL_DIR);
    return roots.some((dir) => {
      try { return fs.readdirSync(dir).some((f) => f.endsWith('.onnx')); } catch { return false; }
    });
  } catch { return false; }
}

function report(checks, asJson) {
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);

  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.map((c) => c.name), checks }, null, 2));
  } else {
    console.log('MYTHOS parity check');
    console.log('-------------------');
    for (const c of checks) {
      const mark = c.ok === true ? ' ok ' : c.ok === false ? 'FAIL' : ' ?? ';
      console.log(`[${mark}] ${c.name}${c.detail ? '  —  ' + c.detail : ''}`);
    }
    console.log('');
    if (failed.length) {
      // The NAMED LIST is the deliverable. "Parity check failed" with no names is
      // exactly the kind of report that sends the operator back to testing by hand.
      console.log(`FAILED (${failed.length}): ${failed.map((c) => c.name).join(', ')}`);
    } else {
      console.log('Every check passed.');
    }
    if (unknown.length) {
      console.log(`Indeterminate (${unknown.length}): ${unknown.map((c) => c.name).join(', ')} — `
        + 'could not be asked, so neither passed nor failed.');
    }
  }
  return failed.length === 0 ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const checks = await runChecks(opts);
  process.exitCode = report(checks, opts.json);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('parity-check failed to run:', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runChecks, report, PARITY_KEYS, readCapabilityManifest, adapterChecks, REQUIRED_ONLINE_ADAPTERS, ADAPTER_TOOL_PREFIXES, MANIFEST_FRESHNESS_SLACK_SEC };
