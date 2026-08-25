'use strict';

// test/bug-311-316-completion-is-allowlist.test.js — BUG-311 and BUG-316.
//
// THE BUG, AND WHY IT IS THE FIFTH OF ITS KIND. completion-status.js exists to
// stop a build being announced as finished when it is not. It decided that with
// a DENYLIST:
//
//     var needsWork = reviewStatus === 'failed' || isFallbackEngine;
//
// so every value it had not been taught to distrust read as 'done'. Measured
// against the real function on the parent commit:
//
//     DONE  evidence.pass=true  | review SKIPPED (tiny-fix path, hardcoded approve)
//     DONE  evidence.pass=true  | a future value nobody taught it ('skipped')
//     DONE  evidence.pass=true  | undefined reviewStatus
//     DONE  evidence.pass=true  | typo in the status string ('aproved')
//     DONE  evidence.pass=true  | no args at all -> deriveCompletionPayload({})
//
// The module whose header states "a failed review must never be announced as a
// success" announced success for the empty object. Commit 7d7b55a, earlier the
// same day, was titled "four places that reported success they had not earned".
// These are the next two, and the denylist is why they keep arriving.
//
// BUG-316: agent-actions.js:593 does
//     needsReview ? await fullReview(...) : { verdict: 'approve', ... }
// and then writes reviewStatus = 'approved'. On the 2026-08-22 AI-news-digest
// build no reviewer ran, the card recorded reviewStatus:"approved",
// status:"done", evidence.pass:true, and MYTHOS said "Completed and verified,
// Sir."
//
// BUG-311: the refine loop DID reject that artifact — pass 1, mistral-small,
// pass:false, six issues including "No electric blue accents visible in the
// design". Its regeneration was then vetoed by the SOURCE verifier, so
// build-runner took the 'reverted' branch and shipped the original, the one the
// visual gate had just rejected. refineStatus was never passed to
// deriveCompletionPayload at all, so 'reverted' could not affect anything.
//
// THE DELIBERATE NON-CHANGE, PINNED BELOW. 'blind' and 'skipped' refine
// statuses do NOT degrade the result. "We looked and rejected it" (reverted,
// exhausted) is evidence of a defect; "we never looked" (refinement disabled,
// or the vision lane could not answer) is absence of evidence. Treating absence
// as failure would make every build read needs-work the moment
// BUILD_REFINE_ENABLED is off or the vision lane times out — which this repo
// records happening routinely — and a status that is always bad is a status
// nobody reads.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nodeFs = require('fs');

const { deriveCompletionPayload } = require('../src/core/effectors/completion-status');
const { deriveReviewMeta } = require('../src/core/effectors/review-status');
const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const riskClassifier = require('../src/core/effectors/risk-classifier');

function status(arg) { return deriveCompletionPayload(arg).status; }

