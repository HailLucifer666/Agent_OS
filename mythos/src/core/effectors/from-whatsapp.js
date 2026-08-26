'use strict';

// effectors/from-whatsapp.js — send a WhatsApp message from the desktop app.
//
// "Send a WhatsApp message to dad saying hi" is the target utterance. There was
// no desktop WhatsApp support at all before this: the only WhatsApp path in the
// repo drives a PHONE over ADB (from-android.js phone_whatsapp_send) and is
// documented as never actually sending — it pre-fills and waits for a human tap.
//
// DESIGN — why a deep link plus verified typing, and not UI hunting.
//
// The obvious approach is to automate the app like a human: click the search
// box, type the contact name, click the result, type, press Enter. That is the
// fragile path. WhatsApp Desktop is Electron, and this repo has already paid for
// that lesson twice: Chromium/CEF apps build their accessibility tree lazily and
// silently drop background clicks (see from-cua.js's header and the Spotify
// notes in CLAUDE.md), so element hunting there is a coin flip that breaks on
// every UI revision and every window size.
//
// The deep link removes the entire ambiguity: whatsapp://send?phone=<E.164>
// asks WhatsApp itself to open that exact conversation. No search box, no
// clicking, no guessing which result is the right "dad" — the app resolves the
// contact, which is the one component guaranteed to get it right.
//
// The message is then typed with ui_type against the resolved pid rather than
// passed in the deep link's &text=. Two reasons:
//   1. ui_type verifies where the keystrokes actually landed (typedIntoPid vs the
//      target), so a message typed into the wrong window is an honest failure
//      instead of a fabricated success. The &text= form gives no such evidence.
//   2. It composes with the same focus/target machinery every other app action
//      uses, so the WhatsApp path inherits future fixes to it.
//
// WHAT IS AND IS NOT VERIFIED. Enter is pressed only after focus_window has
// confirmed via GetForegroundWindow that WhatsApp really is foreground, and after
// ui_type has confirmed the text landed in that pid. That is strong evidence the
// message was submitted. It is NOT a delivery receipt: nothing here reads the
// conversation back to confirm WhatsApp accepted and sent it. The result says
// exactly that, and never claims more (the alternative — "Message delivered,
// Sir" with no oracle — is the specific failure mode this repo keeps fixing).

const { effectorFromTool } = require('./adapter');
const fromPc = require('./from-pc');
// Every launch_app below resolves a WhatsApp window this module then drives by
// explicit pid. Passing INTERNAL keeps those launches from evicting the
// operator's implicit ui_type/ui_click target (BUG-353).
const implicitTarget = require('./implicit-target');
const { formatOutgoingMessage } = require('./message-format');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

// WAVE 9. Effectors return their failure reason in .result, which is USUALLY a
// string but is an object whenever the underlying call failed with a structured
// result — and `String(obj)` renders that as "[object Object]". A real failure was
// reported to the operator exactly that way on 2026-08-01, which is a reporting
// defect of the same family as the rest of this plan: the information existed and
// the message threw it away.
function reasonText(res) {
  const r = res && typeof res === 'object' ? res.result : res;
  if (r == null) return 'no reason given';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') {
    if (typeof r.error === 'string' && r.error) return r.error;
    if (typeof r.reason === 'string' && r.reason) return r.reason;
    if (typeof (res && res.reason) === 'string' && res.reason) return res.reason;
    try { return JSON.stringify(r); } catch (_) { return 'unreportable failure'; }
  }
  return String(r);
}

// vault/Contacts/contacts.json — { "dad": "+15551234567", "mom": "+15559876543" }
// Lives in the vault (gitignored) because these are personal phone numbers: they
// must never be committed, and the open-source portability rule forbids baking
// anyone's identifiers into tracked files.
const { levenshtein } = require('../lib/levenshtein');
const CONTACTS_PATH = 'Contacts/contacts.json';
const MAX_MESSAGE_CHARS = 2000;

let vaultFs = null;
let logger = null;

// Strict E.164: a leading '+', a non-zero country-code digit, then enough
// digits to make a real international number (8-15 digits total after the
// '+', per ITU-T E.164). The '+' is REQUIRED here, unlike from-android.js's
// sanitizePhoneNumber (which is deliberately lenient because it feeds a shell
// token, not a dialable identifier) — this number goes straight into
// whatsapp://send?phone=<number>, so a bare national number with no country
// code must be refused rather than silently dialed as if it had one. This does
// NOT catch a country code that was dropped but left a plausible-length number
// behind (that is a semantic error, not a shape error); it only rejects
// strings that are not E.164-shaped at all.
const E164_RE = /^\+[1-9]\d{7,14}$/;

function sanitizeNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  return E164_RE.test(cleaned) ? cleaned : null;
}

const E164_SHAPE_HINT = 'E.164 form: a "+", then digits only, starting with a non-zero digit, ' +
  '8-15 digits total (e.g. +15551234567).';

