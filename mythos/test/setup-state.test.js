'use strict';

// js/setup/setup-state.js — the pure decisions behind the first-run setup screen.
//
// The behaviours worth pinning are the ones that would make the screen either
// dishonest or annoying, and both failure directions are easy to reintroduce:
//   - painting "your install is incomplete" when the server merely did not
//     answer, or when the real condition is "not authenticated yet";
//   - opening itself for optional gaps, which trains the operator to dismiss it
//     without reading, at which point it protects nothing;
//   - saying "saved" in a way that implies a stored key is already live. It is
//     not — keys reach the server child's env at fork().
//
// Run: cd mythos && node --test test/setup-state.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The module is browser ESM (it imports nothing, but it uses `export`), and this
// suite is CJS. Rather than add a build step or a loader, evaluate the source
// with its `export ` keywords stripped — the same trick the HUD's other pure-module
// tests would need, and it keeps the module itself free of any test-shaped seam.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'setup', 'setup-state.js'),
  'utf8'
);
const factory = new Function(`${SRC.replace(/^export /gm, '')}
  return { deriveSetupNeed, planGapActions, extractKeyNames, validateKeyValue, interpretStoreResult,
           shouldRetryProbe, retryDelayMs, chooseSetupScreen, validatePinPair, interpretPinSetResult,
           buildProviderCatalog, wizardCanFinish };`);
const {
  deriveSetupNeed, planGapActions, extractKeyNames, validateKeyValue, interpretStoreResult,
  shouldRetryProbe, retryDelayMs, chooseSetupScreen, validatePinPair, interpretPinSetResult,
  buildProviderCatalog, wizardCanFinish,
} = factory();

const okBody = (rows) => ({
  ok: true,
  status: 200,
  body: { needsSetup: rows.some((r) => !r.ok && r.required), keys: rows, assets: [], keyStoreNames: [] },
});

describe('deriveSetupNeed', () => {
  it('opens for a required gap', () => {
    const need = deriveSetupNeed({
      status: okBody([{ id: 'brain', label: 'Brain', required: true, ok: false, detail: 'none of: GOOGLE_API_KEY' }]),
    });
    assert.equal(need.show, true);
    assert.equal(need.reason, 'required-gaps');
    assert.equal(need.requiredGaps.length, 1);
  });

  it('does NOT open for optional gaps alone — but still lists them once open', () => {
    const need = deriveSetupNeed({
      status: okBody([{ id: 'adb', label: 'adb', required: false, ok: false, detail: null }]),
    });
    assert.equal(need.show, false, 'a dashboard that nags about optional gaps every boot gets dismissed unread');
    assert.equal(need.reason, 'complete');
    assert.equal(need.optionalGaps.length, 1, 'and they are still available to show alongside a required one');
  });

  it('treats 401 as an auth condition, never as an incomplete install', () => {
    const need = deriveSetupNeed({ status: { ok: false, status: 401, body: null } });
    assert.equal(need.show, false);
    assert.equal(need.reason, 'unauthenticated', 'the token gate owns this case and opens on its own');
  });

  it('an unreachable or unparseable server is indeterminate, and paints nothing', () => {
    assert.deepEqual(deriveSetupNeed({ status: null }).reason, 'indeterminate');
    assert.deepEqual(deriveSetupNeed({ status: { ok: true, status: 200, body: null } }).reason, 'indeterminate');
    assert.deepEqual(deriveSetupNeed({ status: { ok: true, status: 200, body: { keys: 'nope' } } }).reason, 'indeterminate');
    assert.equal(deriveSetupNeed({}).show, false, 'no probe at all must never paint');
  });

  it('a fully wired machine produces nothing', () => {
    const need = deriveSetupNeed({ status: okBody([{ id: 'brain', label: 'Brain', required: true, ok: true }]) });
    assert.equal(need.show, false);
    assert.equal(need.reason, 'complete');
  });

  it('reports the required progress pair so the header bar can be honest', () => {
    const rows = [
      { id: 'brain', label: 'Brain', required: true, ok: true },
      { id: 'live-voice', label: 'Gemini Live', required: true, ok: false },
      { id: 'stt', label: 'STT', required: false, ok: false },
    ];
    const need = deriveSetupNeed({ status: okBody(rows) });
    assert.equal(need.requiredTotal, 2);
    assert.equal(need.requiredDoneCount, 1);
    assert.deepEqual(need.requiredDone.map((r) => r.id), ['brain'],
      'satisfied required rows are listed so the screen can show them as stored-with-tick');
    assert.equal(need.requiredGaps.length, 1);
    assert.equal(need.show, true);
  });

  it('requiredDone stays empty when nothing required is satisfied', () => {
    const rows = [{ id: 'brain', label: 'Brain', required: true, ok: false }];
    const need = deriveSetupNeed({ status: okBody(rows) });
    assert.equal(need.requiredTotal, 1);
    assert.equal(need.requiredDoneCount, 0);
    assert.deepEqual(need.requiredDone, []);
  });
});

