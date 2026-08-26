'use strict';

// test/parity-check-adapters.test.js — BUG-360 (2026-08-26), the parity half.
//
// parity-check.js exists because a packaged MYTHOS.exe can be byte-identical to
// the dev tree and still misbehave — it asks the RUNNING install what it resolved
// at boot. It asked about config keys, the autonomy ceiling, models, the TTS
// chain and vault state. It did not ask about ADAPTERS, which are the largest
// such surface: each one resolves an external binary at boot and gates a whole
// family of tools behind the result.
//
// The cost of that blind spot was BUG-360. android-child sat OFFLINE because
// nothing resolved the adb setup-android.js had already installed;
// buildCapabilitySnapshot then withheld all 14 phone_* tools from the model as
// UNAVAILABLE rather than as failing; and every existing check in parity-check.js
// passed the whole time. These tests cover the checks added to close that.
//
// Everything here is pure: a manifest object, an uptime number, a clock reading.
// No server, no vault, no adb, no dependence on what this machine has installed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parity = require('../scripts/parity-check.js');

function writeManifest(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-manifest-'));
  const file = path.join(dir, 'capabilities.md');
  fs.writeFileSync(file, body);
  return file;
}

function manifest(adapters, tools, ageSec) {
  return {
    adapters,
    tools: tools || [],
    mtimeMs: Date.now() - (ageSec || 0) * 1000,
  };
}

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

describe('readCapabilityManifest', () => {
  it('parses adapter states and their reasons out of the "## Adapters" section', () => {
    const file = writeManifest([
      '# Capabilities',
      '',
      '## Adapters',
      '- pc-child: ONLINE',
      '- cua-driver: ONLINE',
      '- android-child: OFFLINE (adb not found at "C:\\nope\\adb.exe")',
      '',
      '## Tools',
      '- phone_list_devices — List paired devices.',
      '- ui_click — Click something.',
    ].join('\n'));

    const parsed = parity.readCapabilityManifest(file);
    assert.equal(parsed.adapters.length, 3);
    assert.deepEqual(parsed.adapters[0], { name: 'pc-child', online: true, reason: '' });
    assert.equal(parsed.adapters[2].name, 'android-child');
    assert.equal(parsed.adapters[2].online, false);
    assert.equal(parsed.adapters[2].reason, 'adb not found at "C:\\nope\\adb.exe"');
    assert.deepEqual(parsed.tools, ['phone_list_devices', 'ui_click']);
  });

  it('reads a reason whose closing parenthesis is missing — a real line in this file', () => {
    // NOT a hypothetical. src/main.js writes the adapter reason into a
    // line-oriented format without escaping it, and Playwright's CDP error
    // contains a newline, so the real manifest on this machine ends a line at:
    //   - browser-agent: OFFLINE (CDP connect failed: browserType.connectOverCDP:
    // The first version of this parser required a ')' and therefore reported
    // "NO REASON GIVEN" for an adapter that had given a perfectly good one —
    // the guard reproducing the very defect it was written to catch.
    const file = writeManifest([
      '## Adapters',
      '- browser-agent: OFFLINE (CDP connect failed: browserType.connectOverCDP:',
      '    connect ECONNREFUSED 127.0.0.1:9222',
    ].join('\n'));

    const parsed = parity.readCapabilityManifest(file);
    assert.equal(parsed.adapters.length, 1);
    assert.equal(parsed.adapters[0].reason, 'CDP connect failed: browserType.connectOverCDP:');
    assert.notEqual(parsed.adapters[0].reason, '',
      'an unterminated parenthesis must not erase the reason — that is what made a good adapter look silent');
  });

  it('reads a CRLF manifest', () => {
    // Operator-edited vault files on this machine are CRLF and a literal \n split
    // has silently returned defaults here before, so the vault parsers are held
    // to \r?\n. This file is app-written today, but it lives in the same folder.
    const file = writeManifest('## Adapters\r\n- pc-child: ONLINE\r\n- dsh-agent: OFFLINE (not installed)\r\n');
    const parsed = parity.readCapabilityManifest(file);
    assert.equal(parsed.adapters.length, 2);
    assert.equal(parsed.adapters[1].reason, 'not installed');
  });

  it('does not mistake adapter lines in other sections for adapter entries', () => {
    const file = writeManifest([
      '## Notes',
      '- pc-child: ONLINE',   // prose that happens to look like an entry
      '',
      '## Adapters',
      '- dsh-agent: ONLINE',
    ].join('\n'));
    const parsed = parity.readCapabilityManifest(file);
    assert.deepEqual(parsed.adapters.map((a) => a.name), ['dsh-agent']);
  });

  it('returns null for an absent file rather than an empty manifest', () => {
    // The distinction matters: null becomes INDETERMINATE, while an empty
    // manifest becomes a FAILURE saying the format changed. Collapsing them
    // would report a missing vault as a broken build.
    assert.equal(parity.readCapabilityManifest(path.join(os.tmpdir(), 'no-such-capabilities.md')), null);
  });
});

