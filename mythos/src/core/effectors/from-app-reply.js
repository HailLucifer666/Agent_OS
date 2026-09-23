'use strict';

// from-app-reply.js — WAVE 7. Reply into whatever chat app is already open, and
// STOP before sending.
//
// This is the operator's headline ask, and the reason it is its own effector
// rather than a prompt instruction is that "do not press Enter" has to be true by
// construction. On 2026-07-31 MYTHOS pressed Enter into a real Slack DM twice
// before any text had verifiably reached it, then said "I have typed the message
// and sent it." A rule in a prompt cannot prevent that. A tool with no code path
// to Enter can.
//
// The sequence, every step of which can refuse:
//   1. Find the app among the windows that ALREADY EXIST (never launch — the
//      operator said "reply", so the conversation is on screen). Two matches means
//      ask, not guess.
//   2. Focus it, and confirm via the foreground-pid oracle that focus took.
//   3. Read the screen through OCR (Wave 4) so what follows is grounded in what
//      is actually displayed rather than in a vision model's prose.
//   4. Locate the message box through UIA and put the caret in it, then confirm
//      the element now holding the caret is genuinely editable.
//   5. Type, and read the text back out of the box (Wave 2).
//   6. Return sendPending:true. Nothing here sends.
//
// The result carries the read-back quote so MYTHOS can say the exact words that
// are sitting in the box, and the operator can press Enter — or say "send", which
// Wave 8 turns into a spoken confirm.

const pcChild = require('../../../adapters/pc-child');
const { effectorFromTool } = require('./adapter');
const evidence = require('./evidence');
const fromPc = require('./from-pc');
// BUG-443 (2026-09-18). Every failure sentence below is SPOKEN and written to
// vault/Audit, and each of them used to render its reason with String(). from-pc
// returns structured failures ({ok:false, result:{error, ...}}), so on
// 2026-09-16 the operator heard, and the Audit recorded, the literal:
//   "Could not type the reply into whatsapp: [object Object] Nothing was sent."
// The more the producer said, the less reached the person. This is the third
// instance of the class here — dispatch-action.js on 2026-07-29 and BUG-101
// before it — which is why the shared normalizer already existed and the fix is
// to REACH it rather than to write a fourth private one.
const { reasonText } = require('../util/reason-text');

function ok(result) { return { ok: true, result }; }
function fail(message) { return { ok: false, result: message }; }

async function pc(cmdObj) {
  const st = pcChild.getStatus();
  if (!st || st.state !== 'ONLINE') {
    return { ok: false, error: 'PC automation is not running' + (st && st.hint ? ' (' + st.hint + ')' : '') + '.' };
  }
  return pcChild.sendCommand(cmdObj);
}

// Chat apps we know how to reach, by process name. Deliberately a list rather
// than "anything the model names": app_reply types into whatever it resolves, and
// a fuzzy match on an arbitrary string is how you end up typing into a banking
// window that happened to match.
const KNOWN_APPS = {
  slack: /^slack$/i,
  teams: /^(ms-?teams|teams)$/i,
  whatsapp: /^whatsapp$/i,
  discord: /^discord$/i,
  telegram: /^telegram(desktop)?$/i,
  signal: /^signal$/i,
  outlook: /^outlook$/i,
};

function resolveAppKey(app) {
  const wanted = String(app || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!wanted) return null;
  if (KNOWN_APPS[wanted]) return wanted;
  const keys = Object.keys(KNOWN_APPS);
  const partial = keys.filter((k) => k.indexOf(wanted) !== -1 || wanted.indexOf(k) !== -1);
  return partial.length === 1 ? partial[0] : null;
}

