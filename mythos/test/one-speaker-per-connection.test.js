'use strict';

// F2 (2026-08-15) — one connection, one voice.
//
// Three functions in server/index.js can put speech on a connection. Two of
// them (proactiveSpeak, handleVisionQuery) have routed to the open Live session
// since BUG-060. sendSpokenReply never did — BUGS.md has carried it as "Known
// remaining gap, NOT fixed in this pass" (BUG-083) since 2026-07-31, and NO TEST
// COVERED IT, which is why three weeks passed.
//
// What that cost on 2026-08-14: at 21:45:59 all three TTS providers failed
// within 4ms, every chunk shipped audioB64:null, and voice-loop.js spoke them
// through window.speechSynthesis while Gemini Live's PCM playback was already
// the entity's voice on the same connection. Two audio engines at once —
// necessarily different voices, since one is Gemini PCM and the other is the OS.
//
// This is deliberately a SOURCE-SHAPE test over the whole class, not a unit test
// of one function. sendSpokenReply is a closure inside the connection handler
// with no injectable seam, and the defect being pinned is structural: a speech
// emitter that reaches its synthesis loop with Live open. Testing one function
// would re-pin the instance and leave the class open — which is exactly how this
// bug survived (rules/core.md §11.6). If a fourth speech path is ever added,
// this fails until it carries the guard too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');

// Every function that can put audio on a connection. Adding a speech path means
// adding it here — the last test in this file catches the ones you forget.
// The `...Now` suffixes are the unlocked bodies; the same-named wrappers own the
// F2b per-connection speech lock and do no speaking of their own.
const SPEECH_FUNCTIONS = ['proactiveSpeakNow', 'sendSpokenReplyNow', 'handleVisionQuery'];

// Brace-matched extraction from the declaration's opening `{`. Indentation-based
// slicing was tried first and is wrong here — these three functions sit at three
// different nesting depths.
function blockFrom(text, at) {
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces from offset ' + at);
}

function declOffset(name) {
  const at = src.search(new RegExp('(?:async )?function ' + name + '\\s*\\('));
  assert.notStrictEqual(at, -1, name + ' must exist in server/index.js');
  return at;
}

function bodyOf(name) { return blockFrom(src, declOffset(name)); }

