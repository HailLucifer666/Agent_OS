'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeEntities, stripTags, extractTitle, htmlToText } = require('../src/core/util/html-text');

test('decodeEntities handles named entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e'), 'a & b <c> "d"  e');
  assert.equal(decodeEntities('caf&eacute;'), 'caf&eacute;'); // unknown named left intact
});

test('decodeEntities handles numeric (decimal + hex) entities', () => {
  assert.equal(decodeEntities('&#65;&#66;&#67;'), 'ABC');
  assert.equal(decodeEntities('&#x41;&#x42;'), 'AB');
  assert.equal(decodeEntities('&#128512;'), String.fromCodePoint(128512)); // emoji
});

test('stripTags removes markup', () => {
  assert.equal(stripTags('<p>hi <b>there</b></p>'), 'hi there');
});

test('extractTitle pulls and cleans the <title>', () => {
  assert.equal(extractTitle('<html><head><title>  Hello &amp; World </title></head></html>'), 'Hello & World');
  assert.equal(extractTitle('<html><body>no title</body></html>'), '');
});

test('htmlToText drops script/style, block→newline, decodes, collapses whitespace', () => {
  const html = `<html><head><style>.x{color:red}</style><title>T</title></head>
    <body>
      <nav>menu here</nav>
      <h1>Heading</h1>
      <p>First   paragraph &amp; more.</p>
      <script>var x = 1;</script>
      <p>Second paragraph.</p>
      <footer>footer junk</footer>
    </body></html>`;
  const text = htmlToText(html, { maxChars: 1000 });
  assert.ok(text.includes('Heading'));
  assert.ok(text.includes('First paragraph & more.'));
  assert.ok(text.includes('Second paragraph.'));
  assert.ok(!text.includes('color:red'), 'style content dropped');
  assert.ok(!text.includes('var x'), 'script content dropped');
  assert.ok(!text.includes('menu here'), 'nav dropped');
  assert.ok(!text.includes('footer junk'), 'footer dropped');
  assert.ok(!/  /.test(text), 'no double spaces after collapse');
  // block elements produce line breaks between heading and paragraphs
  assert.ok(text.split('\n').length >= 3);
});

test('htmlToText respects maxChars', () => {
  const text = htmlToText('<p>' + 'a'.repeat(100) + '</p>', { maxChars: 10 });
  assert.equal(text.length, 10);
});
