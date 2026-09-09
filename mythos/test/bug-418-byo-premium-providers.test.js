'use strict';

// bug-418-byo-premium-providers.test.js — BUG-418.
//
// THE GAP. Free tiers are how MYTHOS is DEVELOPED; the shipped product is
// bring-your-own-key with any provider. mythos/providers/ held google, mistral,
// groq, nim, cerebras, ollama, zcode and openrouter — no native Anthropic, no
// native OpenAI — so a buyer holding either key had to open an OpenRouter
// account and pay its margin to use a key they already owned.
//
// THE COST IS ASYMMETRIC, and that is the whole shape of the fix. OpenAI speaks
// exactly the protocol openai-compat.js was generalised from, so it is a
// configuration entry. Anthropic's Messages API differs in five ways that each
// break that factory, so it needs a provider of its own — and those five
// differences are what most of this file tests, because each one fails QUIETLY:
// reading choices[0].delta.content off an Anthropic stream finds nothing and
// returns an empty string as a SUCCESS.
//
// TESTED AGAINST A REAL HTTP SERVER, not a fetch stub. A stub would be written
// from the provider's own code and would agree with any bug it contains
// (/kee: a test that pins the implementation is not a test). A loopback server
// asserts the bytes actually put on the wire — which is where the auth header,
// the version header and the system-message split all live.
//
// MUTATION PROBES, run 2026-09-09 against providers/anthropic.js and the lane
// table, all landed, all fired, no survivors; sources restored by byte copy with
// matching hashes:
//   (m1) send Authorization: Bearer instead of x-api-key
//        -> fails (a) "the wire carries Anthropic's auth, not OpenAI's"
//   (m2) drop the anthropic-version header
//        -> fails (a)
//   (m3) leave system messages in the array instead of hoisting them
//        -> fails (b) "system is a top-level field"
//   (m4) read choices[0].delta.content, the OpenAI shape
//        -> fails (c) "text comes from content_block_delta"
//   (m5) accept any event with a delta
//        -> fails (d) "message_delta metadata never reaches the answer"
//   (m6) remove BYO_PREMIUM from the build lane
//        -> fails (f) "a supplied key is actually reachable"

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const anthropic = require('../providers/anthropic');
const openaiProvider = require('../providers/openai');
const { BRAIN_TABLES } = require('../src/core/brain/lanes.default');

// ---------------------------------------------------------------------------
// A loopback Anthropic. Records exactly what arrived and replays a real
// Messages-API stream, event names and all.
// ---------------------------------------------------------------------------
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
  '',
  // Deliberately present: message_delta carries a `delta` too. A provider that
  // matches loosely on "has a delta" emits stop-reason metadata into the answer.
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

let server, baseURL;
const received = [];
let respond = null;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      received.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
      if (respond) return respond(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port + '/v1';
});

after(() => new Promise((resolve) => server.close(resolve)));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return (async () => fn())().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