// The guard: an isOpen() check whose branch sends to Live and RETURNS. Matching
// on the return rather than on the isOpen() call alone is the whole point — the
// pre-fix sendSpokenReply DID call `liveSession.isOpen()`, but only as one term
// of the Aether short-circuit's condition, and then fell through to synthesis.
// A test that only looked for the call would have passed against the bug.
// handleVisionQuery hoists the same test into a `liveOpen` boolean, so both
// spellings are accepted. What is NOT accepted is the negated form
// `if (!(liveSession && liveSession.isOpen()) && ...)` — that is the Aether
// short-circuit, and mistaking it for the guard is precisely the reading error
// that left sendSpokenReply unprotected for three weeks.
function hasLiveEarlyReturn(body) {
  const re = /if \(([^{]*?)\)\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const cond = m[1];
    // The Aether short-circuit negates the WHOLE isOpen test — that is the
    // not-a-guard. A condition that merely carries other terms (sendSpokenReply
    // also excludes node connections) is still a guard.
    if (/!\(\s*liveSession && liveSession\.isOpen\(\)\s*\)/.test(cond)) continue;
    if (!/\bliveOpen\b/.test(cond) && !/liveSession && liveSession\.isOpen\(\)/.test(cond)) continue;
    const branch = blockFrom(body, m.index);
    if (/\breturn\b/.test(branch) && /sendText\(/.test(branch)) return true;
  }
  return false;
}

describe('F2 — one speaker per connection', () => {
  for (const name of SPEECH_FUNCTIONS) {
    test(name + ' returns early into the Live session when one is open', () => {
      const body = bodyOf(name);
      assert.ok(hasLiveEarlyReturn(body),
        name + ' must route to liveSession.sendText() and RETURN when Live is open. '
        + 'Without the return it falls through to local synthesis and a second '
        + 'audio engine plays over Gemini\'s PCM.');
    });
  }

  test('sendSpokenReply reaches no speech-chunk emission with Live open', () => {
    const body = bodyOf('sendSpokenReplyNow');
    const guardAt = body.search(/if \(!ws\._mythosNodeId && liveSession && liveSession\.isOpen\(\)\)/);
    const chunkAt = body.indexOf('sendSpeechChunk(');
    assert.notStrictEqual(guardAt, -1, 'the Live guard must exist');
    assert.notStrictEqual(chunkAt, -1, 'sendSpokenReply must still be the function that emits chunks');
    assert.ok(guardAt < chunkAt,
      'the Live guard must come BEFORE the synthesis loop. This is the exact ordering '
      + 'defect: the pre-fix code checked isOpen() only inside the Aether condition, '
      + 'which sits above the loop but never returns.');
  });

  test('the injection is framed as a system notice, not as operator speech', () => {
    // BUG-117: everything injected via sendText() is attributed to the USER by
    // the Gemini Live wire protocol. An unprefixed reply would make MYTHOS
    // believe the operator said its own answer back to it.
    const body = bodyOf('sendSpokenReplyNow');
    const branch = body.slice(body.search(/if \(!ws\._mythosNodeId && liveSession && liveSession\.isOpen\(\)\)/));
    assert.match(branch.slice(0, 600), /SYSTEM_NOTICE_PREFIX/,
      'the routed text must carry SYSTEM_NOTICE_PREFIX');
  });

  test('no speech path was added without the guard', () => {
    // The class-level check. Every call site of sendSpeechChunk() must sit
    // inside one of the guarded functions above. `sendSpeechChunk` itself is
    // the transport, not a speech path, so its own declaration is excluded.
    const guardedRanges = SPEECH_FUNCTIONS.map((n) => {
      const at = declOffset(n);
      return { name: n, at, end: at + bodyOf(n).length };
    });
    const orphans = [];
    const re = /sendSpeechChunk\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (src.slice(0, m.index).endsWith('function ')) continue;   // the declaration
      const owner = guardedRanges.find((r) => m.index > r.at && m.index < r.end);
      if (!owner) orphans.push('offset ' + m.index);
    }
    assert.deepStrictEqual(orphans, [],
      'speech chunks are emitted outside every Live-guarded function, at: ' + orphans.join(', ')
      + ' — add that function to SPEECH_FUNCTIONS and give it the guard.');
  });

  test('the reply guard does not steal a NODE-origin turn', () => {
    // Caught by aether-node-routing.test.js against the first cut of this guard,
    // and pinned here so the reason travels with the guard. A phone node can have
    // its own Live session open; a node-origin utterance is nonetheless answered
    // by the batch pipeline on purpose, and routing its reply into Live would
    // answer on the desktop a question asked at the phone.
    const body = bodyOf('sendSpokenReplyNow');
    const guard = body.slice(body.search(/if \(!ws\._mythosNodeId/));
    assert.ok(guard.startsWith('if (!ws._mythosNodeId && liveSession'),
      'the node exclusion must be part of the guard condition itself, not a later check');
  });

  test('both speech entry points go through the per-connection lock', () => {
    for (const wrapper of ['proactiveSpeak', 'sendSpokenReply']) {
      const at = src.search(new RegExp('(?:async )?function ' + wrapper + '\\s*\\('));
      const body = blockFrom(src, at);
      assert.match(body, /serializeSpeech\(/,
        wrapper + ' must acquire the speech lock — a guard on one function is an '
        + 'instance, not the class: a reminder can still fire mid-reply.');
      assert.ok(!body.includes('sendSpeechChunk('),
        wrapper + ' is the lock wrapper and must not speak directly');
    }
  });
});

// The lock's own semantics, tested for real rather than by source shape. The
// implementation is a closure inside createServer, so this reimplements the same
// contract and asserts the three properties that matter — which is honest about
// what it covers: it pins the DESIGN, and the test above pins that production
// actually calls it.
describe('F2b — the speech lock queues, never discards, and cannot wedge', () => {
  const CEILING = 60;
  function makeSerializer(onCeiling) {
    const chains = new WeakMap();
    const GLOBAL = Object.freeze({});
    return function serializeSpeech(target, fn) {
      const key = (target && typeof target === 'object') ? target : GLOBAL;
      const prev = chains.get(key) || Promise.resolve();
      let timer = null;
      const bounded = Promise.race([
        prev,
        new Promise((res) => { timer = setTimeout(() => { onCeiling(); res(); }, CEILING); }),
      ]).then(() => { if (timer) clearTimeout(timer); });
      const next = bounded.then(fn);
      chains.set(key, next.then(() => {}, () => {}));
      return next;
    };
  }

  test('two utterances on one connection never overlap', async () => {
    const serialize = makeSerializer(() => {});
    const ws = {};
    const log = [];
    const speak = (name, ms) => serialize(ws, async () => {
      log.push(name + ':start');
      await new Promise((r) => setTimeout(r, ms));
      log.push(name + ':end');
    });
    await Promise.all([speak('reply', 20), speak('reminder', 5)]);
    assert.deepStrictEqual(log, ['reply:start', 'reply:end', 'reminder:start', 'reminder:end']);
  });

  test('the second utterance is queued, not dropped', async () => {
    const serialize = makeSerializer(() => {});
    const ws = {};
    let spoken = 0;
    await Promise.all([
      serialize(ws, async () => { spoken++; }),
      serialize(ws, async () => { spoken++; }),
      serialize(ws, async () => { spoken++; }),
    ]);
    assert.strictEqual(spoken, 3, 'the risk of this change is a lost announcement; it must queue');
  });

  test('a failed utterance does not wedge the queue', async () => {
    const serialize = makeSerializer(() => {});
    const ws = {};
    const boom = serialize(ws, async () => { throw new Error('tts exploded'); });
    await assert.rejects(boom, /tts exploded/, 'the caller must still see the real failure');
    let after = false;
    await serialize(ws, async () => { after = true; });
    assert.ok(after, 'the next utterance must still be spoken');
  });

  test('a hung utterance releases the lock at the ceiling instead of muting the session', async () => {
    let ceilingHit = 0;
    const serialize = makeSerializer(() => { ceilingHit++; });
    const ws = {};
    serialize(ws, () => new Promise(() => {}));   // never resolves — a hung provider
    let after = false;
    await serialize(ws, async () => { after = true; });
    assert.ok(after, 'a mute assistant is the worse failure — the lock must fail open');
    assert.strictEqual(ceilingHit, 1, 'and must say so when it does');
  });

  test('separate connections do not block each other', async () => {
    const serialize = makeSerializer(() => {});
    const a = {}; const b = {};
    const order = [];
    await Promise.all([
      serialize(a, async () => { await new Promise((r) => setTimeout(r, 25)); order.push('a'); }),
      serialize(b, async () => { order.push('b'); }),
    ]);
    assert.deepStrictEqual(order, ['b', 'a'], 'the lock is per connection, not global');
  });
});
