'use strict';

// effectors/vault-url.js — REMEDIATION P1-6/P1-7: the single place that maps a
// vault-relative artifact reference (spelled "/vault/...", "vault/...", or a
// mistaken "file:///vault/..." URL) to (a) the fs-store-relative path used
// for an existence check and (b) the URL the dashboard's own HTTP server
// actually serves it at. open_artifact (from-dashboard.js) and
// browser_navigate (from-browser.js) both call this — previously
// browser_navigate had no equivalent mapping at all and forwarded a
// vault-relative path straight into a file:// URL, which is not a real
// filesystem path on any machine (P1-7 in the 2026-07-29 audit).

var VAULT_PATTERN = /^(?:file:\/+)?\/?vault\/(.+)$/i;

// Returns the fs-store-relative path (e.g. "builds/pipeline/foo.html") if
// `raw` names something inside the vault, or null if it doesn't look like a
// vault path at all (a plain http(s) URL, for example).
function vaultRelativePath(raw) {
  var m = VAULT_PATTERN.exec(String(raw || '').trim());
  return m ? m[1] : null;
}

// Builds the URL the dashboard's HTTP server serves a vault-relative path at.
//
// BUG-317: pass { sign: true } for a URL that will be handed to a BROWSER. The
// browser sends no Authorization header, and /vault/builds is behind
// requireToken, so an unsigned URL 401s — which is exactly how open_artifact
// came to report opened:true for a page the operator could not open. Signing is
// best-effort: with no MYTHOS_AUTH_TOKEN configured there is nothing to sign
// with and nothing to authorise against, so the plain URL is already correct.
function vaultUrl(relPath, config, opts) {
  var port = process.env.PORT || (config && config.MYTHOS_PORT) || 4478;
  var base = 'http://localhost:' + port + '/vault/' + relPath;
  if (!opts || !opts.sign) return base;
  var secret = config && config.MYTHOS_AUTH_TOKEN;
  if (!secret) return base;
  var token = require('./artifact-token').signArtifactPath(relPath, secret);
  if (!token) return base;
  return base + '?exp=' + encodeURIComponent(token.exp) + '&sig=' + encodeURIComponent(token.sig);
}

// BUG-319: how old is this artifact, in whole hours, or null if unknowable.
//
// On 2026-08-22 at 23:40:12 — in the same turn that STARTED the research, before
// any build existed — open_artifact was called on
// /vault/builds/pipeline/ai-news-digest-openai-ai-went-rogue-2.html and returned
// opened:true. That file was last written on 2026-08-11. The existence check
// passes on a real old file, so a ten-day-old artifact was presented to the
// operator as the thing just built; it is the page they called "totally failed".
//
// Deliberately DISCLOSURE, NOT REFUSAL. "Open the pawshop page from last week" is
// a legitimate request, and refusing anything older than the process would break
// it. Age on the result (and therefore in the audit line) lets the model and a
// later reader tell "the build I just made" from "a file that was already there".
function vaultAgeHours(relPath, fsStore) {
  try {
    if (!fsStore || typeof fsStore.vaultPath !== 'function') return null;
    var st = require('fs').statSync(fsStore.vaultPath(relPath));
    return Math.max(0, Math.floor((Date.now() - st.mtimeMs) / 3600000));
  } catch (_) {
    return null;
  }
}

module.exports = {
  vaultRelativePath: vaultRelativePath,
  vaultUrl: vaultUrl,
  vaultAgeHours: vaultAgeHours,
};