describe('adapterChecks', () => {
  it('is INDETERMINATE, never a failure, when there is no manifest', () => {
    const checks = parity.adapterChecks(null, 100, Date.now());
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, null, 'a vault that could not be read is not evidence of a misconfiguration');
  });

  it('refuses to believe a manifest older than the server it is describing', () => {
    // The trap this closes: capabilities.md is a BOOT SNAPSHOT and outlives the
    // process that wrote it. A manifest from yesterday's boot describes a
    // different run entirely, and reporting its adapters as this run's state
    // would be a confident lie — the worst outcome for a parity tool.
    const stale = manifest([{ name: 'pc-child', online: true, reason: '' }], [], 3600);
    const checks = parity.adapterChecks(stale, 30, Date.now());
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'adapters');
    assert.equal(checks[0].ok, null);
    assert.match(checks[0].detail, /previous boot/);
  });

  it('accepts a manifest written during this server\'s own boot', () => {
    const fresh = manifest([{ name: 'pc-child', online: true, reason: '' }], []);
    const checks = parity.adapterChecks(fresh, 30, Date.now());
    assert.equal(byName(checks, 'adapter:pc-child').ok, true);
  });

  it('tolerates a manifest slightly older than uptime without calling it stale', () => {
    // The manifest is written DURING boot, so it can predate the instant uptime
    // is measured from. An exact comparison would fail on that rounding and the
    // check would be muted within a week.
    const slightlyOld = manifest([{ name: 'pc-child', online: true, reason: '' }], [], 40);
    const checks = parity.adapterChecks(slightlyOld, 5, Date.now());
    assert.equal(byName(checks, 'adapter:pc-child').ok, true, 'a few seconds of skew is not a stale manifest');
  });

  it('cannot judge freshness with no uptime, and still reports the adapters', () => {
    // /health not answering is not evidence either way. Report what the manifest
    // says rather than dropping the whole section.
    const checks = parity.adapterChecks(manifest([{ name: 'pc-child', online: true, reason: '' }], []), null, Date.now());
    assert.equal(byName(checks, 'adapter:pc-child').ok, true);
  });

  it('fails when a REQUIRED adapter is offline', () => {
    const checks = parity.adapterChecks(
      manifest([{ name: 'pc-child', online: false, reason: 'PowerShell child exited' }], []), 30, Date.now());
    assert.equal(byName(checks, 'adapter:pc-child').ok, false);
    assert.match(byName(checks, 'adapter:pc-child').detail, /PowerShell child exited/);
  });

  it('passes an OPTIONAL adapter that is offline WITH a reason', () => {
    // browser-agent is offline by design until the debug browser is launched.
    // Failing on that would train the operator to ignore this report, which is
    // how a check stops being a check.
    const checks = parity.adapterChecks(
      manifest([{ name: 'browser-agent', online: false, reason: 'CDP connect failed' }], []), 30, Date.now());
    assert.equal(byName(checks, 'adapter:browser-agent').ok, true);
  });

  it('fails an offline adapter that gives NO reason', () => {
    // The one thing demanded of every adapter. A silently-off adapter is exactly
    // the shape BUG-360 hid in for weeks: nothing was broken-looking anywhere.
    const checks = parity.adapterChecks(
      manifest([{ name: 'browser-agent', online: false, reason: '' }], []), 30, Date.now());
    assert.equal(byName(checks, 'adapter:browser-agent').ok, false);
    assert.match(byName(checks, 'adapter:browser-agent').detail, /NO REASON GIVEN/);
  });

  it('fails an ONLINE adapter whose tools are all missing from the manifest — the BUG-360 signature', () => {
    const checks = parity.adapterChecks(
      manifest([{ name: 'android-child', online: true, reason: '' }], ['ui_click', 'web_search']), 30, Date.now());
    const c = byName(checks, 'adapter-tools:android-child');
    assert.equal(c.ok, false);
    assert.match(c.detail, /BUG-360 signature/);
  });

  it('passes an ONLINE adapter whose tools ARE present', () => {
    const checks = parity.adapterChecks(
      manifest([{ name: 'android-child', online: true, reason: '' }],
        ['phone_list_devices', 'phone_sms_send', 'ui_click']), 30, Date.now());
    assert.equal(byName(checks, 'adapter-tools:android-child').ok, true);
    assert.match(byName(checks, 'adapter-tools:android-child').detail, /lists 2 phone_\* tool\(s\)/);
  });

  it('does not fault an OFFLINE adapter for having no tools — that is correct behaviour', () => {
    // An offline adapter's tools SHOULD be withheld. Failing here would make the
    // honest degraded path indistinguishable from the bug.
    const checks = parity.adapterChecks(
      manifest([{ name: 'android-child', online: false, reason: 'adb not found' }], ['ui_click']), 30, Date.now());
    assert.equal(byName(checks, 'adapter-tools:android-child').ok, true);
  });

  it('reports a manifest with no adapters section as a format failure, not as "all fine"', () => {
    const checks = parity.adapterChecks(manifest([], ['ui_click']), 30, Date.now());
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, /manifest format changed/);
  });

  it('every adapter in the required list is one a working install must really have', () => {
    // Guard-the-guard. REQUIRED_ONLINE_ADAPTERS drives a hard failure, so an
    // over-broad list would make this report red on every correct machine and get
    // it ignored. pc-child is the only adapter with no degraded mode: every ui_*
    // tool sits on it and nothing substitutes.
    assert.deepEqual(parity.REQUIRED_ONLINE_ADAPTERS, ['pc-child']);
  });
});

