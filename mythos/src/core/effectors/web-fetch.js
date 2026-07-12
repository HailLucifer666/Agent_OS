'use strict';

// web-fetch.js — shared URL fetcher. Extracted from from-dashboard.js so both
// the dashboard effector and the agent-actions research gate can use it.
// Direct fetch first (fast, no dep), Jina reader fallback (handles JS-rendered pages).

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
var MAX_CHARS = 4000;

async function web_fetch({ url }) {
  if (!url || !String(url).trim()) return { ok: false, error: 'A URL is required.' };
  var raw = String(url).trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: 'URL must start with http:// or https://' };

  // Direct fetch first
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 15000);
    var res = await fetch(raw, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (res.ok) {
      var contentType = res.headers.get('content-type') || '';
      var body = await res.text();
      var text = body;
      if (contentType.includes('text/html')) {
        text = stripHtml(body);
      }
      if (text && text.trim().length > 0) {
        var truncated = text.length > MAX_CHARS;
        return {
          ok: true,
          result: {
            url: raw,
            status: res.status,
            contentType: contentType.split(';')[0].trim(),
            content: text.slice(0, MAX_CHARS),
            truncated: truncated,
            totalLength: text.length,
          }
        };
      }
    }
  } catch (_) { /* fall through to Jina */ }

  // Jina reader fallback (handles JS-rendered pages)
  try {
    var jinaUrl = 'https://r.jina.ai/' + raw.replace(/^https?:\/\//, '');
    var controller2 = new AbortController();
    var timer2 = setTimeout(function() { controller2.abort(); }, 15000);
    var res2 = await fetch(jinaUrl, {
      signal: controller2.signal,
      headers: { 'User-Agent': BROWSER_UA },
    });
    clearTimeout(timer2);
    if (res2.ok) {
      var text2 = await res2.text();
      if (text2 && text2.trim()) {
        var truncated2 = text2.length > MAX_CHARS;
        return {
          ok: true,
          result: {
            url: raw,
            status: res2.status,
            contentType: 'text/plain',
            content: text2.slice(0, MAX_CHARS),
            truncated: truncated2,
            totalLength: text2.length,
          }
        };
      }
    }
  } catch (_) { /* both failed */ }

  return { ok: false, error: 'Could not fetch content from ' + raw };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { web_fetch: web_fetch, _stripHtml: stripHtml };
