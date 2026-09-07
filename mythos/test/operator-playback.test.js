'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.resolve(__dirname, '../ui/public/js/voice');
function source(name) { return fs.readFileSync(path.join(dir, name), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, ''); }
function sinkRig(timeoutMs = 1000) {
  const handlers = {}, events = []; let speaking = false, player;
  const create = vm.runInNewContext(source('operator-playback.js') + '\ncreateOperatorPlayback', { setTimeout, clearTimeout });
  const sink = create({ timeoutMs, subscribe: (k, f) => handlers[k] = f, unsubscribe: (k) => delete handlers[k],
    onOwnership: (v) => events.push(['owned', v]), onDrain: () => events.push(['drain']), onError: (e) => events.push(['error', e]),
    playerFactory: (callbacks) => player = { enqueue() { speaking = true; callbacks.onSpeakStart(); }, endTurn() {}, isSpeaking: () => speaking,
      close() { speaking = false; }, drain() { speaking = false; callbacks.onSpeakEnd(); } } });
  return { sink, handlers, events, player: () => player };
}
test('Live turn end and actual PCM drain are both required, in either order', () => {
  for (const endFirst of [true, false]) {
    const r = sinkRig(); r.sink.begin('current'); r.handlers['live-audio-out']({ operatorReqId: 'current', data: 'pcm' });
    if (endFirst) r.handlers['live-turn-complete']({ operatorReqId: 'current' }); else r.player().drain();
    assert.equal(r.events.some((e) => e[0] === 'drain'), false);
    if (endFirst) r.player().drain(); else r.handlers['live-turn-complete']({ operatorReqId: 'current' });
    assert.equal(r.events.filter((e) => e[0] === 'drain').length, 1);
    r.sink.close();
  }
});
test('local stop drops later chunks and missing end reports error instead of successful drain', async () => {
  const r = sinkRig(10); r.sink.begin('current'); r.handlers['live-audio-out']({ operatorReqId: 'current', data: 'pcm' }); r.player().drain();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(r.events.some((e) => e[0] === 'error'), true);
  assert.equal(r.events.some((e) => e[0] === 'drain'), false);
  r.sink.begin('current'); r.sink.stop(); r.handlers['live-audio-out']({ operatorReqId: 'current', data: 'late' });
  assert.equal(r.player().isSpeaking(), false); r.sink.close();
});
test('operator batch loop forwards completed controls despite offline brain and bypasses shortcuts', () => {
  let sent; const states = [], timers = new Set();
  const code = source('voice-loop.js').replace('    setOperatorPlayback(owned)', '    processTranscript,\n    setOperatorPlayback(owned)');
  const create = vm.runInNewContext(code + '\ncreateVoiceLoop', { window: {}, navigator: {}, console,
    utterance: (args) => { sent = args; return { reqId: 'r' }; }, stopRequest() {}, sendMessage() {},
    isVisionQuery: () => true, setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn),
    clearInterval() {}, Float32Array, Date, URLSearchParams });
  let begins = 0, stops = 0;
  const loop = create({ operatorEnabled: () => true, brainOnline: () => false, onState: (s) => states.push(s),
    openPanel() { assert.fail('operator utterance must reach server'); }, closePanel() { assert.fail('shortcut bypass'); },
    onVisionQuery() { assert.fail('vision shortcut bypass'); }, onOperatorTurn: () => begins++, onOperatorStop: () => stops++ });
  loop.processTranscript('pause'); assert.equal(sent.text, 'pause'); assert.equal(begins, 1);
  sent.onDone({ say: '', routedToLive: true });
  assert.equal(states.at(-1), 'processing');
  loop.setOperatorPlayback(true); assert.equal(states.at(-1), 'speaking');
  loop.finishOperatorPlayback(); assert.equal(states.at(-1), 'idle');
  loop.processTranscript('open settings'); assert.equal(sent.text, 'open settings');
  const oldDone = sent.onDone;
  loop.stop();
  loop.processTranscript('resume');
  oldDone({ say: '', routedToLive: true });
  assert.equal(states.at(-1), 'processing', 'cancelled done cannot release newer turn ownership');
  loop.stop(); assert.ok(stops > 0);
});
test('operator mode chooses batch and playback sink never owns a microphone', () => {
  const app = fs.readFileSync(path.resolve(dir, '../app.js'), 'utf8');
  assert.match(app, /s2sEnabled: _s2sEnabled && !_operatorEnabled/);
  assert.match(app, /await voiceConfigReady/);
  const sink = source('operator-playback.js');
  assert.doesNotMatch(sink, /getUserMedia|live-audio['"]|pcm-capture|live-open/);
});

test('desktop HUD exposes accessible state and sends bound pause/cancel without claiming success', () => {
  const code = fs.readFileSync(path.resolve(dir, '../desktop-task.js'), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const elements = [], sent = []; let receive, online = true;
  function element(tag) { const e = { tag, attrs: {}, style: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; },
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    addEventListener(k, fn) { this[k] = fn; }, remove() {}, set innerHTML(_) { assert.fail('unsafe HTML'); } }; elements.push(e); return e; }
  const host = element('body');
  const mount = vm.runInNewContext(code + '\nmountDesktopTask', { document: { createElement: element } });
  const ui = mount({ host, subscribe: (_, fn) => receive = fn, unsubscribe() {}, send: (m) => sent.push(m), connected: () => online });
  receive({ ok: true, result: { taskId: 'task1', state: 'running', reason: '<img onerror=bad>' } });
  const buttons = elements.filter((e) => e.tag === 'button');
  assert.ok(elements.some((e) => e.attrs.role === 'status'));
  buttons[0].click(); assert.equal(sent[0].action, 'pause'); assert.equal(sent[0].taskId, 'task1');
  assert.ok(elements.some((e) => /awaiting confirmation/.test(e.textContent || '')));
  online = false; buttons[1].click(); assert.equal(sent.length, 1);
  receive({ ok: true, result: { taskId: 'task1', state: 'completed' } });
  assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, true);
  receive({ ok: true, result: { taskId: 'restart-task', state: 'paused', request: 'Open YouTube again', requiresResume: true } });
  assert.equal(buttons[2].disabled, false);
  assert.ok(elements.some(e => /Open YouTube again.*restart-task/.test(e.textContent || '')));
  online = true; buttons[2].click();
  assert.equal(sent.at(-1).action, 'resume'); assert.equal(sent.at(-1).taskId, 'restart-task');
  assert.ok(elements.some(e => /Resume requested; awaiting confirmation/.test(e.textContent || '')));
  assert.ok(elements.some(e => e.textContent === 'State: paused'));
  ui.close();
});

test('desktop speech receipt waits for actual audio drain and never acknowledges cancellation', async () => {
  for (const cancelled of [false, true]) {
    const audio = [], sent = [];
    class FakeAudio { constructor() { audio.push(this); } play() { return Promise.resolve(); } pause() {} }
    const create = vm.runInNewContext(source('voice-loop.js') + '\ncreateVoiceLoop', {
      window: {}, navigator: {}, Audio: FakeAudio, console, sendMessage: (m) => sent.push(m), stopRequest() {},
      setTimeout, clearTimeout, clearInterval, Float32Array, Date, URLSearchParams,
    });
    const loop = create({}), session = loop.beginTurn('request');
    loop.onExternalChunk({ index: 0, total: 1, text: 'Starting task', audioB64: 'sound' }, session);
    loop.deliverExternalReply({ say: 'Starting task', chunked: true, desktopSpeechId: 'receipt-1' }, session);
    assert.equal(sent.length, 0, 'server done is not playback evidence');
    if (cancelled) loop.stop();
    audio[0].onended();
    assert.equal(sent.filter((m) => m.type === 'desktop-speech-drained').length, cancelled ? 0 : 1);
    if (!cancelled) assert.equal(sent[0].speechId, 'receipt-1');
    loop.cleanup();
  }
});

test('operator sink ignores unidentified and prior-request events after new ownership begins', () => {
  const r = sinkRig();
  r.sink.begin('old'); r.handlers['live-audio-out']({ operatorReqId: 'old', data: 'old-pcm' });
  const oldPlayer = r.player();
  r.sink.begin(); r.sink.setRequestId('new');
  for (const operatorReqId of [undefined, 'old']) {
    r.handlers['live-audio-out']({ operatorReqId, data: 'late' });
    r.handlers['live-interrupted']({ operatorReqId });
    r.handlers['live-turn-complete']({ operatorReqId });
  }
  assert.equal(r.sink.isActive(), true); assert.equal(r.player().isSpeaking(), false);
  assert.equal(r.events.some(e => e[0] === 'error'), false);
  r.handlers['live-audio-out']({ operatorReqId: 'new', data: 'new-pcm' });
  r.handlers['live-turn-complete']({ operatorReqId: 'new' });
  oldPlayer.drain();
  assert.equal(r.events.some(e => e[0] === 'drain'), false, 'old player callback cannot finish current playback');
  r.player().drain();
  assert.equal(r.events.filter(e => e[0] === 'drain').length, 1);
  r.sink.close();
});
test('operator begin stops prior TTS locally and binds returned request identity', () => {
  const audio = [], bound = [], starts = [], stops = [];
  class FakeAudio { constructor() { audio.push(this); } play() { return Promise.resolve(); } pause() { this.paused = true; } }
  const create = vm.runInNewContext(source('voice-loop.js') + '\ncreateVoiceLoop', {
    window: {}, navigator: {}, Audio: FakeAudio, console, sendMessage() {}, stopRequest: id => stops.push(id),
    setTimeout, clearTimeout, clearInterval, Float32Array, Date, URLSearchParams,
  });
  const loop = create({ operatorEnabled: () => true, onOperatorTurn: id => starts.push(id), onOperatorRequestId: id => bound.push(id) });
  const session = loop.beginTurn('old');
  loop.onExternalChunk({ index: 0, total: 1, text: 'old', audioB64: 'sound' }, session);
  loop.beginTurn(); loop.setActiveReqId('new');
  assert.equal(audio[0].paused, true); assert.equal(starts[0], 'old'); assert.equal(bound.at(-1), 'new');
  assert.equal(stops.length, 0, 'local replacement must not send a duplicate task stop');
  loop.cleanup();
});
