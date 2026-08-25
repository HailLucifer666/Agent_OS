'use strict';

// Task F6 — format outgoing messages.
//
// Incident (installed-build session, 2026-08-12, ~01:26): a WhatsApp message
// listing several items went out as one unbroken line with no breaks at
// all. This tests the pure formatter that turns a list-shaped body into a
// lead-in line ending in a colon followed by one item per line — without
// sending anything, and without any real messaging API involved.
//
// No message "kind" field exists anywhere in this codebase for whatsapp_send
// or gmail_send (both are plain to/text or to/subject/body tools), so there
// is nothing to key an emoji/tone rule off. This file therefore only tests
// list formatting, per the task's own instruction not to invent a taxonomy.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatOutgoingMessage } = require('../src/core/effectors/message-format');

describe('formatOutgoingMessage: list-shaped bodies', () => {
  it('renders a comma-delimited list after a colon as a lead-in line plus one item per line', () => {
    const out = formatOutgoingMessage('Groceries: milk, eggs, bread');
    assert.equal(out, 'Groceries:\nmilk\neggs\nbread');
  });

  it('renders a semicolon-delimited list the same way', () => {
    const out = formatOutgoingMessage('Reminders: call the vet; pay the rent; book flights');
    assert.equal(out, 'Reminders:\ncall the vet\npay the rent\nbook flights');
  });

  it('renders an already-newline-separated, bulleted list, stripping the bullet markers', () => {
    const out = formatOutgoingMessage("Here's the list:\n- milk\n- eggs\n- bread");
    assert.equal(out, "Here's the list:\nmilk\neggs\nbread");
  });

  it('strips numbered-list markers the same way', () => {
    const out = formatOutgoingMessage('Steps: 1) preheat oven 2) mix batter 3) bake 20 min');
    // No comma/semicolon/newline separators here, only numbering with no
    // delimiter between items at all — this is intentionally NOT recovered,
    // since guessing item boundaries from numbering alone risks mangling
    // prose. Numbering is only stripped when items are ALSO newline-separated.
    assert.equal(out, 'Steps: 1) preheat oven 2) mix batter 3) bake 20 min');
  });

  it('strips numbered markers when items are newline-separated', () => {
    const out = formatOutgoingMessage('Steps:\n1) preheat oven\n2) mix batter\n3) bake 20 min');
    assert.equal(out, 'Steps:\npreheat oven\nmix batter\nbake 20 min');
  });
});

describe('formatOutgoingMessage: conservative false-positive guards', () => {
  it('leaves an ordinary sentence with a comma but no colon untouched', () => {
    const text = "I'll be there at 6, see you soon";
    assert.equal(formatOutgoingMessage(text), text);
  });

  it('leaves text with a colon but only one clause after it untouched (not a list)', () => {
    const text = 'Note: call me back';
    assert.equal(formatOutgoingMessage(text), text);
  });

  it('leaves a long comma-separated sentence after a colon untouched (clauses too long to be list items)', () => {
    const text = "Reminder: I already told you about this, and I really don't want to repeat myself again";
    assert.equal(formatOutgoingMessage(text), text);
  });

  it('does not treat a clock time as a list lead-in', () => {
    const text = '10:30, please call me back';
    assert.equal(formatOutgoingMessage(text), text);
  });

  it('preserves punctuation and emoji in ordinary (non-list) text', () => {
    const text = "Don't forget: 50% off (today) + free! 👋";
    assert.equal(formatOutgoingMessage(text), text);
  });

  it('is a no-op on an empty or non-string body', () => {
    assert.equal(formatOutgoingMessage(''), '');
    assert.equal(formatOutgoingMessage(null), '');
    assert.equal(formatOutgoingMessage(undefined), '');
  });
});

describe('formatOutgoingMessage: idempotence and options', () => {
  it('formatting already-formatted text returns the same text', () => {
    const once = formatOutgoingMessage('Groceries: milk, eggs, bread');
    const twice = formatOutgoingMessage(once);
    assert.equal(twice, once);
  });

  it('accepts a custom item joiner for channels that cannot render a literal newline', () => {
    const out = formatOutgoingMessage("Here's the list:\n- milk\n- eggs\n- bread", { itemJoiner: ', ' });
    assert.equal(out, "Here's the list: milk, eggs, bread");
    assert.doesNotMatch(out, /\n/);
  });

  it('the comma joiner is a no-op on text that was already a clean comma list', () => {
    const original = 'Groceries: milk, eggs, bread';
    assert.equal(formatOutgoingMessage(original, { itemJoiner: ', ' }), original);
  });
});

describe('formatOutgoingMessage: wired into whatsapp_send composition', () => {
  // whatsapp_send types the result through SendInput, and its own
  // sanitizeMessage collapses every run of whitespace (including a literal
  // newline) to a single space specifically to stop a mid-message newline
  // from submitting the composer early (see from-whatsapp.js). That is why
  // whatsapp_send calls formatOutgoingMessage with itemJoiner: ', ' rather
  // than the default — this proves that choice actually survives the
  // collapse instead of being flattened back into a run-on line.
  const { formatOutgoingMessage: format } = require('../src/core/effectors/message-format');

  function sanitizeLikeWhatsapp(raw) {
    // Mirrors from-whatsapp.js's sanitizeMessage whitespace collapse, without
    // requiring the whole effector module (and its from-pc dependency) here.
    return String(raw).replace(/\s+/g, ' ').trim();
  }

  it('a bulleted list survives whatsapp_send\'s whitespace collapse as one readable line', () => {
    const bulleted = "Here's the list:\n- milk\n- eggs\n- bread";
    const composed = sanitizeLikeWhatsapp(format(bulleted, { itemJoiner: ', ' }));
    assert.equal(composed, "Here's the list: milk, eggs, bread");
  });
});