describe('extractKeyNames', () => {
  it('reads the key names out of an unsatisfied anyOf row', () => {
    assert.deepEqual(
      extractKeyNames({ detail: 'none of: GOOGLE_API_KEY, GROQ_API_KEY' }),
      ['GOOGLE_API_KEY', 'GROQ_API_KEY']
    );
  });

  it('reads them out of a partially satisfied allOf row', () => {
    assert.deepEqual(extractKeyNames({ detail: 'missing: GOOGLE_REFRESH_TOKEN' }), ['GOOGLE_REFRESH_TOKEN']);
  });

  it('yields nothing for an asset gap that names no keys', () => {
    assert.deepEqual(extractKeyNames({ detail: 'no .onnx voices in models/piper' }), []);
    assert.deepEqual(extractKeyNames({ detail: null }), []);
    assert.deepEqual(extractKeyNames({}), []);
  });

  it('rejects anything that is not an env-var-shaped name', () => {
    // Guards against turning a prose detail into an input box labelled with
    // arbitrary server text.
    assert.deepEqual(extractKeyNames({ detail: 'none of: not a key, GOOD_KEY' }), ['GOOD_KEY']);
  });
});

describe('planGapActions', () => {
  const keyGap = { id: 'brain', label: 'Brain', required: true, why: 'w', fix: 'f', detail: 'none of: GROQ_API_KEY' };
  const assetGap = { id: 'adb', label: 'adb', required: false, why: 'w', fix: 'node scripts/setup-android.js --install', detail: null };

  it('offers to store a key gap when the desktop key store is present', () => {
    const [plan] = planGapActions([keyGap], true);
    assert.equal(plan.action, 'store');
    assert.deepEqual(plan.keyNames, ['GROQ_API_KEY']);
  });

  it('falls back to describing it in a plain browser tab, where there is no bridge', () => {
    const [plan] = planGapActions([keyGap], false);
    assert.equal(plan.action, 'describe',
      'an input box that silently does nothing is worse than the instruction to edit .env');
  });

  it('always describes an asset gap — no input box can install adb', () => {
    assert.equal(planGapActions([assetGap], true)[0].action, 'describe');
  });
});

describe('validateKeyValue', () => {
  it('rejects empty and whitespace-only input', () => {
    assert.equal(validateKeyValue('GOOGLE_API_KEY', '').ok, false);
    assert.equal(validateKeyValue('GOOGLE_API_KEY', '   ').ok, false);
  });

  it('rejects a multi-line paste, because it is usually the whole .env line', () => {
    const res = validateKeyValue('GOOGLE_API_KEY', 'GOOGLE_API_KEY=abc\nGROQ_API_KEY=def');
    assert.equal(res.ok, false);
    assert.match(res.error, /more than one line/);
  });

  it('never echoes the value into the error text', () => {
    const res = validateKeyValue('GOOGLE_API_KEY', 'CANARY\nSECRET');
    assert.doesNotMatch(res.error, /CANARY/);
  });

  it('accepts an ordinary key', () => {
    assert.equal(validateKeyValue('GOOGLE_API_KEY', 'AIza-not-a-real-key').ok, true);
  });
});