describe('BUG-311/316 — completion status is an allowlist, not a denylist', () => {
  describe('the denylist holes', () => {
    test('no arguments at all is not a finished build', () => {
      const out = deriveCompletionPayload({});
      assert.strictEqual(out.status, 'needs-work',
        'deriveCompletionPayload({}) returned a proven-good build out of nothing');
      assert.strictEqual(out.evidence.pass, false);
    });

    test('a missing reviewStatus is not an approval', () => {
      assert.strictEqual(status({ buildEngine: 'dsh' }), 'needs-work');
    });

    test('a typo in the status string is not an approval', () => {
      assert.strictEqual(status({ reviewStatus: 'aproved', buildEngine: 'dsh' }), 'needs-work');
    });

    test('an unknown future status value degrades rather than defaulting to done', () => {
      // THE GUARD AGAINST THE SIXTH RECURRENCE. Any value added later must be
      // taught to this module explicitly before it can read as finished.
      assert.strictEqual(status({ reviewStatus: 'pending-human', buildEngine: 'dsh' }), 'needs-work');
      assert.strictEqual(status({ reviewStatus: 'in-review', buildEngine: 'dsh' }), 'needs-work');
    });
  });

  describe('BUG-316 — a skipped review is not an approved review', () => {
    test('skipped with no statement about whether review was required is needs-work', () => {
      assert.strictEqual(status({ reviewStatus: 'skipped', buildEngine: 'dsh' }), 'needs-work');
    });

    test('skipped is acceptable ONLY when the risk class did not require review', () => {
      // tiny-fix and quick-win legitimately gate on ['artifact'] alone. The
      // defect was never that they skip review — it was recording the skip as
      // an approval. A declared, expected skip may still finish.
      assert.strictEqual(
        status({ reviewStatus: 'skipped', reviewRequired: false, buildEngine: 'dsh' }),
        'done');
    });

    test('a skip on a class that DID require review never finishes', () => {
      assert.strictEqual(
        status({ reviewStatus: 'skipped', reviewRequired: true, buildEngine: 'dsh' }),
        'needs-work');
    });
  });

  describe('BUG-311 — a visually rejected artifact is not done', () => {
    test('refineStatus reverted is not a finished build', () => {
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'reverted' }),
        'needs-work',
        'the visual gate rejected it and the regeneration was discarded');
    });

    test('refineStatus exhausted is not a finished build', () => {
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'exhausted' }),
        'needs-work');
    });

    test('a refine pass that actually succeeded still finishes', () => {
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'refined' }),
        'done');
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'passed-first-look' }),
        'done');
    });

    test('DELIBERATE: "we never looked" does not degrade the result', () => {
      // Pinned so it cannot drift silently in either direction. See the header
      // for why absence of evidence is treated differently from evidence of a
      // defect.
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'blind' }),
        'done');
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh', refineStatus: 'skipped' }),
        'done');
      assert.strictEqual(
        status({ reviewStatus: 'approved', buildEngine: 'dsh' }),
        'done', 'a build with no refine phase at all is unaffected');
    });
  });

  describe('the behaviour that already worked must not regress', () => {
    test('a failed review is needs-work', () => {
      assert.strictEqual(status({ reviewStatus: 'failed', buildEngine: 'dsh' }), 'needs-work');
    });

    test('a fallback engine is needs-work even with an approving review', () => {
      assert.strictEqual(status({ reviewStatus: 'approved', buildEngine: 'brain-fallback' }), 'needs-work');
      assert.strictEqual(status({ reviewStatus: 'approved', buildEngine: 'fallback' }), 'needs-work');
    });

    test('an approved review on the real engine is done', () => {
      const out = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'dsh' });
      assert.strictEqual(out.status, 'done');
      assert.strictEqual(out.evidence.pass, true);
    });

    test('historical engine tags on stored job records still derive as before', () => {
      // Job records on disk predate the harness swap; 'hermes' was the real
      // engine, not a fallback, and must keep deriving 'done'.
      assert.strictEqual(status({ reviewStatus: 'approved', buildEngine: 'hermes' }), 'done');
    });
  });

  describe('no arguments at all', () => {
    test('called with nothing is needs-work, not done', () => {
      assert.strictEqual(deriveCompletionPayload().status, 'needs-work');
    });
  });
});

describe('BUG-316 — deriveReviewMeta never launders a skip into an approval', () => {
  test('a review that did not run reports skipped', () => {
    // The skip is implemented as a hardcoded { verdict: 'approve' } upstream, so
    // this is the exact input the ship path used to call "approved".
    const meta = deriveReviewMeta({ verdict: 'approve', issues: [], visualDescription: '' }, false);
    assert.strictEqual(meta.reviewStatus, 'skipped');
  });

  test('a real approval still reports approved and carries the visual note', () => {
    const meta = deriveReviewMeta({ verdict: 'approve', issues: [], visualDescription: 'looks right' }, true);
    assert.strictEqual(meta.reviewStatus, 'approved');
    assert.strictEqual(meta.visualReview, 'looks right');
  });

  test('a rejection reports failed and carries the issues', () => {
    const meta = deriveReviewMeta({ verdict: 'reject', issues: ['no dark theme'] }, true);
    assert.strictEqual(meta.reviewStatus, 'failed');
    assert.deepStrictEqual(meta.reviewIssues, ['no dark theme']);
  });

  test('a missing review object does not become an approval', () => {
    assert.strictEqual(deriveReviewMeta(undefined, true).reviewStatus, 'failed');
    assert.strictEqual(deriveReviewMeta(null, true).reviewStatus, 'failed');
  });
});

