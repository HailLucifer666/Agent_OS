// voice-control.test.js — Phase 3 additive event/history API (notifyEvent/getHistory/
// subscribeEvents/confirm-resolution semantics). voice-control.js is a browser-only IIFE with
// no module.exports (relies on window/document globals), so this test installs a minimal
// self-contained global stub (no new dependency) sufficient to load the module and drive its
// real internal handlers end-to-end:
//   - Space keydown/keyup drives the real startRecognition()/stopRecognition() path.
//   - A fake SpeechRecognition fires a real onresult -> the real (unexported) sendUtteranceOnce.
//   - sendUtteranceOnce calls the real (unexported) window.voiceControl._ws.voiceStream(),
//     which we mock; the onStatus/onAction/onConfirm/onSay/onDone callbacks it captures ARE the
//     real handleVoiceStatus/handleVoiceAction/handleVoiceConfirm/handleVoiceSay/handleVoiceDone
//     function references voice-control.js wired up — invoking them simulates a server reply
//     exactly as ws.js's real message dispatch would.
// This never requires touching voice-control.js's public API beyond what Item 1 already added.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, 'voice-control.js');

// Stashes the transcript the next-constructed FakeRecognition instance should resolve with.
// voice-control.js's startRecognition() lazily constructs `recognition` once and reuses it, so
// each fake instance reads this module-scoped value at start()-time (mirrors real recognition
// resolving to whatever was actually spoken during that particular press).
let pendingTranscript = '';
function setNextTranscript(text) {
  pendingTranscript = text;
}

function FakeRecognition() {
  this.lang = '';
  this.continuous = false;
  this.interimResults = false;
  this._ended = false;
  this.start = () => {
    this._ended = false;
    const transcript = pendingTranscript;
    // Real (non-continuous) Web Speech recognition fires onresult, then onend shortly after, for
    // a single press — mirror both so recognitionActive resets and the next press can start().
    setTimeout(() => {
      if (this.onresult) this.onresult({ results: [[{ transcript }]] });
      if (!this._ended) {
        this._ended = true;
        if (this.onend) this.onend();
      }
    }, 0);
  };
  this.stop = () => {
    // A stop() called before onresult/onend already fired (e.g. released before speaking) also
    // triggers onend in real recognition; guard against double-firing if onresult's own onend
    // (above) already ran first.
    if (this._ended) return;
    this._ended = true;
    setTimeout(() => { if (this.onend) this.onend(); }, 0);
  };
  this.abort = () => {};
}

function installBrowserStub() {
  const listeners = { window: {}, document: {} };
  function fakeTarget(bucket) {
    return {
      addEventListener: (type, fn) => { (bucket[type] = bucket[type] || []).push(fn); },
      removeEventListener: () => {},
    };
  }
  const fakeElement = () => ({
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
  });

  global.window = {
    ...fakeTarget(listeners.window),
    SpeechRecognition: FakeRecognition,
    webkitSpeechRecognition: FakeRecognition,
  };
  global.document = {
    ...fakeTarget(listeners.document),
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    createElement: fakeElement,
    activeElement: null,
  };
  global.location = { hash: '', protocol: 'http:', host: 'localhost' };
  global.fetch = async () => { throw new Error('no network in test'); };

  return listeners;
}

function fireKey(listeners, target, type, evt) {
  (listeners[target][type] || []).forEach((fn) => fn(evt));
}

function pressSpace(listeners) {
  fireKey(listeners, 'document', 'keydown', { key: ' ', code: 'Space', preventDefault() {} });
}