describe('interpretStoreResult', () => {
  it('says stored, and says it is not live until a restart', () => {
    const res = interpretStoreResult({ ok: true });
    assert.equal(res.stored, true);
    assert.match(res.message, /[Rr]estart/,
      'keys are read into the child env at fork() — implying otherwise is the dishonesty this screen exists to end');
  });

  it('shows the main process refusal verbatim', () => {
    const res = interpretStoreResult({ ok: false, error: 'this key name is reserved (env-injection vector)' });
    assert.equal(res.stored, false);
    assert.match(res.message, /env-injection vector/, 'the main process is the authority; do not reword it');
  });

  it('reports a thrown IPC denial rather than swallowing it', () => {
    const res = interpretStoreResult(null, 'mythos:set-key: denied — sender is not the HUD window');
    assert.equal(res.stored, false);
    assert.match(res.message, /denied/);
  });

  it('never claims success on an unrecognized answer', () => {
    assert.equal(interpretStoreResult(undefined).stored, false);
    assert.equal(interpretStoreResult({}).stored, false);
  });
});

// ---------------------------------------------------------------------------
// First-run additions
// ---------------------------------------------------------------------------
// The bug these pin: on the packaged .exe the BrowserWindow is up before the
// fork()ed server child is listening, so the boot probe answered nothing,
// deriveSetupNeed said 'indeterminate' (correctly — it knew nothing), and the
// screen never asked again. A brand-new install was therefore never offered a
// place to put an API key, and there was no PIN-creation client at all.

describe('shouldRetryProbe', () => {
  it('retries an indeterminate probe — that is the cold-launch race, not a verdict', () => {
    assert.equal(shouldRetryProbe('indeterminate', 1, 12), true);
    assert.equal(shouldRetryProbe('indeterminate', 11, 12), true);
  });

  it('stops at the attempt ceiling instead of polling a dead server forever', () => {
    assert.equal(shouldRetryProbe('indeterminate', 12, 12), false);
  });

  it('never retries a real answer, and never fights the token gate', () => {
    assert.equal(shouldRetryProbe('required-gaps', 1, 12), false);
    assert.equal(shouldRetryProbe('complete', 1, 12), false);
    assert.equal(shouldRetryProbe('unauthenticated', 1, 12), false,
      'the auth gate opens on its own; re-probing behind it just 401s again');
  });
});

describe('retryDelayMs', () => {
  it('backs off and stays capped', () => {
    assert.equal(retryDelayMs(1), 400);
    assert.equal(retryDelayMs(2), 800);
    assert.equal(retryDelayMs(50), 3000);
  });
});

describe('chooseSetupScreen', () => {
  const need = { show: true };

  it('opens the wizard when nothing has ever been configured here', () => {
    assert.equal(chooseSetupScreen({ need, keyStoreNames: [], pinConfigured: false }), 'wizard');
  });

  it('keeps the gap list for a configured machine that has drifted', () => {
    assert.equal(chooseSetupScreen({ need, keyStoreNames: ['GROQ_API_KEY'], pinConfigured: false }), 'gaps');
    assert.equal(chooseSetupScreen({ need, keyStoreNames: [], pinConfigured: true }), 'gaps');
  });

  it('paints nothing when there is no required gap to report', () => {
    assert.equal(chooseSetupScreen({ need: { show: false }, keyStoreNames: [], pinConfigured: false }), 'none');
  });
});