async function app_reply({ app, text }) {
  if (!text || !String(text).trim()) return fail('The reply text is required.');
  if (!app || !String(app).trim()) {
    return fail('Which app? Name the chat app that is open — ' + Object.keys(KNOWN_APPS).join(', ') + '.');
  }

  const key = resolveAppKey(app);
  if (!key) {
    return fail('I do not know how to reply in "' + app + '". I can reply in: ' +
      Object.keys(KNOWN_APPS).join(', ') + '.');
  }
  const nameRe = KNOWN_APPS[key];

  // ---- 1. Find it among windows that already exist. Never launch. ----------
  const wins = await pc({ cmd: 'list_windows' });
  if (!wins.ok) return fail('Could not list the open windows: ' + reasonText(wins.error || 'unknown error'));

  const all = (wins.result && wins.result.windows) || [];
  const matches = all.filter((w) => nameRe.test(String(w.process || w.processName || '')));

  if (matches.length === 0) {
    return fail(key + ' is not open, so there is no conversation to reply to. ' +
      'Open it and the reply will go into whatever chat is on screen.');
  }
  if (matches.length > 1) {
    // Ask rather than pick. Two Slack windows means two conversations, and
    // guessing puts a private reply in the wrong one.
    return fail('There are ' + matches.length + ' ' + key + ' windows open: ' +
      matches.map((w) => '"' + String(w.title || '(untitled)') + '" (pid ' + w.pid + ')').join(', ') +
      '. Which one should I reply in?');
  }

  const target = matches[0];
  const targetPid = target.pid;
  const targetTitle = String(target.title || '');

  // ---- 2. Focus it, and prove focus took. ---------------------------------
  const focused = await pc({ cmd: 'focus_window', pid: targetPid });
  if (!focused.ok) {
    return fail('Could not bring ' + key + ' to the front: ' + reasonText(focused.error || 'focus refused') +
      '. Nothing was typed.');
  }
  const fg = await pc({ cmd: 'get_foreground_window' });
  if (fg.ok && fg.result && typeof fg.result.pid === 'number' && fg.result.pid !== targetPid) {
    // The foreground-pid oracle disagrees with the focus call's own ok:true.
    return fail('Asked Windows to focus ' + key + ' (pid ' + targetPid + ') but "' +
      String(fg.result.title || '') + '" (pid ' + fg.result.pid + ') still has the keyboard. ' +
      'Typing now would go to the wrong window, so nothing was typed.');
  }

  // ---- 3. Ground in what is actually on screen (Wave 4). ------------------
  // Best-effort context, not a gate: OCR may have no language pack, and that must
  // not stop a reply the operator asked for.
  let onScreen = [];
  try {
    const ocr = await pc({ cmd: 'screen_read_text' });
    if (ocr.ok && ocr.result && typeof ocr.result.text === 'string') {
      onScreen = ocr.result.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-12);
    }
  } catch (_) { /* grounding is a bonus here, not a precondition */ }

  // ---- 4. Put the caret in a genuinely editable message box. --------------
  const box = await pc({ cmd: 'focus_message_box', pid: targetPid });
  if (!box.ok || !box.result || box.result.focused !== true) {
    return fail('I can see ' + key + ' ("' + targetTitle + '") but I could not find its message box: ' +
      reasonText(box.error || (box.result && box.result.error) || 'no editable element') +
      '. Nothing was typed — I will not guess where the text goes.');
  }

  // ---- 5. Type, and read it back. ----------------------------------------
  const typed = await fromPc.ui_type({ text: String(text), pid: targetPid });

  if (!typed.ok) {
    return fail('Could not type the reply into ' + key + ': ' +
      reasonText(typed.result || typed.error || 'typing failed') + ' Nothing was sent.');
  }

  const composed = {
    app: key,
    window: targetTitle,
    pid: targetPid,
    text: String(text),
    messageBox: { via: box.result.via, method: box.result.method, name: box.result.name || null },
    existingTextBefore: box.result.existingText || '',
    onScreen: onScreen,
    // The contract, stated in the payload the model reads: this is composed, not
    // sent, and the human closes the loop.
    sendPending: true,
    sent: false,
  };

  if (evidence.isVerified(typed)) {
    return evidence.verifiedOk(ok(composed), {
      oracle: 'read-back',
      expected: String(text),
      observed: String(typed.evidence.observed),
    });
  }

  // Typed, but the box would not read back. Say so — do not upgrade it to a quote.
  return evidence.unverified(ok(composed),
    reasonText(typed.reason || 'the message box would not read its text back') +
    ' — the reply may be in ' + key + ', but I cannot quote it back to you, so check before sending');
}

const TOOLS = [
  {
    name: 'app_reply',
    description: 'Type a reply into the message box of a chat app that is ALREADY OPEN (slack, teams, ' +
      'whatsapp, discord, telegram, signal, outlook), then STOP without sending. Use for "reply to that", ' +
      '"answer him on Slack", "type back that I am on my way". It focuses the app, finds the real message ' +
      'box through the accessibility tree, types, and reads the text back so you can be told exactly what ' +
      'is sitting in the box. It NEVER presses Enter: the operator sends, or says "send". Does not launch ' +
      'anything — if the app is not open, it says so.',
    params: {
      app: 'string - the chat app that is open: slack|teams|whatsapp|discord|telegram|signal|outlook',
      text: 'string - the reply to type',
    },
    // Not danger: nothing leaves the machine. Composing into a visible box that
    // the operator then reads and sends is the whole point of the design.
    danger: false,
    fn: app_reply,
  },
];

function registerFromAppReply(hub) {
  for (let i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromAppReply,
  TOOLS,
  app_reply,
  KNOWN_APPS,
  _internal: { resolveAppKey },
};
