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
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
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
    return fail('Could not open WhatsApp for ' + label + ': ' + String(launched.result) +
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
      'foreground (' + String(focused.result) + '), so I did not type anything. The message is NOT sent.');
  }

  // 4. Type the message, verified against the target window.
  const typed = await fromPc.ui_type({ text: message, pid });
  if (!typed.ok) {
    return fail('The chat with ' + label + ' is open but I could not type the message: ' +
      String(typed.result) + '. Nothing was sent.');
  }

  const typedInto = (typed.result && typed.result.typedIntoTitle) || '';
  if (send === false) {
    return ok({
      recipient: label, number: recipient.number, message,
      sent: false, composed: true, window: typedInto,
      note: 'Typed the message into the chat with ' + label + ' and left it unsent, as asked.',
    });
  }

  // 5. Submit. Enter goes to the foreground window, which step 3 verified and
  //    step 4 confirmed again by reporting the pid the text landed in.
  const submitted = await fromPc.send_key({ key: 'enter' });
  if (!submitted.ok) {
    return fail('The message to ' + label + ' is typed into the chat but pressing Enter failed (' +
      String(submitted.result) + '), so it is NOT sent. It is sitting in the composer.');
  }

  return ok({
    recipient: label,
    number: recipient.number,
    message,
    sent: true,
    window: typedInto,
    // Precise about the evidence: the keystrokes are verified, delivery is not.
    note: 'Typed the message into WhatsApp\'s chat with ' + label + ' (verified it went to that window) ' +
      'and pressed Enter. I have not read the conversation back, so I cannot confirm WhatsApp delivered it.',
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
  // exported for tests
  _internal: { resolveRecipient, sanitizeNumber, sanitizeMessage, CONTACTS_PATH },
};
