'use strict';

// identity/update-report.js — what the last update did, if anything.
//
// electron/main.js's unfinishedUpdate() reads and clears a single-shot attempt
// file on boot, then hands the result to the server child as JSON in the
// MYTHOS_UPDATE_RESULT env var — a file handoff would land in the wrong vault
// (the packaged app and the batch launcher use DIFFERENT vault directories),
// so env is the only channel that reaches both.
//
// The env value is one of:
//   - absent/empty: no update happened this boot. Normal case, every boot.
//   - a JSON string shaped {completed, version, from, releaseNotes}.
//   - garbage: corrupt/truncated env, or valid JSON in the wrong shape.
//
// This repo has a scar (readJSON) where "absent" and "corrupt" collapsed into
// the same silent fallback, and a store quietly truncated data while reporting
// success. getUpdateReport() refuses to make that mistake: absent input
// returns null (nothing to report); corrupt or malformed input THROWS, so a
// caller that mishandles it fails loudly instead of greeting with a lie.

function getUpdateReport() {
  const raw = process.env.MYTHOS_UPDATE_RESULT;
  if (!raw) return null; // ABSENT: nothing happened this boot.

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // CORRUPT: distinguishable from absent — the caller must not silently
    // treat this the same as "no update happened".
    throw new Error('MYTHOS_UPDATE_RESULT is not valid JSON: ' + err.message);
  }

  if (!parsed || typeof parsed !== 'object' ||
      typeof parsed.version !== 'string' || !parsed.version) {
    // WRONG SHAPE: valid JSON, but not the {completed, version, from,
    // releaseNotes} contract unfinishedUpdate() promises. Same treatment as
    // corrupt — a caller cannot tell "nothing happened" from "something is
    // wrong with what we were told happened" unless we say so.
    throw new Error('MYTHOS_UPDATE_RESULT is valid JSON but not an update report');
  }

  return {
    completed: !!parsed.completed,
    version: parsed.version,
    from: typeof parsed.from === 'string' ? parsed.from : '',
    releaseNotes: typeof parsed.releaseNotes === 'string' ? parsed.releaseNotes : '',
  };
}

module.exports = {
  getUpdateReport: getUpdateReport,
};
