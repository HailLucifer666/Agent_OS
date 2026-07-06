// radar-feeds.js — fetch and parse RSS/Atom feeds for The Radar.
//
// Free-only MVP: reads RADAR_FEEDS (comma-separated URLs) from env, fetches each
// server-side (avoids browser CORS), extracts the most recent items, and normalizes
// them into the signal shape consumed by radar.js's renderSignalCard().
//
// Honesty rules:
//   - No feeds configured → returns { signals: [], note: '...' } — never fakes items.
//   - Feed fetch failures are caught per-feed; one dead feed doesn't poison the rest.
//   - No NLP scoring — `score` is a simple recency/length heuristic, clearly approximate.
//   - No new npm deps. RSS/Atom XML is parsed with a tight regex extractor over <item>/<entry>.

const https = require('https');
const http = require('http');

const DEFAULT_LIMIT = 12;

function getEnvFeeds() {
  const raw = process.env.RADAR_FEEDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getEnvKeywords() {
  const raw = process.env.RADAR_KEYWORDS || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Fetch a URL as text with a timeout. Rejects on network/HTTP error. */
function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'AgenticOS-Radar/1.0 (+local)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect (common for feedburner, etc.)
        res.resume();
        fetchText(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/** Decode HTML entities + unwrap CDATA sections (feeds often use both). */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Strip HTML tags + collapse whitespace for a one-line excerpt. */
function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract <item> (RSS) or <entry> (Atom) blocks from feed XML. */
function extractItems(xml) {
  const items = [];
  // RSS: <item>...</item>; Atom: <entry>...</entry>
  const re = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push(m[1]);
  }
  return items;
}

function firstMatch(block, tagPattern) {
  const m = block.match(tagPattern);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Approximate feed source name from a URL or the channel title. */
function sourceName(feedUrl, channelBlock) {
  const hostMatch = feedUrl.match(/^https?:\/\/([^/]+)/);
  return hostMatch ? hostMatch[1].replace(/^www\./, '') : feedUrl;
}

/** Deduplicate signals by normalized title (lowercased, whitespace-collapsed). */
function dedupSignals(signals) {
  const seen = new Set();
  return signals.filter((s) => {
    const key = s.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Convert raw XML block to a signal object matching radar.js's renderSignalCard. */
function toItem(block, feedUrl) {
  // RSS uses <title>, <link>, <description>, <pubDate>, <category>, <author>.
  // Atom uses <title>, <link href="..."/>, <summary>, <published>/<updated>, <author><name>.
  const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i);
  let link = firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/i);
  if (!link) {
    const href = block.match(/<link[^>]*href="([^"]+)"/i);
    link = href ? href[1] : '';
  }
  const description = firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/i)
    || firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/i)
    || firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/i);
  const pubDateRaw = firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)
    || firstMatch(block, /<published[^>]*>([\s\S]*?)<\/published>/i)
    || firstMatch(block, /<updated[^>]*>([\s\S]*?)<\/updated>/i);
  const category = firstMatch(block, /<category[^>]*>([\s\S]*?)<\/category>/i)
    || firstMatch(block, /<category[^>]*term="([^"]+)"/i);

  const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
  const body = stripHtml(description);

  // Approximate score: recency (≤24h=60, ≤72h=40, else 20) + length bonus, capped 95.
  let score = 20;
  if (pubDate) {
    const ageHrs = (Date.now() - pubDate.getTime()) / 36e5;
    if (ageHrs <= 24) score = 60;
    else if (ageHrs <= 72) score = 40;
    else score = 25;
  }
  score = Math.min(95, score + Math.min(20, Math.floor(body.length / 200)));

  // Keyword relevance boost: each matching keyword adds +5 (max +20).
  const keywords = getEnvKeywords();
  if (keywords.length) {
    const haystack = `${title} ${body}`.toLowerCase();
    let kwBonus = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) kwBonus += 5;
    }
    score = Math.min(95, score + Math.min(20, kwBonus));
  }

  return {
    title: stripHtml(title) || '(untitled)',
    body,
    quote: body.slice(0, 140),
    handle: sourceName(feedUrl, block),
    datetime: pubDate ? pubDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'recent',
    category: category || 'signal',
    score,
    sources: [sourceName(feedUrl, block)],
    angle: '', // left blank — no LLM angle-invention in the free MVP
    link,
    isoDate: pubDate ? pubDate.toISOString() : null,
  };
}

/**
 * Fetch and normalize all configured feeds.
 * @returns {Promise<{ signals: Array, note: string, fedCount: number, failCount: number }>}
 */
async function fetchSignals(limit = DEFAULT_LIMIT) {
  const feeds = getEnvFeeds();
  if (!feeds.length) {
    return {
      signals: [],
      note: 'No RSS feeds configured. Set RADAR_FEEDS in .env (comma-separated feed URLs) to populate The Radar.',
      fedCount: 0,
      failCount: 0,
    };
  }

  const results = await Promise.allSettled(
    feeds.map(async (url) => {
      const xml = await fetchText(url);
      const blocks = extractItems(xml).slice(0, 10); // per-feed cap before merge
      return blocks.map((b) => toItem(b, url));
    })
  );

  let all = [];
  let fedCount = 0;
  let failCount = 0;
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      fedCount += 1;
      all = all.concat(r.value);
    } else {
      failCount += 1;
      failures.push(`${feeds[i]}: ${r.reason.message}`);
    }
  });

  // Sort by date desc (undated last), take the top N.
  all.sort((a, b) => {
    if (a.isoDate && b.isoDate) return b.isoDate.localeCompare(a.isoDate);
    if (a.isoDate) return -1;
    if (b.isoDate) return 1;
    return 0;
  });

  // Dedup by normalized title (lowercased, whitespace-collapsed).
  all = dedupSignals(all);

  const signals = all.slice(0, limit);

  let note;
  if (!signals.length) {
    note = failCount === feeds.length
      ? `All ${failCount} feed(s) failed to load. Check RADAR_FEEDS URLs.`
      : 'Feeds loaded but no items extracted.';
  } else {
    const kwCount = getEnvKeywords().length;
    note = `${signals.length} signal(s) from ${fedCount} feed(s)${failCount ? `, ${failCount} failed` : ''}. Score is an approximate recency heuristic, not a relevance model.${kwCount ? ` Keyword boost active (${kwCount} keywords).` : ''}`;
  }

  if (failures.length) {
    // Surface failure detail server-side only (not to the client) — keep the UI clean.
    console.warn('[radar] feed failures:', failures.join('; '));
  }

  return { signals, note, fedCount, failCount };
}

module.exports = { fetchSignals, getEnvFeeds, getEnvKeywords, toItem, dedupSignals };
