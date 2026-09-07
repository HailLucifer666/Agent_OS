'use strict';

// BUG-401: the real app mounts widgets before createComposeBar. A mounted
// Chromium probe reproduced unavailable after the real compose module emitted
// listening; the same probe passes after observing the stable container.
// These offline tests cover lifecycle permutations; they do not substitute for
// browser MutationObserver delivery, which the mounted probe exercised.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('voice state follows late creation, replacement, removal, and teardown', async (t) => {
  const { observeVoiceState } = await import(pathToFileURL(path.join(__dirname,
    '../ui/public/js/widgets/kinds/voice.js')).href);
  let pill = null;
  const root = { querySelector(selector) {
    assert.equal(selector, '[data-voice-state]');
    return pill;
  } };
  let observed;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observed = this; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    deliver() { if (!this.disconnected) this.callback(); }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'MutationObserver', previous);
    else delete globalThis.MutationObserver;
  });
  const states = [];
  const stop = observeVoiceState(root, state => states.push(state));
  assert.deepEqual(states, [null], 'missing pill must not invent idle');
  assert.equal(observed.target, root);
  assert.deepEqual(observed.options, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-voice-state'],
  });
  pill = { dataset: { voiceState: 'listening' } };
  observed.deliver();
  assert.equal(states.at(-1), 'listening');
  pill.dataset.voiceState = 'processing';
  observed.deliver();
  assert.equal(states.at(-1), 'processing');
  pill = { dataset: { voiceState: 'speaking' } };
  observed.deliver();
  assert.equal(states.at(-1), 'speaking', 'replacement pill must replace old source');
  pill = null;
  observed.deliver();
  assert.equal(states.at(-1), null, 'removed source must not retain speaking');
  const count = states.length;
  stop();
  pill = { dataset: { voiceState: 'idle' } };
  observed.deliver();
  assert.equal(states.length, count, 'teardown must disconnect');

  const initial = [];
  observeVoiceState(root, state => initial.push(state))();
  assert.deepEqual(initial, ['idle'], 'already-mounted compose must work too');
  const missing = [];
  observeVoiceState(null, state => missing.push(state))();
  assert.deepEqual(missing, [null], 'missing compose container is unavailable');
});