describe('BUG-363: parity-check asks whether a deep link still serves the HUD', () => {
  // res.sendFile defaults to dotfiles:'ignore', and send applies that to EVERY
  // SEGMENT OF THE ABSOLUTE PATH — not just the part below a root. An install
  // under any dot-directory (a worktree in .claude/worktrees/, a user install
  // under ~/.config) therefore 404s a file that is plainly present.
  //
  // Proven on this machine, same express, two directories differing only by a
  // leading dot:
  //     plain path                 / -> 200   /a/b -> 200
  //     path with a .dot segment   / -> 200   /a/b -> 404
  //
  // `/` stays healthy in BOTH because express.static answers it — its dotfiles
  // rule runs on the REQUEST path relative to its own root, never on the root
  // itself. So the screen the operator actually opens looks perfect and only
  // deep links and route reloads die. Identical code, two installs, different
  // behaviour: exactly what parity-check exists to catch, and it could not
  // before this.
  const http = require('node:http');

  // The smallest server runChecks will talk to: enough for it to get past the
  // settings gate and reach the deep-link probe.
  function fakeMythos(deepLinkStatus) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const json = (body, status) => {
          res.writeHead(status || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url.startsWith('/api/config/settings')) {
          return json({ file: 'config.json', keys: [{ name: 'VOICE_TTS_CHAIN', value: 'piper', origin: '.env' }], autonomy: {} });
        }
        if (req.url === '/health') return json({ ok: true, uptime: 5, authRequired: false });
        if (req.url.startsWith('/api/config/wakeword')) return json({ enabled: true, modelsPresent: true });
        if (req.url.startsWith('/api/setup/components')) return json({ components: [] });
        // The probe. 200 = the SPA fallback answered; 404 = BUG-363.
        res.writeHead(deepLinkStatus, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html>HUD</html>');
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }

  it('passes when an unknown deep path serves the HUD', async () => {
    const { server, port } = await fakeMythos(200);
    try {
      const checks = await parity.runChecks({ host: '127.0.0.1', port, token: '' });
      const row = checks.find((c) => c.name === 'spa-deep-link');
      assert.ok(row, 'the deep-link check must run');
      assert.equal(row.ok, true, row.detail);
    } finally { server.close(); }
  });

  it('FAILS when a deep path 404s, and names BUG-363 rather than leaving a bare status', async () => {
    // The failure mode is invisible from the HUD, so the message has to do the
    // explaining — a reader who sees only "404" will go looking at routing.
    const { server, port } = await fakeMythos(404);
    try {
      const checks = await parity.runChecks({ host: '127.0.0.1', port, token: '' });
      const row = checks.find((c) => c.name === 'spa-deep-link');
      assert.equal(row.ok, false);
      assert.match(row.detail, /BUG-363/);
      assert.match(row.detail, /dot-directory/);
    } finally { server.close(); }
  });
});