// Collapse whitespace and drop control characters, then cap length. The text is
// typed through SendInput as Unicode, so there is no shell to escape for — but a
// newline mid-message would submit it early in WhatsApp's composer, which is a
// correctness bug, not a security one.
//
// Filtering by CODE POINT rather than with a control-character regex is
// deliberate. A literal range is dangerously easy to get wrong: `[ -]` looks like
// "space or hyphen" but is really the range 0x20-0x2D, which silently eats spaces
// and most punctuation out of every message. This loop cannot express that
// mistake, and it survives being copied through a shell without escape damage.
function sanitizeMessage(raw) {
  const collapsed = String(raw == null ? '' : raw).replace(/\s+/g, ' ');
  let out = '';
  for (const ch of collapsed) {
    const code = ch.codePointAt(0);
    if (code < 0x20) continue;                    // C0 controls
    if (code >= 0x7f && code <= 0x9f) continue;   // DEL + C1 controls
    out += ch;
  }
  return out.trim().slice(0, MAX_MESSAGE_CHARS);
}

function loadContacts() {
  if (!vaultFs || typeof vaultFs.readJSONStrict !== 'function') return {};
  try {
    // readJSONStrict, not readJSON: a corrupt contacts file must surface as an
    // anomaly rather than silently reading as "no contacts", which would look
    // identical to a missing file and send the operator hunting for the wrong bug.
    const raw = vaultFs.readJSONStrict(CONTACTS_PATH, {});
    // 2026-08-02: the file on disk was [["alex","+..."]] — an array of pairs — while
    // this reader accepted only the documented object shape and threw everything else
    // away as {}. The operator's saved contact was therefore invisible, and MYTHOS
    // answered "I have no contacts saved" over a file that plainly had one in it.
    // Accept both shapes: a reader that silently discards real data is the same
    // failure class as an effector reporting success it did not earn.
    if (Array.isArray(raw)) {
      const pairs = raw.filter((e) => Array.isArray(e) && e.length >= 2 &&
        typeof e[0] === 'string' && e[0].trim());
      return Object.fromEntries(pairs.map((e) => [String(e[0]).trim(), String(e[1])]));
    }
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (err) {
    if (logger) logger.warn('whatsapp.contacts-unreadable', { error: err.message });
    return {};
  }
}

// Resolve "dad", "Dad", "my dad", or a raw number to E.164.
// Returns { number } or { error }.
function resolveRecipient(to) {
  const wanted = String(to || '').trim();
  if (!wanted) return { error: 'Who should I message? Give a contact name or a phone number.' };

  // A string with a '+' or 3+ digits was meant as a phone number, not a
  // contact name — resolve it as a number (strictly) rather than falling
  // through to the name lookup below, which would misreport a malformed
  // number as "not in my contact list" and hide the actual problem (shape).
  const digitCount = wanted.replace(/[^\d]/g, '').length;
  if (wanted.includes('+') || digitCount >= 3) {
    const direct = sanitizeNumber(wanted);
    if (direct) return { number: direct };
    return { error: '"' + wanted + '" is not a phone number I can use. Give it in ' + E164_SHAPE_HINT };
  }

  const contacts = loadContacts();
  const names = Object.keys(contacts);
  if (!names.length) {
    return {
      error: '"' + wanted + '" is not in my contact list — I have no contacts saved yet. ' +
        'What is their phone number, in international form (e.g. +15551234567)? Tell me and ' +
        'I can save it with whatsapp_contact_save so I can message them by name next time, ' +
        'or just give me the number now to send this message.',
    };
  }

  const needle = wanted.toLowerCase().replace(/^(my|to)\s+/, '').trim();
  let fuzzyNote = null;
  let hit = names.find((n) => n.toLowerCase() === needle);
  if (!hit) hit = names.find((n) => n.toLowerCase().replace(/^(my|to)\s+/, '') === needle);
  if (!hit) {
    const partial = names.filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()));
    // Refuse an ambiguous match rather than guessing which person was meant —
    // sending a message to the wrong human is not a recoverable error.
    if (partial.length === 1) hit = partial[0];
    else if (partial.length > 1) {
      return { error: '"' + wanted + '" matches more than one contact (' + partial.join(', ') + '). Which one?' };
    }
  }
  // Fuzzy rung (2026-08-21 audit) — fires ONLY when exact, prefix-strip and
  // substring have all found nothing, so it can never override a stronger
  // match. STT renders the saved contact "Moushumi" as "Mousumi" and "Mausumi
  // Paul" as "Mousumi Paul" (one edit each); both were refused outright while
  // the refusal read the correct name aloud in its own "Known contacts" list.
  // The operator had already written that alias into vault user-facts, so the
  // system held the answer and still said no.
  //
  // Q1 (what ELSE matches this?): the cap is the whole safety story, because
  // messaging the wrong human is not recoverable. Names of 4 characters or
  // fewer get distance 1 only — at the general cap of 2, "mom" and "dad" sit
  // within reach of the same typo and there is no undo on a sent message.
  // Longer names get max(2, 20% of length), so "Mousumi"->"Moushumi" (1 edit
  // in 8) resolves while "Mousumi"->"Mausumi Paul" (6 edits) does not.
  //
  // Q8 (pin the disposition): a tie at the same distance ASKS rather than
  // picking, matching the substring rung directly above — this file's existing
  // rule that an ambiguous recipient is a question, not a guess. Deliberately
  // unlike semantic.forget()'s fuzzy pass, which DELETES on a single candidate;
  // the same audit refused to loosen that one for exactly this reason.
  if (!hit) {
    const scored = names
      .map((n) => {
        const lower = n.toLowerCase();
        const cap = lower.length <= 4 ? 1 : Math.max(2, Math.floor(lower.length * 0.2));
        return { name: n, d: levenshtein(needle, lower), cap: cap };
      })
      .filter((c) => c.d > 0 && c.d <= c.cap)
      .sort((a, b) => a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0].d < scored[1].d)) {
      hit = scored[0].name;
      fuzzyNote = 'closest match to "' + wanted + '" is saved contact "' + hit + '"';
    } else if (scored.length > 1) {
      return {
        error: '"' + wanted + '" is close to more than one contact (' +
          scored.map((c) => c.name).join(', ') + '). Which one?',
      };
    }
  }
  if (!hit) {
    return {
      error: '"' + wanted + '" is not in my contact list. Known contacts: ' + names.join(', ') +
        '. What is their phone number, in international form (e.g. +15551234567)? Tell me and ' +
        'I can save it with whatsapp_contact_save so I can message them by name next time, ' +
        'or just give me the number now to send this message. Say whatsapp_contacts to hear ' +
        'the list again.',
    };
  }

  const number = sanitizeNumber(contacts[hit]);
  if (!number) {
    return { error: 'The number saved for "' + hit + '" is not a valid phone number. Fix it in vault/' + CONTACTS_PATH + '.' };
  }
  return fuzzyNote ? { number, name: hit, fuzzyNote } : { number, name: hit };
}

  // A4: how long the composer is given to appear after focus, and how often it is
  // asked. 3s covers the measured cold start (the successful 17:31:47 attempt came
  // after the operator asked it to wait a couple of seconds) without turning a
  // genuinely dead window into a long stall — and a warm app answers on the first
  // read, before either constant is consulted.
  const COMPOSER_SETTLE_MS = 3000;
  const COMPOSER_POLL_MS = 250;

  // BUG-359 — 2026-08-25. Same question as A4's pair above, one stage EARLIER in
  // this flow: how long the WINDOW gets to appear after a deep-link activation.
  // MEASURED LIVE on this machine that day: WhatsApp's MSIX process OUTLIVES its
  // window — chat closed reads `pid=17056 processName=WhatsApp.Root
  // MainWindowHandle=0`, and after activation the SAME pid owns the visible
  // "WhatsApp" window. Activation-to-enumerable-window takes seconds. This used
  // to be probed exactly once; on a cold start that one probe landed before the
  // window existed and three operator-approved sends failed with "could not
  // identify its window" / "Process 17056 has no main window" — the second time
  // this flow produced that shape (C1 was the name mismatch; BUGS.md's C1 Q8 note
  // declined a poll until there was evidence of a timing case, and asked for
  // exactly the measurement that now exists).
  //
  // Defaults follow A4's own arithmetic, scaled for the heavier event: 6s of
  // settle, asked every 400ms. BOTH apply only on the failure path — a window
  // present on the first probe answers immediately, so the warm send gains
  // nothing and loses nothing.
  const WINDOW_SETTLE_MS = 6000;
  const WINDOW_POLL_MS = 400;
  let windowSettleMs = WINDOW_SETTLE_MS;
  let windowPollMs = WINDOW_POLL_MS;

