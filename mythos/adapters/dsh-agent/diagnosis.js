'use strict';
// adapters/dsh-agent/diagnosis.js — turning a dead child process into a sentence.
//
// Split out of index.js for BUG-356, and the split is not cosmetic: index.js sat
// EXACTLY on its file-size ratchet ceiling (929, test/file-size-ratchet.test.js),
// so the fix could not be added there at all. What moved is the post-mortem
// layer — the functions that run after spawnDsh has resolved and turn its result
// into something a human can act on. fatalStderrSignature stayed behind on
// purpose: it is consulted DURING the spawn, on each stderr chunk, to decide
// whether to kill the child. That is a live decision, not a post-mortem.
//
// ---------------------------------------------------------------------------
// WHY dsh CAN EXIT 1 AND SAY NOTHING, which is the whole of BUG-356.
//
// MEASURED 2026-08-28 by reading the installed engine (dsh 0.1.1-rc.2), not from
// memory — dsh is a developer preview whose README promises breaking changes.
// @deepseek-ai/dsh-headless/lib/index.js:96-98 is its entire one-shot reporting
// contract, three lines:
//
//   io.stdout.write(outcome.text + "\n");
//   if (outcome.reason?.kind === "error") io.stderr.write(`dsh: ${code}: ${msg}\n`);
//   io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
//
// So the exit code separates `completed` from everything else, while stderr
// separates `error` from everything else — and those are NOT the same cut.
// @deepseek-ai/dsh-agent-loop/lib/index.js raises `completed` (:544, :684),
// `blocked` (:539), `aborted` (:577), `error` (:583) and `max-tokens` (:557),
// and appends turn/end from a `finally`, so the reason can also be absent when
// the loop breaks without setting one. Four of those five, plus the absent case,
// exit 1 in complete silence.
//
// Meanwhile stdout is written on EVERY outcome and holds `outcome.text`: the
// last assistant message of the turn. On max-tokens that is the truncated
// deliverable — the most valuable thing in the whole failure. The old exit
// branch printed "(stderr empty)" and discarded it, so BUG-356's live failure
// (exit 1 after 72s, stderr empty) deleted its only evidence while reporting
// that there was none.
//
// LIVE, same day, through the real adapter spawn on mistral/codestral-latest:
//   trivial task            -> exit 0, stdout "OK\n",  stderr 0 bytes
//   write task, read-only   -> exit 0, stdout refusal, stderr 0 bytes
//   invalid MISTRAL_API_KEY -> exit 1, stdout 1 byte,  stderr "dsh: AUTH: Mistral
//                              API error (401): {"detail":"Invalid API Key"}"
// The auth case is the one shape that reaches stderr, which is exactly why it
// was never the shape BUG-356 hit.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never returns the partial stdout as
// content. A max-tokens turn holds half a landing page, and shipping that would
// be the plausible-but-wrong artifact BUG-244 ruling A exists to forbid. The
// text goes into the failure message, where a human reads it, and nowhere else.

var STDERR_QUOTE = 600;
var STDOUT_QUOTE = 600;

// The reasons that exit non-zero without writing a word. Named in the message
// because "(stderr empty)" reads as "dsh had nothing to say", and a reader who
// believes that stops looking.
var SILENT_EXIT_REASONS = 'blocked, aborted, max-tokens, or with no reason recorded at all';

// stderr is quoted from the FRONT and stdout from the BACK, and the asymmetry is
// the point. An error message states its cause in its first clause. A truncated
// deliverable is identical to a complete one for its first several thousand
// characters and differs only at the end — quoting the head of a half-written
// HTML document returns `<!DOCTYPE html>`, which answers nothing. The question
// an operator actually has is "did this stop mid-tag?", and only the tail
// answers it. Measured on BUG-356's own live reproduction 2026-08-28: the first
// 600 characters were an ordinary `:root` block and looked entirely healthy.
function tail(s, n) {
  return s.length <= n ? s : s.slice(s.length - n);
}

