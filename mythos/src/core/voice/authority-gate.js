'use strict';

// authority-gate.js — "ask first" (BUG-461) and "lock memory to the operator's
// words" (BUG-464), 2026-09-24. The rules are in operator-authority.js (pure);
// this is the per-connection state around them: one spoken proposal, the
// operator's last words, and the approval that runs the proposal on a yes.
//
// Shape copied from voice-agent.js's WAVE 8 spoken send confirm, the one spoken
// approval this repo already had: one armed proposal per connection, a second
// supersedes the first, a whole-utterance yes approves (since B2c, 2026-09-26, so
// does a yes whose rest names this call's key or words: approves()), anything else
// cancels, and the SERVER runs the stored call — the model's say-so never does.
//
// What an approval binds, and where each is enforced:
//   exact call    - the leash confirm entry stores the decision; a yes runs THAT,
//                   and a re-issued call must have the same canonical signature
//   presented     - confirm.markPresented(), only after MYTHOS's own speech put
//                   the question (memory: most of the exact words) to the operator
//   connection    - confirm.acceptSpoken() is strict: same connection, never null
//   expiry        - SPOKEN_APPROVAL_TTL_MS, and any other operator speech cancels
//   single use    - acceptSpoken() deletes; consent tokens are single-use too
//   policy        - the leash is re-checked immediately before an approved dispatch
//   target        - the effector's own checks (BUG-462's page pin refuses a stale ref)
// The model cannot set any of these: every input is the operator's transcript
// (server-owned, live-session.js) or MYTHOS's own spoken output.
//
// This gate only NARROWS. It acts only on calls the leash already allowed, so a
// spoken yes can never approve something that needs a click (NEVER_TRUSTABLE,
// tier 4, trust disabled): those still take the leash's own confirm path.

const { judgeTrustedAction, judgeMemoryWrite, judgeNoteWrite, isAffirmativeReply, yesAndRest, restNamesCall, readBackMatches, leadingWords,
  KEY_WORDS } = require('./operator-authority');
const { mintConsent, signatureOf } = require('../leash/consent');
const { withoutStamp } = require('./note-stamp');

// The leash reasons that exist only because a human connection is driving
// (leash/index.js: isOperatorPresent). That premise is what BUG-461 broke.
const HUMAN_PREMISE_REASONS = new Set(['operator-present-trusted', 'session-granted']);
// Tools whose effector writes the permanent `user-facts` memory. Derived in
// the test from the effector source, not trusted from this line.
const MEMORY_TOOLS = new Set(['remember']);
// BUG-464 widened, operator decision 2026-10-06: a note is permanent memory too,
// written only when the operator asked for one or approved the exact text read
// back. Same lock (the effectors verify a consent), same gate; only the rule for
// what counts as asking differs (operator-authority.js judgeNoteWrite).
const NOTE_TOOLS = new Set(['note_take', 'write_note']);
// Every tool whose effector verifies a consent token. Derived in
// test/bug-464-background-writers-need-the-operator.test.js (d2) from the
// effector source: a tool that verifies one but is missing here could never get one.
const CONSENT_TOOLS = new Set([...MEMORY_TOOLS, ...NOTE_TOOLS]);
// voice-agent.js's VOICE_SPOKEN_CONFIRM_TTL_MS default, for the same reason.
const SPOKEN_APPROVAL_TTL_MS = 60000;

const WHY = {
  'operator-objected': "the operator's words object to acting (\"I didn't say that\")",
  'short-input': "the operator's words were too short to be sure they asked for this",
  'not-a-request': 'nothing the operator said asks for this',
  'no-operator-words': 'the operator has not said anything that asks for this',
  'not-requested': 'the operator did not ask you to remember anything',
  'operator-declined': 'the operator said not to save it',
  'bare-referent': 'the operator did not say what to remember',
  'unsupported-number': 'the text contains a number the operator did not say',
  'operator-prohibited': 'the operator\'s words tell you NOT to do this',
  'not-this-action': 'the operator\'s words do not ask for this action',
  'unsupported-operation': 'this action cannot be matched to anything the operator said',
  'content-mismatch': 'the text to save is not what the operator said',
  'note-not-requested': 'the operator did not ask you to write a note',
  'note-declined': 'the operator said not to write it down',
};
function why(reason) {
  return WHY[reason] || WHY[String(reason).replace(/-before$/, '')] || 'the operator has not clearly asked for this';
}

