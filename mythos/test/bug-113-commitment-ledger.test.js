'use strict';

// BUG-113 — spoken commitments are dropped. MYTHOS says "I'll check on that"
// / "let me look into the ad thing", the turn ends, and nothing records that
// a commitment was made — goals, reminders and the build pipeline all exist
// but none of them fire on the ASSISTANT's own spoken text.
//
// This test covers the three self-contained primitives built in
// from-calendar.js (chosen over goals/index.js — see the file header there
// for why): detectCommitment(text), logCommitmentIfPresent(text, {goals}),
// listOpenCommitments(goals).
//
// Call-site wiring (server/index.js + live-tool-adapter.js turn-completion,
// from-dashboard.js read_status) is INTENTIONALLY NOT part of this file —
// that's the orchestrator's job once these exports are known.

var test = require('node:test');
var assert = require('node:assert');

var calendarMod = require('../src/core/effectors/from-calendar');
var detectCommitment = calendarMod.detectCommitment;
var logCommitmentIfPresent = calendarMod.logCommitmentIfPresent;
var listOpenCommitments = calendarMod.listOpenCommitments;

// Minimal fake goal system mirroring the real contract in
// src/core/goals/index.js: create(opts) returns a goal object built from a
// FIXED set of fields (title/status/drive/reason/...) — arbitrary opts keys
// are NOT preserved — and list(filter) filters by status/drive.
function makeFakeGoals(seed) {
  var store = [];
  (seed || []).forEach(function(g, i) {
    store.push(Object.assign({ id: 'seed-' + i, drive: 'user-service', priority: 0.5 }, g));
  });
  return {
    create: function(opts) {
      opts = opts || {};
      var goal = {
        id: 'goal-' + store.length,
        title: opts.title || 'Untitled goal',
        status: opts.status || 'proposed',
        drive: opts.drive || 'user-service',
        reason: opts.reason || '',
        createdAt: Date.now()
      };
      store.push(goal);
      return goal;
    },
    list: function(filter) {
      filter = filter || {};
      return store.filter(function(g) {
        if (filter.status && g.status !== filter.status) return false;
        if (filter.drive && g.drive !== filter.drive) return false;
        return true;
      });
    },
    _store: store
  };
}

// ---- detectCommitment: MUST match ----

test('detectCommitment matches "I\'ll check X and get back to you"', function() {
  var m = detectCommitment("I'll check the ad thing and get back to you");
  assert.ok(m, 'expected a match');
  assert.match(m, /check the ad thing/i);
});

test('detectCommitment matches "I will look into that"', function() {
  var m = detectCommitment('I will look into that');
  assert.ok(m, 'expected a match');
  assert.match(m, /look into that/i);
});

test('detectCommitment matches "Let me get those numbers for you"', function() {
  var m = detectCommitment('Let me get those numbers for you');
  assert.ok(m, 'expected a match');
  assert.match(m, /get those numbers/i);
});

test('detectCommitment matches "I\'ll follow up on that tomorrow"', function() {
  var m = detectCommitment("I'll follow up on that tomorrow");
  assert.ok(m, 'expected a match');
});

test('detectCommitment matches "I\'ll take care of it"', function() {
  var m = detectCommitment("I'll take care of it");
  assert.ok(m, 'expected a match');
});

// ---- detectCommitment: MUST NOT match ----

test('detectCommitment does NOT match "I can check that if you like" (offer, not commitment)', function() {
  var m = detectCommitment('I can check that if you like');
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match "that would need a tool I don\'t have" (explicit limitation)', function() {
  var m = detectCommitment("that would need a tool I don't have");
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match "I checked that already" (past tense, not a new open commitment)', function() {
  var m = detectCommitment('I checked that already');
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match "I could look into it" (mere offer, not stated intent)', function() {
  var m = detectCommitment('I could look into it');
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match "I\'ll check that if you want" (conditional, not a firm commitment)', function() {
  var m = detectCommitment("I'll check that if you want");
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match "I don\'t think I\'ll check that today" (hedged/negated)', function() {
  var m = detectCommitment("I don't think I'll check that today");
  assert.strictEqual(m, null);
});

test('detectCommitment does NOT match plain unrelated text', function() {
  assert.strictEqual(detectCommitment('The weather today is sunny.'), null);
  assert.strictEqual(detectCommitment(''), null);
  assert.strictEqual(detectCommitment(null), null);
});

// ---- logCommitmentIfPresent ----

test('logCommitmentIfPresent logs a status:proposed goal when a commitment is detected', function() {
  var goals = makeFakeGoals();
  var result = logCommitmentIfPresent("I'll check the ad thing and get back to you", { goals: goals });
  assert.ok(result, 'expected a logged goal record');
  assert.strictEqual(result.status, 'proposed');
  assert.match(result.title, /^Commitment: /);
  assert.match(result.title, /check the ad thing/i);
  assert.strictEqual(goals._store.length, 1);
});

test('logCommitmentIfPresent does NOT log anything when no commitment is present', function() {
  var goals = makeFakeGoals();
  var result = logCommitmentIfPresent('I can check that if you like', { goals: goals });
  assert.strictEqual(result, null);
  assert.strictEqual(goals._store.length, 0);
});

test('logCommitmentIfPresent degrades honestly (no throw) when goals system is missing', function() {
  assert.doesNotThrow(function() {
    var result = logCommitmentIfPresent("I'll check that", {});
    assert.strictEqual(result, null);
  });
});

// ---- listOpenCommitments ----

test('listOpenCommitments returns exactly the logged commitment entries and nothing else', function() {
  var goals = makeFakeGoals([
    // A non-commitment proposed goal — same inert-anchor shape as the
    // existing T3 reminder-action anchor in this file (must NOT be
    // confused with a commitment record).
    { title: 'Reminder action: whatsapp_send', status: 'proposed' },
    // An active (non-proposed) goal — must never surface here regardless
    // of title.
    { title: 'Commitment: something old', status: 'active' },
    // Another unrelated proposed goal.
    { title: 'Untitled goal', status: 'proposed' }
  ]);

  logCommitmentIfPresent("I'll check the ad thing and get back to you", { goals: goals });
  logCommitmentIfPresent('I will look into that', { goals: goals });
  // A non-match must not add a 4th commitment entry.
  logCommitmentIfPresent('I can check that if you like', { goals: goals });

  var open = listOpenCommitments(goals);
  assert.strictEqual(open.length, 2);
  open.forEach(function(g) {
    assert.strictEqual(g.status, 'proposed');
    assert.match(g.title, /^Commitment: /);
  });
  assert.ok(open.some(function(g) { return /check the ad thing/i.test(g.title); }));
  assert.ok(open.some(function(g) { return /look into that/i.test(g.title); }));
});

test('listOpenCommitments returns [] when goals system is missing', function() {
  assert.deepStrictEqual(listOpenCommitments(null), []);
  assert.deepStrictEqual(listOpenCommitments(undefined), []);
});
