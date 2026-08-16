// setup-state.js — the pure decisions behind the first-run setup screen, split
// out of the DOM shell (setup-screen.js) so node:test can cover them with no
// browser. Same split, and the same reasoning, as auth/auth-gate-state.js vs
// auth/auth-gate.js. See test/setup-state.test.js.
//
// Backed by server/routes/setup.js:
//   GET /api/setup/status -> 200 {needsSetup, keys[], assets[], keyStoreNames[]}
//                          | 401 (the token gate is in front of it)
//
// Honesty rules, inherited from the auth gate and the PIN screen:
//   - an INDETERMINATE probe (server unreachable, unparseable body) does NOT
//     paint the screen. Telling the operator their install is incomplete
//     because the server did not answer is a guess dressed as a finding.
//   - only REQUIRED gaps open the screen unprompted. Every install has optional
//     gaps (no adb, no piper voice) and a dashboard that nags about them on
//     every boot would be trained away within a day.
//   - nothing here ever holds, echoes, or logs a key VALUE. The screen writes
//     values straight to the Electron key store and forgets them; AD-8 means
//     they never come back from the server either.

// deriveSetupNeed({status}) -> {show, reason, requiredGaps, optionalGaps, requiredDone, requiredTotal, requiredDoneCount}
//   status: {ok, status, body} from GET /api/setup/status, or null if it failed
//   reason: 'complete' | 'required-gaps' | 'unauthenticated' | 'indeterminate'
//   requiredDone: required rows that ARE satisfied (so the screen can show them
//     as stored-with-tick instead of making them vanish — vanishing reads as
//     "did saving do anything?")
//   requiredTotal / requiredDoneCount: the progress pair for the header bar.
export function deriveSetupNeed(probe) {
  const p = probe || {};
  const res = p.status || null;

  const EMPTY = { show: false, reason: 'unauthenticated', requiredGaps: [], optionalGaps: [], requiredDone: [], requiredTotal: 0, requiredDoneCount: 0 };
  if (res && res.status === 401) {
    // The token gate is in front of this and will open on its own. Saying
    // "setup incomplete" here would blame the install for an auth condition.
    return EMPTY;
  }

  const body = res && res.ok && res.body && typeof res.body === 'object' ? res.body : null;
  if (!body || !Array.isArray(body.keys) || !Array.isArray(body.assets)) {
    return { ...EMPTY, reason: 'indeterminate' };
  }

  const allRows = [...body.keys, ...body.assets].filter((r) => r && typeof r === 'object');
  const requiredRows = allRows.filter((r) => r.required === true);
  const requiredDone = requiredRows.filter((r) => r.ok === true);
  const gaps = allRows.filter((r) => r.ok === false);
  const requiredGaps = gaps.filter((r) => r.required === true);
  const optionalGaps = gaps.filter((r) => r.required !== true);

  return {
    show: requiredGaps.length > 0,
    reason: requiredGaps.length > 0 ? 'required-gaps' : 'complete',
    requiredGaps,
    optionalGaps,
    requiredDone,
    requiredTotal: requiredRows.length,
    requiredDoneCount: requiredDone.length,
  };
}

// Which gaps this client can actually FIX in place, versus the ones it can only
// describe. A key gap is fixable when the Electron key-store bridge is present;
// in a plain browser tab there is no bridge, so the honest answer is the .env
// instruction and not an input box that silently does nothing.
export function planGapActions(gaps, hasKeyStore) {
  return (gaps || []).map((gap) => {
    const keyNames = extractKeyNames(gap);
    const fixable = Boolean(hasKeyStore) && keyNames.length > 0;
    return {
      id: gap.id,
      label: gap.label,
      why: gap.why,
      fix: gap.fix,
      required: gap.required === true,
      keyNames,
      // 'store' -> we can write it here and now; 'describe' -> show the command
      // or the .env line and let the operator run it.
      action: fixable ? 'store' : 'describe',
    };
  });
}