// What to say when the clock really does run out.
//
// BUG-305, second half. The old message asserted a cause: "in headless mode this
// is the shape an unanswerable approval prompt takes". During BUG-301 that was
// printed three times in one day and was wrong all three times — the engine had
// crashed at load, and its stderr was sitting in the same error string, after
// the guess. A theory that outranks the evidence next to it is worse than no
// theory, because it stops the reader looking.
//
// So: the evidence first, the elapsed time, and the approval prompt offered as
// one possibility only when there is nothing else to go on.
function timeoutDiagnosis(ctx) {
  var stderrText = String((ctx && ctx.stderr) || '').trim();
  var stdoutText = String((ctx && ctx.stdout) || '').trim();
  var lines = ['dsh produced no terminal turn within ' + ctx.timeoutMs + 'ms and was killed.'];
  if (stderrText) {
    lines.push('It did write to stderr, and that is the first thing to read: '
      + JSON.stringify(stderrText.slice(0, STDERR_QUOTE)));
  } else {
    lines.push('Nothing on stderr, and nothing was killed early, so there is no crash to point at.');
  }
  lines.push('Partial stdout: ' + (stdoutText ? JSON.stringify(stdoutText.slice(0, 300)) : '(none)'));
  lines.push('Model: ' + ctx.model + '.');
  if (!stderrText) {
    lines.push('With no output at all, one possibility is a permission or approval request with '
      + 'nowhere to be answered in headless mode; another is a provider that accepted the '
      + 'connection and never replied. Check the provider first — it is the cheaper test.');
  }
  return lines.join(' ');
}

// What to say when dsh exits non-zero. Same shape as timeoutDiagnosis and the
// same rule: whatever the child actually wrote goes first, and a possibility is
// offered only where there is no evidence to outrank it.
function exitDiagnosis(ctx) {
  ctx = ctx || {};
  var stderrText = String(ctx.stderr || '').trim();
  var stdoutText = String(ctx.stdout || '').trim();
  var lines = ['dsh exit ' + (ctx.code == null ? '?' : ctx.code) + ' on ' + ctx.model + '.'];
  if (stderrText) {
    lines.push('It named the failure on stderr: ' + JSON.stringify(stderrText.slice(0, STDERR_QUOTE)));
  } else {
    // Not "stderr empty". That was true and it stopped the investigation.
    lines.push('stderr is empty, which is dsh BEHAVING AS DESIGNED rather than dsh having '
      + 'nothing to say: it writes stderr only when the turn ended with reason kind "error", so '
      + 'a turn that ended ' + SILENT_EXIT_REASONS + ' exits non-zero in silence.');
  }
  if (!stdoutText) {
    lines.push('The turn produced no assistant text at all, so the failure came before or '
      + 'instead of a reply rather than partway through one.');
  } else if (stdoutText.length <= STDOUT_QUOTE) {
    lines.push('Last assistant text, from stdout, in full ('
      + stdoutText.length + ' chars): ' + JSON.stringify(stdoutText));
  } else {
    lines.push('Last assistant text, from stdout: ' + stdoutText.length + ' chars, ENDING '
      + JSON.stringify(tail(stdoutText, STDOUT_QUOTE))
      + ' — if that ends mid-tag or mid-sentence the turn was cut off, which is what '
      + 'max-tokens looks like; if it ends cleanly, the generation finished and something '
      + 'after it failed.');
  }
  return lines.join(' ');
}

// Attach the child's own output to the error being thrown.
//
// BUG-356's quieter half. runTask's catch block has read `err.stderrText` since
// BUG-305 added it, and NOTHING in the repo has ever assigned that property — so
// the log line built specifically to record dsh failures has recorded
// `stderr: null` on every failure since, including the 401 above whose stderr
// held the entire answer. A field with no writer is a field that reports absence
// forever, and it does it in the one place someone looks after the process is
// gone.
//
// Empty becomes null rather than '': the log distinguishes "the child wrote
// nothing" from "we did not capture it", and an empty string blurs them.
function withEvidence(err, res) {
  err.stderrText = String((res && res.stderr) || '').trim().slice(0, STDERR_QUOTE) || null;
  // Tail, for the reason given above tail(): the log line and the message must
  // show the same end of the same document, or the two disagree about where it
  // stopped and the log becomes the less useful of the two.
  err.stdoutText = tail(String((res && res.stdout) || '').trim(), STDOUT_QUOTE) || null;
  return err;
}

module.exports = {
  timeoutDiagnosis: timeoutDiagnosis,
  exitDiagnosis: exitDiagnosis,
  withEvidence: withEvidence,
  SILENT_EXIT_REASONS: SILENT_EXIT_REASONS,
};
