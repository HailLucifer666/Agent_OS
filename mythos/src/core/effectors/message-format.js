'use strict';

// message-format.js — pure formatting for outgoing message bodies.
//
// Incident (installed-build session, 2026-08-12, ~01:26): a WhatsApp message
// that listed several items went out as one run-on line with no breaks at
// all. Nothing between "the model composed a reply" and "the effector typed
// it" ever recognised a list-shaped body and rendered it as one.
//
// DETECTION RULE — deliberately narrow, chosen over a "does this look like a
// list" guess:
//
//   Only a body with a COLON that separates a non-empty lead-in from a
//   non-empty tail of >=2 delimited items counts as "list-shaped". A colon
//   used this way ("Here's your list: milk, eggs, bread") is a strong,
//   low-ambiguity signal that a lead-in introduces a list — ordinary
//   sentences essentially never use a colon like that. Requiring it is what
//   keeps this from mangling a normal sentence that merely happens to
//   contain a comma or two ("I'll be there at 6, see you soon" has a comma
//   but no colon, so it is left untouched).
//
//   Items are recovered from the tail in this priority, matching the two
//   signals named in the task: (1) the body already emitted separators —
//   literal newlines, optionally with bullet/number markers ("- ", "* ",
//   "1) "); then (2) semicolons; then (3) commas — but comma-splitting only
//   counts as a list when every resulting piece is short (<= MAX_ITEM_CHARS),
//   so a single comma-heavy sentence after a colon ("Reminder: I already
//   told you about this, and I really don't want to repeat myself") is not
//   torn into fragments.
//
//   A lead-in that is purely digits ("10:30, leave now") is rejected even
//   though the shape otherwise matches — a clock time is the single most
//   common false positive for a bare colon check, and a real list lead-in is
//   essentially never just a number.
//
// NO MESSAGE "KIND"/TONE/EMOJI LOGIC. Neither whatsapp_send (from-whatsapp.js)
// nor gmail_send (from-gmail.js) carries any notion of message kind — no
// enum, no tag, nothing a tone/emoji rule could key off. Adding one here
// would be inventing a taxonomy nothing in the codebase produces, so this
// module only implements the list formatting.
// Comma-split items only count as a list when every piece is both short and
// few-worded — a plain length cap alone let a couple of ordinary clauses
// ("and I really don't want to repeat myself again", 9 words / 48 chars)
// through as "list items"; requiring both catches that while still passing
// real short list entries ("pick up dry cleaning").
const MAX_ITEM_CHARS = 40;
const MAX_ITEM_WORDS = 6;
const BULLET_PREFIX_RE = /^\s*(?:[-*•‣◦]|\d+[.)])\s+/;
const PURE_DIGITS_RE = /^\d+$/;

function stripBullet(item) {
  return item.replace(BULLET_PREFIX_RE, '').trim();
}

function looksLikeListItem(s) {
  if (!s || s.length > MAX_ITEM_CHARS) return false;
  return s.trim().split(/\s+/).length <= MAX_ITEM_WORDS;
}

// Returns an array of >=2 items, or null if the tail does not decompose into
// a list by any of the three signals.
function splitItems(tail) {
  const byLine = tail.split('\n').map((s) => s.trim()).filter(Boolean);
  if (byLine.length >= 2) return byLine.map(stripBullet);

  const bySemicolon = tail.split(';').map((s) => s.trim()).filter(Boolean);
  if (bySemicolon.length >= 2) return bySemicolon.map(stripBullet);

  const byComma = tail.split(',').map((s) => s.trim()).filter(Boolean);
  if (byComma.length >= 2 && byComma.every(looksLikeListItem)) {
    return byComma.map(stripBullet);
  }
  return null;
}

// formatOutgoingMessage(text, opts?) -> string
//
// opts.itemJoiner (default '\n') controls how recovered items are rejoined.
// The default matches the task's literal contract — "one item per line" —
// and is what a channel that renders real line breaks (email) should use.
// A channel whose transport cannot carry a literal newline into the message
// it types (WhatsApp's SendInput-based composer refuses to, by design — see
// from-whatsapp.js's sanitizeMessage) can pass itemJoiner: ', ' instead,
// which turns an already-bulleted/newline list into one clean punctuated
// line rather than losing its structure to a later whitespace collapse.
function formatOutgoingMessage(rawText, opts) {
  const text = String(rawText == null ? '' : rawText);
  const itemJoiner = (opts && typeof opts.itemJoiner === 'string') ? opts.itemJoiner : '\n';

  const colonIndex = text.indexOf(':');
  if (colonIndex < 0) return text;

  const leadIn = text.slice(0, colonIndex).trim();
  const tail = text.slice(colonIndex + 1).trim();
  if (!leadIn || !tail) return text;
  if (PURE_DIGITS_RE.test(leadIn)) return text; // clock-time false positive ("10:30, ...")

  const items = splitItems(tail);
  if (!items || items.length < 2 || items.some((i) => !i)) return text;

  // The separator right after the colon is not the item joiner itself
  // (joining with ", " would otherwise print "lead-in:, item1, item2") — it
  // is just whatever whitespace matches the joiner's own shape.
  const afterColon = itemJoiner.indexOf('\n') !== -1 ? '\n' : ' ';
  return leadIn + ':' + afterColon + items.join(itemJoiner);
}

module.exports = { formatOutgoingMessage };
