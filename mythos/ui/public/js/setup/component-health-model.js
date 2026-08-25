// component-health-model.js — the pure decision behind the "a component you
// asked for is not actually installed" banner.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the NSIS installer recorded
// silero:true, wakeword:true and adb:true in install-selection.json, fetched
// nothing, and said nothing. The wizard's Components step never completed. On
// disk, resources/app.asar.unpacked/mythos/ui/public/models/ did not exist at
// all — so the wake word was dead, and the only symptom the operator ever saw
// was that saying "hey jarvis" did nothing.
//
// A recorded intention that never happened has to be visible somewhere. This is
// that somewhere: a standing banner, driven by GET /api/setup/components, which
// already reports `selected` (what the installer recorded) beside `installed`
// (what doctor can see on disk right now).
//
// Split pure/DOM the same way setup-state.js and auth/auth-gate-state.js are, and
// for the same reason: node:test can cover every case with no browser.
//
// HONESTY RULES, inherited from setup-state.js:
//   - an INDETERMINATE probe never paints. A server that did not answer is not
//     evidence that a component is missing.
//   - installed:null means "doctor cannot observe this" (autostart). Unknown is
//     not missing, and must never be reported as a failure.
//   - only components the operator ACTUALLY ASKED FOR are named. Every install
//     has optional components nobody wanted, and a banner that nags about those
//     would be dismissed permanently within a day — taking the real warnings
//     with it.

// deriveComponentHealth(body) -> {show, reason, missing:[{id,label}], message}
//   body: the parsed GET /api/setup/components response, or null when the probe
//         failed or returned something unparseable.
//   reason: 'ok' | 'indeterminate' | 'selected-not-installed'
export function deriveComponentHealth(body) {
  const rows = body && Array.isArray(body.components) ? body.components : null;
  if (!rows) {
    return { show: false, reason: 'indeterminate', missing: [], message: '' };
  }

  // selected === true means "recorded as wanted AND not already installed"
  // (src/core/setup/components.js mergeComponentState clears `selected` for
  // anything doctor already sees). installed === false is doctor's own verdict;
  // null is "not observable here" and is deliberately excluded.
  const missing = rows
    .filter((r) => r && r.selected === true && r.installed === false && r.available !== false)
    .map((r) => ({ id: r.id, label: r.label || r.id }));

  if (!missing.length) {
    return { show: false, reason: 'ok', missing: [], message: '' };
  }

  return {
    show: true,
    reason: 'selected-not-installed',
    missing,
    message: missing.length === 1
      ? `${missing[0].label} was selected during setup but is not installed.`
      : `${missing.length} components were selected during setup but are not installed: `
        + missing.map((m) => m.label).join(', ') + '.',
  };
}

// summariseInstallResults(results) -> {ok, failed:[{id,error}], message}
//
// For the wizard's own Components step, after POST
// /api/setup/components/install. The server verifies each install against
// doctor's asset rows and retries once before giving up (server/routes/
// components.js installAndVerify), so `verified:false` here means the files are
// genuinely not there after two attempts — a fact, not a guess.
//
// verified:null (autostart, which doctor cannot observe) is NOT a failure: the
// exit code is all the information that exists for it, and inventing a warning
// from absence of evidence is the same dishonesty as the silent success was.
export function summariseInstallResults(results) {
  const rows = Array.isArray(results) ? results : [];
  const failed = rows
    .filter((r) => r && (r.ok === false || r.verified === false))
    .map((r) => ({
      id: r.id,
      error: r.error || (r.verified === false ? 'the installer finished but its files are not on disk' : 'install failed'),
    }));

  if (!failed.length) {
    return { ok: true, failed: [], message: '' };
  }
  return {
    ok: false,
    failed,
    // Names the component AND its own last words. "Install failed" with no
    // detail is never actionable, which is why the route returns the installer's
    // tail rather than a generic string.
    message: failed.map((f) => `${f.id}: ${f.error}`).join('\n'),
  };
}
