'use strict';

// P21 — web search chain: pure-function tests for DDG HTML parser,
// DDG href unwrapping, stripTags, and Wikipedia parser.
// NO live-network tests.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { _stripTags, _unwrapDdgHref, _ddgHtml, _ddgLite, _wikiSearch } = require('../src/core/effectors/web-search')

// --- canned DDG HTML fixture ---
// Three results with result__a links and result__snippet anchors.
// Second result uses a uddg=-wrapped DDG redirect URL.
// Third result has a plain href (no uddg).
var DDG_HTML_FIXTURE = [
  '<!DOCTYPE html>',
  '<html><head><title>DuckDuckGo</title></head><body>',
  '<div class="results">',
  // Result 1: plain href, snippet present
  '<div class="result results_links results_links_deep web-result">',
  '<a class="result__a" href="https://example.com/nodejs-runtime">Node.js Runtime — Official Site</a>',
  '<a class="result__snippet" href="...">Node.js is a JavaScript runtime built on Chrome\'s V8 engine.</a>',
  '</div>',
  // Result 2: uddg-wrapped redirect URL
  '<div class="result results_links results_links_deep web-result">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FJavaScript&amp;rut=abc123">MDN Web Docs</a>',
  '<a class="result__snippet" href="...">Resources for developers, by developers. The MDN Web Docs site.</a>',
  '</div>',
  // Result 3: another plain URL
  '<div class="result results_links results_links_deep web-result">',
  '<a class="result__a" href="https://github.com/nodejs/node">Node.js &mdash; GitHub Repository</a>',
  '<a class="result__snippet" href="...">Node.js is a JavaScript runtime built on Chrome&#39;s V8 JavaScript engine.</a>',
  '</div>',
  '</div>',
  '</body></html>'
].join('\n')

// --- canned DDG Lite HTML fixture ---
var DDG_LITE_FIXTURE = [
  '<!DOCTYPE html>',
  '<html><head><title>DuckDuckGo Lite</title></head><body>',
  '<table>',
  '<tr><td><a class="result-link" href="https://example.com/rust-lang">The Rust Programming Language</a></td></tr>',
  '<tr><td class="result-snippet">A language empowering everyone to build reliable and efficient software.</td></tr>',
  '<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2Flearn&amp;rut=xyz">Learn Rust</a></td></tr>',
  '<tr><td class="result-snippet">Take your first steps with Rust &mdash; read the book.</td></tr>',
  '</table>',
  '</body></html>'
].join('\n')