// The key names a gap row is asking for. doctor.js reports them in `detail` for
// a satisfied row and in the same field for an unsatisfied one ("none of: A, B"
// / "missing: A"), which is deliberately parseable — but a row that names no
// keys at all (an asset gap like adb) must yield [] rather than garbage.
export function extractKeyNames(gap) {
  // Preferred source: the server now projects the requirement table's own
  // `anyOf` list as `keyNames` (server/routes/setup.js). Parsing prose out of
  // `detail` was the only option before that field existed, and it silently
  // yielded [] the moment doctor.js reworded a sentence — which presented as a
  // gap row with no input box and no explanation. The regex below stays as the
  // fallback for an older server, not as the primary path.
  if (gap && Array.isArray(gap.keyNames)) {
    return gap.keyNames.filter((s) => typeof s === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(s));
  }
  const detail = gap && typeof gap.detail === 'string' ? gap.detail : '';
  const match = /^(?:none of|missing):\s*(.+)$/.exec(detail.trim());
  if (!match) return [];
  return match[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_]{1,64}$/.test(s));
}

// validateKeyValue(name, value) -> {ok} | {ok:false, error}
// Shape only. The value is never echoed into the error text, and never trimmed
// into something different from what the operator pasted beyond the outer
// whitespace a copy/paste always brings.
export function validateKeyValue(name, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `Enter a value for ${name}.` };
  }
  if (/[\r\n]/.test(value)) {
    // A newline means a multi-line paste — usually the whole .env line, or two
    // keys at once. It would be stored verbatim and then fail confusingly at
    // the provider, so refuse it here where the cause is still obvious.
    return { ok: false, error: 'That looks like more than one line — paste just the key value.' };
  }
  if (value.length > 4096) {
    return { ok: false, error: 'That value is too long to be a key.' };
  }
  return { ok: true };
}

// interpretStoreResult(res) -> {stored, message}
// res is whatever window.mythos.setKey resolved to ({ok:true} | {ok:false,error})
// or a thrown error's message. The main process is the authority; its refusal
// text is shown verbatim rather than reworded.
export function interpretStoreResult(res, thrownMessage) {
  if (thrownMessage) {
    return { stored: false, message: String(thrownMessage) };
  }
  if (res && res.ok === true) {
    // Deliberately not "applied". Keys are decrypted into the server child's
    // env at fork() (electron/main.js decryptedKeysForChild), so a running
    // server does not see a key stored a moment ago. Saying "saved" and letting
    // the operator conclude it is live is the exact dishonesty this screen is
    // supposed to end.
    return { stored: true, message: 'Stored. Restart MYTHOS for it to take effect.' };
  }
  const error = res && typeof res.error === 'string' && res.error ? res.error : '';
  return { stored: false, message: error || 'The key store refused that value.' };
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------
// Why this section exists: the gap screen above is REACTIVE — it answers "what
// is missing here" once, at HUD boot, and paints nothing when the probe is
// indeterminate. In the packaged .exe the window is up before the forked server
// child is listening, so the very first install — the only run that actually
// needs the screen — probed too early, resolved 'indeterminate', and never
// asked again. Nobody was ever offered a place to put a key. Hence: retry the
// probe, and when this really is a fresh machine, open a WIZARD rather than a
// list of complaints.

// shouldRetryProbe(reason, attempt, maxAttempts) -> boolean
// Only 'indeterminate' is worth retrying: it means the server did not answer,
// which on a cold launch is a timing fact and not a verdict. 'unauthenticated'
// is the token gate's job, and 'complete'/'required-gaps' are real answers.
export function shouldRetryProbe(reason, attempt, maxAttempts) {
  if (reason !== 'indeterminate') return false;
  return Number(attempt) < Number(maxAttempts);
}

// retryDelayMs(attempt) -> ms
// Linear-ish backoff, capped. A cold Electron launch forks the server child
// while the window loads; a handful of seconds covers it without turning into
// a permanent poll against a server that is genuinely down.
export function retryDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(400 * n, 3000);
}

// chooseSetupScreen({need, keyStoreNames, pinConfigured}) -> 'wizard'|'gaps'|'none'
//   'wizard' — nothing has ever been configured on this machine (no key stored,
//              no PIN set) AND something required is missing. That is a first
//              run, and a first run deserves an ordered flow that also offers
//              the PIN and the optional providers, not a gap list.
//   'gaps'   — a configured machine that has drifted: show the existing list.
//   'none'   — nothing required is missing, or the probe told us nothing.
export function chooseSetupScreen(input) {
  const need = (input && input.need) || {};
  if (!need.show) return 'none';
  const names = (input && Array.isArray(input.keyStoreNames)) ? input.keyStoreNames : [];
  const pinConfigured = Boolean(input && input.pinConfigured);
  const untouched = names.length === 0 && !pinConfigured;
  return untouched ? 'wizard' : 'gaps';
}