async function whatsapp_send({ to, text, send }) {
  const recipient = resolveRecipient(to);
  if (recipient.error) return fail(recipient.error);

  // F6: a list-shaped body ("Groceries: milk, eggs, bread") is reformatted
  // before it reaches sanitizeMessage. itemJoiner is ', ' rather than the
  // default '\n' — sanitizeMessage's whitespace collapse (a newline mid-type
  // submits WhatsApp's composer early, see its comment below) would flatten
  // real line breaks back into unpunctuated spaces, so a newline-joined list
  // would lose its structure the moment it reached that step. A comma-joined
  // rendering survives the collapse untouched and still turns an already-
  // bulleted/newline list ("- milk\n- eggs\n- bread", the shape that produced
  // the wall-of-text incident) into one clean, readable line instead of the
  // dash-soup that collapse alone leaves behind.
  const message = sanitizeMessage(formatOutgoingMessage(text, { itemJoiner: ', ' }));
  if (!message) return fail('What should the message say?');

  // A fuzzy recipient resolution is never silent: the note rides on the label,
  // which every success AND failure message below interpolates, so the operator
  // always hears which saved contact was actually chosen — including when the
  // send then fails for an unrelated reason.
  const label = (recipient.name ? recipient.name + ' (' + recipient.number + ')' : recipient.number) +
    (recipient.fuzzyNote ? ' — ' + recipient.fuzzyNote : '');

  // 1. Ask WhatsApp to open this exact conversation. The URI scheme is what makes
  //    contact resolution WhatsApp's problem rather than ours.
  const uri = 'whatsapp://send?phone=' + recipient.number.replace(/^\+/, '');
  const launched = await fromPc.launch_app({ name: uri }, implicitTarget.INTERNAL);
  if (!launched.ok) {
    return fail('Could not open WhatsApp for ' + label + ': ' + reasonText(launched) +
      ' — is WhatsApp Desktop installed?');
  }

  // 2. Resolve the WhatsApp window. launch_app on a URI may report the scheme
  //    handler rather than the app, so resolve by name as well.
  let pid = launched.result && typeof launched.result.pid === 'number' ? launched.result.pid : null;
  if (!pid) {
    const byName = await fromPc.launch_app({ name: 'whatsapp' }, implicitTarget.INTERNAL);
    if (byName.ok && byName.result && typeof byName.result.pid === 'number') pid = byName.result.pid;
  }
  // BUG-273 C1 — 2026-08-18: two sends failed here, to `mom` and to `alex`, both
  // with "WhatsApp opened the chat ... but I could not identify its window". The
  // chat opened; nothing was typed; zero messages delivered. Honest, and useless.
  //
  // Why both attempts above can come back without a pid. Step 1 launches a URI
  // (`whatsapp://send?phone=...`), and since BUG-272 T1 launch_app only reports a
  // pid when it can resolve a live windowed process whose NAME matches what was
  // asked for — a deliberate change, because a pid belonging to a different app is
  // worse than none. The name asked for here is a URI, which matches no process
  // name, so T1 correctly declines. Step 2 asks for 'whatsapp' by name, but on a
  // machine where the app is already running that is an activation whose new
  // process exits immediately (the MSIX shape BUG-272 slice 4 documents), so it
  // can decline too.
  //
  // The remedy is the one launch_app's own failure text already names: enumerate
  // what is actually open. list_windows returns {pid, processName, title, visible}
  // read from live top-level windows, which is an observation of the world rather
  // than a launch call's say-so — the same 'process-window' class of evidence T1
  // requires, obtained a different way.
  //
  // Q1 — WHAT ELSE MATCHES THIS? Matched on processName, never on title. WhatsApp's
  // window title is "(194) WhatsApp" whichever conversation is open, so a title
  // match would happily select a browser tab, an Explorer window in a WhatsApp
  // folder, or a chat with the wrong person. This is the trap that targeted the
  // operator's IDE for a launch of "notepad" on 2026-07-31, and from-pc.js's
  // Resolve-WindowedProcessByName has refused title matches ever since.
  //
  // Q8 — WHAT DELIBERATELY DOES NOT CHANGE. If this ALSO finds nothing, the send
  // still refuses. Typing blind into an unidentified window is how a message
  // reaches the wrong person, and the whole point of step 3.5 below is that even a
  // confirmed window is not a confirmed RECIPIENT. A fallback that guessed would be
  // worse than the failure it replaced.
  if (!pid && typeof fromPc.list_windows === 'function') {
    // Guarded on the function EXISTING, not just on its answer. An unguarded call
    // threw a TypeError here against a from-pc without list_windows, which turned a
    // clean refusal ("the message is NOT sent") into an exception — a worse outcome
    // than the bug being fixed, and caught by whatsapp-send.test.js's existing
    // no-window case rather than by anything written for C1.
    //
    // 2026-08-21 audit: this compared against the bare string 'whatsapp', and
    // the desktop app on Windows reports its process as "WhatsApp.Root" — 23
    // occurrences in the live vault and server log, zero occurrences of a bare
    // "WhatsApp" process. So this fallback could never identify the window it
    // was looking at, and three sends failed with "I could not identify its
    // window". bug-273-c1's fixture used processName:'WhatsApp', which is the
    // one spelling that did work — the fixture was more generous than the wire,
    // which is why a green suite sat on top of a dead code path.
    //
    // Q1 — WHAT ELSE MATCHES THIS? Anchored at both ends, and a suffix is
    // allowed only after a DOT, which is the MSIX sub-process convention that
    // produced ".Root". "WhatsAppSpoofer" and "whatsapp-web-helper" therefore do
    // not match: a process that merely STARTS with these letters is not this
    // app, and prefix matching is how an unrelated binary would inherit a send.
    // Still matched on processName only, never on title — the browser-tab trap
    // in the Q1 note above is unchanged.
    //
    // BUG-359 — an earlier Q8 note here read "no retry/settle poll was added:
    // there is no evidence of a 'window not yet enumerable' timing case." The
    // 2026-08-24 session supplied that evidence (three approved sends failing
    // while the MSIX process was alive but windowless — see the WINDOW_SETTLE_MS
    // comment above for the live capture), so the bounded poll below now exists.
    // It early-exits on the first decisive answer and still refuses blind-typing
    // when exhausted.
    //
    // Q8 — WHAT DELIBERATELY DOES NOT CHANGE. If this finds nothing even after
    // the settle window is exhausted, the send still refuses. Typing blind into
    // an unidentified window is how a message reaches the wrong person, and the
    // whole point of step 3.5 below is that even a confirmed window is not a
    // confirmed RECIPIENT. A fallback that guessed would be worse than the
    // failure it replaced.
    const deadline = Date.now() + Math.max(0, windowSettleMs);
    for (;;) {
      let listed = null;
      try { listed = await fromPc.list_windows(); } catch (_) { listed = null; }
      const rows = (listed && listed.ok && listed.result && Array.isArray(listed.result.windows))
        ? listed.result.windows : [];
      const WHATSAPP_PROCESS_RE = /^whatsapp(\.[a-z0-9._-]+)?$/;
      const matches = rows.filter((row) => {
        const name = String((row && row.processName) || '').trim().toLowerCase();
        return WHATSAPP_PROCESS_RE.test(name) && row.visible !== false && typeof row.pid === 'number';
      });
      if (matches.length === 1) {
        pid = matches[0].pid;
        break;
      }
      // Exactly one, or none. Two visible WhatsApp windows means the desktop app
      // and something else claiming the name, and picking one at random is the
      // guess this whole path exists to avoid — so it names them and stops,
      // WITHOUT waiting out the settle first: ambiguity is not cured by waiting.
      if (matches.length > 1) {
        return fail('WhatsApp opened the chat with ' + label + ', but ' + matches.length +
          ' windows report themselves as WhatsApp (pids ' + matches.map((m) => m.pid).join(', ') +
          '), so I will not guess which one to type into. The conversation should be open — ' +
          'the message is NOT sent.');
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, windowPollMs)));
    }
  }
  if (!pid) {
    return fail('WhatsApp opened the chat with ' + label + ', but I could not identify its window, ' +
      'so I cannot type into it safely — launch_app could not name it and no open window reports ' +
      'itself as WhatsApp. The conversation should be open — the message is NOT sent.');
  }

  // 3. Focus, and let the OS confirm it. focus_window verifies through
  //    GetForegroundWindow rather than trusting SetForegroundWindow's return, so
  //    an ok here means WhatsApp genuinely is the foreground window.
  const focused = await fromPc.focus_window({ pid });
  if (!focused.ok) {
    return fail('WhatsApp is open on the chat with ' + label + ', but I could not bring its window to the ' +
      'foreground (' + reasonText(focused) + '), so I did not type anything. The message is NOT sent.');
  }

  // 3.5. WAVE 9 (BUG-064) — WHO is the composer addressed to?
  //
  // Everything above verifies the WINDOW. WhatsApp's window title is
  // "(194) WhatsApp" whether the open conversation is your mother or your employer,
  // so a deep link that silently failed to switch conversations would leave the
  // PREVIOUS chat open and every check so far would still pass. The message would
  // then be typed there and Enter pressed. Sending to the wrong human is not a
  // recoverable error, so this refuses before a single character is typed.
  //
  // The oracle is the app's own words: measured 2026-07-31, WhatsApp names its
  // composer "Type a message to <recipient>", with the conversation header as an
  // independent second opinion. Either naming the intended recipient is enough;
  // neither is a refusal.
  // A4 (2026-08-14 session): the operator was right. whatsapp_send failed at
  // 17:29:26 and 17:31:11 with "could not read its message box (No editable
  // element found...)" and succeeded at 17:31:47 only because they told it to
  // wait — "WhatsApp takes a couple of seconds to start". focus_window returning
  // proves the WINDOW exists; WebView2 has not necessarily registered its
  // editable surface yet, so ps-automation.ps1 answers honestly that there is no
  // editable element and this refused a chat that was about to be readable.
  //
  // A POLL, not a sleep. A fixed delay is a guess that is simultaneously too slow
  // when the app is warm (every send pays it) and too short when it is cold. This
  // returns the instant the composer answers.
  //
  // Scope: this covers "the composer is not there yet" ONLY. The recipient-match
  // check below keeps its immediate, no-retry refusal — a composer that IS found
  // and names the wrong human must never be re-read in the hope of a better
  // answer (BUG-064: sending to the wrong human is not a recoverable error).
  //
  // Honest framing: this removes the cold-start class, it does not "fix
  // WhatsApp". The second failure that day came 105s later with the app already
  // focused, so something else is also in play.
  let composer = await fromPc.readComposeBox(pid);
  let cbox = (composer && composer.ok && composer.result) || null;
  if (!cbox) {
    const deadline = Date.now() + COMPOSER_SETTLE_MS;
    while (!cbox && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COMPOSER_POLL_MS));
      composer = await fromPc.readComposeBox(pid);
      cbox = (composer && composer.ok && composer.result) || null;
    }
  }
  if (!cbox) {
    return fail('WhatsApp is open and focused for ' + label + ', but I could not read its message box (' +
      String((composer && composer.result) || 'no message box found') + ') after waiting ' +
      Math.round(COMPOSER_SETTLE_MS / 1000) + 's for it to appear, so I cannot prove the chat on ' +
      'screen is the right one. Nothing was typed and nothing was sent.');
  }

  const wantDigits = recipient.number.replace(/\D/g, '');
  const addressee = String(cbox.name || '') + '   ' + String(cbox.headerName || '');
  const seenDigits = addressee.replace(/\D/g, '');
  // A saved contact opens by NAME in the header ("Mom"), not by number, so accept
  // either. Digits are compared with the country code stripped as well, because
  // WhatsApp renders local numbers without it once a contact is known.
  const matchedByNumber = Boolean(wantDigits) &&
    (seenDigits.includes(wantDigits) || seenDigits.includes(wantDigits.slice(-10)));
  const matchedByName = Boolean(recipient.name) &&
    addressee.toLowerCase().includes(String(recipient.name).toLowerCase());

  if (!matchedByNumber && !matchedByName) {
    // Wave 4 (2026-08-13): the deep link silently failing to switch chats is
    // the diagnosed root cause (BUGS.md) — WhatsApp was already open on a
    // DIFFERENT conversation and whatsapp://send?phone=... did not move it.
    // One retry of the SAME deep link (not an in-app search-and-click):
    // this file's own header explains why UI-hunting (search box, type,
    // click a result) was deliberately rejected as the fragile path for
    // this Electron app — a retry that reintroduces exactly that path would
    // undo the reason the deep link exists. Re-issuing the deep link is the
    // one retry consistent with the architecture already chosen; it either
    // recovers from whatever made the first navigation not take, or the
    // retry proves it wasn't a fluke and the honest fail below stands.
    const retryLaunch = await fromPc.launch_app({ name: uri }, implicitTarget.INTERNAL);
    if (retryLaunch.ok) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const retryComposer = await fromPc.readComposeBox(pid);
      const retryBox = (retryComposer && retryComposer.ok && retryComposer.result) || null;
      if (retryBox) {
        const retryAddressee = String(retryBox.name || '') + '   ' + String(retryBox.headerName || '');
        const retrySeenDigits = retryAddressee.replace(/\D/g, '');
        const retryMatchedByNumber = Boolean(wantDigits) &&
          (retrySeenDigits.includes(wantDigits) || retrySeenDigits.includes(wantDigits.slice(-10)));
        const retryMatchedByName = Boolean(recipient.name) &&
          retryAddressee.toLowerCase().includes(String(recipient.name).toLowerCase());
        if (retryMatchedByNumber || retryMatchedByName) {
          cbox.name = retryBox.name;
          cbox.headerName = retryBox.headerName;
          cbox.currentText = retryBox.currentText;
        } else {
          return fail('REFUSED: WhatsApp is showing a different conversation, and retrying the deep link ' +
            'did not switch it. I asked for ' + label + ', but the message box says "' +
            String(retryBox.name || cbox.name || '(unnamed)') + '"' +
            (retryBox.headerName ? ' and the chat header says "' + retryBox.headerName + '"' : '') +
            '. Nothing was typed and nothing was sent — open the right chat, or check the saved number.');
        }
      } else {
        return fail('REFUSED: WhatsApp is showing a different conversation. I asked for ' + label +
          ', but the message box on screen says "' + String(cbox.name || '(unnamed)') + '"' +
          (cbox.headerName ? ' and the chat header says "' + cbox.headerName + '"' : '') +
          '. A retry of the deep link could not re-read the message box either. Nothing was typed and ' +
          'nothing was sent — open the right chat, or check the saved number.');
      }
    } else {
      return fail('REFUSED: WhatsApp is showing a different conversation. I asked for ' + label +
        ', but the message box on screen says "' + String(cbox.name || '(unnamed)') + '"' +
        (cbox.headerName ? ' and the chat header says "' + cbox.headerName + '"' : '') +
        '. A retry of the deep link failed too (' + reasonText(retryLaunch) + '). Nothing was typed and ' +
        'nothing was sent — open the right chat, or check the saved number.');
    }
  }

  // Anything already sitting in the composer is the operator's draft. Report it
  // rather than silently appending this message to the end of it.
  const existingDraft = String(cbox.currentText || '').trim();

  // 4. Type the message, verified against the target window.
  const typed = await fromPc.ui_type({ text: message, pid });
  if (!typed.ok) {
    return fail('The chat with ' + label + ' is open but I could not type the message: ' +
      reasonText(typed) + '. Nothing was sent.');
  }

  const typedInto = (typed.result && typed.result.typedIntoTitle) || '';
  if (send === false) {
    return ok({
      recipient: label, number: recipient.number, message,
      sent: false, composed: true, window: typedInto,
      addressedTo: String(cbox.name || ''),
      priorDraft: existingDraft || undefined,
      note: 'Typed the message into the chat with ' + label + ' and left it unsent, as asked.' +
        (existingDraft ? ' NOTE: the composer already contained "' + existingDraft + '" — this was added after it.' : ''),
    });
  }

  // 5. Submit, and PROVE it left the box.
  //
  // This was `send_key('enter')`, which on 2026-08-01 returned ok while the message
  // sat in the composer untouched — WhatsApp is MSIX-packaged and silently discards
  // SendInput (BUG-061), so Enter was accepted and did nothing, and this function
  // reported sent:true. submitMessage invokes WhatsApp's own Send button through UIA
  // and only succeeds when the composer has actually emptied.
  const submitted = await fromPc.submitMessage(pid);
  if (!submitted.ok) {
    return fail('The message to ' + label + ' is typed into the chat but I could not submit it (' +
      reasonText(submitted) + '), so it is NOT sent. It is sitting in the composer.');
  }

  return ok({
    recipient: label,
    number: recipient.number,
    message,
    sent: true,
    window: typedInto,
    // WAVE 9: the recipient is now evidence rather than an assumption — this is
    // WhatsApp's own label for the conversation the text went into.
    addressedTo: String(cbox.name || ''),
    priorDraft: existingDraft || undefined,
    submittedVia: String((submitted.result && submitted.result.mechanism) || ''),
    // Precise about the evidence at each step: the addressee was verified before
    // typing, the text was read back out of the box, and the box then emptied. What
    // is still NOT claimed is delivery — WhatsApp's servers are not an oracle we read.
    note: 'Sent to ' + label + '. Verified before typing that the message box was addressed to "' +
      String(cbox.name || '') + '", read the text back out of the box, then submitted it via ' +
      String((submitted.result && submitted.result.mechanism) || 'the send control') +
      ' and confirmed the box emptied. I have not read the conversation back, so I cannot confirm ' +
      'WhatsApp delivered it to the recipient.',
  });
}

