'use strict';
// probe-aec-routes.js — measures, acoustically, which of MYTHOS's playback
// routes the browser's echo canceller actually removes from the microphone.
//
// WHY THIS EXISTS. BUG-274 T4 asked one question: is MYTHOS's own voice reaching
// the mic because AEC is bypassed, or because AEC cannot cancel page audio at
// all? The ticket's answer twice came back NOT MEASURED, and the reason was the
// oracle, not the effort:
//
//   * `live.echo-check` asks whether the mic's TRANSCRIPT matched what MYTHOS had
//     just said. But `echo-filter.js` holds a reference for only ECHO_WINDOW_MS
//     (3s), and the own-voice gate deliberately shuts the mic while MYTHOS
//     speaks. A leak has to be transcribed during a window in which capture is
//     suppressed. All 55 decisions in the 2026-08-20 session came back
//     `no-reference`, which reads as "no echo" and means "could not see one".
//   * A three-engine comparison in a normal session cannot control level, room,
//     or which engine spoke — and a session recorded it as un-runnable because
//     "there is no way to make sound leave a real speaker and land in a real
//     microphone". There is. You play a known signal and measure the mic.
//
// So this uses the RMS oracle the barge-in policy itself gates on, with a fixed
// deterministic signal, and it compares each route ONLY AGAINST ITSELF with
// echoCancellation:false. That last part is what makes it scorable: a route that
// is merely louder at the source no longer looks less cancelled.
//
// WHAT IT WILL NOT DO. It will not tell you a session went well. It measures one
// room, at one playback level, with one signal. Absolute numbers here are not
// interchangeable with a live session's `bleedPeak` — see the caveats printed
// with the verdict.
//
//   node mythos/scripts/probe-aec-routes.js            # every environment found
//   node mythos/scripts/probe-aec-routes.js --chrome   # one environment
//   node mythos/scripts/probe-aec-routes.js --electron
//   node mythos/scripts/probe-aec-routes.js --score <dir>   # re-score raw JSON
//
// IT MAKES REAL NOISE OUT OF THE REAL SPEAKERS, for about three minutes per
// environment, and it needs a real microphone on the same machine. That is the
// phenomenon under test; there is no quiet version of this measurement.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PROBE_DIR = path.join(__dirname, 'aec-probe');
const UI_JS_ROOT = path.join(__dirname, '..', 'ui', 'public');
const DEFAULT_PORT = Number(process.env.AEC_PROBE_PORT || 4791);

// ---------------------------------------------------------------------------
// SCORING. Pure, exported, and tested in test/aec-route-probe-scoring.test.js —
// the acoustic half cannot run in CI, so the arithmetic that turns frames into a
// verdict is the part that must be pinned.

// Mean POWER, not mean RMS. Averaging RMS under-weights the loud frames, and
// loud frames are exactly what the barge-in policy reacts to.
function framePower(frames) {
  if (!frames || !frames.length) return null;
  let sum = 0;
  for (const x of frames) sum += x * x;
  return sum / frames.length;
}

const rmsOf = (p) => (p == null ? null : Math.sqrt(p));
const db = (a, b) => (a > 0 && b > 0 ? 20 * Math.log10(a / b) : null);

// A route counts as driven only when its AEC-OFF reference is 4x floor power
// (+6dB) above the room. Below that the cell proves nothing: headphones, muted
// speakers, or a mic on a different device all produce near-zero everywhere,
// which is indistinguishable from perfect cancellation. Run 1 of this probe hit
// exactly that and the gate is why it was not reported as success.
const SNR_GATE = 4;
const CANCELLED_DB = 12;
const PARTIAL_DB = 6;

// The floor is the QUIETER of the two silence readings. One window can be
// polluted by a single transient — a chair, a keystroke, someone talking — and
// taking the minimum keeps that from inflating the floor and erasing a real
// leak. The disagreement is reported rather than averaged away, because a large
// spread means the room moved during the run and the cells are not comparable.
function floorOf(pass) {
  const pre = framePower((pass.conditions['silence-pre'] || {}).frames);
  const post = framePower((pass.conditions['silence-post'] || {}).frames);
  const both = [pre, post].filter((x) => x != null);
  if (!both.length) return { power: null, pre, post, spreadDb: null };
  const power = Math.min(...both);
  return {
    power,
    pre,
    post,
    spreadDb: both.length === 2 ? db(rmsOf(Math.max(...both)), rmsOf(power)) : null,
  };
}

