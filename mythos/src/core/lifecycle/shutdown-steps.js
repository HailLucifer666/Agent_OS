'use strict';

// lifecycle/shutdown-steps.js — the ORDER of the server's graceful shutdown, in
// one place a test can read. BUG-437, 2026-09-23.
//
// THE BUG. main.js registered stop-loops, then reflection-final-pass (a brain
// call), then the three steps that save: episodic-flush, checkpoint-write,
// audit-flush. On the 2026-09-23 X-button quit the brain call did not return,
// the 6 s hard exit fired, and none of the saving steps ran — the checkpoint on
// disk was 47 s older than the quit. main.js's own D-07 comment listed the order
// as stop-loops -> episodic-flush -> checkpoint-write -> audit-flush and never
// mentioned reflection; the reflection step was inserted second later.
//
// THE ORDER NOW, and why:
//   stop-loops        stop admitting work: the cortex, sensors and children stop
//                     producing before anything is flushed.
//   episodic-flush    working memory -> the episodic vault.
//   checkpoint-write  the crash-recovery checkpoint the next boot reads.
//   audit-flush       the lifecycle shutdown line in the audit trail.
//   reflection-final-pass  LAST, with whatever the deadline leaves (lifecycle
//                     reserves 500 ms after it). It gets the step's AbortSignal,
//                     passes it to the brain, and checks it before every write —
//                     a pass that returns after its deadline writes nothing
//                     (identity/reflection.js). A final reflection is worth
//                     having; it is not worth the checkpoint.
//
// fs-store writes are temp-then-rename. A Windows EPERM on the rename LOSES that
// write rather than tearing the file — a lost checkpoint means the next boot
// recovers from the previous one, which is the honest failure.

function registerCoreShutdownSteps(lifecycle, { stopRunningLoops, getMemory, getReflection }) {
  lifecycle.registerShutdownStep('stop-loops', function() { return stopRunningLoops(); });
  lifecycle.registerShutdownStep('episodic-flush', function() {
    const memory = getMemory();
    if (memory) return memory.working.flushToEpisodic();
  });
  lifecycle.registerShutdownStep('checkpoint-write', function() {
    const memory = getMemory();
    if (memory) return memory.checkpoints.save(memory.working.snapshot());
  });
  lifecycle.registerShutdownStep('audit-flush', function() {
    const memory = getMemory();
    if (memory) return memory.audit.write({ tool: 'lifecycle', tier: 0, decision: 'shutdown', outcome: 'ok' });
  });
  lifecycle.registerShutdownStep('reflection-final-pass', function(ctx) {
    // P4: one last learning pass over the session's conversations; skips when
    // the brain is offline, and stops writing at the deadline (see above).
    const reflection = getReflection();
    if (reflection) return reflection.runNow('shutdown', { signal: ctx && ctx.signal });
  });
}

module.exports = { registerCoreShutdownSteps };
