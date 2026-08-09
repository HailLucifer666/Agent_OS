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

// deriveSetupNeed({status}) -> {show, reason, requiredGaps, optionalGaps}
//   status: {ok, status, body} from GET /api/setup/status, or null if it failed
//   reason: 'complete' | 'required-gaps' | 'unauthenticated' | 'indeterminate'
export function deriveSetupNeed(probe) {
  const p = probe || {};
  const res = p.status || null;

  if (res && res.status === 401) {
    // The token gate is in front of this and will open on its own. Saying
    // "setup incomplete" here would blame the install for an auth condition.
    return { show: false, reason: 'unauthenticated', requiredGaps: [], optionalGaps: [] };
  }

  const body = res && res.ok && res.body && typeof res.body === 'object' ? res.body : null;
  if (!body || !Array.isArray(body.keys) || !Array.isArray(body.assets)) {
    return { show: false, reason: 'indeterminate', requiredGaps: [], optionalGaps: [] };
  }

  const rows = [...body.keys, ...body.assets].filter((r) => r && r.ok === false);
  const requiredGaps = rows.filter((r) => r.required === true);
  const optionalGaps = rows.filter((r) => r.required !== true);

  return {
    show: requiredGaps.length > 0,
    reason: requiredGaps.length > 0 ? 'required-gaps' : 'complete',
    requiredGaps,
    optionalGaps,
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