function scorePass(pass) {
  if (!pass) return { error: 'missing' };
  if (pass.error) return { error: pass.error };
  const floor = floorOf(pass);
  const routes = {};
  for (const [name, cell] of Object.entries(pass.conditions || {})) {
    if (/^silence/.test(name)) continue;
    if (cell.unavailable) { routes[name] = { unavailable: cell.unavailable }; continue; }
    const p = framePower(cell.frames);
    routes[name] = {
      n: cell.frames.length,
      rms: rmsOf(p),
      peak: cell.frames.reduce((m, x) => (x > m ? x : m), 0),
      // What the PLAYBACK added, with the room's own contribution removed.
      excessRms: floor.power == null ? null : rmsOf(Math.max(0, p - floor.power)),
      snrDb: db(rmsOf(p), rmsOf(floor.power)),
      driven: floor.power != null && p >= floor.power * SNR_GATE,
    };
  }
  return { granted: pass.granted, sampleRate: pass.sampleRate, source: pass.source, floor, routes };
}

// One route's verdict. `off` is the same route with echoCancellation:false.
function scoreRoute(off, on) {
  if (!off || !on || off.unavailable || on.unavailable) {
    return { state: 'UNAVAILABLE', why: (off && off.unavailable) || (on && on.unavailable) || 'not run' };
  }
  if (!off.driven) {
    return {
      state: 'UNDER-DRIVEN',
      reductionDb: null,
      why: 'the AEC-off reference is only ' + (off.snrDb == null ? 'n/a' : off.snrDb.toFixed(1))
        + 'dB over the room floor, so this cell cannot tell cancellation from silence',
    };
  }
  // An AEC-on reading at or below the floor has no meaningful value, only a
  // bound: the residue is smaller than the room. Reporting a point estimate
  // there is how two runs of this probe appeared to disagree by 15dB when they
  // were both just measuring room noise.
  if (!on.excessRms) {
    return { state: 'CANCELLED', belowFloor: true, reductionDb: null, lowerBoundDb: off.snrDb };
  }
  const reductionDb = db(off.excessRms, on.excessRms);
  let state = 'NOT CANCELLED';
  if (reductionDb >= CANCELLED_DB) state = 'CANCELLED';
  else if (reductionDb >= PARTIAL_DB) state = 'PARTIAL';
  return { state, belowFloor: false, reductionDb };
}

function scoreRun(raw) {
  const on = scorePass(raw.passes && raw.passes['aec-on']);
  const off = scorePass(raw.passes && raw.passes['aec-off']);
  const rawPass = raw.passes && raw.passes.raw ? scorePass(raw.passes.raw) : null;
  const routes = {};
  if (!on.error && !off.error) {
    for (const name of Object.keys(on.routes)) {
      routes[name] = scoreRoute(off.routes[name], on.routes[name]);
    }
  }
  return { env: raw.env, ua: raw.ua, on, off, raw: rawPass, routes };
}

// The T4 question, answered from the route table rather than from transcripts.
// Deliberately refuses to convert "nothing measurable" into good news.
function verdictOf(scored) {
  const names = Object.keys(scored.routes);
  const scorable = names.filter((n) => ['CANCELLED', 'PARTIAL', 'NOT CANCELLED'].includes(scored.routes[n].state));
  if (!scorable.length) {
    return {
      verdict: 'INVALID',
      detail: 'no route was driven above the room floor. Check that sound is actually '
        + 'coming out of open speakers (not headphones), that the mic is on this machine, '
        + 'and that the output volume is up. A clean sweep here is NOT evidence of '
        + 'working cancellation.',
    };
  }
  const leaking = scorable.filter((n) => scored.routes[n].state === 'NOT CANCELLED');
  const cancelled = scorable.filter((n) => scored.routes[n].state === 'CANCELLED');
  if (leaking.length === scorable.length) {
    return {
      verdict: 'CAPABILITY GAP',
      detail: 'every driven route came back uncancelled, so no page-rendered audio is being '
        + 'removed from the capture and swapping engines cannot help.',
      leaking,
    };
  }
  if (leaking.length) {
    return {
      verdict: 'ROUTING DIFFERENCE',
      detail: 'cancellation works on ' + cancelled.join(', ') + ' but not on ' + leaking.join(', ')
        + '. The fix is to stop speaking through the uncancelled route while the mic is live, '
        + 'not to add an echo canceller.',
      leaking,
    };
  }
  return {
    verdict: 'NO ECHO PATH',
    detail: 'every driven route was cancelled to at or below the room floor. If a live session '
      + 'still measures high bleed, the cause is not this room, this level, or AEC being off — '
      + 'look at playback level and at what else the bleed metric is counting.',
    leaking: [],
  };
}