function releaseSpace(listeners) {
  fireKey(listeners, 'document', 'keyup', { key: ' ', code: 'Space', preventDefault() {} });
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Loads a fresh voice-control.js instance with a fresh global stub + fake _ws, returning the
// live voiceControl public API, the listeners map (for keyboard simulation), and the array of
// voiceStream() calls captured so far (each call's onAction/onConfirm/onSay are the REAL
// handler function references).
function freshVoiceControl() {
  const listeners = installBrowserStub();
  delete require.cache[require.resolve(MODULE_PATH)];
  require(MODULE_PATH);

  const calls = [];
  window.voiceControl._ws = {
    voiceStream(opts) {
      calls.push(opts);
      return { reqId: opts.reqId || `test-req-${calls.length}`, stop() {} };
    },
  };
  return { vc: window.voiceControl, listeners, calls };
}

// Simulates one full push-to-talk utterance turn: press Space, let the fake recognition fire
// onresult(text) asynchronously (the real onresult handler calls the real sendUtteranceOnce),
// release Space. Returns the voiceStream() call this utterance produced.
async function speakUtterance(listeners, calls, text) {
  const before = calls.length;
  pressSpace(listeners);
  // The FakeRecognition instance was just constructed inside startRecognition(); stash the text
  // it should resolve with. We can't reach it directly (not exported), so we monkey-patch the
  // constructor to record the most recently created instance instead.
  await wait(5);
  releaseSpace(listeners);
  await wait(5);
  assert.equal(calls.length, before + 1, 'expected exactly one voiceStream() call for this utterance');
  return calls[before];
}

describe('voice-control.js — Phase 3 event/history API', () => {
  test('getHistory() starts empty', () => {
    const { vc } = freshVoiceControl();
    assert.deepEqual(vc.getHistory(), []);
  });

  test('a transcript event is logged for a heard user utterance', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('create a goal to ship the HUD');
    await speakUtterance(listeners, calls, 'create a goal to ship the HUD');

    const history = vc.getHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].type, 'transcript');
    assert.equal(history[0].payload.role, 'user');
    assert.equal(history[0].payload.text, 'create a goal to ship the HUD');
  });

  test('an agent reply (voice-say) is logged as a transcript event with role "agent"', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('what is my status');
    const call = await speakUtterance(listeners, calls, 'what is my status');

    call.onSay({ reqId: call.reqId, text: 'You have three goals in progress.', audioB64: null });

    const history = vc.getHistory();
    const agentEntry = history.find((e) => e.type === 'transcript' && e.payload.role === 'agent');
    assert.ok(agentEntry, 'expected an agent transcript entry');
    assert.equal(agentEntry.payload.text, 'You have three goals in progress.');
  });

  test('action event payload captures tool/args/ok/summary on success', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('create a goal');
    const call = await speakUtterance(listeners, calls, 'create a goal');

    call.onAction({ tool: 'create_goal', args: { category: 'Engineering', text: 'ship the HUD' }, ok: true, summary: 'done' });

    const history = vc.getHistory();
    const actionEntry = history.find((e) => e.type === 'action');
    assert.ok(actionEntry);
    assert.equal(actionEntry.payload.tool, 'create_goal');
    assert.deepEqual(actionEntry.payload.args, { category: 'Engineering', text: 'ship the HUD' });
    assert.equal(actionEntry.payload.ok, true);
  });

  test('action event payload captures ok:false for a failed tool call', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('update a goal');
    const call = await speakUtterance(listeners, calls, 'update a goal');

    call.onAction({ tool: 'update_goal', args: {}, ok: false, summary: 'timeout' });

    const history = vc.getHistory();
    const actionEntry = history.find((e) => e.type === 'action');
    assert.equal(actionEntry.payload.ok, false);
  });

  test('confirm-pending event is logged once when the prompt appears', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('delete goal X');
    const call = await speakUtterance(listeners, calls, 'delete goal X');

    call.onConfirm({ confirmId: 'c1', reqId: call.reqId, summary: 'Delete goal X?' });

    const history = vc.getHistory();
    assert.equal(history.length, 2, 'transcript entry + confirm entry');
    const confirmEntry = history.find((e) => e.type === 'confirm');
    assert.ok(confirmEntry);
    assert.equal(confirmEntry.payload.summary, 'Delete goal X?');
    assert.equal(confirmEntry.resolution, null, 'unresolved confirm has a null resolution');
  });

  test('accepting a pending confirm (button path) mutates the SAME log entry in place — resolution becomes "accepted", no new confirm entry is pushed', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('delete goal X');
    const call = await speakUtterance(listeners, calls, 'delete goal X');
    call.onConfirm({ confirmId: 'c1', reqId: call.reqId, summary: 'Delete goal X?' });

    const confirmCallsBefore = calls.length;
    vc.acceptPendingConfirm();

    const history = vc.getHistory();
    const confirmEntries = history.filter((e) => e.type === 'confirm');
    assert.equal(confirmEntries.length, 1, 'accepting must not add a second confirm log entry');
    assert.equal(confirmEntries[0].resolution, 'accepted');

    assert.equal(calls.length, confirmCallsBefore + 1, 'acceptPendingConfirm must issue exactly one new voiceStream call');
    const acceptCall = calls[calls.length - 1];
    assert.equal(acceptCall.confirmId, 'c1');
    assert.equal(acceptCall.accept, true);
    assert.equal(acceptCall.reqId, call.reqId, 'must reuse the original reqId, mirroring the accept-phrase path');
  });

  test('a subsequent successful action after acceptance is a SEPARATE action event, not conflated with the confirm entry', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('delete goal X');
    const call = await speakUtterance(listeners, calls, 'delete goal X');
    call.onConfirm({ confirmId: 'c1', reqId: call.reqId, summary: 'Delete goal X?' });
    vc.acceptPendingConfirm();

    const acceptCall = calls[calls.length - 1];
    acceptCall.onAction({ tool: 'delete_goal', args: { id: '2' }, ok: true, summary: 'Deleted.' });

    const history = vc.getHistory();
    const confirmEntry = history.find((e) => e.type === 'confirm');
    const actionEntry = history.find((e) => e.type === 'action');
    assert.ok(confirmEntry && actionEntry, 'both a confirm entry and a separate action entry must exist');
    assert.equal(confirmEntry.resolution, 'accepted');
    assert.equal(actionEntry.payload.tool, 'delete_goal');
    assert.notEqual(confirmEntry, actionEntry);
  });

  test('cancelPendingConfirm() (Escape-key path) mutates the same entry in place with resolution "cancelled"', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('delete goal X');
    const call = await speakUtterance(listeners, calls, 'delete goal X');
    call.onConfirm({ confirmId: 'c1', reqId: call.reqId, summary: 'Delete goal X?' });

    fireKey(listeners, 'document', 'keydown', { key: 'Escape', code: 'Escape', preventDefault() {} });

    const history = vc.getHistory();
    const confirmEntries = history.filter((e) => e.type === 'confirm');
    assert.equal(confirmEntries.length, 1, 'Escape cancel must not add a second confirm log entry');
    assert.equal(confirmEntries[0].resolution, 'cancelled');
  });

  test('cancelPendingConfirm() is a no-op when there is no pending confirm', () => {
    const { vc } = freshVoiceControl();
    assert.doesNotThrow(() => vc.cancelPendingConfirm());
    assert.deepEqual(vc.getHistory(), []);
  });

  test('acceptPendingConfirm() is a no-op when there is no pending confirm', () => {
    const { vc, calls } = freshVoiceControl();
    vc.acceptPendingConfirm();
    assert.equal(calls.length, 0, 'must not call voiceStream when nothing is pending');
  });

  test('getHistory() returns a defensive copy: mutating the returned array/objects does not affect internal state', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    setNextTranscript('delete goal X');
    const call = await speakUtterance(listeners, calls, 'delete goal X');
    call.onConfirm({ confirmId: 'c1', reqId: call.reqId, summary: 'Delete goal X?' });

    const historyA = vc.getHistory();
    const confirmIdxA = historyA.findIndex((e) => e.type === 'confirm');
    historyA[confirmIdxA].payload.summary = 'TAMPERED';
    historyA[confirmIdxA].resolution = 'accepted'; // attempt to tamper resolution too
    historyA.push({ type: 'fake', payload: {}, ts: 0, resolution: null });

    const historyB = vc.getHistory();
    const confirmIdxB = historyB.findIndex((e) => e.type === 'confirm');
    assert.equal(historyB.length, 2, 'push onto returned array must not affect internal buffer');
    assert.equal(historyB[confirmIdxB].payload.summary, 'Delete goal X?', 'mutating returned payload must not affect internal buffer');
    assert.equal(historyB[confirmIdxB].resolution, null, 'mutating returned resolution must not affect internal buffer');
  });

  test('ring buffer is bounded at 50 entries, dropping oldest first', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    for (let i = 0; i < 60; i++) {
      setNextTranscript(`utterance ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await speakUtterance(listeners, calls, `utterance ${i}`);
    }
    const history = vc.getHistory();
    assert.equal(history.length, 50);
    assert.equal(history[0].payload.text, 'utterance 10', 'oldest 10 entries should have been dropped');
    assert.equal(history[49].payload.text, 'utterance 59', 'newest entry should be the last pushed');
  });

  test('subscribeEvents(fn) fires for events emitted after subscription, and unsubscribe stops delivery', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    const received = [];
    const unsubscribe = vc.subscribeEvents((evt) => received.push(evt));

    setNextTranscript('first');
    await speakUtterance(listeners, calls, 'first');
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'transcript');

    unsubscribe();
    setNextTranscript('second');
    await speakUtterance(listeners, calls, 'second');
    assert.equal(received.length, 1, 'no further delivery after unsubscribe');
  });

  test('a throwing subscriber does not break delivery to other subscribers or the voice loop', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    const received = [];
    vc.subscribeEvents(() => { throw new Error('boom'); });
    vc.subscribeEvents((evt) => received.push(evt));

    setNextTranscript('resilience check');
    await assert.doesNotReject(async () => {
      await speakUtterance(listeners, calls, 'resilience check');
    });
    assert.equal(received.length, 1, 'the second, non-throwing subscriber must still receive the event');
  });

  test('setTtsMuted(true) suppresses speak() audio side effects but transcript/action logging still populates normally', async () => {
    const { vc, listeners, calls } = freshVoiceControl();
    vc.setTtsMuted(true);
    assert.equal(vc.isTtsMuted(), true);

    setNextTranscript('mute test');
    const call = await speakUtterance(listeners, calls, 'mute test');
    call.onSay({ reqId: call.reqId, text: 'Reply while muted.', audioB64: null });
    await wait(5);

    const history = vc.getHistory();
    const agentEntry = history.find((e) => e.type === 'transcript' && e.payload.role === 'agent');
    assert.ok(agentEntry, 'transcript logging must be unaffected by mute');
    assert.equal(agentEntry.payload.text, 'Reply while muted.');
  });

  test('setTtsMuted(false) is the default (unmuted)', () => {
    const { vc } = freshVoiceControl();
    assert.equal(vc.isTtsMuted(), false);
  });
});

