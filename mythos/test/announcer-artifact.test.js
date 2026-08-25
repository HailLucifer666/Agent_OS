'use strict';

// announcer-artifact.test.js — the perception.job artifact must reach the
// SPOKEN completion sentence as a real path, never "[object Object]".
//
// The job record's `artifact` is an object ({path, …}); sensors/job.js now
// emits the PATH string on the perception, and conversation/announcer.js
// accepts both shapes defensively. Before the fix, onJobPerception stringified
// whatever it found, so every announced build named its artifact
// "[object Object]" — the operator heard it, and brain.think composed the
// model-visible sentence around it.
//
// Brain is faked OFFLINE so generate() returns its deterministic fallback
// text ('Your <name> is ready…'), making the artifact name directly assertable
// in the spoken string.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');

function offlineBrain() {
  return { think: async () => ({ offline: true }) };
}

function announceOnce(payload) {
  return async () => {
    const spoken = [];
    const bus = createBus({ historySize: 50 });
    const announcer = createConversationAnnouncer({
      bus, brain: offlineBrain(), speak: (t) => { spoken.push(t); return Promise.resolve(); },
    });
    announcer.start();
    bus.emit('perception.job', payload);
    await new Promise((r) => setTimeout(r, 20));
    announcer.stop();
    return spoken;
  };
}

describe('conversation/announcer: artifact naming', () => {
  it('names the artifact from a path STRING payload', async () => {
    const spoken = await announceOnce({
      jobId: 'job-str', status: 'done', artifact: '/vault/Builds/2026-08-17/report.html',
    })();
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].includes('report.html'), `spoken text must name the artifact, got: ${spoken[0]}`);
    assert.ok(!spoken[0].includes('[object Object]'));
  });

  it('still names the artifact when the payload carries the artifact OBJECT (defensive shape)', async () => {
    const spoken = await announceOnce({
      jobId: 'job-obj', status: 'done',
      artifact: { path: 'C:\\Builds\\sites\\landing.html', kind: 'html' },
    })();
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].includes('landing.html'), `object shape must degrade to its path, got: ${spoken[0]}`);
    assert.ok(!spoken[0].includes('[object Object]'));
  });

  it('falls back to "your build" with no artifact, never "[object Object]"', async () => {
    const spoken = await announceOnce({ jobId: 'job-none', status: 'done', artifact: null })();
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].includes('your build'), got(spoken[0]));
    assert.ok(!spoken[0].includes('[object Object]'));
  });
});

function got(s) { return `expected the generic fallback, got: ${s}`; }
