'use strict';

// C1: A failed review cannot be announced as a success.
//
// Job -531 (2026-08-12 voice-session finding) carried reviewStatus:'failed'
// with buildFailed:false, evidence.pass:true, progress:100, and was
// announced as done. evidence.pass meant "the gate phases ran", which reads
// to a human as "the thing works" — those are not the same fact.
//
// This pins the shared completion-status rule (effectors/completion-status.js)
// that both the pipeline/kanban ship path (agent-actions.js) and the spoken/
// HUD announcer (conversation/announcer.js) now derive from: a job record
// with reviewStatus:'failed' must produce a completion payload whose status
// is 'needs-work' (never 'done') and whose evidence.pass is false. The same
// must hold when the artifact came from the brain fallback engine rather
// than the real one, even if the review itself approved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { deriveCompletionPayload } = require('../src/core/effectors/completion-status');

describe('C1: failed review / fallback-engine builds must never be announced as done', () => {
  it('reviewStatus "failed" -> needs-work, evidence.pass false', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'failed', buildEngine: 'hermes' });
    assert.equal(payload.status, 'needs-work', 'a failed review must never read as done');
    assert.equal(payload.evidence.pass, false, 'evidence.pass must not mean "the phases ran" when review failed');
  });

  it('reviewStatus "approved" on the real engine -> done, evidence.pass true', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'hermes' });
    assert.equal(payload.status, 'done');
    assert.equal(payload.evidence.pass, true);
  });

  it('buildEngine "brain-fallback" degrades status even when review approved', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'brain-fallback' });
    assert.equal(payload.status, 'needs-work', 'artifact did not come from the real engine — never announce it as finished');
    assert.equal(payload.evidence.pass, false);
  });

  it('legacy literal buildEngine "fallback" is also treated as not-the-real-engine', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'fallback' });
    assert.equal(payload.status, 'needs-work');
    assert.equal(payload.evidence.pass, false);
  });

  it('both signals failing at once still yields exactly one needs-work payload', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'failed', buildEngine: 'brain-fallback' });
    assert.equal(payload.status, 'needs-work');
    assert.equal(payload.evidence.pass, false);
  });
});
