'use strict';

// BUG-356 — the build engine failed with "exit 1 ... (stderr empty)" and the
// adapter had thrown away the one channel that was not empty.
//
// THE TICKET NAMES THE WRONG STREAM. It says "the harness swallowed its own
// error output" and proposes "teaching dsh-agent to capture child stderr
// instead of reporting null". dsh-agent has captured stderr since it was
// written, and prints it verbatim. It was reporting "(stderr empty)" because
// stderr genuinely WAS empty, and it is empty by design.
//
// MEASURED 2026-08-28 in the installed engine,
// @deepseek-ai/dsh-headless/lib/index.js:96-98 — dsh's entire one-shot
// reporting contract is three lines:
//
//   io.stdout.write(outcome.text + "\n");
//   if (outcome.reason?.kind === "error") io.stderr.write(`dsh: ${code}: ${msg}\n`);
//   io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
//
// So stderr carries a diagnosis for EXACTLY ONE of the turn-end reasons.
// @deepseek-ai/dsh-agent-loop/lib/index.js raises `completed` (:544, :684),
// `blocked` (:539), `aborted` (:577), `error` (:583) and `max-tokens` (:557),
// and it appends turn/end from a `finally` block, so the reason can also be
// null when the loop breaks without setting one. Every one of those except
// `completed` exits 1; every one of them except `error` writes NOTHING to
// stderr while doing it.
//
// And on all of them stdout still holds `outcome.text` — the last assistant
// message of the turn. On max-tokens that is the truncated deliverable; on
// blocked it is whatever the agent said before the refusal. The old exit branch
// reported "(stderr empty)" and dropped it, so BUG-356's live failure (exit 1
// after 72s, stderr empty) deleted its only evidence while announcing that
// there was none.
//
// LIVE MEASUREMENTS behind the assertions, all 2026-08-28 against
// dsh 0.1.1-rc.2 on mistral/codestral-latest through the real adapter spawn:
//   trivial task            -> exit 0, stdout "OK\n",  stderr 0 bytes
//   write task, read-only   -> exit 0, stdout refusal, stderr 0 bytes
//   invalid MISTRAL_API_KEY -> exit 1, stdout 1 byte,  stderr "dsh: AUTH: Mistral
//                              API error (401): {"detail":"Invalid API Key"}"
// The auth case is the one shape that DOES reach stderr, which is why it was
// never the shape BUG-356 hit.
//
// NOT CLOSED BY THIS: the digest brief's own failure. This makes the next live
// run print what dsh said instead of discarding it; it cannot say in advance
// which reason that run will report.
//
// Run: cd mythos && node --test test/bug-356-dsh-exit-discards-its-only-evidence.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const diagnosis = require('../adapters/dsh-agent/diagnosis');
const dsh = require('../adapters/dsh-agent');
const ADAPTER = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js'), 'utf8');

// The real 401, byte for byte, as the child wrote it.
const LIVE_AUTH_STDERR = 'dsh: AUTH: Mistral API error (401): {"detail":"Invalid API Key"}\n';

