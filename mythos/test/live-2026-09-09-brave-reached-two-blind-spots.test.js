'use strict';
// Two defects found by LIVE-VERIFYING BUG-414..BUG-419 on 2026-09-09. Neither
// was reachable before that day, and no unit test could see either, because
// both live in code the unit tests inject around.
//
// (a) adapters/browser-agent's pidfile lookup ran its own PowerShell query
//     filtered on 'chrome.exe' or 'msedge.exe'. BUG-415 taught the launcher to
//     start BRAVE and made it the first attempt on a Brave machine. Measured:
//     launchLocal returned true, seven brave.exe processes appeared under
//     %LOCALAPPDATA%/MYTHOS/brave-debug-profile, the log said "browserPid":null,
//     and .browser-agent.pid was never written. That file's only consumer is
//     `Start Agent OS.bat`'s orphan reap, so a Brave surviving a dirty shutdown
//     would have gone on playing audio invisibly — BUG-029's exact symptom,
//     reintroduced for the default browser.
//
//     The fix is a deletion: browser-process.js's processesForProfile already
//     ran that query, never filtered on name, and guards harder. So these tests
//     ask the BEHAVIOURAL question — "does a Brave profile yield Brave's pid" —
//     against an injected PowerShell runner. An earlier draft asserted on the
//     command string and on a list of names; both would have passed a rewrite
//     that produced the right list and then ignored it.
//
// (b) adapters/browser-extension wrote `protocol: 1` into
//     browser-extension-host.json after BUG-416 bumped the handshake to 2.
//     Nothing reads it today, which is exactly why it would have survived: the
//     C# host takes only pipeName and allowedExtensionIds.
//
// MUTATION PROBES — run 2026-09-09, each verified to have landed on disk before
// its red was believed, each green before this change and each KILLED after:
//   m1  findChromePidByUserDataDir filters rows to chrome/msedge only   fails (a1)(a2)(a3)
//   m2  the row scan drops the known-browser check and takes rows[0]    fails (a3)
//   m3  processesForProfile swapped back for a hand-rolled query with
//       a hardcoded chrome/msedge name clause                           fails (a4)(a5)
//   m4  browser-extension-host.json writes `protocol: 1` again          fails (b1)
//
// m3 is worth reading twice. It was PREDICTED to fail (a1) and (a2) and did
// not: the injected PowerShell stand-in answers with Brave rows whatever script
// it is handed, so a behavioural test cannot see a change to the script itself.
// (a4) and (a5) caught it instead — (a4) because the name clause came back, and
// (a5) because the hand-rolled query skipped isMythosDebugProfile and would have
// run against the operator's real browser profile. Two lessons: a behavioural
// test built on a fake runner is blind to the query, and the guard that caught
// the regression was the SAFETY one, not the correctness one.
//
// (a5) is also the false-positive twin: a profile that is NOT a MYTHOS debug
// profile must still be refused, or this fix would have widened a query that
// can name the operator's own browser.
//
// One more thing, recorded because it nearly cost the work: the first driver run
// died with UNKNOWN (errno -4094, a transient Windows file lock) DURING m4's
// restore and left the mutant on disk, where it read as an ordinary modified
// file. Restores must retry and then verify the bytes; a driver that reports a
// probe killed has not thereby reported the file restored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const browserAgent = require('../adapters/browser-agent');
const browserTarget = require('../src/core/effectors/browser-target');
const { createBrowserExtensionBridge } = require('../adapters/browser-extension');

const BRAVE_PROFILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'MYTHOS', 'brave-debug-profile');

// A PowerShell stand-in that answers with the process rows a real Brave launch
// produces. The crashpad row is not decoration: it carries --user-data-dir and
// no --type=, so it survives the real query's filter and is the thing a naive
// "take the first row" would return.
function fakePowerShell(rows) {
  const calls = [];
  return {
    calls,
    execFileSync(exe, args) {
      calls.push({ exe, script: args[args.length - 1] });
      return Buffer.from(rows.map((r) => r.pid + '=' + r.name).join('\r\n'), 'utf8');
    },
  };
}

test('(a1) a Brave profile yields Brave\'s pid', () => {
  const ps = fakePowerShell([
    { pid: 4242, name: 'brave.exe' },
    { pid: 4243, name: 'brave.exe' },
  ]);
  const pid = browserAgent.findChromePidByUserDataDir(BRAVE_PROFILE, ps);
  assert.strictEqual(pid, 4242,
    'measured live 2026-09-09: launchLocal started brave.exe and this returned null, '
    + 'so .browser-agent.pid was never written and the orphan reap was disarmed');
});