// ---------------------------------------------------------------------------
// REPORTING
function f4(x) { return x == null ? '     n/a' : x.toFixed(4).padStart(8); }

function report(scored) {
  const L = [];
  L.push('');
  L.push('=== ' + scored.env + ' ===');
  L.push('  ' + String(scored.ua || '').replace(/^Mozilla\/5\.0 /, ''));
  for (const [label, s] of [['aec-on ', scored.on], ['aec-off', scored.off], ['raw    ', scored.raw]]) {
    if (!s) continue;
    if (s.error) { L.push('  ' + label + ': ERROR ' + s.error); continue; }
    const g = s.granted || {};
    L.push('  ' + label + ': ec=' + g.echoCancellation + ' ns=' + g.noiseSuppression
      + ' agc=' + g.autoGainControl + ' | floor rms ' + f4(rmsOf(s.floor.power)).trim()
      + (s.floor.spreadDb != null && s.floor.spreadDb >= 6
        ? '  [floor moved ' + s.floor.spreadDb.toFixed(1) + 'dB during this pass - cells are not comparable]'
        : ''));
  }
  L.push('');
  L.push('  route              off rms   on rms  on peak   result');
  for (const name of Object.keys(scored.routes)) {
    const r = scored.routes[name];
    const off = scored.off.routes ? scored.off.routes[name] : null;
    const on = scored.on.routes ? scored.on.routes[name] : null;
    let result = r.state;
    if (r.state === 'CANCELLED' && r.belowFloor) {
      result = 'CANCELLED below the floor (>=' + (r.lowerBoundDb || 0).toFixed(1) + 'dB)';
    } else if (r.reductionDb != null) {
      result = r.state + ' (' + r.reductionDb.toFixed(1) + 'dB)';
    } else if (r.why) {
      result = r.state + ' - ' + r.why;
    }
    L.push('  ' + name.padEnd(18) + f4(off && off.rms) + f4(on && on.rms) + f4(on && on.peak) + '   ' + result);
  }
  const v = verdictOf(scored);
  L.push('');
  L.push('  T4 VERDICT: ' + v.verdict);
  L.push('    ' + v.detail);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// THE RIG
function serve(port, outDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const finish = (code, body) => { res.writeHead(code, { 'cache-control': 'no-store' }); res.end(body); };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (url.pathname === '/result') {
          const env = (url.searchParams.get('env') || 'unknown').replace(/[^a-z0-9-]/gi, '');
          fs.writeFileSync(path.join(outDir, 'result-' + env + '.json'), body);
          server.emit('probe-result', env);
        } else if (url.pathname === '/log') {
          process.stdout.write('  | ' + body + '\n');
        }
        finish(200, 'ok');
      });
      return;
    }
    const rel = url.pathname === '/' ? '/probe.html' : url.pathname;
    const root = rel.startsWith('/js/') ? UI_JS_ROOT : PROBE_DIR;
    const file = path.join(root, rel.replace(/^\/+/, ''));
    if (path.relative(root, file).startsWith('..')) return finish(403, 'no');
    fs.readFile(file, (err, data) => (err ? finish(404, 'not found') : finish(200, data,
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream'))));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Chrome is found through the environment, never a written-out path — anyone
// supplying their own keys has to be able to run this, and a hardcoded install
// location breaks that on day one (CLAUDE.md, portability).
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const rel = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findElectron() {
  try { return require('electron'); } catch (_) { return null; }
}

// Launch, then wait for the page to POST its result. The window is closed by us
// rather than by a timer in the page, so a run that dies mid-pass fails loudly
// instead of posting a half-filled result that would score as UNDER-DRIVEN.
function runEnv(server, port, env, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: false });
    let done = false;
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.removeListener('probe-result', onResult);
      try { child.kill(); } catch (_) {}
      resolve({ ok, why });
    };
    const onResult = (which) => { if (which === env) finish(true); };
    server.on('probe-result', onResult);
    const timer = setTimeout(() => finish(false, 'no result after ' + Math.round(timeoutMs / 1000) + 's'), timeoutMs);
    child.on('error', (e) => finish(false, e.message));
    child.on('exit', () => setTimeout(() => finish(false, 'the browser exited before posting a result'), 1500));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const scoreIdx = argv.indexOf('--score');
  const outDir = scoreIdx !== -1 && argv[scoreIdx + 1]
    ? argv[scoreIdx + 1]
    : fs.mkdtempSync(path.join(os.tmpdir(), 'aec-probe-'));

  if (scoreIdx === -1) {
    const wantChrome = argv.includes('--chrome') || (!argv.includes('--electron'));
    const wantElectron = argv.includes('--electron') || (!argv.includes('--chrome'));
    const port = DEFAULT_PORT;
    const server = await serve(port, outDir);
    console.log('probe server on 127.0.0.1:' + port + ', results in ' + outDir);
    console.log('This plays audible noise through the speakers for ~3 minutes per environment.');

    if (wantChrome) {
      const chrome = findChrome();
      if (!chrome) {
        console.log('\n[chrome] not found (set CHROME_PATH to override) - skipping this environment');
      } else {
        // Its own throwaway profile: the operator's real Chrome profile must not
        // acquire a microphone grant as a side effect of a diagnostic.
        // --use-fake-ui-for-media-stream auto-accepts the prompt with the REAL
        // device; --use-fake-device-for-media-capture would substitute a
        // synthetic one and is deliberately NOT used.
        const profile = path.join(outDir, 'chrome-profile');
        console.log('\n[chrome] ' + chrome);
        const r = await runEnv(server, port, 'chrome', chrome, [
          '--user-data-dir=' + profile,
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--no-first-run', '--no-default-browser-check',
          '--new-window', 'http://127.0.0.1:' + port + '/?env=chrome',
        ], 300000);
        if (!r.ok) console.log('[chrome] FAILED: ' + r.why);
      }
    }

    if (wantElectron) {
      const electron = findElectron();
      if (!electron || typeof electron !== 'string') {
        console.log('\n[electron] not installed - skipping this environment');
      } else {
        console.log('\n[electron] ' + electron);
        // ELECTRON_RUN_AS_NODE is exported by some agent shells and turns the
        // binary into a bare node, so the window never opens and the run times
        // out with no explanation.
        const env = Object.assign({}, process.env);
        delete env.ELECTRON_RUN_AS_NODE;
        const r = await runEnv(server, port, 'electron', electron, [
          path.join(PROBE_DIR, 'electron-main.js'),
          'http://127.0.0.1:' + port + '/?env=electron',
        ], 300000);
        if (!r.ok) console.log('[electron] FAILED: ' + r.why);
      }
    }
    server.close();
  }

  const files = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => /^result-.*\.json$/.test(f)) : [];
  if (!files.length) {
    console.error('\nno results in ' + outDir);
    process.exitCode = 2;
    return;
  }
  for (const f of files) {
    console.log(report(scoreRun(JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')))));
  }
  console.log('');
  console.log('  CAVEATS, and they matter before anyone acts on the numbers:');
  console.log('    - One room, one playback level, one signal. These absolute values are NOT');
  console.log('      interchangeable with a live session\'s bleedPeak, which is measured at');
  console.log('      MYTHOS\'s own playback level and may be counting operator speech too.');
  console.log('    - An AEC-on reading at or below the floor is a BOUND, not a value. Two runs');
  console.log('      differing there are measuring room noise, not cancellation.');
  console.log('    - Raw frames are kept in ' + outDir + ' - re-score with --score <dir>.');
}

module.exports = { framePower, floorOf, scorePass, scoreRoute, scoreRun, verdictOf, report, SNR_GATE };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