describe('BUG-356 — a non-zero exit reports the stream dsh actually wrote to', () => {
  it('quotes stdout when stderr is empty, because that is the only evidence there is', () => {
    const msg = diagnosis.exitDiagnosis({
      code: 1,
      model: 'mistral/codestral-latest',
      stdout: '<!doctype html><title>AI Digest</title><main>...truncated mid-page',
      stderr: '',
    });
    assert.match(msg, /truncated mid-page/,
      'the last assistant text is what dsh writes on EVERY outcome; dropping it on the one '
      + 'outcome that has no stderr deletes the whole failure record');
  });

  it('does not let an empty stderr read as "dsh said nothing"', () => {
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'm/x', stdout: 'partial', stderr: '' });
    // The distinction the old message erased: silence on stderr is dsh's
    // DOCUMENTED behaviour for four of its five turn-end reasons, not an absence
    // of information. A reader told "(stderr empty)" stops looking.
    assert.match(msg, /blocked/i, 'the reader must learn which reasons exit 1 in silence');
    assert.match(msg, /max-tokens/i,
      'max-tokens is the likely one for a page-sized build and the one whose stdout is worth '
      + 'reading, because it holds the truncated deliverable');
  });

  it('still leads with stderr when dsh did write one — the live 401, verbatim', () => {
    // Both streams non-empty so the ORDER is observable. An earlier draft used
    // the live 401's real one-byte stdout and asserted against the word
    // "stdout", which the no-text branch never emits — so indexOf returned -1
    // and the comparison was measuring nothing.
    const msg = diagnosis.exitDiagnosis({
      code: 1, model: 'mistral/codestral-latest',
      stdout: 'PARTIAL-REPLY-MARKER', stderr: LIVE_AUTH_STDERR,
    });
    assert.match(msg, /Invalid API Key/, 'a named cause must survive into the message');
    assert.match(msg, /PARTIAL-REPLY-MARKER/, 'and so must the text, whichever stream spoke');
    assert.ok(msg.indexOf('Invalid API Key') < msg.indexOf('PARTIAL-REPLY-MARKER'),
      'when dsh named the failure, that name comes first: this file already carries BUG-305\'s '
      + 'lesson that a theory printed above the evidence stops the reader looking');
  });

  it('says the turn produced no text at all rather than printing an empty quote', () => {
    // The live 401 wrote exactly one byte to stdout: `outcome.text + "\n"` with
    // text empty. Quoting "" as if it were content is a third wrong answer.
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'm/x', stdout: '\n', stderr: '' });
    assert.doesNotMatch(msg, /stdout: ""/, 'an empty quote reads as "dsh replied with nothing useful"');
    assert.match(msg, /no assistant text/i,
      'no text at all is a different fact from truncated text, and it points at a different cause');
  });

  it('quotes the END of a long reply, not the beginning', () => {
    // The question a silent exit 1 leaves is "did the generation stop mid-tag?",
    // and only the tail answers it. MEASURED on BUG-356's own live reproduction
    // 2026-08-28: the first 600 characters of the failed digest build were an
    // ordinary `:root` block and looked completely healthy, so a head-quoted
    // message would have been evidence that pointed away from the cause.
    const cut = '<!DOCTYPE html><head>HEAD-MARKER</head>' + 'x'.repeat(5000) + '<div class="card" styl';
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'm/x', stderr: '', stdout: cut });
    assert.match(msg, /styl"/, 'the tail is the part that shows where it stopped');
    assert.doesNotMatch(msg, /HEAD-MARKER/,
      'a head quote of a truncated document is indistinguishable from a complete one');
    assert.match(msg, new RegExp('\\b' + cut.length + ' chars\\b'),
      'the true length must be stated, or a quoted fragment reads as the whole reply');
  });

  it('quotes a short reply whole, and says so', () => {
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'm/x', stdout: 'brief answer', stderr: '' });
    assert.match(msg, /in full \(12 chars\): "brief answer"/,
      'a reply that fits needs no tail-vs-head caveat, and calling it a tail would be a lie');
  });

  it('names the model, so a lane-head failure is not mistaken for an engine failure', () => {
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'mistral/codestral-latest', stdout: '', stderr: '' });
    assert.match(msg, /mistral\/codestral-latest/);
  });

  it('reports a null exit code as unknown instead of as zero', () => {
    // spawn gives code=null when the child died on a signal. Printing "exit
    // null" or coercing to 0 would both be lies about how it ended.
    const msg = diagnosis.exitDiagnosis({ code: null, model: 'm/x', stdout: '', stderr: '' });
    assert.doesNotMatch(msg, /exit (0|null)\b/);
    assert.match(msg, /exit \?/);
  });
});