// PIN rules, mirrored from src/core/security/pin-lock.js (PIN_RE = /^\d{4,12}$/)
// so the wizard can refuse a bad PIN before a round-trip. The SERVER stays the
// authority — this only avoids a pointless request and a vague error.
const PIN_RE = /^\d{4,12}$/;

// validatePinPair(pin, confirm) -> {ok} | {ok:false, error, field}
export function validatePinPair(pin, confirm) {
  const a = typeof pin === 'string' ? pin : '';
  const b = typeof confirm === 'string' ? confirm : '';
  if (!a) return { ok: false, error: 'Choose a PIN.', field: 'pin' };
  if (!PIN_RE.test(a)) return { ok: false, error: 'PIN must be 4–12 digits, numbers only.', field: 'pin' };
  if (!b) return { ok: false, error: 'Type the PIN again to confirm.', field: 'confirm' };
  if (a !== b) return { ok: false, error: 'The two PINs do not match.', field: 'confirm' };
  return { ok: true };
}

// interpretPinSetResult(res, body) -> {ok, message}
// The server owns the vocabulary (routes/pin.js → pinLock.setPin): 400 for a
// malformed PIN or a wrong current PIN, 429 for a standing lockout, 404 when
// PIN lock is not wired into this deployment at all. Each is shown as itself;
// none is reworded into a friendlier lie.
export function interpretPinSetResult(res, body) {
  const status = res && typeof res.status === 'number' ? res.status : 0;
  const serverError = body && typeof body.error === 'string' && body.error ? body.error : '';
  if (status === 200 && body && body.ok === true) {
    return { ok: true, message: 'PIN set. It is asked for on the next launch.' };
  }
  if (status === 404) {
    return { ok: false, message: 'This build has no PIN lock wired, so a PIN cannot be set here.' };
  }
  if (status === 429) {
    return { ok: false, message: serverError || 'Too many attempts — wait for the lockout to clear.' };
  }
  if (status === 0) {
    return { ok: false, message: 'The server did not answer. Nothing was changed.' };
  }
  return { ok: false, message: serverError || `The server refused that PIN (HTTP ${status}).` };
}

// buildProviderCatalog(body) -> [{id,label,required,ok,why,fix,keyNames,storedNames,action}]
// The wizard's key step. Unlike planGapActions this keeps SATISFIED rows too, so
// the operator can add a second provider on purpose instead of only being shown
// what is broken — "let me put in the keys I intend to use" was the actual
// request the gap screen could not serve.
export function buildProviderCatalog(body, hasKeyStore) {
  const rows = body && Array.isArray(body.keys) ? body.keys : [];
  const stored = body && Array.isArray(body.keyStoreNames) ? body.keyStoreNames : [];
  return rows.map((row) => {
    const keyNames = extractKeyNames(row);
    return {
      id: row.id,
      label: row.label,
      required: row.required === true,
      ok: row.ok === true,
      why: row.why,
      fix: row.fix,
      keyNames,
      storedNames: keyNames.filter((n) => stored.includes(n)),
      action: (hasKeyStore && keyNames.length > 0) ? 'store' : 'describe',
    };
  });
}

// wizardCanFinish(catalog, storedThisRun) -> {ok, reason}
// A wizard that lets the operator walk out with no brain lane at all should say
// so plainly rather than pretending the install is done. It does NOT block —
// blocking a dismissible screen would strand anyone who intends to use .env —
// it just supplies the honest warning text.
export function wizardCanFinish(catalog, storedThisRun) {
  const brain = (catalog || []).find((r) => r.id === 'brain');
  const fresh = storedThisRun instanceof Set ? storedThisRun : new Set(storedThisRun || []);
  const brainSatisfied = Boolean(brain && (brain.ok || brain.keyNames.some((n) => fresh.has(n))));
  if (brainSatisfied) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: 'No LLM provider key is set, so the brain has no lane and MYTHOS will not think. You can add one later from the compose bar.',
  };
}