describe('P21: web search chain — pure-function tests', function() {

  // ---- stripTags ----

  describe('stripTags', function() {
    it('removes all HTML tags', function() {
      var input = '<p>Hello <b>world</b></p>'
      assert.equal(_stripTags(input), 'Hello world')
    })

    it('strips script and style blocks entirely', function() {
      var input = '<script>var x = 1;</script><style>.x{}</style>Visible'
      assert.equal(_stripTags(input), 'Visible')
    })

    it('decodes common HTML entities', function() {
      var input = '5 &gt; 3 &amp; 2 &lt; 4'
      assert.equal(_stripTags(input), '5 > 3 & 2 < 4')
    })

    it('decodes numeric entities (decimal and hex)', function() {
      var input = '&#65;&#x42;'
      assert.equal(_stripTags(input), 'AB')
    })

    it('decodes &apos; and &quot;', function() {
      var input = '&apos;hi&apos; &quot;there&quot;'
      assert.equal(_stripTags(input), "'hi' \"there\"")
    })

    it('collapses whitespace and trims', function() {
      var input = '  <p>   spaced   out  </p>  '
      assert.equal(_stripTags(input), 'spaced out')
    })

    it('returns empty string for null/undefined', function() {
      assert.equal(_stripTags(null), '')
      assert.equal(_stripTags(undefined), '')
    })

    it('returns empty string for empty string', function() {
      assert.equal(_stripTags(''), '')
    })

    it('handles &nbsp; and unknown entities gracefully', function() {
      var input = 'a&nbsp;b&unknown;c'
      assert.equal(_stripTags(input), 'a b c')
    })
  })

  // ---- unwrapDdgHref ----

  describe('unwrapDdgHref', function() {
    it('unwraps a protocol-relative uddg URL', function() {
      var href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath&amp;rut=abc'
      assert.equal(_unwrapDdgHref(href), 'https://example.com/path')
    })

    it('unwraps a full https uddg URL', function() {
      var href = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&amp;rut=def'
      assert.equal(_unwrapDdgHref(href), 'https://example.com')
    })

    it('returns plain URLs unchanged', function() {
      assert.equal(_unwrapDdgHref('https://example.com'), 'https://example.com')
      assert.equal(_unwrapDdgHref('http://example.com/path?q=1'), 'http://example.com/path?q=1')
    })

    it('returns empty string for empty/falsy input', function() {
      assert.equal(_unwrapDdgHref(''), '')
      assert.equal(_unwrapDdgHref(null), '')
    })

    it('returns as-is when uddg param is missing', function() {
      var href = '//duckduckgo.com/l/?rut=abc&foo=bar'
      // no uddg → return unchanged (still a DDG URL but not our pattern)
      assert.equal(_unwrapDdgHref(href), href)
    })
  })

  // ---- ddgHtml (with mocked fetch) ----

  describe('ddgHtml', function() {
    it('parses DDG HTML fixture with 3 results including uddg unwrap', async function() {
      // Monkey-patch global.fetch for this test
      var origFetch = global.fetch
      global.fetch = function(url, opts) {
        return Promise.resolve({
          ok: true,
          text: function() { return Promise.resolve(DDG_HTML_FIXTURE) }
        })
      }
      try {
        var results = await _ddgHtml('nodejs runtime', 10)
        assert.equal(results.length, 3)

        // Result 1: plain href
        assert.equal(results[0].title, 'Node.js Runtime — Official Site')
        assert.equal(results[0].url, 'https://example.com/nodejs-runtime')
        assert.equal(results[0].snippet, "Node.js is a JavaScript runtime built on Chrome's V8 engine.")

        // Result 2: uddg-unwrapped href
        assert.equal(results[1].title, 'MDN Web Docs')
        assert.equal(results[1].url, 'https://developer.mozilla.org/en-US/docs/Web/JavaScript')
        assert.equal(results[1].snippet, 'Resources for developers, by developers. The MDN Web Docs site.')

        // Result 3: plain href, entity decoded in snippet
        assert.equal(results[2].title, 'Node.js — GitHub Repository')
        assert.equal(results[2].url, 'https://github.com/nodejs/node')
        assert.equal(results[2].snippet, "Node.js is a JavaScript runtime built on Chrome's V8 JavaScript engine.")
      } finally {
        global.fetch = origFetch
      }
    })

    it('returns empty array when fetch fails', async function() {
      var origFetch = global.fetch
      global.fetch = function() { return Promise.reject(new Error('network error')) }
      try {
        var results = await _ddgHtml('test', 5)
        assert.deepEqual(results, [])
      } finally {
        global.fetch = origFetch
      }
    })

    it('returns empty array when no result__a links found', async function() {
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          text: function() { return Promise.resolve('<html><body>No results here</body></html>') }
        })
      }
      try {
        var results = await _ddgHtml('nonsense', 5)
        assert.deepEqual(results, [])
      } finally {
        global.fetch = origFetch
      }
    })

    it('respects maxResults parameter', async function() {
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          text: function() { return Promise.resolve(DDG_HTML_FIXTURE) }
        })
      }
      try {
        var results = await _ddgHtml('nodejs', 2)
        assert.equal(results.length, 2)
      } finally {
        global.fetch = origFetch
      }
    })
  })

  // ---- ddgLite (with mocked fetch) ----

  describe('ddgLite', function() {
    it('parses DDG Lite fixture with 2 results including uddg unwrap', async function() {
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          text: function() { return Promise.resolve(DDG_LITE_FIXTURE) }
        })
      }
      try {
        var results = await _ddgLite('rust lang', 10)
        assert.equal(results.length, 2)

        assert.equal(results[0].title, 'The Rust Programming Language')
        assert.equal(results[0].url, 'https://example.com/rust-lang')
        assert.equal(results[0].snippet, 'A language empowering everyone to build reliable and efficient software.')

        assert.equal(results[1].title, 'Learn Rust')
        assert.equal(results[1].url, 'https://www.rust-lang.org/learn')
        assert.equal(results[1].snippet, 'Take your first steps with Rust — read the book.')
      } finally {
        global.fetch = origFetch
      }
    })

    it('returns empty array when fetch fails', async function() {
      var origFetch = global.fetch
      global.fetch = function() { return Promise.reject(new Error('timeout')) }
      try {
        var results = await _ddgLite('test', 5)
        assert.deepEqual(results, [])
      } finally {
        global.fetch = origFetch
      }
    })
  })

  // ---- wikiSearch (with mocked fetch) ----

  describe('wikiSearch', function() {
    it('parses Wikipedia OpenSearch JSON response', async function() {
      var fixture = [
        'javascript',
        ['JavaScript', 'JavaScript (programming language)', 'JavaScript library'],
        [
          'A high-level programming language',
          'A programming language and core technology of the World Wide Web',
          'A collection of pre-written JavaScript code'
        ],
        ['https://en.wikipedia.org/wiki/JavaScript',
         'https://en.wikipedia.org/wiki/JavaScript_(programming_language)',
         'https://en.wikipedia.org/wiki/JavaScript_library']
      ]
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          json: function() { return Promise.resolve(fixture) }
        })
      }
      try {
        var results = await _wikiSearch('javascript', 5)
        assert.equal(results.length, 3)
        assert.equal(results[0].title, 'JavaScript')
        assert.equal(results[0].url, 'https://en.wikipedia.org/wiki/JavaScript')
        assert.ok(results[0].snippet.indexOf('high-level') !== -1)
      } finally {
        global.fetch = origFetch
      }
    })

    it('returns empty array for malformed response', async function() {
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          json: function() { return Promise.resolve({ error: 'bad' }) }
        })
      }
      try {
        var results = await _wikiSearch('test', 5)
        assert.deepEqual(results, [])
      } finally {
        global.fetch = origFetch
      }
    })

    it('returns empty array when fetch fails', async function() {
      var origFetch = global.fetch
      global.fetch = function() { return Promise.reject(new Error('fail')) }
      try {
        var results = await _wikiSearch('test', 5)
        assert.deepEqual(results, [])
      } finally {
        global.fetch = origFetch
      }
    })

    it('respects maxResults parameter', async function() {
      var fixture = ['q', ['A', 'B', 'C'], ['d1', 'd2', 'd3'], ['http://a', 'http://b', 'http://c']]
      var origFetch = global.fetch
      global.fetch = function() {
        return Promise.resolve({
          ok: true,
          json: function() { return Promise.resolve(fixture) }
        })
      }
      try {
        var results = await _wikiSearch('q', 2)
        assert.equal(results.length, 2)
        assert.equal(results[0].title, 'A')
        assert.equal(results[1].title, 'B')
      } finally {
        global.fetch = origFetch
      }
    })
  })
})
