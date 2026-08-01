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
const CONTACTS_PATH = 'Contacts/contacts.json';
const MAX_MESSAGE_CHARS = 2000;

let vaultFs = null;
let logger = null;

// E.164-ish: digits with an optional leading +. Deliberately the same shape
// from-android.js's sanitizePhoneNumber accepts, so a number that works for the
// phone bridge works here too.
function sanitizeNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{3,15}$/.test(cleaned)) return null;
  return cleaned;
}

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

  const direct = sanitizeNumber(wanted);
  if (direct && /\d{3,}/.test(wanted.replace(/[^\d]/g, ''))) return { number: direct };

  const contacts = loadContacts();
  const names = Object.keys(contacts);
  if (!names.length) {
    return {
      error: 'I have no contacts saved, so I cannot look up "' + wanted + '". Add them to ' +
        'vault/' + CONTACTS_PATH + ' as {"' + wanted.toLowerCase() + '": "+15551234567"}, or give me the number directly.',
    };
  }

  const needle = wanted.toLowerCase().replace(/^(my|to)\s+/, '').trim();
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
  if (!hit) {
    return {
      error: 'I do not have a number for "' + wanted + '". Known contacts: ' + names.join(', ') +
        '. Add them to vault/' + CONTACTS_PATH + ' and I will send it.',
    };
  }

  const number = sanitizeNumber(contacts[hit]);
  if (!number) {
    return { error: 'The number saved for "' + hit + '" is not a valid phone number. Fix it in vault/' + CONTACTS_PATH + '.' };
  }
  return { number, name: hit };
}

async function whatsapp_send({ to, text, send }) {
  const recipient = resolveRecipient(to);
  if (recipient.error) return fail(recipient.error);

  const message = sanitizeMessage(text);
  if (!message) return fail('What should the message say?');

  const label = recipient.name ? recipient.name + ' (' + recipient.number + ')' : recipient.number;

  // 1. Ask WhatsApp to open this exact conversation. The URI scheme is what makes
  //    contact resolution WhatsApp's problem rather than ours.
  const uri = 'whatsapp://send?phone=' + recipient.number.replace(/^\+/, '');
  const launched = await fromPc.launch_app({ name: uri });
  if (!launched.ok) {
    return fail('Could not open WhatsApp for ' + label + ': ' + reasonText(launched) +
      ' — is WhatsApp Desktop installed?');
  }

  // 2. Resolve the WhatsApp window. launch_app on a URI may report the scheme
  //    handler rather than the app, so resolve by name as well.
  let pid = launched.result && typeof launched.result.pid === 'number' ? launched.result.pid : null;
  if (!pid) {
    const byName = await fromPc.launch_app({ name: 'whatsapp' });
    if (byName.ok && byName.result && typeof byName.result.pid === 'number') pid = byName.result.pid;
  }
  if (!pid) {
    return fail('WhatsApp opened the chat with ' + label + ', but I could not identify its window, ' +
      'so I cannot type into it safely. The conversation should be open — the message is NOT sent.');
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
  const composer = await fromPc.readComposeBox(pid);
  const cbox = (composer && composer.ok && composer.result) || null;
  if (!cbox) {
    return fail('WhatsApp is open and focused for ' + label + ', but I could not read its message box (' +
      String((composer && composer.result) || 'no message box found') + '), so I cannot prove the chat on ' +
      'screen is the right one. Nothing was typed and nothing was sent.');
  }

  const wantDigits = recipient.number.replace(/\D/g, '');
  const addressee = String(cbox.name || '') + '   ' + String(cbox.headerName || '');
  const seenDigits = addressee.replace(/\D/g, '');
  // A saved contact opens by NAME in the header ("Mom"), not by number, so accept
  // either. Digits are compared with the country code stripped as well, because
  // WhatsApp renders local numbers without it once a contact is known.
  const matchedByNumber = Boolean(wantDigits) &&
    (seenDigits.includes(wantDigits) || seenDigits.includes(wantDigits.slice(-10)));
  const matchedByName = Boolean(recipient.name) &&
    addressee.toLowerCase().includes(String(recipient.name).toLowerCase());

  if (!matchedByNumber && !matchedByName) {
    return fail('REFUSED: WhatsApp is showing a different conversation. I asked for ' + label +
      ', but the message box on screen says "' + String(cbox.name || '(unnamed)') + '"' +
      (cbox.headerName ? ' and the chat header says "' + cbox.headerName + '"' : '') +
      '. Nothing was typed and nothing was sent — open the right chat, or check the saved number.');
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
async function whatsapp_contact_save({ name, number }) {
  const label = String(name || '').trim();
  if (!label) return fail('What name should I save them under?');
  if (!vaultFs || typeof vaultFs.writeJSON !== 'function') {
    return fail('The vault is not writable, so I cannot save contacts right now.');
  }
  const e164 = sanitizeNumber(number);
  if (!e164) {
    return fail('"' + String(number || '') + '" is not a phone number I can use. ' +
      'Give it in full international form, like +15551234567.');
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
];

function registerFromWhatsapp(hub, ctx) {
  vaultFs = (ctx && ctx.memory && ctx.memory.fs) || (ctx && ctx.vault) || null;
  logger = (ctx && ctx.logger) || null;
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
  // exported for tests
  _internal: { resolveRecipient, sanitizeNumber, sanitizeMessage, CONTACTS_PATH },
};