describe('BUG-356 — the failure log had a field nothing could ever fill', () => {
  it('withEvidence puts the child output on the error object', () => {
    const err = diagnosis.withEvidence(new Error('dsh exit 1'), { stdout: 'partial page', stderr: LIVE_AUTH_STDERR });
    assert.match(err.stderrText, /Invalid API Key/);
    assert.equal(err.stdoutText, 'partial page');
  });

  it('the logged stdout is the same end of the document the message quotes', () => {
    // Two routes to one fact. If the message shows the tail and the log shows
    // the head, they disagree about where the reply stopped, and the log — the
    // one that survives the process — becomes the less useful of the two.
    const long = 'A'.repeat(2000) + 'TAIL-MARKER';
    const err = diagnosis.withEvidence(new Error('x'), { stdout: long, stderr: '' });
    assert.match(err.stdoutText, /TAIL-MARKER/);
    const msg = diagnosis.exitDiagnosis({ code: 1, model: 'm/x', stdout: long, stderr: '' });
    assert.ok(msg.includes(err.stdoutText),
      'the log line must be a substring of what the message shows, not a different window');
  });

  it('carries null rather than an empty string, so the log shows absence honestly', () => {
    const err = diagnosis.withEvidence(new Error('x'), { stdout: '\n', stderr: '' });
    assert.equal(err.stderrText, null);
    assert.equal(err.stdoutText, null);
  });

  it('noteTaskFailure logs both streams', () => {
    const seen = [];
    const logger = { warn: (evt, data) => seen.push([evt, data]), info() {}, error() {} };
    const err = diagnosis.withEvidence(new Error('dsh exit 1 on m/x'), {
      stdout: 'truncated page', stderr: LIVE_AUTH_STDERR,
    });
    dsh.noteTaskFailure(err, {
      logger, model: 'm/x', elapsedMs: 72000,
      stderr: err.stderrText, stdout: err.stdoutText,
    });
    assert.equal(seen.length, 1);
    const data = seen[0][1];
    assert.match(String(data.stderr), /Invalid API Key/);
    assert.match(String(data.stdout), /truncated page/,
      'stdout is the channel BUG-356 lost; a log line that records only stderr repeats the bug '
      + 'in the one place someone looks after the process is gone');
  });

  it('the runTask catch reads properties something actually sets', () => {
    // The original defect in miniature: the catch block passed
    // `stderr: err && err.stderrText`, and NOTHING in the repo ever assigned
    // stderrText. Every dsh failure since BUG-305 logged `stderr: null`,
    // including the 401 above whose stderr held the entire answer. A guard that
    // only asserts the read would have passed against that code, so this asserts
    // both halves: the property is read AND it has a writer.
    assert.match(ADAPTER, /stderr: err && err\.stderrText/, 'the catch must still forward it');
    assert.match(ADAPTER, /stdout: err && err\.stdoutText/, 'and the stream BUG-356 lost');
    assert.match(ADAPTER, /withEvidence\(/,
      'and something must assign those properties — a field with no writer is a field that '
      + 'reports null forever');
  });
});

describe("BUG-356 — the ticket's own oracle could not see an artifact", () => {
  const DRIVER = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-ai-digest-brief.js'), 'utf8');
  const RUNNER = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'build-runner.js'), 'utf8');

  it('the driver reads the field a job record actually has', () => {
    // The evidence line said `job.artifactPath || job.result?.artifactPath`.
    // Neither exists. It therefore printed an empty ARTIFACT on EVERY run,
    // success included — and BUG-356's headline "so no artifact ships" was
    // written from it. Measured 2026-08-28: a `done` run printed `ARTIFACT `
    // while vault/builds/pipeline/ai-news-digest-landing-page.html was on disk.
    // CODE, not prose about code. A flat search matched the comment that
    // documents the dead field, which is the fourth time in this campaign an
    // assertion has scored a mention as if it were a statement.
    const code = DRIVER.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /job\.artifactPath/,
      'a driver reading a property no job record carries is an oracle that can only ever '
      + 'report absence');
    assert.match(code, /const raw = job\.artifact;/);
  });

  it('and that field is the one build-runner writes', () => {
    // Two routes to one fact, pointed at the same input. Asserting the driver
    // alone would pass just as happily against the next wrong name.
    assert.match(RUNNER, /if \(runResult && runResult\.artifact\) job\.artifact = runResult\.artifact;/,
      'if build-runner renames the field, this guard must fail rather than let the driver go '
      + 'quietly blind again');
  });

  it('a done job with no artifact is reported, not printed as a blank', () => {
    // The CONDITION, not just the string. Found by mutation: asserting only that
    // "ARTIFACT MISSING" appears in the file passed happily against
    // `if (false)`, because the dead branch still contains the words. A guard
    // that scores the presence of a message rather than its reachability is the
    // same fail-open shape as the oracle it is guarding.
    assert.match(DRIVER, /if \(job\.status === 'done' && !artifact\) \{[\s\S]{0,300}ARTIFACT MISSING/,
      'silence is what let this hide; an empty line reads as "nothing shipped" whether or not '
      + 'anything shipped');
  });

  it('an artifact record is unwrapped rather than stringified', () => {
    // build-runner may set `artifact` to a string OR a {path} record —
    // announcer.js:108 already handles both, and this driver must not be the
    // place that prints "[object Object]" into an evidence block.
    assert.match(DRIVER, /typeof raw === 'object' \? raw\.path : raw/);
  });
});

describe('BUG-356 — the exit branch is wired to the diagnosis, not to a bare string', () => {
  it('runTask builds its non-zero-exit message with exitDiagnosis', () => {
    // Anchored on runTask's OWN comment, not on `if (res.code !== 0)`: probe()
    // has an identical line and indexOf found that one first, so the assertion
    // named the exit branch and read the version check. Caught while watching
    // this file go red — a window is only as honest as what it starts at.
    const oracle = ADAPTER.indexOf('// The exit code IS the oracle');
    assert.notStrictEqual(oracle, -1, "runTask's exit-code comment must still exist");
    const at = ADAPTER.indexOf('if (res.code !== 0)', oracle);
    assert.notStrictEqual(at, -1, 'the exit-code branch must still exist');
    const body = ADAPTER.slice(at, at + 400);
    assert.match(body, /exitDiagnosis\(/,
      'inlining the message again is how the stdout drop returns');
    assert.match(body, /stdout: res\.stdout/,
      'the branch must hand over the stream it used to discard');
  });

  it('the old message that reported the drop as an absence is gone', () => {
    // A STATEMENT, not a mention. The first draft matched /\(stderr empty\)/
    // anywhere and went red against the fixed file, because the comment above
    // the new branch QUOTES the old string to explain what was wrong with it.
    // Same failure BUG-346 hit with /\bstop\(\)/ — an assertion is only as good
    // as its ability to tell code from prose about code.
    assert.doesNotMatch(ADAPTER, /'\s*\(stderr empty\)'/,
      '"(stderr empty)" was true and useless as a message: it described the one stream dsh had '
      + 'not written to while deleting the one it had');
  });

  it('exitDiagnosis and timeoutDiagnosis stay re-exported from the adapter', () => {
    // Both are named inside failure messages and driven directly by tests, which
    // is the reason index.js exports its diagnosis helpers at all. Moving them
    // into a sibling module must not quietly narrow the adapter's surface.
    assert.equal(typeof dsh.exitDiagnosis, 'function');
    assert.equal(typeof dsh.timeoutDiagnosis, 'function');
  });
});