// The unit tests above prove the rule. These prove the rule is WIRED — the
// module fix is worthless if the ship path still writes 'approved' itself, which
// is how this defect survived a previous honesty pass.
describe('BUG-311/316 — the real ship path records it', () => {
  function setup(opts) {
    const o = opts || {};
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });
    nodeFs.mkdirSync(path.join(dir, 'builds', 'kanban'), { recursive: true });

    const brain = {
      think: async (args) => {
        if (args.source === 'reviewer-agent' || args.source === 'reality-check') {
          return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
        }
        if (args.source === 'visual-verify') {
          return { content: '{"match":true,"issues":[],"description":"ok"}', offline: false, parsed: { match: true, issues: [], description: 'ok' } };
        }
        return { content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>B</body>', offline: false, parsed: null };
      },
    };
    const buildEngine = {
      generate: async () => ({
        content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>E</body>',
        engine: 'dsh', offline: false,
      }),
    };
    // A refiner whose critique always fails AND whose regeneration is rejected by
    // the source verifier reproduces refineStatus:'reverted' — the state the
    // 2026-08-22 build shipped as done.
    const refiner = o.refineReverted ? {
      available: () => true,
      unavailableReason: () => 'n/a',
      looksRenderable: () => true,
      render: async () => ({ ok: true, screenshotB64: '', screenshotPath: null, consoleErrors: [], pageErrors: [], observations: null }),
      critique: async () => ({ pass: false, verdict: 'FAIL', issues: ['no electric blue accents visible'], model: 'fake' }),
    } : undefined;
    // Rejects only the REGENERATION, so the loop reverts to the original.
    let verifyCalls = 0;
    const verifier = o.refineReverted ? {
      verify: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { pass: true, issues: [], warnings: [] }
          : { pass: false, issues: ['missing required design element: dark.theme'], warnings: [] };
      },
    } : undefined;

    const pipeline = createPipelineEffector({ fs: vaultFs, classifier: riskClassifier });
    const kanban = createKanbanEffector({ fs: vaultFs });
    const buildRunner = createBuildRunner({
      config: { BUILD_REFINE_MAX_ITERATIONS: 1 },
      brain, bus: fakeBus(), vault: vaultFs, buildEngine, refiner, verifier,
    });
    const agentActions = createAgentActions({
      fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine,
      webSearch: async () => ({ ok: true, result: { results: [{ title: 'r', url: 'https://example.com/a', snippet: 's' }] } }),
      webFetch: async () => ({ ok: true, result: { content: 'body' } }),
    });
    return { dir, pipeline, kanban, buildRunner, agentActions };
  }

  test('a tiny-fix card ships with reviewStatus "skipped", not "approved"', async () => {
    const env = setup();
    try {
      // 'typo' => tiny-fix => requiresReview false. This is the shipped card's class.
      const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      await waitForJobFinished(env.buildRunner, jobId);

      const found = env.pipeline.findCard(card.id);
      assert.ok(found, 'the card must still exist');
      assert.strictEqual(found.card.reviewStatus, 'skipped',
        'no reviewer ran, so the card must not claim an approval');
      // A declared skip on a class that does not require review may still finish.
      assert.strictEqual(found.card.status, 'done');
    } finally { cleanupVaultDir(env.dir); }
  });

  test('a visually rejected, reverted artifact does not ship as done', async () => {
    const env = setup({ refineReverted: true });
    try {
      const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.strictEqual(job.refineStatus, 'reverted',
        'the harness must actually reproduce the reverted state');
      const found = env.pipeline.findCard(card.id);
      assert.strictEqual(found.card.refineStatus, 'reverted',
        'the visual rejection must be recorded on the card, not only on the job');
      assert.strictEqual(found.card.status, 'needs-work',
        'the visual gate rejected this artifact; it must not read as a finished build');
    } finally { cleanupVaultDir(env.dir); }
  });
});
