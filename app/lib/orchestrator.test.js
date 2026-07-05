const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;
process.env.ORCHESTRATOR_CONCURRENCY = '1';

// --- Mock the reasoning provider BEFORE requiring orchestrator -------------
// orchestrator.js does `const reasoning = require('./reasoning')` at load time
// and later calls `reasoning.chat(...)`. We monkey-patch the live export so no
// real network call ever happens, while letting each test reprogram chatStub.
const reasoning = require('./reasoning');
let chatStub = async () => 'STUBBED OUTPUT';
const originalChat = reasoning.chat;
reasoning.chat = (messages, opts) => chatStub(messages, opts);

const orchestrator = require('./orchestrator');

// --- Helpers ---------------------------------------------------------------
async function waitForJob(id, { timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = orchestrator.getJob(id);
    if (job && (job.status === 'done' || job.status === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
}

after(() => {
  reasoning.chat = originalChat;
  rmrf(TMP);
});

// Reset the stub to a sane default before each test so prior-test behavior
// can't bleed into the next one.
beforeEach(() => {
  chatStub = async () => 'STUBBED OUTPUT';
});

// --- Tests -----------------------------------------------------------------
describe('orchestrator', () => {
  test('enqueue returns a well-formed queued job', () => {
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-1',
      prompt: 'do something',
      run: async () => ({}),
    });

    assert.equal(job.status, 'queued');
    assert.equal(job.stage, 'queued');
    assert.ok(job.id.startsWith('job-'), `id should start with "job-", got ${job.id}`);
    assert.equal(job.artifact, null);
    assert.equal(job.error, null);
    assert.equal(job.finishedAt, null);
    // createdAt must be a valid ISO timestamp.
    assert.ok(!Number.isNaN(Date.parse(job.createdAt)), 'createdAt should be ISO-parseable');
  });

  test('a successful run completes the job with the artifact', async () => {
    chatStub = async () => 'OUTPUT';
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-2',
      prompt: 'build it',
      run: async () => ({ artifact: { path: '/x' } }),
    });

    const done = await waitForJob(job.id);
    assert.equal(done.status, 'done');
    assert.equal(done.stage, 'done');
    assert.deepEqual(done.artifact, { path: '/x' });
    assert.ok(done.finishedAt, 'finishedAt should be set on completion');
  });

  test('a run that throws fails the job with the thrown message', async () => {
    chatStub = async () => 'OUTPUT';
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-3',
      prompt: 'broken',
      run: async () => {
        throw new Error('bad output');
      },
    });

    const failed = await waitForJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.error, 'bad output');
  });

  test('a rejected chat call fails the job with the rejection message', async () => {
    chatStub = async () => {
      throw new Error('engine down');
    };
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-4',
      prompt: 'no engine',
      run: async () => ({ artifact: { path: '/never' } }),
    });

    const failed = await waitForJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.error, 'engine down');
  });

  test('getJob returns null for unknown ids', () => {
    assert.equal(orchestrator.getJob('nonexistent'), null);
  });

  test('listJobs includes enqueued jobs', async () => {
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-list',
      prompt: 'list me',
      run: async () => ({}),
    });
    await waitForJob(job.id);

    const ids = orchestrator.listJobs().map((j) => j.id);
    assert.ok(ids.includes(job.id), 'listJobs should include the enqueued job id');
  });

  test('setBroadcast callback receives job-update messages through the lifecycle', async () => {
    const messages = [];
    orchestrator.setBroadcast((msg) => messages.push(msg));

    chatStub = async () => 'OUTPUT';
    const job = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'card-broadcast',
      prompt: 'shout',
      run: async () => ({ artifact: { path: '/y' } }),
    });
    await waitForJob(job.id);

    orchestrator.setBroadcast(null); // stop capturing

    assert.ok(messages.length > 0, 'broadcast should have been called at least once');
    assert.ok(
      messages.every((m) => m.type === 'job-update' && m.job),
      'every broadcast message should be {type:"job-update", job}',
    );
    const terminal = messages.filter(
      (m) => m.job.status === 'done' || m.job.status === 'failed',
    );
    assert.ok(terminal.length > 0, 'a done/fail update should have been broadcast');
  });

  test('with concurrency=1, the second job stays queued while the first runs', async () => {
    // Re-confirm the env-driven default; orchestrator reads it at module load.
    assert.equal(process.env.ORCHESTRATOR_CONCURRENCY, '1');

    let resolveFirst;
    const firstGate = new Promise((r) => {
      resolveFirst = r;
    });
    let firstStarted = false;

    // First chat: slow — holds the slot until we resolve the gate.
    let firstChat;
    chatStub = async () => {
      firstStarted = true;
      await firstChat;
      return 'FIRST';
    };

    const j1 = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'c-first',
      prompt: 'first',
      run: async () => ({ artifact: { path: '/first' } }),
    });

    // Wait until the first job has actually entered the chat call.
    const start = Date.now();
    while (!firstStarted && Date.now() - start < 500) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(firstStarted, 'first job should have started running');

    // Swap the stub for the SECOND job (queued behind the first).
    chatStub = async () => 'SECOND';
    const j2 = orchestrator.enqueue({
      kind: 'pipeline',
      cardId: 'c-second',
      prompt: 'second',
      run: async () => ({ artifact: { path: '/second' } }),
    });

    // While job 1 is still running, job 2 must be queued (not running/done).
    const j2Mid = orchestrator.getJob(j2.id);
    assert.equal(j2Mid.status, 'queued', 'second job should still be queued while first runs');

    // Release the first job and let both finish.
    firstChat = firstGate;
    resolveFirst();
    await waitForJob(j1.id);
    await waitForJob(j2.id);

    assert.equal(orchestrator.getJob(j1.id).status, 'done');
    assert.equal(orchestrator.getJob(j2.id).status, 'done');
  });
});