// One rule per kind of save, shared by the Live gate and the typed gate, so the
// two channels cannot drift: a fact must be the operator's own words (F03); a
// note needs only the operator's ask for a note (BUG-464 widened, 2026-10-06).
function judgeSave(decision, input) {
  return NOTE_TOOLS.has(decision.tool) ? judgeNoteWrite(input) : judgeMemoryWrite({ ...input, text: savedText(decision.args) });
}

// What the operator must hear read back: the note WITHOUT BUG-300's disclaimer
// (voice/note-stamp.js, 2026-10-07). The consent token still binds the stamped args.
function savedText(args) {
  const a = args || {};
  return withoutStamp(String(a.text || a.fact || a.note || a.body || a.content || '').trim()); // body/content: note_take reads them too
}

// F04 (S1, 2026-09-25): the name of what a call acts on, in words a person can
// hear — or null. A click by ref, by coordinates or by element index has no name
// in its arguments; `describeRef` (the browser effector's snapshot rows) can name
// a ref. Without a name, no question can have put THIS target to the operator:
// the known-gap test showed "Shall I play the other video instead?" presenting a
// click on a video it never named.
function targetLabel(decision, describeRef) {
  const a = decision.args || {};
  const tool = decision.tool;
  if (tool === 'see_and_click' || tool === 'ui_click') return String(a.text || a.name || '').trim() || null;
  if (tool === 'browser_select_option') return String(a.label || a.value || '').trim() || null;
  if (tool === 'browser_upload_file') return String(a.path || '').split(/[\\/]/).pop() || null;
  if (tool === 'browser_click' && a.ref && typeof describeRef === 'function') {
    try { return String(describeRef(a.ref) || '').trim() || null; } catch (_) { return null; }
  }
  return null;
}

// What the question must carry, by kind: the exact words to save or type, the
// key, or the target's name. null: nothing a question could carry, so a spoken
// yes can never approve it (the operator's own words, restated, still can).
function readBackFor(decision, describeRef) {
  const a = decision.args || {};
  if (CONSENT_TOOLS.has(decision.tool)) return { text: savedText(a), numbers: 'exact' };
  if (typeof a.text === 'string' && a.text && decision.tool !== 'see_and_click') return { text: a.text, numbers: 'exact' };
  if (typeof a.key === 'string' && a.key) return { text: a.key.replace(/([a-z])([A-Z])/g, '$1 $2'), numbers: 'subset', ordered: false };
  const label = targetLabel(decision, describeRef);
  return label ? { text: leadingWords(label), numbers: 'subset', ordered: false } : null;
}

function questionFor(decision, describeRef) {
  const a = decision.args || {};
  if (MEMORY_TOOLS.has(decision.tool)) {
    return `that reads the exact words back: "Shall I remember this: '${savedText(a).slice(0, 300)}'?"`;
  }
  if (NOTE_TOOLS.has(decision.tool)) return `that reads the exact words back: "Shall I save this note: '${savedText(a).slice(0, 300)}'?"`;
  if (typeof a.text === 'string' && a.text && decision.tool !== 'see_and_click') return `: "Shall I type '${a.text.slice(0, 200)}'?"`;
  if (typeof a.key === 'string' && a.key) return `: "Shall I press ${a.key}?"`;
  const need = readBackFor(decision, describeRef);
  if (need) return `that names it in these words: "Shall I click '${need.text}'?"`;
  return null;
}

