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
//
// NO REFLECTION AT QUIT (operator decision 2026-10-06, BUG-437 closure). The
// reflection-final-pass step that used to run LAST is gone. It was a brain call
// given the ~5.5 s the deadline left; it timed out on 2 of the last 3 measured
// closes (2026-09-24, 2026-10-06) and its late answer was fenced to "nothing
// written", so every such quit reported clean=false and bought nothing. The
// learning is not lost: reflection already runs during the session —
// reflection.noteTurn() -> runNow('cadence') every REFLECTION_EVERY_TURNS (15)
// turns (identity/reflection.js), plus reflectOnActions on main.js's
// actionReflectTimer. What IS lost: the up-to-14 turns since the last cadence
// pass are not reflected on at quit; they are still in the episodic vault and
// are folded in by the next session's pass - IF that pass is enabled at all
// (BUG-464: it is off unless MEMORY_AUTO_USER_FACTS is "true", so with the
// default the profile simply stops learning from conversation; that is the
// operator's 2026-10-06 decision, not a silent loss). Deliberately no 'getReflection'
// parameter: a registrar that cannot be handed reflection cannot run it.
// Attack answers: (1) nothing else matched — the step name was unique; (2) no
// evidence hidden — the saving steps' log lines are unchanged; (3) the only
// reader of the old step was this file's test; (4) 'clean' is still computed by
// lifecycle/index.js over the remaining steps, and a timed-out saving step still
// makes it false (test (c)); (6) class: a slow optional step ahead of the exit
// making clean=false — any new quit step must be a SAVE, not a model call.
//
// fs-store writes are temp-then-rename. A Windows EPERM on the rename LOSES that
// write rather than tearing the file — a lost checkpoint means the next boot
// recovers from the previous one, which is the honest failure.

function registerCoreShutdownSteps(lifecycle, { stopRunningLoops, getMemory }) {
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
}

module.exports = { registerCoreShutdownSteps };