describe('BUG-418 (a,b) — the five ways Anthropic is not OpenAI, on the wire', () => {
  test('(a) the request carries x-api-key and a version header, not a bearer token', async () => {
    received.length = 0; respond = null;
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: baseURL }, async () => {
      await anthropic.chat([{ role: 'user', content: 'hi' }]);
    });
    const req = received[0];
    assert.equal(req.url, '/v1/messages', 'the endpoint is /messages, not /chat/completions');
    // (m1)
    assert.equal(req.headers['x-api-key'], 'sk-ant-test');
    assert.equal(req.headers.authorization, undefined,
      'a bearer token is silently ignored by this API — the call would 401 with no clue why');
    // (m2)
    assert.equal(req.headers['anthropic-version'], anthropic.API_VERSION,
      'the version header is REQUIRED; without it the request is refused outright');
  });

  test('max_tokens is always sent, because the API requires it', async () => {
    received.length = 0; respond = null;
    await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL }, async () => {
      await anthropic.chat([{ role: 'user', content: 'hi' }]);
    });
    assert.equal(received[0].body.max_tokens, anthropic.DEFAULT_MAX_TOKENS);
    received.length = 0;
    await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_MAX_TOKENS: '77' }, async () => {
      await anthropic.chat([{ role: 'user', content: 'hi' }]);
    });
    assert.equal(received[0].body.max_tokens, 77, 'and a buyer can raise it without touching code');
  });

  test('(b) system is hoisted to a top-level field, not left in the array', async () => {
    // (m3). A message with role 'system' is rejected as an invalid role, so
    // leaving it in place turns every prompted call into a 400.
    received.length = 0; respond = null;
    await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL }, async () => {
      await anthropic.chat([
        { role: 'system', content: 'You are MYTHOS.' },
        { role: 'user', content: 'hi' },
      ]);
    });
    const body = received[0].body;
    assert.equal(body.system, 'You are MYTHOS.');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.messages.some((m) => m.role === 'system'), false);
  });

  test('several system messages are joined, never silently dropped', () => {
    // MYTHOS composes its Live prompt from sections, so "the last one wins" would
    // discard most of the persona without any error.
    const split = anthropic.splitMessages([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'B' },
    ]);
    assert.equal(split.system, 'A\n\nB');
    assert.deepEqual(split.messages, [{ role: 'user', content: 'q' }]);
  });

  test('an unknown role is normalised rather than sent and refused', () => {
    const split = anthropic.splitMessages([
      { role: 'tool', content: 'result' },
      { role: 'assistant', content: 'ok' },
      null,
      'not an object',
    ]);
    assert.deepEqual(split.messages, [
      { role: 'user', content: 'result' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});

describe('BUG-418 (c,d) — the stream is named events, and only one carries text', () => {
  test('(c) text is assembled from content_block_delta', async () => {
    // (m4). Reading choices[0].delta.content finds nothing here and returns ''
    // as a SUCCESS — a quiet empty answer, not an error.
    received.length = 0; respond = null;
    const tokens = [];
    const out = await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL }, async () =>
      anthropic.chat([{ role: 'user', content: 'hi' }], { onToken: (t) => tokens.push(t) }));
    assert.equal(out, 'Hello there');
    assert.deepEqual(tokens, ['Hello', ' there'], 'streaming reaches the caller token by token');
  });

  test('(d) message_delta metadata never reaches the answer', () => {
    // (m5). message_delta and content_block_start both have a delta/content
    // block; matching on "has a delta" would splice stop_reason into the text.
    assert.equal(anthropic.textFromEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), null);
    assert.equal(anthropic.textFromEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } }), null);
    assert.equal(anthropic.textFromEvent({ type: 'message_stop' }), null);
    assert.equal(anthropic.textFromEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }), 'x');
    // A non-text block (tool use) must not be read as prose either.
    assert.equal(anthropic.textFromEvent({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), null);
    assert.equal(anthropic.textFromEvent(null), null);
  });

  test('an HTTP failure carries a typed status, so the chain and the health record can read it', async () => {
    received.length = 0;
    respond = (res) => { res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'credit balance is too low' } })); };
    await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL }, async () => {
      await assert.rejects(
        anthropic.chat([{ role: 'user', content: 'hi' }]),
        (err) => {
          assert.equal(err.status, 402, 'BUG-336 typed identity; BUG-419 reads this to drop the account');
          assert.match(err.message, /credit balance is too low/, 'the provider reason survives, not a generic one');
          return true;
        });
    });
    respond = null;
  });

  test('an error arriving MID-STREAM after a 200 is surfaced, not returned as a short answer', async () => {
    received.length = 0;
    respond = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"par"}}',
        'data: {"type":"error","error":{"message":"overloaded"}}',
        '',
      ].join('\n'));
    };
    await withEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL }, async () => {
      await assert.rejects(anthropic.chat([{ role: 'user', content: 'hi' }]), /overloaded/);
    });
    respond = null;
  });
});

