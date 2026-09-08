'use strict';
// desktop-intent-trailing-qualifier.test.js — 2026-09-08.
//
// Symptom: in the installed v0.1.11 HUD, "open YouTube on Brave browser" answered
// "This desktop workflow is not supported by the current YouTube qualification stage."
// Mechanism: every Stage 1 pattern in src/core/desktop/intent.js is anchored `...[.!]?$`,
// so naming the browser (or adding "please") rejected the one workflow Stage 1 exists
// for; classify() in server/desktop-connection.js then saw the verb "open" and filed the
// request as unsupported, and the HUD's control buttons, with no task to act on, said
// "Not connected" while the socket was open. Measured 2026-09-08 on the installed code
// (module hashes equal to the working tree): 20 phrasings x 2 contexts, 9 wrong cells.
//
// Mutation probes, 2026-09-08 (each applied, seen to fail the named test, restored):
//   (a) intent.js: QUALIFIER -> '' (drop the trailing-qualifier fragment) ->
//       "every Stage 1 phrase keeps its kind under a trailing browser or please qualifier" fails.
//   (b) desktop-connection.js: restore the old "not supported by the current YouTube
//       qualification stage" string -> "the refusal names what Stage 1 accepts" fails.
//   (c) desktop-task.js: collapse the two button messages back into "Not connected." ->
//       "HUD control buttons tell no-task apart from no-socket" fails.
// Adjacent cases that must keep their verdicts are in the "still rejected" test below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parseRequest } = require('../src/core/desktop/intent');
const { classify, createDesktopConnection } = require('../server/desktop-connection');

// [bare phrase, needs a task in context]. Every Stage 1 verb, one bare form each.
const STAGE1 = [
  ['open youtube', false],
  ['search youtube for lofi and play the third', false],
  ['play the third video on youtube', false],
  ['pause', true],
  ['resume', true],
  ['next', true],
  ['skip', true],
];
const QUALIFIERS = [' on Brave', ' on Brave browser', ' in the Brave browser', ' using Chrome', ' in Edge', ' please', ' on brave please', ' on Brave.'];

test('every Stage 1 phrase keeps its kind under a trailing browser or please qualifier', () => {
  for (const [phrase, ctx] of STAGE1) {
    const bare = parseRequest(phrase, ctx);
    assert.ok(bare, 'bare form must parse: ' + phrase);
    for (const q of QUALIFIERS) {
      const r = parseRequest(phrase + q, ctx);
      assert.ok(r, 'rejected: ' + JSON.stringify(phrase + q));
      assert.equal(r.kind, bare.kind, phrase + q);
    }
  }
  assert.deepEqual(parseRequest('Open YouTube on Brave browser'), { kind: 'open-youtube' });
});

test('still rejected: a qualifier is a browser name or please, never a second task or an unknown browser', () => {
  for (const [phrase, ctx] of [
    ['open youtube on', false], ['open youtube on the', false], ['open youtube on firefox', false],
    ['open youtube and email it', false], ['open youtube on brave and delete files', false],
    ['open gmail on brave', false], ['pause on brave', false], // no task in context: pause has nothing to act on
  ]) assert.equal(parseRequest(phrase, ctx), null, phrase);
});

test('classify promotes a browser-qualified Stage 1 request and pins the two deliberate non-changes', () => {
  assert.deepEqual(classify('open YouTube on Brave browser', false), { request: 'open YouTube on Brave browser' });
  assert.deepEqual(classify('Could you open YouTube on Brave, please?', false), { request: 'open YouTube on Brave, please' });
  assert.deepEqual(classify('open youtube and email it', false), { unsupported: true });
  // Deliberate, 2026-09-08: a bare "next" with no task falls through to the brain (it is
  // an ordinary conversational word), while "skip" with no task is refused as a desktop
  // verb. Pinned so the asymmetry is a decision on record, not drift.
  assert.equal(classify('next', false), null);
  assert.deepEqual(classify('skip', false), { unsupported: true });
});

test('the refusal names what Stage 1 accepts instead of a stage nobody can act on', async () => {
  const sent = [];
  let conn;
  conn = createDesktopConnection({
    connectionId: 'c1',
    runtime: { bind() {}, watch() { return () => {}; }, async unbind() {}, controller: { status: () => ({ ok: false }) } },
    leash: { check: () => ({ allow: true }) },
    dispatch: async () => ({ ok: false }),
    reply: async (_id, _text, opts) => { conn.handle({ type: 'desktop-speech-drained', speechId: opts.desktopSpeechId }); },
    speak: async () => {}, send: (m) => sent.push(m), historyAppend() {}, cancelSpeech() {},
  });
  assert.equal(conn.handle({ type: 'utterance', reqId: 'r1', text: 'open youtube and email it' }), true);
  await new Promise((r) => setImmediate(r));
  const refusal = sent.find((m) => m.type === 'desktop-task');
  assert.ok(refusal && refusal.ok === false, 'a desktop-task refusal frame is sent');
  assert.match(refusal.result, /open YouTube/i);
  assert.match(refusal.result, /pause/i);
  assert.match(refusal.result, /next/i);
  assert.doesNotMatch(refusal.result, /qualification stage/);
  await conn.close();
});

test('HUD control buttons tell no-task apart from no-socket', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../ui/public/js/desktop-task.js'), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const elements = []; let online = true;
  function element(tag) { const e = { tag, attrs: {}, style: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, addEventListener(k, fn) { this[k] = fn; }, remove() {} }; elements.push(e); return e; }
  const mount = vm.runInNewContext(code + '\nmountDesktopTask', { document: { createElement: element } });
  const ui = mount({ host: element('body'), subscribe() {}, unsubscribe() {}, send: () => assert.fail('nothing to send without a task'), connected: () => online });
  const [pause, cancel] = elements.filter((e) => e.tag === 'button');
  pause.click();
  assert.ok(elements.some((e) => /No desktop task/.test(e.textContent || '')), 'no task, socket open');
  assert.equal(elements.some((e) => /Not connected/.test(e.textContent || '')), false);
  online = false; cancel.click();
  assert.ok(elements.some((e) => /not connected to MYTHOS/.test(e.textContent || '')), 'socket closed');
  ui.close();
});