describe('extractKeyNames', () => {
  it('prefers the server-projected keyNames over parsing doctor prose', () => {
    assert.deepEqual(
      extractKeyNames({ keyNames: ['GROQ_API_KEY', 'GOOGLE_API_KEY'], detail: 'none of: SOMETHING_ELSE' }),
      ['GROQ_API_KEY', 'GOOGLE_API_KEY'],
    );
  });

  it('still parses detail when the server is older than the keyNames field', () => {
    assert.deepEqual(extractKeyNames({ detail: 'missing: NIM_API_KEY' }), ['NIM_API_KEY']);
  });

  it('rejects a junk name rather than passing it to setKey', () => {
    assert.deepEqual(extractKeyNames({ keyNames: ['ok_NAME', 'not a key name', ''] }), ['ok_NAME']);
  });
});

describe('validatePinPair', () => {
  it('mirrors pin-lock.js (4–12 digits) so a bad PIN costs no round-trip', () => {
    assert.equal(validatePinPair('1234', '1234').ok, true);
    assert.equal(validatePinPair('123', '123').ok, false);
    assert.equal(validatePinPair('1234567890123', '1234567890123').ok, false);
    assert.equal(validatePinPair('12ab', '12ab').ok, false);
  });

  it('names the field to focus, and never echoes the PIN in the error', () => {
    const mismatch = validatePinPair('1234', '5678');
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.field, 'confirm');
    assert.doesNotMatch(mismatch.error, /1234|5678/);
  });
});

describe('interpretPinSetResult', () => {
  it('confirms only on the server saying ok', () => {
    assert.equal(interpretPinSetResult({ status: 200 }, { ok: true }).ok, true);
    assert.equal(interpretPinSetResult({ status: 200 }, {}).ok, false,
      'a 200 without ok:true is not a confirmation');
  });

  it('passes the server refusal through instead of rewording it', () => {
    const res = interpretPinSetResult({ status: 400 }, { error: 'Incorrect PIN.' });
    assert.equal(res.ok, false);
    assert.match(res.message, /Incorrect PIN/);
  });

  it('reports lockout, an unwired deployment, and a dead server distinctly', () => {
    assert.match(interpretPinSetResult({ status: 429 }, { error: 'locked for 42s' }).message, /42s/);
    assert.match(interpretPinSetResult({ status: 404 }, {}).message, /no PIN lock/i);
    assert.match(interpretPinSetResult(null, null).message, /did not answer/i);
  });
});

describe('buildProviderCatalog', () => {
  const body = {
    keys: [
      { id: 'brain', label: 'Brain', required: true, ok: false, keyNames: ['GROQ_API_KEY', 'GOOGLE_API_KEY'], why: 'w', fix: 'f' },
      { id: 'stt', label: 'STT', required: false, ok: true, keyNames: ['GROQ_API_KEY'], why: 'w', fix: 'f' },
    ],
    assets: [],
    keyStoreNames: ['GROQ_API_KEY'],
  };

  it('keeps SATISFIED rows too — the point is adding a provider on purpose', () => {
    const catalog = buildProviderCatalog(body, true);
    assert.equal(catalog.length, 2);
    assert.equal(catalog[1].ok, true, 'a configured row must still be offered, not hidden');
  });

  it('marks which names are already stored, by name only', () => {
    const brain = buildProviderCatalog(body, true)[0];
    assert.deepEqual(brain.storedNames, ['GROQ_API_KEY']);
  });

  it('describes instead of offering an input when there is no key store', () => {
    assert.equal(buildProviderCatalog(body, false)[0].action, 'describe',
      'a browser tab has no bridge; an input box there would silently do nothing');
  });
});

describe('wizardCanFinish', () => {
  const catalog = [{ id: 'brain', ok: false, keyNames: ['GROQ_API_KEY', 'GOOGLE_API_KEY'] }];

  it('warns when no brain lane exists — and says what will not work', () => {
    const verdict = wizardCanFinish(catalog, new Set());
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /brain/i);
  });

  it('counts a key stored during this run, which the server cannot see yet', () => {
    assert.equal(wizardCanFinish(catalog, new Set(['GOOGLE_API_KEY'])).ok, true);
  });

  it('accepts a row the server already reports as satisfied', () => {
    assert.equal(wizardCanFinish([{ id: 'brain', ok: true, keyNames: [] }], new Set()).ok, true);
  });
});
