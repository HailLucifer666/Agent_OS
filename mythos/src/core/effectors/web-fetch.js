'use strict';

// effectors/web-fetch.js — SSRF-guarded single-page fetch (P23). Every hop
// (initial URL + every redirect Location) is re-validated by guardUrl, closing
// open-redirect-to-metadata attacks (redirect:'manual' — we follow hops
// ourselves so we can guard each one). Content-type is allow-listed (text/html,
// text/plain, application/json). The body is read with a STREAMING byte cap
// (readBodyCapped) so a hostile Content-Length or an endless stream can't
// exhaust memory. HTML → htmlToText + extractTitle; JSON → pretty-printed.
// Exports createWebFetch (reusable core for research) + registerWebFetch(hub).
// Tool web_fetch is T0 (read-only).

const { effectorFromTool } = require('./adapter');
const { guardUrl } = require('../util/ssrf-guard');
const { htmlToText, extractTitle } = require('../util/html-text');

const MAX_REDIRECTS = 5;
const ALLOWED_TYPES = ['text/html', 'text/plain', 'application/json'];

function contentTypeAllowed(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase();
  if (!base) return true; // no content-type: attempt as text
  return ALLOWED_TYPES.indexOf(base) !== -1;
}

// Read the response body up to maxBytes; stop early once the cap is hit.
async function readBodyCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { text: buf.slice(0, maxBytes).toString('utf8'), truncated: true };
    return { text: buf.toString('utf8'), truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total >= maxBytes) {
      const remaining = maxBytes - (total - value.length);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, Math.max(0, remaining)));
      truncated = true;
      try { await reader.cancel(); } catch (_) { /* best-effort */ }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: truncated };
}

function createWebFetch({ config }) {
  config = config || {};
  const maxBytes = config.WEB_FETCH_MAX_BYTES || 2097152;
  const timeoutMs = config.WEB_FETCH_TIMEOUT_MS || 15000;

  async function webFetch({ url, maxChars }) {
    if (!url || !String(url).trim()) return { ok: false, result: 'A URL is required.' };
    let current = String(url).trim();
    let finalUrl = current;
    let res;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const guard = await guardUrl(current);
      if (!guard.ok) return { ok: false, result: 'Blocked for safety: ' + guard.reason };
      finalUrl = guard.url.href;
      try {
        res = await fetch(guard.url.href, {
          redirect: 'manual',
          headers: { 'User-Agent': 'MYTHOS-web-fetch/1.0', 'Accept': 'text/html,text/plain,application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const kind = err && err.name === 'TimeoutError' ? 'timed out' : (err && err.message) || 'fetch failed';
        return { ok: false, result: 'Fetch failed: ' + kind };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, result: 'Redirect (HTTP ' + res.status + ') with no Location header.' };
        if (hop === MAX_REDIRECTS) return { ok: false, result: 'Too many redirects (>' + MAX_REDIRECTS + ').' };
        try { current = new URL(loc, finalUrl).href; }
        catch (_) { return { ok: false, result: 'Redirect to an invalid URL.' }; }
        continue;
      }
      break;
    }

    if (!res.ok) return { ok: false, result: 'Fetch failed: HTTP ' + res.status };
    const ct = res.headers.get('content-type') || '';
    if (!contentTypeAllowed(ct)) return { ok: false, result: 'Unsupported content type: ' + ct.split(';')[0].trim() };

    const body = await readBodyCapped(res, maxBytes);
    const base = ct.split(';')[0].trim().toLowerCase();
    let title = '';
    let text = body.text;
    const cap = maxChars || 0;

    if (base === 'application/json') {
      try { text = JSON.stringify(JSON.parse(body.text), null, 2); }
      catch (_) { /* leave raw */ }
    } else if (base === 'text/html' || (!base && /<html[\s>]/i.test(body.text))) {
      title = extractTitle(body.text);
      text = htmlToText(body.text, { maxChars: cap });
    }
    if (cap && text.length > cap) text = text.slice(0, cap);

    return { ok: true, result: { url: url, finalUrl: finalUrl, title: title, text: text, truncated: body.truncated } };
  }

  return { webFetch: webFetch };
}

function registerWebFetch(hub, ctx) {
  const svc = createWebFetch(ctx);
  hub.register(effectorFromTool({
    name: 'web_fetch',
    description: 'Fetch and read one web page or JSON endpoint by URL, returned as clean text. Private/loopback/link-local addresses are blocked for safety. Use after web_search to read a specific result.',
    params: { url: 'string - the page URL to fetch', maxChars: 'number (optional) - truncate the returned text' },
    danger: false,
    fn: function (params) { return svc.webFetch(params || {}); },
  }));
  return svc;
}

module.exports = { createWebFetch, registerWebFetch, _internal: { readBodyCapped, contentTypeAllowed } };
