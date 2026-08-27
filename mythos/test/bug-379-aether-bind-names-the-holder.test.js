'use strict';

// test/bug-379-aether-bind-names-the-holder.test.js — BUG-379.
//
// THE DEFECT, MEASURED BEFORE ANY CODE WAS WRITTEN
//
// Between 2026-08-08 and 2026-08-09 the operator's vault recorded 65 separate
// `aether-proxy-bind-failed` anomalies for 127.0.0.1:4480. Every one of them
// said "address already in use" three times over and named the holder zero
// times, so nobody could tell what was squatting the port — and 63 of them
// reached the healer with NO playbook at all (`outcome: no-match`), because
// `aether-proxy-rebind` did not exist until 2026-08-13.
//
// Ran the work order's own oracle first ("boot with an orphaned listener on the
// port, get exactly N attempts and one honest anomaly, not a loop"), through the
// real bus, real diagnostician, real healer and real scanner-proxy:
//
//   health.anomaly emissions        : 1
//   health.diagnosed emissions      : 1
//   healer audit rows for this kind : 1   (aether-proxy-rebind, error,
//                                          reason "bind-failed-again")
//   over 38s, with cooldownMs 15000 — a loop would have fired ~2 more times
//   does the operator learn WHO holds the port? NO
//
// So the retry loop the work order describes DOES NOT EXIST: the anomaly is
// emitted from a promise rejection handler in main.js, which runs once per
// process, and the healer's retry catches its own bind error without re-emitting.
// The 65 events were 65 processes, not one process looping. What IS missing is
// the last line of that oracle output: the diagnostic.
//
// WHAT THIS FILE ASSERTS
//
// 1. A bind failure names what holds the port, or says honestly that it could
//    not find out — never silently omits it.
// 2. The lookup is bounded and degrades honestly (non-Windows, missing netstat,
//    garbage output) rather than guessing a pid.
// 3. The retry is capped, so the loop stays impossible even if some future
//    caller does start re-emitting this anomaly. Today it cannot; the cap is the
//    guard, not a fix for an observed loop, and the disposition test below pins
//    the measured single-attempt behaviour so it cannot regress into a loop.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createHealer } = require('../src/core/immune/healer');
const { createDiagnostician } = require('../src/core/immune/diagnostician');
const { createScannerProxy } = require('../src/core/aether/scanner-proxy');

const {
  findPortHolder, describeHolder, parseNetstatForPort, portFromBindError,
} = require('../src/core/util/port-holder');

// The exact string scanner-proxy.js builds, and therefore the exact string
// main.js has to read the port out of. Copied from the operator's vault record
// aud-4fb4a38232c3 (2026-08-26T21:01:29Z) rather than composed here.
const REAL_BIND_ERROR = 'Aether scanner-proxy could not bind 127.0.0.1:4480 for node '
  + '"phone": listen EADDRINUSE: address already in use 127.0.0.1:4480';

// A netstat -ano -p TCP capture, real shape. Trailing spaces and the header are
// left in on purpose: the parser has to survive the actual bytes, not a tidied
// version of them.
const NETSTAT_SAMPLE = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
  '  TCP    127.0.0.1:4480         0.0.0.0:0              LISTENING       15616',
  '  TCP    127.0.0.1:44801        0.0.0.0:0              LISTENING       9999',
  '  TCP    127.0.0.1:4478         127.0.0.1:51000        ESTABLISHED     4296',
  '  TCP    [::]:445               [::]:0                 LISTENING       4',
  '',
].join('\r\n');

describe('BUG-379 — parsing who holds a port', () => {
  it('finds the LISTENING pid for an exact port', () => {
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 4480), 15616);
  });

  it('does not match a port that merely CONTAINS the digits', () => {
    // 44801 contains "4480". A substring match would return 9999 here, which is
    // worse than returning nothing: it names an innocent process as the culprit
    // and sends the reader after the wrong pid.
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 4480), 15616);
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 44801), 9999);
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 448), null);
  });

  it('ignores non-LISTENING rows', () => {
    // 4478 appears only as ESTABLISHED. Reporting 4296 as "holding" it would be
    // wrong — an established connection is not what refuses a bind.
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 4478), null);
  });

  it('handles IPv6 bracket notation without mistaking the address for the port', () => {
    assert.equal(parseNetstatForPort(NETSTAT_SAMPLE, 445), 4);
  });

  it('returns null for garbage rather than a wrong pid', () => {
    for (const junk of ['', '   ', 'not netstat output at all', 'TCP\tbroken']) {
      assert.equal(parseNetstatForPort(junk, 4480), null, JSON.stringify(junk));
    }
  });
});

