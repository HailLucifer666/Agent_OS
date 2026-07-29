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
function vaultUrl(relPath, config) {
  var port = process.env.PORT || (config && config.MYTHOS_PORT) || 4478;
  return 'http://localhost:' + port + '/vault/' + relPath;
}

module.exports = { vaultRelativePath: vaultRelativePath, vaultUrl: vaultUrl };
