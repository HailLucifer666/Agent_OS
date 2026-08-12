'use strict';

// test/electron-update-release-notes.test.js — A2: surfacing electron-updater's
// UpdateInfo.releaseNotes in the install-consent dialog (promptInstall()).
//
// sanitizeReleaseNotes() lives in electron/release-notes.js rather than
// electron/main.js for the same reason electron/child-exit.js was extracted
// (see that file's header comment): main.js requires `electron`, so node
// --test can only make source-shape assertions about anything defined there.
// The actual normalizing/sanitizing logic needs to be callable with real
// inputs, so it lives in a plain module with no electron dependency.
//
// VERIFIED FACT this task is built on (builder-util-runtime out/updateInfo.d.ts):
// releaseNotes is `string | Array<ReleaseNoteInfo> | null`, where
// ReleaseNoteInfo is `{ version: string; note: string | null }`. GitHubProvider
// prefers a plain string sourced from latest.yml, but falls back to an
// Atom-feed array when latest.yml carries no notes — which, as of this task,
// is every release this project has actually published. The array branch is
// therefore the one production hits today, not a defensive-fiction fallback.
//
// Run: cd mythos && node --test test/electron-update-release-notes.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeReleaseNotes } = require('../../electron/release-notes');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readMainJs() {
  return fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
}

test('sanitizeReleaseNotes: null/undefined/empty input returns an empty string, never throws', () => {
  assert.equal(sanitizeReleaseNotes(null), '');
  assert.equal(sanitizeReleaseNotes(undefined), '');
  assert.equal(sanitizeReleaseNotes(''), '');
  assert.equal(sanitizeReleaseNotes([]), '');
});

test('sanitizeReleaseNotes: unusable input (numbers, objects without .note) never throws and returns ""', () => {
  assert.equal(sanitizeReleaseNotes(42), '');
  assert.equal(sanitizeReleaseNotes({}), '');
  assert.equal(sanitizeReleaseNotes([{ version: '1.0.0' }]), '');
});

test('sanitizeReleaseNotes: the plain-string shape (GitHubProvider preferred path)', () => {
  assert.equal(sanitizeReleaseNotes('Fixed a crash on startup.'), 'Fixed a crash on startup.');
});

test('sanitizeReleaseNotes: the Atom-feed ARRAY shape — the branch production actually hits today', () => {
  const raw = [
    { version: '0.2.0', note: 'Fixed the update dialog.' },
    { version: '0.2.0', note: 'Improved boot time.' },
  ];
  const result = sanitizeReleaseNotes(raw);
  assert.match(result, /Fixed the update dialog\./);
  assert.match(result, /Improved boot time\./);
});

test('sanitizeReleaseNotes: array entries with a null .note are skipped, not crashed on', () => {
  const raw = [
    { version: '0.2.0', note: null },
    { version: '0.2.0', note: 'Only this note survives.' },
  ];
  assert.equal(sanitizeReleaseNotes(raw), 'Only this note survives.');
});

test('sanitizeReleaseNotes: HTML tags are stripped', () => {
  const result = sanitizeReleaseNotes('<p>Fixed <strong>a bug</strong> in the updater.</p>');
  assert.doesNotMatch(result, /<[^>]*>/);
  assert.match(result, /Fixed\s+a bug\s+in the updater\./);
});

test('sanitizeReleaseNotes: all 5 standard HTML entities are decoded', () => {
  // &gt; before &lt; deliberately, so the decoded text never contains a
  // "<...>" span (the second tag-strip pass, added for the entity-encoded-tag
  // fix below, would otherwise remove it as a decoded tag rather than leaving
  // it as plain text — which is correct: an entity-decoded "<input>" is
  // exactly as tag-shaped as a literal one, so it must not survive either).
  const result = sanitizeReleaseNotes('Bug &amp; fix: &gt;5 users &amp; &lt;3 admins &quot;quoted&quot; &amp; it&#39;s done');
  assert.equal(result, 'Bug & fix: >5 users & <3 admins "quoted" & it\'s done');
});

test('sanitizeReleaseNotes: whitespace (newlines, tabs, repeats) collapses to single spaces', () => {
  const result = sanitizeReleaseNotes('Line one.\n\n\tLine   two.\r\nLine three.');
  assert.equal(result, 'Line one. Line two. Line three.');
});

test('sanitizeReleaseNotes: caps at 500 characters', () => {
  const long = 'x'.repeat(1000);
  const result = sanitizeReleaseNotes(long);
  assert.equal(result.length, 500);
});

test('sanitizeReleaseNotes: entity-encoded tags do not survive as literal tags (Medium finding on f6975ce)', () => {
  // Decoding entities AFTER the first tag-strip pass can reconstruct a literal
  // tag that was entity-encoded and therefore invisible to that first pass —
  // e.g. "&lt;script&gt;" has no literal '<' at strip time, so it passed
  // through, then decoded into a real "<script>" in what is documented as
  // tag-free plain text.
  const result = sanitizeReleaseNotes('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.doesNotMatch(result, /<[^>]*>/, `output must contain no literal tags, got: ${result}`);
});

test('sanitizeReleaseNotes: array shape is normalized BEFORE HTML/entity handling', () => {
  const raw = [{ version: '0.2.0', note: '<b>Bold &amp; done</b>' }];
  const result = sanitizeReleaseNotes(raw);
  assert.equal(result, 'Bold & done');
});

// ---- main.js wiring: source-shape assertions only, per the file header -----

test('captureReleaseNotes exists and is called from both update-available and update-downloaded', () => {
  const text = readMainJs();
  assert.match(text, /function captureReleaseNotes\(/, 'captureReleaseNotes must be defined');
  const availableHandler = /autoUpdater\.on\('update-available'[\s\S]*?\}\);/.exec(text);
  assert.ok(availableHandler, 'the update-available handler must exist');
  assert.match(availableHandler[0], /captureReleaseNotes\(/,
    'update-available must capture release notes for the version it just learned about');
  const downloadedHandler = /autoUpdater\.on\('update-downloaded'[\s\S]*?\}\);/.exec(text);
  assert.ok(downloadedHandler, 'the update-downloaded handler must exist');
  assert.match(downloadedHandler[0], /captureReleaseNotes\(/,
    'update-downloaded must also capture release notes (it may fire without update-available in some flows)');
});

test('promptInstall references updateReleaseNotes and guards on the version matching', () => {
  const text = readMainJs();
  const fn = /function promptInstall\([\s\S]*?\n\}/.exec(text);
  assert.ok(fn, 'promptInstall must exist');
  assert.match(fn[0], /updateReleaseNotes\.version\s*===\s*version/,
    'notes must only be shown when updateReleaseNotes.version matches the version this dialog is about — ' +
    'otherwise stale notes from a superseded update could show up on the wrong dialog');
  assert.match(fn[0], /updateReleaseNotes\.notes/,
    'promptInstall must actually read the captured notes');
});

test('release-notes.js is required, never re-implemented inline in main.js', () => {
  const text = readMainJs();
  assert.match(text, /require\(['"]\.\/release-notes['"]\)/,
    'main.js must require electron/release-notes.js rather than duplicating the sanitizing logic');
});