describe('BUG-379 — finding which port failed, from the only place it survives', () => {
  it('reads the port out of the real bind-error string', () => {
    assert.equal(portFromBindError(REAL_BIND_ERROR), 4480);
  });

  it('returns null for text with no port, rather than a guess', () => {
    for (const junk of ['', null, undefined, 'listen EADDRINUSE', 'no numbers here']) {
      assert.equal(portFromBindError(junk), null, JSON.stringify(junk));
    }
  });

  it('does not mistake an IP octet or a timestamp for a port', () => {
    // '127.0.0.1' has no colon before its octets, so the first colon-number in
    // the real message is the port. A looser \d+ scan would return 127.
    assert.equal(portFromBindError('bind 127.0.0.1:4480 failed'), 4480);
    // Out-of-range must be refused, not clamped into something plausible.
    assert.equal(portFromBindError('at 12:99999 something'), null);
  });
});

describe('BUG-379 — the lookup degrades honestly instead of guessing', () => {
  it('reports the platform honestly instead of shelling out on non-Windows', async () => {
    // A MUTATION SURVIVED THIS ASSERTION'S FIRST DRAFT. Deleting the platform
    // guard entirely left it green, because the injected error text itself
    // contained the word "platform" — so the regex matched the fixture's own
    // words rather than the code's behaviour. The real contract is that no child
    // process is STARTED on a platform whose output we cannot parse, so that is
    // what this now asserts, and the fixture no longer feeds the assertion its
    // answer.
    let execCalls = 0;
    const holder = await findPortHolder(4480, {
      platform: 'linux',
      execFile: () => { execCalls += 1; throw new Error('should not be reached'); },
    });
    assert.equal(execCalls, 0, 'no child process may be spawned on an unparsed platform');
    assert.equal(holder.pid, null);
    assert.match(holder.reason, /linux/,
      'the reason should name the actual platform it declined to parse');
  });

  it('a tasklist INFO line is not mistaken for a process name', async () => {
    // Added because a mutation survived: tasklist prints an INFO line, not an
    // error, when its filter matches nothing, so accepting the first quoted
    // field blindly puts "INFO: No tasks are running..." into a spoken sentence.
    const holder = await findPortHolder(4480, {
      platform: 'win32',
      execFile: async (cmd) => {
        if (cmd === 'netstat') return { stdout: NETSTAT_SAMPLE };
        return { stdout: 'INFO: No tasks are running which match the specified criteria.' };
      },
    });
    assert.equal(holder.pid, 15616, 'the pid still stands');
    assert.equal(holder.name, null, 'but an INFO line is not a name');
    assert.doesNotMatch(describeHolder(holder), /INFO/,
      'and it must never reach the operator-facing sentence');
  });

  it('a missing netstat is reported, not swallowed into silence', async () => {
    const holder = await findPortHolder(4480, {
      platform: 'win32',
      execFile: async () => { const e = new Error('spawn netstat ENOENT'); e.code = 'ENOENT'; throw e; },
    });
    assert.equal(holder.pid, null);
    assert.ok(holder.reason && holder.reason.trim(), 'a failed lookup still explains itself');
    assert.match(holder.reason, /netstat/i);
  });

  it('nothing listening on the port is different from a failed lookup', async () => {
    const holder = await findPortHolder(4480, {
      platform: 'win32',
      execFile: async () => ({ stdout: '  TCP    127.0.0.1:9999   0.0.0.0:0   LISTENING   7' }),
    });
    assert.equal(holder.pid, null);
    // "I looked and found nothing" must not read like "I could not look" — for a
    // bind failure the first is genuinely strange and worth saying so.
    assert.match(holder.reason, /nothing|no process|not found/i);
  });

  it('resolves the process NAME when it can, and survives when it cannot', async () => {
    const withName = await findPortHolder(4480, {
      platform: 'win32',
      execFile: async (cmd) => {
        if (cmd === 'netstat') return { stdout: NETSTAT_SAMPLE };
        return { stdout: '"node.exe","15616","Console","1","120,000 K"' };
      },
    });
    assert.equal(withName.pid, 15616);
    assert.equal(withName.name, 'node.exe');

    const nameLookupBroken = await findPortHolder(4480, {
      platform: 'win32',
      execFile: async (cmd) => {
        if (cmd === 'netstat') return { stdout: NETSTAT_SAMPLE };
        throw new Error('tasklist exploded');
      },
    });
    // The pid is the load-bearing half. Losing the name must not lose the pid.
    assert.equal(nameLookupBroken.pid, 15616);
    assert.equal(nameLookupBroken.name, null);
  });

  it('passes a bounded timeout to every child process it starts', async () => {
    const timeouts = [];
    await findPortHolder(4480, {
      platform: 'win32',
      execFile: async (cmd, args, opts) => {
        timeouts.push(opts && opts.timeout);
        return { stdout: cmd === 'netstat' ? NETSTAT_SAMPLE : '"node.exe","15616"' };
      },
    });
    assert.ok(timeouts.length >= 1, 'expected at least the netstat call');
    for (const t of timeouts) {
      assert.equal(typeof t, 'number', 'every child gets an explicit timeout');
      assert.ok(t > 0 && t <= 3000, 'a boot-path diagnostic must not hang: got ' + t);
    }
  });
});