function askResponse(decision, reason, describeRef) {
  const question = questionFor(decision, describeRef);
  if (!question) {
    // Refusal rule 1 (src/core/CLAUDE.md): name the way forward in the message.
    return {
      status: 'needs_operator_words',
      message: `${decision.tool} has NOT run: ${why(reason)}, and a yes cannot approve it because nothing here names what `
        + 'it would act on. Tell the operator in one short sentence what you were about to do, and ask them to say in '
        + `their own words what they want. When their own words ask for it, call ${decision.tool} again and it runs.`,
    };
  }
  // BUG-464 residual (i), attended 2026-09-25 02:14: the hold was right, but the
  // model said "I'll keep that in mind for next time" and never read the text
  // back, so nothing could be approved and the operator was told something false.
  // For a save, the message now says first that nothing is kept, forbids that
  // claim (and says how to take it back if already spoken), and makes the
  // read-back the very next thing said. Whether a model obeys cannot be tested
  // here; that is the attended check.
  if (CONSENT_TOOLS.has(decision.tool)) {
    return {
      status: 'needs_operator_yes',
      message: `${decision.tool} has NOT run, and nothing is saved: ${why(reason)}. Do not say you will keep it, note it `
        + 'or bear it in mind; nothing is kept unless they say yes. If you already said so, say it is not saved yet. '
        + `Your next words must be one short question ${question}, then stop and wait. Do not issue the same call again — `
        + 'if they answer yes, it is saved by itself and you will be told; if they say anything else, nothing is saved.',
    };
  }
  return {
    status: 'needs_operator_yes',
    message: `${decision.tool} has NOT run: ${why(reason)}. Ask the operator one short question ${question}, `
      + `then stop and wait. Do not call ${decision.tool} again — if they answer yes, it runs by itself and you will be `
      + 'told the outcome; if they say anything else, it does not run.',
  };
}

// MYTHOS's own speech must have put THIS proposal to the operator: an ask
// ("shall I remember", "did you want me to play") naming the kind of action,
// AND what it acts on — every word, number and negation of the text to save or
// type, the key, or the target's name (readBackFor). The ask is what keeps an
// unrelated yes out: the real 14:53:44 reply carried the saved words AND a
// question, but it TOLD ("I'll keep in mind") and asked about her health ("are
// you feeling like you're on the mend?"); a yes to that must never save
// anything. Matched on the ask phrase, not on sentence boundaries, because a
// read-back has full stops of its own. S1 (2026-09-25) closed two gaps here: a
// read-back used to count at 60% word overlap (F05), and a click at the ask
// alone, whatever it named (F04). The ask phrases are English: a question in
// Bengali or Hindi presents nothing — a bound, pinned in the tests.
const ASK_LEAD = "\\b(?:shall|should|do you want|did you want|would you like|want)\\s+(?:me\\s+to\\s+|I\\s+|me\\s+)?(?:[a-z']+\\s+){0,3}?";
const ASKS_TO_SAVE_RE = new RegExp(ASK_LEAD + '(?:remember|save|note|memori[sz]e|keep)\\b', 'i');
const ASKS_TO_TYPE_RE = new RegExp(ASK_LEAD + '(?:type|enter|write|put)\\b', 'i');
const ASKS_TO_ACT_RE = new RegExp(ASK_LEAD
  + '(?:click|play|open|close|press|select|choose|pick|tap|watch|start|go|scroll|pause|mute|unmute|resume|stop|skip|fill|upload|hit'
  + '|refresh|reload|exit|submit)\\b', 'i'); // S1: a key is asked about by what it does, too (KEY_WORDS)
function presentedBy(spoken, decision, describeRef) {
  const s = String(spoken || '');
  const need = readBackFor(decision, describeRef);
  if (!need || !need.text.trim()) return false;
  const typing = typeof (decision.args || {}).text === 'string' && decision.tool !== 'see_and_click';
  const asks = CONSENT_TOOLS.has(decision.tool) ? ASKS_TO_SAVE_RE : (typing ? ASKS_TO_TYPE_RE : ASKS_TO_ACT_RE);
  if (!asks.test(s)) return false;
  const key = (decision.args || {}).key;
  // A key is named by itself ("PageDown", "page down") or by what it does ("scroll down").
  const texts = typeof key === 'string' && key ? [key, need.text, ...(KEY_WORDS[key] || [])] : [need.text];
  return texts.some((t) => readBackMatches(s, t, { numbers: need.numbers, ordered: need.ordered !== false }));
}

// Spoken and typed words together are the operator's words; `typed` is true only
// when nothing was heard at all, which is what lets a typed command skip the
// too-short rule (operator-authority.js judgeWords).
function operatorWords(spoken, typed) {
  const s = String(spoken || '').trim(); const t = String(typed || '').trim();
  return { said: [s, t].filter(Boolean).join(' '), typed: !s && Boolean(t) };
}