async function whatsapp_contacts() {
  const contacts = loadContacts();
  const names = Object.keys(contacts);
  if (!names.length) {
    return ok({
      contacts: [],
      note: 'No WhatsApp contacts saved yet. Add them to vault/' + CONTACTS_PATH +
        ' as {"dad": "+15551234567"} and I can message them by name.',
    });
  }
  // Names only — a tool result is spoken and logged, and there is no reason for a
  // full phone number to travel through either.
  return ok({ contacts: names, count: names.length });
}

// 2026-08-02: there was no way to add a contact except hand-editing
// vault/Contacts/contacts.json, which is not a thing to ask of someone mid-
// conversation — the operator hit this trying to message someone who simply
// wasn't in the file. Writes the documented object shape, so this can never be
// the thing that puts an array back on disk.
// 2026-08-12: dispatched on intent as {number: "", name: ""} before the
// operator had actually given a name or number — the tool went ahead and
// failed opaquely several steps in (an unwritable-vault message, or a
// generic "not a phone number" for an empty string) instead of naming what
// was actually missing. Validate both arguments before touching the vault at
// all: the message here is read by the MODEL, not spoken to the operator, so
// it says exactly which field to ask for rather than a human-friendly excuse.
async function whatsapp_contact_save({ name, number }) {
  const label = String(name || '').trim();
  if (!label) return fail('Ask the operator for the missing name before calling this.');
  const rawNumber = String(number == null ? '' : number).trim();
  if (!rawNumber) return fail('Ask the operator for the missing number before calling this.');

  if (!vaultFs || typeof vaultFs.writeJSON !== 'function') {
    return fail('The vault is not writable, so I cannot save contacts right now.');
  }
  const e164 = sanitizeNumber(number);
  if (!e164) {
    return fail('"' + String(number || '') + '" is not a phone number I can use. Give it in ' + E164_SHAPE_HINT);
  }

  const contacts = loadContacts();
  const existing = Object.keys(contacts).find((n) => n.toLowerCase() === label.toLowerCase());
  const previous = existing ? contacts[existing] : null;
  if (existing) delete contacts[existing];
  contacts[label] = e164;

  const written = vaultFs.writeJSON(CONTACTS_PATH, contacts);
  if (written && written.ok === false) {
    return fail('Could not save ' + label + ': ' + reasonText(written));
  }

  // Oracle: read the file back and confirm the name resolves through the same
  // path whatsapp_send will use. Writing without re-reading is how the array-shape
  // bug above stayed invisible.
  const check = resolveRecipient(label);
  if (check.error || check.number !== e164) {
    return fail('I wrote ' + label + ' to the contacts file but could not read it back ' +
      'as a usable contact (' + (check.error || 'resolved to something else') + '). Not saved reliably.');
  }

  return ok({
    saved: label,
    replaced: previous ? true : false,
    evidence: 'read-back',
    // Deliberately no number in the result — this is spoken aloud and written to
    // the episodic log, same reasoning as whatsapp_contacts above.
    note: (previous ? 'Updated ' : 'Saved ') + label + '. You can now say "send a WhatsApp to ' + label + '".',
  });
}

