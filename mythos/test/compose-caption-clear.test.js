'use strict';
// test/compose-caption-clear.test.js — pure node:test coverage for the
// caption strip's turn-end decision, extracted out of the DOM shell exactly
// like test/auth-gate-state.test.js does for the auth gate:
//
//   captionFor(state) — given the current voice phase + heard/spoken text,
//                        what should the caption strip above the chat button
//                        read?
//
// The bug this covers: a turn's final phrase used to stay on screen forever
// until the next utterance overwrote it. An ended turn must fall back to an
// idle hint instead of leaving stale output sitting above the compose bar.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const COMPOSE_BAR_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'compose-bar.js')
).href;

describe('captionFor (voice phase + text -> what the caption strip reads)', () => {
  it('a live turn shows what was heard', async () => {
    const { captionFor } = await import(COMPOSE_BAR_URL);
    assert.deepEqual(
      captionFor({ phase: 'listening', text: 'open whatsapp' }),
      { text: 'open whatsapp', kind: 'heard' }
    );
  });

  it('an ended turn clears the strip back to the idle hint', async () => {
    const { captionFor, IDLE_CAPTION } = await import(COMPOSE_BAR_URL);
    assert.deepEqual(
      captionFor({ phase: 'idle', text: 'open whatsapp' }),
      { text: IDLE_CAPTION, kind: 'idle' }
    );
  });

  it('an error stays visible', async () => {
    const { captionFor } = await import(COMPOSE_BAR_URL);
    assert.deepEqual(
      captionFor({ phase: 'error', text: 'mic unavailable' }),
      { text: 'mic unavailable', kind: 'error' }
    );
  });
});