test('(a2) every browser the launcher can start is one this can find', () => {
  // Derived from the launcher's own table, so a fourth browser added there
  // fails this test until the lookup is told about it.
  for (const name of browserTarget.BROWSER_SEARCH_ORDER) {
    const sub = browserTarget.BROWSER_SUBPATHS[name];
    const leaf = String(sub[sub.length - 1]);
    const ps = fakePowerShell([{ pid: 777, name: leaf }]);
    assert.strictEqual(browserAgent.findChromePidByUserDataDir(BRAVE_PROFILE, ps), 777,
      'the launcher can start ' + leaf + ' but the pid lookup would never recognise it');
  }
});

test('(a3) the crashpad handler is NOT mistaken for the browser', () => {
  // It carries --user-data-dir and no --type=, so it passes the query's filter
  // and arrives first. Returning it would be worse than returning nothing: the
  // .bat's provenance check passes, it tree-kills crashpad, and the orphaned
  // browser survives a reap that reported success.
  const ps = fakePowerShell([
    { pid: 9001, name: 'brave_crash_handler.exe' },
    { pid: 9002, name: 'brave.exe' },
  ]);
  assert.strictEqual(browserAgent.findChromePidByUserDataDir(BRAVE_PROFILE, ps), 9002);

  const onlyCrashpad = fakePowerShell([{ pid: 9001, name: 'brave_crash_handler.exe' }]);
  assert.strictEqual(browserAgent.findChromePidByUserDataDir(BRAVE_PROFILE, onlyCrashpad), null,
    'with no browser row the honest answer is null, never a plausible wrong pid');
});

test('(a4) the query itself does not filter on process name', () => {
  const ps = fakePowerShell([{ pid: 1, name: 'brave.exe' }]);
  browserAgent.findChromePidByUserDataDir(BRAVE_PROFILE, ps);
  assert.strictEqual(ps.calls.length, 1, 'expected exactly one PowerShell call');
  const script = ps.calls[0].script;
  assert.ok(!/\$_\.Name\s*-eq/.test(script),
    'the name filter is back in the query, which is how it went blind to Brave:\n' + script);
  assert.ok(script.includes("-notlike '*--type=*'"), 'child processes are no longer excluded:\n' + script);
  assert.ok(script.includes('brave-debug-profile'), 'the profile dir is not in the filter:\n' + script);
});

test('(a5) the adjacent case: a directory that is not a MYTHOS debug profile is refused', () => {
  const ps = fakePowerShell([{ pid: 5, name: 'brave.exe' }]);
  const real = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'BraveSoftware', 'Brave-Browser', 'User Data');
  assert.strictEqual(browserAgent.findChromePidByUserDataDir(real, ps), null,
    'the operator\'s real browser profile must never be queried');
  assert.strictEqual(ps.calls.length, 0, 'it should not even reach PowerShell');
});

test('(b1) the host config records the protocol the handshake actually demands', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-host-protocol-'));
  const extensionId = 'ghmloaaihjkidkjadffmgogindoegdfb';
  // A transport that starts and stops and does nothing else: this test is about
  // the file start() writes, not about the pipe.
  const transportFactory = () => ({
    on() {}, send() {}, close() {},
    start: async () => ({ sid: 'S-1-5-test', sddl: 'D:test' }),
    stop: async () => {},
  });
  const bridge = createBrowserExtensionBridge({ runtimeDir, allowedExtensionIds: [extensionId], transportFactory });
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  await bridge.start();
  const written = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'browser-extension-host.json'), 'utf8'));

  // Derived from the wire, not restated: the number in the file must be the
  // number a hello has to carry, whatever that number becomes next.
  const source = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'browser-extension', 'index.js'), 'utf8');
  const declared = Number((source.match(/^const PROTOCOL = (\d+);/m) || [])[1]);
  assert.ok(Number.isInteger(declared) && declared >= 1, 'could not read PROTOCOL from the bridge source');
  assert.strictEqual(written.protocol, declared,
    'browser-extension-host.json advertises protocol ' + written.protocol
    + ' while a hello must carry ' + declared);
});