// isNegative is the adapter's own spoken-"no" matcher (voice-agent.js NEGATIVE_RE),
// passed in rather than copied: the gate and the cancel path must agree on what
// "no" is, or one forgets a proposal the other still holds.
// describeRef: optional (ref) => the browser snapshot's name for that ref, or
// null (from-browser.js labelForRef). Without it a click by ref names nothing.
function createAuthorityGate({ leash, connectionId, pendingConfirms, dispatchAction, resolveConfirm, isNegative = () => false,
  logger, audit, now = Date.now, describeRef = null }) {
  const key = connectionId || null;
  // A registry without spoken approval (older callers, test fakes) never arms
  // one: the call is still held and the question still asked, but only a click
  // or the operator's own later request can then run it.
  const canArm = Boolean(key && leash.confirm && ['create', 'reject', 'markPresented', 'acceptSpoken']
    .every((m) => typeof leash.confirm[m] === 'function'));
  let proposal = null;      // { confirmId, signature, decision, presented, presentedTurnId, fresh, row }
  let lastOperator = null;  // { text, at, typed }

  function discard(reason) {
    if (!proposal) return;
    try { leash.confirm.reject(proposal.confirmId, key); } catch (_) { /* already gone is fine */ }
    pendingConfirms.delete(proposal.confirmId);
    if (logger && logger.info) logger.info('live.authority-proposal-dropped', { tool: proposal.decision.tool, reason });
    proposal = null;
  }

  function judge(decision, words) {
    const previous = lastOperator ? lastOperator.text : '';
    const previousAgeMs = lastOperator ? now() - lastOperator.at : NaN;
    const previousTyped = Boolean(lastOperator && lastOperator.typed);
    return CONSENT_TOOLS.has(decision.tool)
      ? judgeSave(decision, { current: words.said, previous, previousAgeMs, today: new Date(now()) })
      : judgeTrustedAction({ current: words.said, typed: words.typed, previous, previousAgeMs, previousTyped,
        tool: decision.tool, args: decision.args });
  }

  // B2c: a whole yes, or a yes whose rest names THIS call and its argument ("Yes,
  // refresh the web page" for a proposed F5; for a memory, the exact words to
  // keep). The same answer on both routes: the reply turn and a re-issued call.
  function approves(said, decision) {
    if (isAffirmativeReply(said)) return true;
    const rest = yesAndRest(said);
    if (rest === null) return false;
    return CONSENT_TOOLS.has(decision.tool) ? judge(decision, { said: rest, typed: false }).proceed
      : restNamesCall(rest, decision.tool, decision.args);
  }

  function propose(call, decision, verdict, reason) {
    discard('superseded');
    const tool = decision.tool;
    const row = { tool, ok: false, clarification: true, summary: `${tool} held: ${why(reason)}.`, traceId: call.id };
    // leash.check() has already written "allow" for this call. Without a line
    // saying it was then held, the audit would show a click that never happened
    // (the dispatcher's `blocked` row is the precedent). No operator words in it.
    if (audit && typeof audit.write === 'function') {
      try { audit.write({ tool, tier: verdict.tier, decision: 'held', outcome: null, reason: 'awaiting-operator-yes: ' + reason,
        actor: 'voice-live', traceId: call.id || null }); } catch (_) { /* the hold stands whether or not its record could be written */ }
    }
    if (!canArm) return { response: askResponse(decision, reason, describeRef), row }; // no person to approve it by voice
    const confirmId = leash.confirm.create(`Voice (spoken yes): ${tool}`, { decision, goalId: null, tier: verdict.tier },
      key, { spoken: true, ttlMs: SPOKEN_APPROVAL_TTL_MS });
    pendingConfirms.set(confirmId, { name: tool, callId: call.id, createdAt: now(), spoken: true });
    proposal = { confirmId, signature: signatureOf(tool, decision.args), decision, presented: false, fresh: true, row };
    if (logger && logger.info) logger.info('live.authority-held', { tool, reason });
    return { response: askResponse(decision, reason, describeRef), row };
  }

  // {} -> run it as the leash decided; { consent } -> run it with that consent;
  // { response, row } -> do not run; send `response` to the model.
  // `heard`: { spoken, typed } — this turn's operator words so far, from
  // live-session.js (the echo-accepted transcript, and HUD-typed text).
  function hold(call, decision, verdict, heard) {
    const memory = CONSENT_TOOLS.has(decision.tool); // a save of any kind: remember, or a note (2026-10-06)
    if (!memory && !(verdict && verdict.allow && HUMAN_PREMISE_REASONS.has(verdict.reason))) return {};
    const words = operatorWords(heard && heard.spoken, heard && heard.typed);
    const said = words.said;
    if (proposal && proposal.signature === signatureOf(decision.tool, decision.args)) {
      if (proposal.presented && approves(said, decision)) {
        const p = proposal; proposal = null; pendingConfirms.delete(p.confirmId);
        const action = leash.confirm.acceptSpoken(p.confirmId, key);
        if (action) return memory ? { consent: mintConsent({ tool: decision.tool, args: decision.args, basis: 'approved-proposal' }) } : {};
      } else if (proposal.presented) {
        return { response: { status: 'waiting_for_operator', message: `${decision.tool} has NOT run: you already asked the `
          + 'operator and they have not answered yes. Do not call it again; if they say yes it runs by itself.' },
        row: { tool: decision.tool, ok: false, clarification: true, summary: `${decision.tool} still waiting for a yes.`, traceId: call.id } };
      }
    }
    const judged = judge(decision, words);
    if (judged.proceed) return memory ? { consent: mintConsent({ tool: decision.tool, args: decision.args, basis: 'operator-request' }) } : {};
    return propose(call, decision, verdict, judged.reason);
  }

  function runApproved(confirmId, action) {
    const decision = action.decision || action;
    let verdict;
    try { verdict = leash.check(decision, { connectionId: key, goalId: null }); } catch (err) { verdict = { allow: false, reason: 'gate failure' }; }
    if (!verdict || !verdict.allow) {
      return Promise.resolve(resolveConfirm(confirmId, { ok: false, result: 'no longer permitted: ' + ((verdict && verdict.reason) || 'unknown') }, true));
    }
    const consent = CONSENT_TOOLS.has(decision.tool) ? mintConsent({ tool: decision.tool, args: decision.args, basis: 'approved-proposal' }) : null;
    return Promise.resolve()
      .then(() => dispatchAction(decision, { tier: verdict.tier, channel: 'voice-live', traceId: confirmId, consent }))
      .then((outcome) => resolveConfirm(confirmId, outcome, true))
      .catch((err) => resolveConfirm(confirmId, { ok: false, result: String((err && err.message) || err) }, true));
  }

  // F05: a read-back counts only if the room heard it. live-session.js reports
  // per turn how many audio parts Gemini sent and how many times it cut the turn;
  // no audio (a reply shown but not spoken), any cut, or a caller that reports
  // neither is not evidence the operator heard the question. A cut the HUD made
  // alone arrives afterwards, as onUnheard().
  function heardInFull({ interrupts, audioParts }) {
    return Number.isFinite(interrupts) && interrupts === 0 && Number.isFinite(audioParts) && audioParts > 0;
  }

  // Once per Live turn, before the adapter's own confirm handling. Returns the
  // approved dispatch's promise when the operator's yes ran the proposal.
  function onTurnComplete({ userText, assistantText, typedText, turnId, interrupts, audioParts } = {}) {
    const words = operatorWords(userText, typedText);
    const said = words.said;
    let approval = null;
    if (proposal) {
      const fresh = proposal.fresh; proposal.fresh = false;
      if (said && isNegative(said) && !isAffirmativeReply(said)) {
        proposal = null; // the adapter's spoken-"no" path rejects the entry and tells the model
      } else if (fresh || !said) {
        if (!proposal.presented && presentedBy(assistantText, proposal.decision, describeRef)) {
          if (heardInFull({ interrupts, audioParts })) {
            proposal.presented = leash.confirm.markPresented(proposal.confirmId, key);
            proposal.presentedTurnId = proposal.presented ? turnId : null;
            if (proposal.row) proposal.row.presented = proposal.presented; // read by fragment-guard.js
          } else if (logger && logger.info) {
            logger.info('live.authority-not-heard', { tool: proposal.decision.tool,
              interrupts: Number.isFinite(interrupts) ? interrupts : null, audioParts: Number.isFinite(audioParts) ? audioParts : null });
          }
        }
      } else if (proposal.presented && approves(said, proposal.decision)) {
        const p = proposal; proposal = null;
        const action = leash.confirm.acceptSpoken(p.confirmId, key);
        if (action) approval = runApproved(p.confirmId, action);
        else pendingConfirms.delete(p.confirmId);
      } else {
        discard('other-speech'); // WAVE 8: anything but a yes supersedes the proposal
      }
    }
    if (said) lastOperator = { text: said, at: now(), typed: words.typed };
    return approval;
  }

  // The HUD's 'voice-unheard' report (server/index.js), for the turn that just
  // ended: the room did not hear part of it. If that turn presented the proposal,
  // it no longer has — a yes to half a question approves nothing (rev 8 S1:
  // "interruption clears presentation"). Any cut counts; where it fell is not
  // compared, because an audio position mapped onto transcript words is an estimate.
  function onUnheard(entry) {
    const turnId = entry && entry.turnId;
    if (!proposal || !proposal.presented || turnId == null || proposal.presentedTurnId !== turnId) return false;
    proposal.presented = false; proposal.presentedTurnId = null;
    if (typeof leash.confirm.unmarkPresented === 'function') leash.confirm.unmarkPresented(proposal.confirmId, key);
    if (proposal.row) proposal.row.presented = false;
    if (logger && logger.info) logger.info('live.authority-presentation-revoked', { tool: proposal.decision.tool, reason: 'unheard' });
    return true;
  }

  return { hold, onTurnComplete, onUnheard, _internal: { get proposal() { return proposal; } } };
}

