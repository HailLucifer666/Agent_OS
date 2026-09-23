'use strict';

// vault-push.js — the vault push the QUIT path uses, and only that one.
//
// BUG-437 (2026-09-18). `syncVault()` in main.js is a blocking spawnSync with a
// 15 s timeout. That is right for the boot pull and for the installer handover,
// and wrong for a quit: a JavaScript timer does not fire while spawnSync holds
// the loop, so the 10 s quit watchdog — the backstop that exists precisely for
// a wedged quit — provably could not cut short the one thing most likely to
// wedge it. A slow git against an unreachable host turned the backstop into
// part of the wedge.
//
// So the quit path gets this instead: same script, same environment, same
// honesty about failure, awaited and bounded by whatever is left of the quit
// budget rather than by a fixed 15 s.
//
// It lives in its own file for the reason the rest of this ticket is about.
// main.js requires `electron` and cannot be require()d under node --test, so a
// branch written there is a branch no test can execute — and this ticket exists
// because exactly that shape shipped. Everything here is injectable.

// Resolves when the push finishes, fails, or is cut off by its own timeout.
// NEVER rejects: a vault push is a feature, not a precondition, and the caller
// is in the middle of shutting the application down. Whatever misses this
// window goes on the next boot's sync, which is unchanged.
function spawnVaultPush(opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const spawn = o.spawn || require('node:child_process').spawn;
  const label = 'vault-sync ' + (o.flag || '--push');
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    let out = '';
    let child;
    try {
      child = spawn(o.execPath || process.execPath, [o.script, o.flag], {
        cwd: o.cwd,
        timeout: o.timeoutMs,
        windowsHide: true,
        env: o.env,
      });
    } catch (err) {
      // spawn can throw synchronously (a bad cwd, most often), and a throw here
      // would reject a promise the quit sequence is awaiting.
      log(`${label}: could not start —`, err && err.message);
      return done();
    }
    if (child && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (b) => { out += String(b); });
    }
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        log(`${label}: did not finish —`, err && err.message);
        done();
      });
      // 'close' rather than 'exit': stdout must be drained before the lines are
      // logged, or a push that said something useful says nothing at all.
      child.on('close', (code, signal) => {
        const text = out.trim();
        if (text) for (const line of text.split('\n')) log(line);
        // A timeout arrives as a signal, not as an error, and reporting it as a
        // clean push would be the same lie this ticket is about.
        if (signal) log(`${label}: cut off after ${o.timeoutMs}ms (${signal}) — it will run on the next boot.`);
        else if (code) log(`${label}: exited ${code}.`);
        done();
      });
    } else {
      done();
    }
  });
}

module.exports = { spawnVaultPush };