// Wave 4 (2026-08-13): whatsapp_contact_save already deletes-then-rewrites a
// contact internally when replacing one (line ~439 above) — there was just no
// way to remove one WITHOUT immediately re-adding it, so a throwaway/bad
// contact could only be overwritten with a new number, never actually
// removed. Same case-insensitive lookup whatsapp_contact_save and
// resolveRecipient already use.
async function whatsapp_contact_delete({ name }) {
  const label = String(name || '').trim();
  if (!label) return fail('Ask the operator for the contact name to delete before calling this.');

  if (!vaultFs || typeof vaultFs.writeJSON !== 'function') {
    return fail('The vault is not writable, so I cannot delete contacts right now.');
  }

  const contacts = loadContacts();
  const existing = Object.keys(contacts).find((n) => n.toLowerCase() === label.toLowerCase());
  if (!existing) {
    return fail('No saved contact named "' + label + '". Nothing to delete.');
  }
  delete contacts[existing];

  const written = vaultFs.writeJSON(CONTACTS_PATH, contacts);
  if (written && written.ok === false) {
    return fail('Could not delete ' + existing + ': ' + reasonText(written));
  }

  // Oracle: read the file back and confirm the name no longer resolves,
  // same discipline as whatsapp_contact_save's own read-back.
  const check = resolveRecipient(existing);
  if (!check.error) {
    return fail('I wrote the contacts file without ' + existing + ' but it still resolves to a number ' +
      '(' + check.number + '). Not deleted reliably.');
  }

  return ok({
    deleted: existing,
    evidence: 'read-back',
    note: 'Deleted ' + existing + ' from saved contacts.',
  });
}