// The typed/batch path (voice-agent.js). The words are the operator's own typed
// or transcribed utterance, passed by the server; there is no spoken output to
// check presentation against, so a proposal is approved by the NEXT utterance
// being a yes AND the model re-issuing the identical call. Bound, pinned.
function createTypedMemoryGate({ now = Date.now } = {}) {
  const pending = new Map(); // connectionId -> { signature, at }
  function hold(decision, said, connectionId) {
    if (!CONSENT_TOOLS.has(decision.tool)) return {};
    const k = connectionId || 'system';
    const signature = signatureOf(decision.tool, decision.args);
    const armed = pending.get(k);
    pending.delete(k);
    if (armed && armed.signature === signature && now() - armed.at <= SPOKEN_APPROVAL_TTL_MS && isAffirmativeReply(said)) {
      return { consent: mintConsent({ tool: decision.tool, args: decision.args, basis: 'approved-proposal' }) };
    }
    const judged = judgeSave(decision, { current: said, today: new Date(now()) });
    if (judged.proceed) return { consent: mintConsent({ tool: decision.tool, args: decision.args, basis: 'operator-request' }) };
    pending.set(k, { signature, at: now() });
    // BUG-464 residual (i): say nothing is kept, and forbid the unbacked claim.
    return { refuse: `Not saved: ${why(judged.reason)}, so nothing is saved. Do not say you will keep it or bear it in mind. `
      + `Read this exact text back and ask whether to save it${NOTE_TOOLS.has(decision.tool) ? ' as a note' : ''}: `
      + `"${savedText(decision.args).slice(0, 300)}". It is saved only if their next message is a plain yes.` };
  }
  return { hold };
}

// Review finding, 2026-10-07: a clicked Approve on a confirm card is the operator
// approving exactly that call. server/index.js's confirm-accept dispatched with no
// consent, so a consent-gated tool that needed a click (autonomy ceiling 0, or a
// boundaries.md that lowers it) was refused after the operator approved it ("Not
// saved (no-consent)"). Minted here, because only this file mints (test-pinned).
// The card shows the call's own arguments, and the token binds exactly those.
// Only a reported 'click': the same route takes app.js's thumbs-up gesture, which
// auto-clicked an approval once (G4, confirm-surface-attribution.test.js), and an
// 'unknown' surface is no evidence of a person at all.
function consentForClickedConfirm(decision, surface) {
  return surface === 'click' && decision && CONSENT_TOOLS.has(decision.tool)
    ? mintConsent({ tool: decision.tool, args: decision.args, basis: 'approved-proposal' }) : null;
}

module.exports = { createAuthorityGate, createTypedMemoryGate, HUMAN_PREMISE_REASONS, MEMORY_TOOLS, NOTE_TOOLS, CONSENT_TOOLS,
  SPOKEN_APPROVAL_TTL_MS, consentForClickedConfirm };
