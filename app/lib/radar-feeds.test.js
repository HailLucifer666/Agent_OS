// radar-feeds.test.js — unit tests for dedup, keyword scoring, and env helpers.
// No HTTP calls — tests pure functions exported from radar-feeds.js.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { toItem, dedupSignals, getEnvKeywords, getEnvFeeds } = require('./radar-feeds');

describe('toItem — keyword relevance boost', () => {
  afterEach(() => {
    delete process.env.RADAR_KEYWORDS;
  });

  test('no keywords configured → score uses only recency/length heuristic', () => {
    delete process.env.RADAR_KEYWORDS;
    const signal = toItem(
      '<title>AI breakthrough announced</title><description>A new AI model was released today.</description><pubDate>2026-07-06T12:00:00Z</pubDate>',
      'https://example.com/feed'
    );
    assert.ok(signal.score >= 20, 'score should have baseline value');
    assert.ok(signal.score <= 95, 'score should be capped at 95');
  });

  test('matching keyword boosts score by +5 per keyword', () => {
    process.env.RADAR_KEYWORDS = 'ai,agents';
    const signal = toItem(
      '<title>AI breakthrough announced</title><description>A new AI model was released today.</description><pubDate>2026-07-06T12:00:00Z</pubDate>',
      'https://example.com/feed'
    );
    // "ai" matches in title and body, "agents" does not → +5
    // Baseline: recency (24h=60) + length bonus
    assert.ok(signal.score >= 65, `score with keyword boost should be >= 65, got ${signal.score}`);
  });

  test('multiple keywords stack up to +20 max', () => {
    process.env.RADAR_KEYWORDS = 'ai,agents,model,released';
    const signal = toItem(
      '<title>AI agents model released today</title><description>A new AI model was released by agents today.</description><pubDate>2026-07-06T12:00:00Z</pubDate>',
      'https://example.com/feed'
    );
    // All 4 keywords match → +20 (capped)
    // Baseline: 60 (recent) + length bonus + 20 = max
    assert.ok(signal.score <= 95, 'score should never exceed 95');
  });

  test('keyword matching is case-insensitive', () => {
    process.env.RADAR_KEYWORDS = 'open source';
    const signal = toItem(
      '<title>New Open Source Project Launches</title><description>The project is now available.</description><pubDate>2026-07-06T12:00:00Z</pubDate>',
      'https://example.com/feed'
    );
    // "open source" matches (case-insensitive) → +5
    assert.ok(signal.score >= 65, `case-insensitive keyword should boost, got ${signal.score}`);
  });
});

describe('dedupSignals — title deduplication', () => {
  test('removes exact duplicate titles (case-insensitive)', () => {
    const signals = [
      { title: 'AI Breakthrough', isoDate: '2026-07-06T12:00:00Z' },
      { title: 'ai breakthrough', isoDate: '2026-07-06T11:00:00Z' },
      { title: 'Other News', isoDate: '2026-07-06T10:00:00Z' },
    ];
    const result = dedupSignals(signals);
    assert.equal(result.length, 2, 'should keep 2 unique titles');
    assert.equal(result[0].title, 'AI Breakthrough');
    assert.equal(result[1].title, 'Other News');
  });

  test('removes duplicates with extra whitespace', () => {
    const signals = [
      { title: 'AI  Breakthrough', isoDate: '2026-07-06T12:00:00Z' },
      { title: 'AI Breakthrough', isoDate: '2026-07-06T11:00:00Z' },
    ];
    const result = dedupSignals(signals);
    assert.equal(result.length, 1, 'should collapse whitespace-duplicate titles');
  });

  test('empty input returns empty', () => {
    assert.equal(dedupSignals([]).length, 0);
  });

  test('no duplicates returns same length', () => {
    const signals = [
      { title: 'First', isoDate: '2026-07-06T12:00:00Z' },
      { title: 'Second', isoDate: '2026-07-06T11:00:00Z' },
      { title: 'Third', isoDate: '2026-07-06T10:00:00Z' },
    ];
    assert.equal(dedupSignals(signals).length, 3);
  });
});

describe('getEnvKeywords', () => {
  afterEach(() => { delete process.env.RADAR_KEYWORDS; });

  test('parses comma-separated keywords', () => {
    process.env.RADAR_KEYWORDS = 'ai, agents, llm';
    const keywords = getEnvKeywords();
    assert.deepEqual(keywords, ['ai', 'agents', 'llm']);
  });

  test('returns empty array when not set', () => {
    delete process.env.RADAR_KEYWORDS;
    assert.deepEqual(getEnvKeywords(), []);
  });

  test('trims and filters empty entries', () => {
    process.env.RADAR_KEYWORDS = 'ai, , agents,  ,llm';
    assert.deepEqual(getEnvKeywords(), ['ai', 'agents', 'llm']);
  });
});

describe('toItem — basic signal shape', () => {
  test('extracts title, body, link, datetime, score', () => {
    const signal = toItem(
      '<item><title>Test Title</title><link>https://example.com</link><description>Test body content.</description><pubDate>Mon, 06 Jul 2026 12:00:00 GMT</pubDate><category>tech</category></item>',
      'https://feed.example.com/rss'
    );
    assert.equal(signal.title, 'Test Title');
    assert.equal(signal.link, 'https://example.com');
    assert.equal(signal.body, 'Test body content.');
    assert.equal(signal.category, 'tech');
    assert.ok(signal.score >= 20);
    assert.ok(signal.isoDate.includes('2026'));
  });

  test('angle is empty string (no LLM in free MVP)', () => {
    const signal = toItem(
      '<item><title>T</title><description>D</description></item>',
      'https://example.com'
    );
    assert.equal(signal.angle, '');
  });
});