const TOOLS = [
  {
    name: 'whatsapp_send',
    description: 'Send a WhatsApp message from the desktop app. Use for "send a WhatsApp to dad saying hi", ' +
      '"whatsapp mom that I am running late", "text X on WhatsApp". `to` is a saved contact name or a phone ' +
      'number in E.164 form (+15551234567). Opens the exact conversation via WhatsApp\'s own deep link, types ' +
      'the message into the verified window, and presses Enter. Set send:false to compose without sending.',
    params: { to: 'string', text: 'string', send: 'boolean (optional, default true)' },
    danger: true,
    fn: whatsapp_send,
  },
  {
    name: 'whatsapp_contacts',
    description: 'List the WhatsApp contact names available to message by name. Use when the operator asks ' +
      'who you can message, or after a contact lookup fails.',
    params: {},
    danger: false,
    fn: whatsapp_contacts,
  },
  {
    name: 'whatsapp_contact_save',
    description: 'Save or update a WhatsApp contact so it can be messaged by name later. Use for ' +
      '"save Mousumi\'s number as +91...", "remember dad\'s WhatsApp is +1...". `number` must be full ' +
      'international form (+15551234567). Reach for this when whatsapp_send reports it has no number ' +
      'for someone, instead of telling the operator to edit a file.',
    params: { name: 'string - the name to message them by', number: 'string - phone number in E.164 form, e.g. +15551234567' },
    danger: true,
    fn: whatsapp_contact_save,
  },
  {
    name: 'whatsapp_contact_delete',
    description: 'Permanently remove a saved WhatsApp contact by name. Use for "delete the WhatsApp contact ' +
      'for X", "forget X\'s WhatsApp number", or cleaning up a throwaway/test contact. Destructive — the ' +
      'contact can no longer be messaged by name afterward.',
    params: { name: 'string - the saved contact name to remove' },
    danger: true,
    fn: whatsapp_contact_delete,
  },
];

function registerFromWhatsapp(hub, ctx) {
  vaultFs = (ctx && ctx.memory && ctx.memory.fs) || (ctx && ctx.vault) || null;
  logger = (ctx && ctx.logger) || null;
  // BUG-359 test seam — same shape as createLiveToolAdapter's toolAckDeadlineMs:
  // production registers without these and gets WINDOW_SETTLE_MS/WINDOW_POLL_MS.
  if (ctx && Number.isFinite(ctx.windowSettleMs)) windowSettleMs = ctx.windowSettleMs;
  if (ctx && Number.isFinite(ctx.windowPollMs)) windowPollMs = ctx.windowPollMs;
  for (let i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromWhatsapp,
  TOOLS,
  whatsapp_send,
  whatsapp_contacts,
  whatsapp_contact_save,
  whatsapp_contact_delete,
  // exported for tests
  _internal: { resolveRecipient, sanitizeNumber, sanitizeMessage, CONTACTS_PATH,
    COMPOSER_SETTLE_MS, COMPOSER_POLL_MS, WINDOW_SETTLE_MS, WINDOW_POLL_MS },
};