describe('BUG-418 (e,f) — absent keys degrade honestly, and a supplied key is reachable', () => {
  test('(e) no key means unavailable and a named error, never a boot failure', async () => {
    await withEnv({ ANTHROPIC_API_KEY: '' }, async () => {
      assert.equal(anthropic.isAvailable(), false);
      assert.equal(anthropic.getStatus().ok, false);
      await assert.rejects(anthropic.chat([{ role: 'user', content: 'x' }]),
        /ANTHROPIC_API_KEY missing — add it to mythos\/\.env/,
        'the repo rule: no key, no hardcoded default, and the remedy names the file');
    });
    await withEnv({ OPENAI_API_KEY: '' }, async () => {
      assert.equal(openaiProvider.isAvailable(), false);
      await assert.rejects(openaiProvider.chat([{ role: 'user', content: 'x' }]),
        /OPENAI_API_KEY missing/);
    });
  });

  test('both expose the same surface chain.js calls on every lane', () => {
    for (const p of [anthropic, openaiProvider]) {
      for (const fn of ['chat', 'isAvailable', 'getStatus', 'getModel']) {
        assert.equal(typeof p[fn], 'function', p.name + ' must implement ' + fn);
      }
      assert.equal(typeof p.name, 'string');
    }
    assert.equal(anthropic.name, 'anthropic');
    assert.equal(openaiProvider.name, 'openai');
  });

  test('(f) a supplied key is actually reachable — both head the text-shaped lanes', () => {
    // (m6). A provider nothing references is a provider a buyer cannot use, so
    // the gap would still be open with both files written and wired.
    const shaped = ['voice', 'reasoning', 'memory', 'build', 'simple', 'text'];
    for (const lane of shaped) {
      const prefs = BRAIN_TABLES[lane].prefs;
      assert.equal(prefs[0].provider, 'anthropic', lane + ' must lead with the BYO entries');
      assert.equal(prefs[1].provider, 'openai', lane + ' must offer both');
    }
    // Deliberately NOT vision or embed: the vision lane passes provider-specific
    // image payloads and embed is a different API. Adding either would be a claim
    // this work cannot support, so the absence is pinned as a decision.
    for (const lane of ['vision', 'embed']) {
      const providers = BRAIN_TABLES[lane].prefs.map((p) => p.provider);
      assert.equal(providers.includes('anthropic'), false, lane + ' is deliberately untouched');
      assert.equal(providers.includes('openai'), false, lane + ' is deliberately untouched');
    }
  });

  test('every lane entry names a provider chain.js can actually dispatch to', () => {
    // Gate D. A lane naming a provider LANES has no entry for fails at call time
    // with a TypeError, not a skip — derive the check from the real map rather
    // than trusting that the wiring was remembered.
    // NO EARLY RETURN. The first draft had `if (!lanes) return;` as a courtesy
    // for a future export change — which would have turned this into a check
    // that passes by not running, on the one assertion that catches a provider
    // wired into a lane table but not into chain.js. That is the false-green
    // class; if the export moves, this must go red and be repointed.
    const lanes = require('../src/core/brain/chain')._internal.LANES;
    assert.ok(lanes && typeof lanes === 'object',
      'chain.js must export LANES for this guard to mean anything');
    assert.ok(lanes.anthropic && lanes.openai,
      'both BUG-418 providers must be dispatchable, or a supplied key throws at call time');
    for (const key of Object.keys(BRAIN_TABLES)) {
      for (const pref of BRAIN_TABLES[key].prefs) {
        assert.ok(lanes[pref.provider], key + ' names provider "' + pref.provider + '", which chain.js cannot dispatch');
      }
    }
  });

  test('both keys are documented in .env.example, or nobody knows they exist', () => {
    // The repo rule: every supported key documented there. An undocumented key is
    // a feature only its author can use.
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_MAX_TOKENS',
      'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']) {
      assert.match(env, new RegExp('^# ?' + key + '=', 'm'), key + ' must be documented');
    }
  });
});