describe('BUG-379 — the sentence the operator actually hears', () => {
  it('names the pid and the process when both are known', () => {
    const text = describeHolder({ pid: 15616, name: 'node.exe' });
    assert.match(text, /15616/);
    assert.match(text, /node\.exe/);
  });

  it('names the pid alone when the name could not be resolved', () => {
    const text = describeHolder({ pid: 15616, name: null });
    assert.match(text, /15616/);
    assert.doesNotMatch(text, /null|undefined/);
  });

  it('says it could not tell, rather than going quiet', () => {
    const text = describeHolder({ pid: null, reason: 'netstat is unavailable' });
    assert.ok(text.trim(), 'an unknown holder still produces a sentence');
    assert.match(text, /netstat is unavailable/);
    assert.doesNotMatch(text, /null|undefined/);
  });

  it('never returns the literal strings that mean nothing', () => {
    for (const holder of [null, undefined, {}, { pid: undefined }]) {
      const text = describeHolder(holder);
      assert.equal(typeof text, 'string');
      assert.doesNotMatch(text, /\[object Object\]|undefined|null/,
        'holder ' + JSON.stringify(holder));
    }
  });
});

// ---------------------------------------------------------------------------
// THE LIVE ORACLE. This is the work order's own acceptance check, automated, and
// it is the strongest one available here: the squatter is THIS process, so the
// correct answer is known exactly — process.pid — rather than merely plausible.
describe('BUG-379 — live: a real orphaned listener is named by its real pid', () => {
  it('identifies this very process as the holder of a port it is squatting', async () => {
    const squatter = net.createServer(() => {});
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(0, '127.0.0.1', resolve);
    });
    const port = squatter.address().port;
    try {
      const holder = await findPortHolder(port);
      if (process.platform !== 'win32') {
        // Honest skip-equivalent: the assertion is that it does not LIE, since
        // the parser is Windows-shaped. It must report that, not invent a pid.
        assert.equal(holder.pid, null);
        assert.match(holder.reason, /platform/i);
        return;
      }
      assert.equal(holder.pid, process.pid,
        'the diagnostic must name the real holder; this test IS the holder, so '
        + 'the expected pid is not a guess');
      const text = describeHolder(holder);
      assert.match(text, new RegExp(String(process.pid)));
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// THE TERMINAL CONDITION, and the disposition that says why it is a guard.
//
// The work order asked for "N attempts -> OFFLINE with a spoken reason". The
// oracle above shows the anomaly fires once per process today, so N is already 1
// in practice. The cap still matters because this playbook declares no verifyMs
// and therefore can never emit heal-failed — if any future source repeats this
// anomaly kind, the 15s cooldown is the only thing between it and an unbounded
// retry. These assert the cap, and the last one PINS the measured single-attempt
// behaviour so a future change cannot quietly turn it into a loop.
function healerRig({ startImpl }) {
  const bus = createBus({ historySize: 200 });
  const audits = [];
  const proxy = {
    start: startImpl,
    whenReady: () => proxy._ready,
    ports: () => ({ phone: 4480 }),
    stop() {},
    isRunning: () => false,
    _ready: Promise.resolve(),
  };
  const memory = { audit: { write: (e) => audits.push(e) }, episodic: { write: async () => ({}) } };
  const healer = createHealer({
    bus, config: {}, memory,
    getCortex: () => null, getGoals: () => null, getEffectors: () => null,
    getScannerProxy: () => proxy,
  });
  return { bus, healer, audits, proxy };
}

// NO ESCAPE HATCH, deliberately. The first draft of this read
// `_internal.actions` while the real key is `ACTIONS`, and then did
// `if (!action) return;` — so both tests below passed while asserting NOTHING.
// That is the "a guard that passes vacuously" class, authored straight into a
// test written to close a different instance of it, and it was caught by
// checking the accessor against the real export rather than by trusting green.
// A missing or renamed action is now a failure, never a silent skip.
function actionUnderTest(rig) {
  const internal = rig.healer._internal;
  assert.ok(internal, 'healer must expose _internal for this test');
  assert.ok(internal.ACTIONS, 'healer._internal.ACTIONS must exist');
  const action = internal.ACTIONS['retry-aether-proxy'];
  assert.equal(typeof action, 'function',
    'retry-aether-proxy must be reachable; if it was renamed, fix this test '
    + 'rather than letting it skip');
  return action;
}
describe('BUG-379 — the rebind gives up instead of retrying forever', () => {
  it('stops after MAX attempts and says the proxy is OFFLINE, naming why', async () => {
    const rig = healerRig({
      startImpl() {
        rig.proxy._ready = Promise.reject(new Error(
          'Aether scanner-proxy could not bind 127.0.0.1:4480 for node "phone": '
          + 'listen EADDRINUSE: address already in use 127.0.0.1:4480'));
      },
    });
    const action = actionUnderTest(rig);

    // No holder on the evidence here on purpose: the cap must work even when
    // detection could not name the squatter.
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await action({ kind: 'aether-proxy-bind-failed', evidence: {} }));
    const terminal = outcomes.filter((o) => o && o.terminal === true);
    assert.ok(terminal.length > 0, 'expected the action to become terminal, got '
      + JSON.stringify(outcomes.map((o) => o && o.reason)));
    assert.match(terminal[0].reason, /offline|retries/i);
    assert.match(String(terminal[0].detail), /OFFLINE/);
    assert.ok(outcomes.filter((o) => o && o.reason === 'bind-failed-again').length <= 3,
      'no more than MAX real bind attempts should be made');
  });

  it('a recovery clears the retry budget rather than leaving it spent', async () => {
    let fail = true;
    const rig = healerRig({
      startImpl() {
        rig.proxy._ready = fail
          ? Promise.reject(new Error('could not bind 127.0.0.1:4480: listen EADDRINUSE'))
          : Promise.resolve();
      },
    });
    const action = actionUnderTest(rig);
    await action();
    await action();
    fail = false;
    const good = await action();
    assert.equal(good.ok, true, 'a successful rebind must report ok');
    fail = true;
    // Budget reset: three more real attempts are available, so the 4th is the
    // first terminal one. If the budget had stayed spent, this would be terminal
    // immediately and a transient collision would permanently disable the proxy.
    const after = [await action(), await action(), await action()];
    assert.ok(after.every((o) => o && o.terminal !== true),
      'a recovery must restore the full retry budget');
  });
});

describe('BUG-379 — DISPOSITION: one anomaly per process, measured, not assumed', () => {
  // RETARGETED after the file-size ratchet forced the payload out of main.js and
  // into aether/bind-failure.js. The first version read main.js for the payload
  // literal and went red the moment the literal moved — the guard catching its
  // own author moving the thing it watches. Each assertion now reads the file
  // that actually owns the property it is pinning.
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  it('main.js emits this anomaly from a once-per-process rejection handler', () => {
    // ORDER-BASED, NOT DISTANCE-BASED: an earlier draft used a fixed
    // character window and broke on this commit's own comments.
    const src = read('src/main.js');
    const emit = src.indexOf('buildBindFailureAnomaly({');
    assert.ok(emit > 0, 'main.js must still build the bind-failure anomaly');
    const then = src.lastIndexOf('whenReady()', emit);
    assert.ok(then > 0 && then < emit,
      'the emit must sit inside a whenReady() continuation — a promise rejection '
      + 'arm runs at most once per process, which is what makes a loop impossible');
    const between = src.slice(then, emit);
    assert.doesNotMatch(between, /setInterval|setImmediate|while\s*\(|for\s*\(;;/,
      'no timer or loop may sit between whenReady() and the bind-failure emit — '
      + 'that is what would turn one honest anomaly back into the 65-record storm');
  });

  it('the SPOKEN field carries the holder, and the raw error survives beside it', () => {
    const src = read('src/core/aether/bind-failure.js');
    // `reason` is what immune/explainer.js speaks (AD-5). Assert against that
    // line specifically: an earlier draft matched /holder/ anywhere in the block
    // and stayed green when `reason` stopped carrying it, because the payload's
    // own `holder:` field satisfied the regex. A mutation caught that.
    const reasonLine = /reason:\s*message\s*\+([^\n]*)/.exec(src);
    assert.ok(reasonLine, 'reason must still be built from the raw message');
    assert.match(reasonLine[1], /holder/,
      'the spoken field must carry the holder, not just a structured sibling');
    assert.match(src, /error:\s*message,/,
      'and the raw error text must survive untouched (a path that '
      + 'improves a message must not overwrite the evidence)');
    assert.match(src, /holder:\s*holder,/,
      'the structured field is kept too, because the healer reads it instead of '
      + 'running its own lookup');
  });

  it('the healer reads the holder rather than looking it up again', () => {
    // The regression this pins: the first draft called findPortHolder() inside
    // the heal action, which spawned netstat per retry and raced an existing
    // test's 10ms window. One lookup per bind failure, at detection.
    // COMMENTS STRIPPED FIRST. The first draft scanned the raw source and fired
    // on the module's own comment explaining why the call was removed — a guard
    // that goes red on an honest historical note is a guard someone switches
    // off, which is the same reasoning build-capability-map.js's header records
    // for not banning the string "Hermes".
    const code = read('src/core/immune/aether-rebind.js').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /findPortHolder|require\([^)]*port-holder/,
      'the heal path must not spawn a lookup; it reads evidence.holder');
    assert.match(code, /evidence\.holder/,
      'and it must actually read the holder the anomaly carried');
  });
});


// ---------------------------------------------------------------------------
// LIVE END-TO-END. A real orphaned listener, the real scanner-proxy, the real
// diagnostician and the real healer — the work order's oracle, automated, with
// the squatter being this process so the expected pid is known exactly.
describe('BUG-379 — live: the heal path names the squatter and then gives up', () => {
  it('a real bind collision is diagnosed, named, and capped', async () => {
    const squatter = net.createServer(() => {});
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(0, '127.0.0.1', resolve);
    });
    const port = squatter.address().port;
    const logger = { info() {}, error() {}, warn() {}, debug() {} };
    const bus = createBus({ historySize: 200 });
    const audits = [];
    const proxy = createScannerProxy({
      config: { AETHER_PROXY_PORT_BASE: port, AETHER_NODE_IDS: 'phone' },
      logger,
    });
    const healer = createHealer({
      bus,
      config: {},
      memory: { audit: { write: (e) => audits.push(e) }, episodic: { write: async () => ({}) } },
      getCortex: () => null, getGoals: () => null, getEffectors: () => null,
      getScannerProxy: () => proxy,
    });
    const action = healer._internal.ACTIONS['retry-aether-proxy'];
    // Exactly what main.js's bind-failure handler does: resolve the holder ONCE
    // at detection and put it on the anomaly. The squatter is this process, so
    // the expected pid is known rather than plausible.
    const holderText = describeHolder(await findPortHolder(port));

    try {
      // Attempt 1: a real bind against a really-held port.
      const diagnosis = { kind: 'aether-proxy-bind-failed', evidence: { holder: holderText } };
      const first = await action(diagnosis);
      assert.equal(first.ok, false, 'the bind must genuinely fail — the port IS held');
      assert.equal(first.reason, 'bind-failed-again');
      if (process.platform === 'win32') {
        assert.match(String(first.detail), new RegExp('held by pid ' + process.pid),
          'the heal detail must name the real holder, which for this test is this '
          + 'very process — an exactly-known answer, not a plausible one');
      } else {
        assert.match(String(first.detail), /EADDRINUSE/,
          'the raw bind error survives on platforms whose netstat we do not parse');
      }
      assert.equal(first.attemptsRemaining, 2, 'the budget must be reported honestly');

      // Attempts 2 and 3 still try; the 4th must refuse.
      await action(diagnosis);
      await action(diagnosis);
      const gaveUp = await action(diagnosis);
      assert.equal(gaveUp.terminal, true,
        'after MAX attempts the action must be terminal, not merely failed');
      assert.match(gaveUp.reason, /offline-after-retries/);
      assert.match(String(gaveUp.detail), /OFFLINE/);
      if (process.platform === 'win32') {
        assert.match(String(gaveUp.detail), new RegExp(String(process.pid)),
          'the give-up sentence must still say who is holding the port');
      }

      // And it stays terminal — this is the "not a loop" half.
      const again = await action(diagnosis);
      assert.equal(again.terminal, true, 'a terminal give-up does not un-give-up');
    } finally {
      try { proxy.stop(); } catch (_) { /* already torn down by the failed bind */ }
      if (typeof healer.stop === 'function') healer.stop();
      await new Promise((r) => squatter.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// buildBindFailureAnomaly — the payload itself. These two cases were added
// because mutations survived without them: `target` reverting to the vague
// phrase, and the holder lookup's own failure becoming an exception. Both are
// the whole reason the builder was extracted from main.js — it is now callable
// without booting an application.
const { buildBindFailureAnomaly } = require('../src/core/aether/bind-failure');

describe('BUG-379 — the anomaly payload names the port, and cannot throw', () => {
  it('target names the actual port, not "the port range"', async () => {
    // THE SECOND DEFECT THIS COMMIT FIXES. ports() returns an OBJECT, so
    // main.js's old `failedPorts.length` test was undefined-and-falsy on every
    // run: the branch meant to name the port was unreachable, and its .join()
    // would have thrown inside an error handler if it ever had run. Every record
    // in the operator's vault, including aud-4fb4a38232c3, therefore reads "the
    // Aether proxy port range" while the code's own comment promises the
    // operator hears which port.
    const payload = await buildBindFailureAnomaly({
      err: new Error(REAL_BIND_ERROR),
      ports: [4480],
      portBase: 4480,
      findPortHolder: async () => ({ pid: 15616, name: 'node.exe' }),
    });
    assert.equal(payload.target, 'port 4480');
    assert.notEqual(payload.target, 'the Aether proxy port range');
    assert.match(payload.reason, /15616/, 'and the spoken reason names the holder');
    assert.match(payload.reason, /node\.exe/);
    assert.equal(payload.error, REAL_BIND_ERROR, 'the raw error survives byte-for-byte');
  });

  it('falls back to the port range ONLY when no port can be determined', async () => {
    const payload = await buildBindFailureAnomaly({
      err: new Error('listen EADDRINUSE with no port in the text'),
      ports: [],
      portBase: null,
      findPortHolder: async () => { throw new Error('must not be called without a port'); },
    });
    assert.equal(payload.target, 'the Aether proxy port range');
    assert.match(payload.reason, /could not determine what holds it/);
  });

  it('a holder lookup that THROWS still produces a payload, never an exception', async () => {
    // This runs inside a promise rejection handler during boot. An exception
    // here replaces a diagnosable bind failure with an unhandled rejection —
    // strictly worse than the failure being diagnosed. A mutation removing the
    // try/catch survived until this existed.
    const payload = await buildBindFailureAnomaly({
      err: new Error(REAL_BIND_ERROR),
      ports: [4480],
      findPortHolder: async () => { throw new Error('netstat blew up'); },
    });
    assert.equal(payload.kind, 'aether-proxy-bind-failed');
    assert.equal(payload.error, REAL_BIND_ERROR, 'the bind error is never lost to a lookup failure');
    assert.match(payload.holder, /the lookup itself failed/);
    assert.match(payload.holder, /netstat blew up/, 'and it says what went wrong');
    assert.match(payload.reason, /netstat blew up/);
  });

  it('a lookup that returns an unknown holder still yields a spoken sentence', async () => {
    const payload = await buildBindFailureAnomaly({
      err: new Error(REAL_BIND_ERROR),
      ports: [4480],
      findPortHolder: async () => ({ pid: null, reason: 'netstat is unavailable' }),
    });
    assert.match(payload.reason, /netstat is unavailable/);
    assert.doesNotMatch(payload.reason, /undefined|null|\[object Object\]/);
  });
});
