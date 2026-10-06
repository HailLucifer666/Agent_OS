'use strict';

// operator-authority.js — does what the operator SAID authorise this call?
// (BUG-461, BUG-464, 2026-09-24.) Pure: no IO, no clock, no registry — the
// caller passes the words and the ages, so every rule here is a table test.
//
// WHY THIS EXISTS. The leash lets a human connection click, type and press keys
// with no confirmation (operator-present-trusted, leash/index.js), on the
// premise that the operator "asked for out loud". Nothing checked that premise.
// Measured in Episodic 2026-09-23/24, both with a clear transcript:
//   09-24 15:11:24  browser_click, in a turn whose words were "I didn't say
//                   anything. I didn't say anything. It's the background noise."
//                   The request it carried out was the PREVIOUS turn's four-word
//                   noise transcript, "Yep, can you play".
//   09-23 14:05:39  browser_click, in a turn that said "I didn't ask you to play
//                   that video."
// And `remember` (tier 0, no gate at all) wrote "User has not been feeling well"
// to permanent memory in a turn whose transcript was "November" (09-24 14:53:37).
//
// THE RULES, and the replay behind them (every trusted click/type/key call and
// every remember call in 13 days of Episodic, 98 + 10 calls):
//   - An objection in the operator's words ("I didn't say / ask", "not talking",
//     "background noise") stops the action. Catches both measured clicks.
//   - Four words or fewer is too little to act on. The longest measured noise
//     transcripts are four words ("Yep, can you play", "What do you think?").
//     This also asked on real short commands ("further", "Mute the volume.") —
//     the operator chose that trade on 2026-09-24: "repeating it back costs a
//     second, guessing wrong brings the wrong dish". Changed 2026-09-26 (B2c):
//     a short command that starts with its verb and names THIS call's key or
//     typed words runs; see shortCommandNames() below.
//   - A longer transcript must contain a request form. The 09-11 16:37:13 click
//     rode on 34 words of a news video's own audio.
//   - A turn with no operator words (started by MYTHOS's own late-result notice)
//     inherits the judgement of the operator's LAST words, if they are recent.
//     It never inherits a free pass.
//   Replayed with this module: 61 of 98 trusted calls proceed, 37 ask. Every
//   ask is a question, never a refusal — a "yes" runs exactly the proposed call.
//   Of 10 remember calls, the 6 the operator asked for proceed; the 2 plainly
//   unrequested and 2 ambiguous 09-02 turns ask.
//
// NOT A MEANING CHECK, AND IT SAYS SO. There is no judge model here (binding
// constraint). These are English lexical proxies: a clear command in another
// language asks; a long, well-formed transcript of something the operator did
// not say proceeds. Both bounds are pinned in the test file.
//
// S1, 2026-09-25 (audit F01-F05, mythos/docs/PLAN-AUDIT-2026-09-25.md). Four
// holes, each reproduced in memory against main f456217d before this change:
//   F01 "Please do not click that button" proceeded: "please" is a request form,
//       and nothing looked for a prohibition.
//   F02 "Could you explain why this happens" authorised a click: the check saw
//       only request-SHAPED words, never which operation they asked for. The vault
//       replay (all four roots, 294 gated calls) found the real version of it: a
//       window closed after "Can you open Brave?".
//   F03 "Remember my favorite color is blue" authorised saving "...is green":
//       nothing bound the saved words to the operator's.
//   F05 "I will not remember your favorite color is blue" counted as reading
//       "Your favorite color is blue" back: 60% overlap of English words of four
//       letters or more, blind to "not", to numbers and to any other script.
// So: a prohibition always holds; a request must name the operation the call
// performs (or, for typing, dictate its text); a memory write must say only what
// the operator said; and a read-back must carry every word, number and negation
// of what it reads. Everything else asks. The rules still only narrow.

const { contentOf, unsupportedWords, sameOrder, readBackMatches, leadingWords, requiredOf } = require('./authority-words');

const SHORT_INPUT_MAX_WORDS = 4;
// A turn MYTHOS started itself (a late tool result) may carry on the operator's
// last request only this soon after it. Late results measured on 09-24 arrive
// within 10 s; a minute leaves room for a slow snapshot and no more.
const CONTINUATION_WINDOW_MS = 60000;

const DENIAL_RE = new RegExp([
  /\bI (?:didn'?t|did not|never) (?:say|said|ask|asked|tell|told|want|wanted|mean|meant)\b/.source,
  /\b(?:I'?m|I am|I was) not (?:even )?(?:talking|speaking)\b/.source,
  /\bnot (?:even )?(?:talking|speaking) to you\b/.source,
  /\bbackground (?:noise|sound|audio|voice|chatter)\b/.source,
  /\b(?:that|it) (?:wasn'?t|was not) me\b/.source,
].join('|'), 'i');

// Every verb a trusted call can be asked for by, in any family below. A
// prohibition is "don't", "do not" or "never" before one of them, up to two words
// apart ("don't ever click", "do not press anything"), or "stop clicking".
// Not prohibitions: "don't ask me", "don't forget to…", "don't wait", "why don't
// you play it" (a suggestion), and "stop playing" (a request to pause).
const ACTION_VERB = '(?:click|tap|press|hit|select|choose|pick|open|play|watch|start|resume|pause|stop|mute|unmute'
  + '|close|dismiss|skip|scroll|type|write|enter|fill|search|put|paste|add|submit|send|upload|attach|refresh|reload'
  + '|exit|quit|shut|touch|do (?:it|that|this|anything))';
// Commas may sit anywhere in it — "do not ever, under any circumstances, click"
// and "never, ever click" were a way past the first version (attacked 2026-09-25).
const PROHIBITION_RE = new RegExp('(?<!\\bwhy\\s)\\b(?:don\'?t|do not|never)[\\s,]+(?!ask\\b|forget\\b|wait\\b|worry\\b|hesitate\\b|bother\\b)'
  + '(?:[a-z\']+[\\s,]+){0,4}?(' + ACTION_VERB + ')\\b'
  + '|\\bstop ((?:click|typ|press|scroll|open|clos)ing)\\b', 'gi');
// "Don't do anything", "don't touch it": no verb to narrow by, so they hold all.
const GENERIC_PROHIBITION_RE = /^(?:touch|do )/i;
// "What if I asked you to click it?", "suppose you pressed Enter". A request
// inside a hypothetical, like one inside quotes, is mentioned, not made.
const ACTION_HYPOTHETICAL_RE = /\b(?:what if|suppose|supposing|imagine|hypothetically|if I (?:say|said|tell|told|ask|asked))\b/i;
const QUOTED_SPAN_RE = /["“‘][^"”’]{0,200}["”’]/g;

// The operations a trusted call performs, as the words that ask for them. Every
// tool the leash can allow because a human is connected must map to one — a tool
// with no family ASKS (fail safe), and test (g4) derives that population from
// the real leash. Bounded and explicit on purpose: rev 8 S1 says unsupported
// forms stay honestly unresolved and use the confirmation, rather than a parser.
// "go ahead" is an approval of something already said, not an operation.
const GO = 'go(?!\\s+ahead)';
const OPERATION_WORDS = {
  pointer: ['click', 'tap', 'press', 'hit', 'select', 'choose', 'pick', 'open', 'play', 'watch', 'start', 'resume', 'pause',
    'stop', 'mute', 'unmute', 'close', 'dismiss', 'skip', 'next', 'previous', 'back', GO, 'show', 'like', 'subscribe',
    'accept', 'check', 'uncheck', 'toggle', 'expand', 'collapse', 'enable', 'disable', 'join', 'follow', 'load', 'view',
    'switch', 'maximi[sz]e', 'minimi[sz]e', 'full ?screen', 'turn', 'bring', 'move', 'drag', 'download', 'save', 'sign in',
    'log in', 'scroll', 'add', 'submit'],
  text: ['type', 'write', 'enter', 'fill', 'search', 'put', 'input', 'insert', 'paste', 'add', 'reply', 'rename', 'replace',
    'clear', 'answer', 'look up'],
  key: ['press', 'hit', 'refresh', 'reload', 'scroll', 'page (?:up|down)', GO, 'back', 'forward', 'pause', 'play', 'resume',
    'stop', 'mute', 'unmute', 'skip', 'next', 'previous', 'rewind', 'fast ?forward', 'full ?screen', 'exit', 'escape', 'enter',
    'submit', 'tab', 'zoom', 'copy', 'paste', 'undo', 'redo', 'close', 'captions?', 'subtitles?', 'volume', 'space'],
  option: ['select', 'choose', 'pick', 'set', 'change', 'switch', 'sort', 'filter'],
  upload: ['upload', 'attach', 'add'],
  window: ['close', 'exit', 'quit', 'shut', 'dismiss', 'get rid of'],
};
// "can you try PLAYING this video" and "try SEARCHING Mousumi" ask for play and
// search: a plain word also matches its -s and -ing forms (the vault replay
// flagged both). Not -ed: "I closed it" reports, it does not ask.
function inflected(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  return word.endsWith('e') ? word.slice(0, -1) + '(?:e|es|ing)' : word + '(?:s|es|ing)?';
}
const OPERATION_RES = Object.fromEntries(Object.entries(OPERATION_WORDS)
  .map(([family, words]) => [family, new RegExp('\\b(?:' + words.map(inflected).join('|') + ')\\b', 'i')]));
const TOOL_OPERATION = Object.freeze({
  browser_click: 'pointer', ui_click: 'pointer', click_at: 'pointer', see_and_click: 'pointer', cua_click: 'pointer',
  browser_type: 'text', ui_type: 'text', browser_fill_form: 'text',
  browser_press_key: 'key', send_key: 'key',
  browser_select_option: 'option', browser_upload_file: 'upload', close_window: 'window',
});
// What each key the browser tool accepts DOES, in the words a person uses for it
// (from-browser.js ALLOWED_KEYS, RELOAD_KEYS and the player keys). A question
// may name the key or its effect: "Shall I refresh the page?" puts F5 to the
// operator as plainly as "Shall I press F5?". A key missing here can still be
// named by its own name. Test (g5) derives the key set from the effector.
const KEY_WORDS = Object.freeze({
  F5: ['refresh', 'reload'], Refresh: ['refresh', 'reload'], Reload: ['refresh', 'reload'],
  PageDown: ['page down', 'scroll down'], PageUp: ['page up', 'scroll up'],
  ArrowDown: ['down arrow', 'scroll down'], ArrowUp: ['up arrow', 'scroll up'],
  ArrowLeft: ['left arrow'], ArrowRight: ['right arrow'],
  Home: ['top'], End: ['bottom'], Escape: ['escape', 'exit'], Enter: ['enter', 'submit'],
  Tab: ['tab'], Backspace: ['backspace'], Delete: ['delete'], Space: ['space', 'pause', 'play'],
  k: ['pause', 'play', 'resume'], m: ['mute', 'unmute'], f: ['full screen', 'fullscreen'],
  c: ['captions', 'subtitles'], j: ['back 10', 'rewind'], l: ['forward 10', 'skip ahead'],
});

// "Try again", "do the same", "go ahead": no operation of their own, so they
// carry the operator's previous words' operation, if those are recent and pass.
const RETRY_RE = /\b(?:try (?:it |that |this )?again|try that|do (?:the same|it again|that again)|one more time|retry|go ahead)\b/i;
// B2c: the same, said as a whole short utterance. 09-24 15:11:06 "further", nine
// seconds after "Scroll down a bit.", asked for one more of the same press.
const CONTINUE_RE = /^(?:(?:a (?:bit|little) )?(?:further|more)|keep going|continue|again|once more)[.!]?$/i;

// B2c (2026-09-26, BUG-461, campaign C1 row 8). The operator's answer after the
// 09-25 sitting: a short command whose own words name the action runs without
// asking. Rev 8 bounds it: the words must match the operation AND its argument.
// Measured first (.cache/b2c/, read-only): of 122 short live utterances naming an
// action word, the one that was noise and reached a gated tool was "Yep, can you
// play" — a yes-word, then a question with no object. Every real one begins with
// its verb ("refresh the page", "Mythos, pause the song."). So a short command is
// a verb first, after at most these leads, and never after a yes-word or "can you".
const COMMAND_LEAD = '(?:(?:hey\\s+)?(?:mythos|jarvis)|please|now|and|also|just|ok(?:ay)?|so|then)';
const COMMAND_VERB = '(?:press|hit|refresh|reload|scroll|page|pause|play|resume|stop|mute|unmute|skip|next|previous|rewind'
  + '|fast|go|exit|escape|enter|submit|zoom|copy|paste|undo|redo|close|type|write|search|fill|put|input|insert|clear|answer'
  + '|reply|look)';
const SHORT_COMMAND_RE = new RegExp('^(?:' + COMMAND_LEAD + '[\\s,.!]+)*' + COMMAND_VERB + '\\b', 'i');
// send_key names its keys in lower case ("pagedown"); these are the browser names
// that KEY_WORDS describes. The player letters and Space are left out on purpose:
// in a desktop app they type a character, whatever YouTube does with them.
const SEND_KEY_NAMES = Object.freeze({ pagedown: 'PageDown', pageup: 'PageUp', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', escape: 'Escape', enter: 'Enter', tab: 'Tab', home: 'Home', end: 'End',
  delete: 'Delete', backspace: 'Backspace', f5: 'F5' });

// The phrases that name THIS key: its own name ("PageDown" is "page down"), and
// what it does, from the same table a question is checked against (KEY_WORDS).
function keyPhrases(tool, key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return [];
  const named = tool === 'send_key' ? SEND_KEY_NAMES[k.toLowerCase()] : k;
  const own = (named || k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[+_]/g, ' ').toLowerCase();
  return [own, ...((named && KEY_WORDS[named]) || [])];
}

function saysPhrase(said, phrase) {
  const re = new RegExp('\\b' + phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\b', 'i');
  return re.test(said);
}

// Does a short command name what THIS call does, to what? A key press: the key or
// its effect. Typing: a typing verb and every word and number typed. Anything else
// (a click on a ref, a window by pid, an option, an upload) has no argument the
// operator's words can be matched to, so it still asks — pinned in the tests.
function shortCommandNames(said, tool, args) {
  const s = unquoted(said).trim();
  if (!SHORT_COMMAND_RE.test(s)) return false;
  const family = TOOL_OPERATION[tool];
  if (family === 'key') return keyPhrases(tool, (args || {}).key).some((p) => saysPhrase(s, p));
  if (family === 'text') {
    const text = typedTextOf(tool, args);
    return Boolean(text.trim()) && OPERATION_RES.text.test(s) && !unsupportedWords(text, s).length
      && !unsupportedNumbers(text, s).length;
  }
  return false;
}

const REQUEST_PHRASE_RE = new RegExp([
  /\b(?:can|could|would|will) (?:you|we)\b/.source, /\bshall we\b/.source, /\bplease\b/.source,
  /\bgo ahead\b/.source, /\blet'?s\b/.source, /\bI (?:want|need|would like|'d like)\b/.source,
  /\bI (?:asked|told) you to\b/.source, /\b(?:you|we) (?:need|have) to\b/.source,
  /\byou should\b/.source, /\bI mean\b/.source, /\btry\b/.source, /\bjust\b/.source, /\bmake sure\b/.source,
].join('|'), 'i');
// An imperative at the start of a clause, after any run of fillers.
const IMPERATIVE_RE = new RegExp(
  '(?:^|[.?!;]\\s*)(?:(?:ok(?:ay)?|now|so|and|then|yes|yeah|yep|fantastic|great|right|alright|anyway|also|no)[\\s,.!]*)*'
  + '(?:play|click|open|close|scroll|type|search|press|pause|mute|unmute|go|select|choose|pick|tap|hit|put|write|enter'
  + '|fill|skip|stop|start|resume|show|bring|move|find|exit|maximi[sz]e|minimi[sz]e|full|next|back|add|take|grab|keep'
  + '|continue|do|turn|switch|watch|clear|remove|upload|drag|refresh|reload|zoom)\\b', 'i');

// A whole-utterance yes. Anchored at both ends on purpose (voice-agent.js's
// WAVE 8 AFFIRMATIVE_RE is the precedent): "Yep, can you play" is not a yes.
// Not "right": a bare "Right." is a filler — it is one of the fragments the
// 2026-09-23 replay measured — and WAVE 8's list does not take it either.
// B2c added "proceed", "approved" and "try again": measured replies to MYTHOS's own
// questions ("Yes, proceed. Approved.", "Yes, go ahead proceed.", "Yeah, try again.").
const AFFIRM_WORD = "(?:ok(?:ay)?|yes|yeah|yep|yup|sure|correct|exactly|absolutely|affirmative|please|go|go on|go ahead|do it|do that|that one|that'?s right|that'?s it"
  + '|proceed|approved|try (?:it |that )?again)';
const AFFIRM_ECHO = '(?:(?:please )?(?:remember|save|note|play|click|type|press|open|close) (?:it|that|this)|scroll)';
const AFFIRMATIVE_REPLY_RE = new RegExp('^(?:(?:' + AFFIRM_WORD + '|' + AFFIRM_ECHO + ')[\\s,.!]*)+$', 'i');

// B2c: a yes that goes on — the 09-25 02:19:42 residual, "Yes, refresh the web
// page". Measured (.cache/b2c/, M2): of 47 replies to MYTHOS's action questions
// that began with a yes-word, about half were not approvals at all: "Yeah, I
// heard two voices", "Okay. Moving on, what's the price…", "Yes, first find the
// path and then try to open it". So this only hands back the rest, for the caller
// to judge as a request for THIS call on its own words; a contrast, a sequence, a
// deferral, another target or a question anywhere makes it no yes at all.
const LEAD_YES_RE = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|absolutely|correct)\b[\s,.!]+(\S.*)$/i;
const NOT_A_CLEAN_YES_RE = /\b(?:but|not|no|never|instead|first|then|before|after|later|wait|maybe|else|other|another|different|next time|moving on|actually)\b|n't\b|\?/i;
function yesAndRest(text) {
  const s = plain(text).trim();
  const m = LEAD_YES_RE.exec(s);
  return m && !NOT_A_CLEAN_YES_RE.test(s) ? m[1] : null;
}

// Does the rest of a yes name THIS call and its argument by itself, as a short
// command must? Only a key or typed words can be matched. "Yes, play the third
// video" after "Shall I click 'Café Ambience'?" names another target in words a
// page label cannot be checked against (attacked 2026-09-26), so only a whole yes
// approves a click.
function restNamesCall(rest, tool, args) {
  return !DENIAL_RE.test(plain(rest)) && !prohibits(rest, tool) && shortCommandNames(rest, tool, args);
}

// An explicit ask to keep something. Each form is imperative or addressed to
// MYTHOS; "I remember when…", "do you remember…" and "can you remember what…"
// are recollection, not requests.
const RECALL_TAIL = '(?!\\s+(?:what|how|where|who|whether|the time|last time|yesterday)\\b)';
const MEMORY_REQUEST_RES = [
  new RegExp('(?:^|[.?!,;]\\s*|\\b(?:please|also|and|so|just|always|now|then|but)\\s+)remember\\b' + RECALL_TAIL, 'i'),
  new RegExp('\\b(?:can|could|would|will) you (?:please )?(?:remember|memori[sz]e|note|keep)\\b' + RECALL_TAIL, 'i'),
  /\bI (?:want|need|would like|'d like) you to (?:always )?(?:remember|memori[sz]e|note|keep (?:it |this |that )?in mind)\b/i,
  /\b(?:make|take) a note\b/i,
  /(?:^|[.?!,;]\s*|\b(?:please|also|and|so|just)\s+)note (?:that|this|it|down)\b/i,
  /\b(?:don'?t|do not) forget\b/i,
  /\bkeep (?:it |this |that )?in (?:mind|memory|your memory)\b/i,
  /\b(?:save|store|commit|put|add|write) (?:it |this |that )?(?:to|in|into) (?:your )?memory\b/i,
  /\bmemori[sz]e\b/i,
  /\bfrom now on\b/i,
  // A standing instruction addressed forward: "next time don't say it", "next
  // time when I ask you to open that link". Not "I'll try it next time".
  /\bnext time\s+(?:when\s+|if\s+)?(?:I|you|don'?t|do|just|please|always|never)\b/i,
];
// The operator's own 14:55:27 line was "You don't have to remember that."
const MEMORY_NEGATION_RE = new RegExp([
  /\b(?:don'?t|do not|no need to|needn'?t|never|not|shouldn'?t|should not)\s+(?:have to\s+|need to\s+)?(?:remember|memori[sz]e|note|save|store|keep)\b/.source,
  /(?<!\b(?:don'?t|do not)\s)\bforget (?:that|it|this|about it)\b/.source,
].join('|'), 'i');
// "If I say remember my birthday…", 'the word "remember"'.
const MEMORY_HYPOTHETICAL_RE = /\b(?:if|what if|suppose|supposing|when|whenever)\b[^.?!]{0,40}\b(?:I|you)\s+(?:say|said|tell|told|ask|asked)\b[^.?!]{0,20}?["'“‘]?\s*(?:remember|note|don'?t forget|keep in mind)/i;
// A memory phrase inside a quoted span is being mentioned, not said to MYTHOS.
const MEMORY_QUOTED_RE = /["“‘][^"”’]{0,60}\b(?:remember|note that|don'?t forget|keep in mind)\b[^"”’]{0,120}["”’]/i;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// "didn’t" with a typographic apostrophe (a phone keyboard, a pasted line) is
// the same word as "didn't"; every pattern here is written with the ASCII one and
// single spaces, so runs of whitespace collapse too — "do  not click", typed with
// two spaces, walked past the prohibition until 2026-09-25.
function plain(text) {
  return String(text || '').replace(/[’‘ʼ]/g, "'").replace(/\s+/g, ' ');
}

// A quoted request ('he said "click the red one"') is mentioned, not made.
function unquoted(text) {
  return plain(text).replace(QUOTED_SPAN_RE, ' ');
}

function hasRequestForm(text) {
  const s = unquoted(text);
  return REQUEST_PHRASE_RE.test(s) || IMPERATIVE_RE.test(s);
}

function isAffirmativeReply(text) {
  return AFFIRMATIVE_REPLY_RE.test(plain(text).trim());
}

// F01: does a prohibition in these words cover THIS call? "Type it, but do not
// press enter" (a real 09-02 line) prohibits the key press, not the typing. A
// prohibited verb in this call's family, a generic one ("don't do anything"), or
// a call with no family at all holds. Read over the WHOLE text, quotes included:
// "don't" wins over any "please" near it, and a quoted one only makes a call ask.
function prohibits(said, tool) {
  const family = TOOL_OPERATION[tool];
  for (const m of plain(said).matchAll(PROHIBITION_RE)) {
    const verb = m[1] || m[2];
    if (!family || GENERIC_PROHIBITION_RE.test(verb) || OPERATION_RES[family].test(verb)) return true;
  }
  return false;
}

// `typed`: the words came from the HUD text box, not the microphone. Typing
// cannot be background noise, so only the too-short rule — which exists for
// noise — is skipped; an objection, a prohibition or a non-request still asks.
function judgeWords(said, typed, tool, args) {
  const s = plain(said);
  if (DENIAL_RE.test(s)) return { proceed: false, reason: 'operator-objected' };
  if (prohibits(said, tool)) return { proceed: false, reason: 'operator-prohibited' };
  if (!typed && countWords(said) <= SHORT_INPUT_MAX_WORDS) {
    return shortCommandNames(said, tool, args) ? { proceed: true, reason: 'short-command' } : { proceed: false, reason: 'short-input' };
  }
  if (ACTION_HYPOTHETICAL_RE.test(s) || !hasRequestForm(said)) return { proceed: false, reason: 'not-a-request' };
  return { proceed: true, reason: 'operator-request' };
}

function typedTextOf(tool, args) {
  const a = args || {};
  if (tool === 'browser_fill_form') return (Array.isArray(a.fields) ? a.fields : []).map((f) => String((f && f.value) || '')).join(' ');
  return typeof a.text === 'string' ? a.text : '';
}

// Do these words ask for what THIS call does (F02)? A request naming a different
// operation — or none, like "could you explain why this happens" — asks. One
// widening, measured in the vault: typing is how "can you play the GTA 6 trailer"
// gets done (the search box), so a request for an on-screen action whose words
// dictate the very text typed asks for that typing too. Only then: the operator's
// words typed after "could you explain why this happens" still ask.
function namesOperation(said, tool, args) {
  const family = TOOL_OPERATION[tool];
  if (!family) return { proceed: false, reason: 'unsupported-operation' };
  const s = unquoted(said);
  if (OPERATION_RES[family].test(s)) return { proceed: true, reason: 'operator-request' };
  const text = family === 'text' ? typedTextOf(tool, args) : '';
  if (text.trim() && OPERATION_RES.pointer.test(s) && !unsupportedWords(text, said).length
    && !unsupportedNumbers(text, said).length) {
    return { proceed: true, reason: 'operator-request' };
  }
  return { proceed: false, reason: 'not-this-action' };
}

// A short command has already been matched to this call's operation and argument,
// which is stricter than namesOperation's family match.
function judgeCall(words, tool, args) {
  const verdict = judgeWords(words.said, words.typed, tool, args);
  return verdict.proceed && verdict.reason !== 'short-command' ? namesOperation(words.said, tool, args) : verdict;
}

// The words that speak for this turn: its own, or — only when it has none —
// the operator's last words, if recent. Returns null when there are none.
function wordsFor({ current, previous, previousAgeMs, typed, previousTyped }) {
  const now = String(current || '').trim();
  if (now) return { said: now, from: 'current', typed: typed === true };
  const before = String(previous || '').trim();
  if (before && Number.isFinite(previousAgeMs) && previousAgeMs >= 0 && previousAgeMs <= CONTINUATION_WINDOW_MS) {
    return { said: before, from: 'previous', typed: previousTyped === true };
  }
  return null;
}

// A click, type or key press that the leash allowed only because a human is
// connected: { current, previous, previousAgeMs, typed, previousTyped, tool,
// args }. `tool` is required — without it no operation can be matched, so the
// call asks. proceed:false means ASK, never refuse.
function judgeTrustedAction(input) {
  const i = input || {};
  const words = wordsFor(i);
  if (!words) return { proceed: false, reason: 'no-operator-words' };
  const before = words.from === 'previous';
  const verdict = judgeCall(words, i.tool, i.args);
  if (verdict.proceed) return { proceed: true, reason: before ? 'continuation' : verdict.reason };
  // "Try again" names no operation; the operator's previous words may. So may a
  // whole "further" (B2c), and only for the same call: one hop, never a chain.
  const s = plain(words.said).trim();
  if (!before && ((verdict.reason === 'not-this-action' && RETRY_RE.test(s)) || (verdict.reason === 'short-input' && CONTINUE_RE.test(s)))) {
    const earlier = wordsFor({ previous: i.previous, previousAgeMs: i.previousAgeMs, previousTyped: i.previousTyped });
    if (earlier && judgeCall(earlier, i.tool, i.args).proceed) return { proceed: true, reason: 'retry' };
  }
  return { proceed: false, reason: before ? verdict.reason + '-before' : verdict.reason };
}

function findMemoryRequest(text) {
  const s = plain(text);
  const explicit = MEMORY_REQUEST_RES.some((re) => re.test(s));
  return {
    explicit,
    negated: MEMORY_NEGATION_RE.test(s),
    // Quotes are read from the original text: plain() turns ’ into an apostrophe.
    hypothetical: MEMORY_HYPOTHETICAL_RE.test(s) || MEMORY_QUOTED_RE.test(String(text || '')),
  };
}

// Numbers are the facts a model most often supplies itself (a time, an amount,
// a phone number). Each digit run in the save must be in the operator's words
// or be part of today's date, which the model routinely appends.
function unsupportedNumbers(text, said, today) {
  const heard = new Set((String(said || '').match(/\d+/g) || []).map((d) => String(Number(d))));
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    [today.getFullYear(), today.getMonth() + 1, today.getDate()].forEach((n) => heard.add(String(n)));
  }
  return (String(text || '').match(/\d+/g) || []).filter((d) => !heard.has(String(Number(d))));
}

// The rest of the sentence after the memory request: "Please remember that MY
// SISTER'S NAME IS PRIYA." Empty when the content is in another sentence.
function requestClause(said) {
  const s = plain(said);
  let end = -1;
  for (const re of MEMORY_REQUEST_RES) {
    const m = re.exec(s);
    if (m && (end < 0 || m.index + m[0].length < end)) end = m.index + m[0].length;
  }
  return end < 0 ? '' : s.slice(end).split(/[.?!]/)[0];
}

// F03: what would be saved must be what the operator said. Every word of it
// must be in their words (so "green" for "blue", an added fact, a translation
// or a paraphrase asks), and it must keep what their request clause is about:
// "my SISTER's name is Priya" saved as "User's name is Priya" is a different
// fact, and "I DON'T like coffee" saved as "User likes coffee" is its opposite.
function contentMismatch(text, said, today) {
  if (unsupportedWords(text, said, today).length) return true;
  // Same words, other order, other fact: "I owe Ravi 500" is not "Ravi owes me 500".
  if (!sameOrder(text, said)) return true;
  const saved = contentOf(text);
  const required = requiredOf(requestClause(said));
  for (const head of required.heads) if (!saved.words.has(head)) return true;
  return required.negated && !saved.negated;
}

// A permanent-memory write. proceed:true only for an explicit, non-negated,
// non-hypothetical ask that carries its own content — and says only that.
function judgeMemoryWrite({ text, current, previous, previousAgeMs, today } = {}) {
  const words = wordsFor({ current, previous, previousAgeMs });
  if (!words) return { proceed: false, reason: 'not-requested' };
  const found = findMemoryRequest(words.said);
  if (found.negated || DENIAL_RE.test(plain(words.said))) return { proceed: false, reason: 'operator-declined' };
  if (!found.explicit || found.hypothetical) return { proceed: false, reason: 'not-requested' };
  // "Remember that." points at something the model then chooses for itself.
  if (countWords(words.said) <= SHORT_INPUT_MAX_WORDS) return { proceed: false, reason: 'bare-referent' };
  if (unsupportedNumbers(text, words.said, today).length) return { proceed: false, reason: 'unsupported-number' };
  if (contentMismatch(text, words.said, today)) return { proceed: false, reason: 'content-mismatch' };
  return { proceed: true, reason: 'operator-request' };
}

// BUG-464 widened, operator decision 2026-10-06: a NOTE (note_take, write_note)
// is permanent memory too, and is written only when the operator asked for one.
// Unlike a remembered fact, a note is a document the operator asks MYTHOS to
// compose ("write that down" after a recipe was read out), so there is no
// content check and no bare-referent rule: the ask is for a note, and what goes
// in it is the model's to draft. Anything else is read back first.
// ATTACKED 2026-10-06 before shipping (test (j1)/(j2) pin each):
//   - a READ request names a note too: "what's in my shopping note" must not
//     count. So every form here carries a write verb, and "in my X note" alone
//     never does.
//   - "Did you take a note of that?" asks about the past: excluded.
//   - negation ("you don't have to write that down"), the operator's objection,
//     quotation and "if I say take a note" do not ask.
// Bound: English lexical forms, like every rule here. A long note cannot be read
// back in full, so it is written only when the operator's own words asked.
const NOTE_REQUEST_RES = [
  /(?<!\b(?:did|have|has|had) you\s)\b(?:make|take|write|save|start|create|jot|keep)\s+(?:a|an|another|one)\s+(?:quick\s+|short\s+|new\s+)?note\b/i,
  /\b(?:write|jot|note|put|get|take)\s+(?:it|this|that|these|those|them|everything|all of (?:it|this|that))\s+down\b/i,
  /\b(?:write|jot|note) down\b/i,
  /\b(?:save|put|add|write|append|store|keep|log)\s+(?:it\s+|this\s+|that\s+|these\s+|those\s+)?(?:to|in|into|under)\s+(?:a|my|the|that|this)\s+(?:[\w'-]+\s+){0,3}?note\b/i,
  /(?:^|[.?!,;]\s*|\b(?:please|also|and|so|just)\s+)note (?:that|this|it)\b/i,
];
const NOTE_NEGATION_RE = /\b(?:don'?t|do not|no need to|needn'?t|never|not|shouldn'?t|should not)\s+(?:have to\s+|need to\s+|bother(?:\s+to)?\s+)?(?:make|take|write|save|jot|note|add|keep|put)\b/i;
const NOTE_HYPOTHETICAL_RE = /\b(?:if|what if|suppose|supposing|when|whenever)\b[^.?!]{0,40}\b(?:I|you)\s+(?:say|said|tell|told|ask|asked)\b/i;

function judgeNoteWrite({ current, previous, previousAgeMs } = {}) {
  const words = wordsFor({ current, previous, previousAgeMs });
  if (!words) return { proceed: false, reason: 'note-not-requested' };
  const s = plain(words.said);
  if (NOTE_NEGATION_RE.test(s) || DENIAL_RE.test(s)) return { proceed: false, reason: 'note-declined' };
  const asked = unquoted(words.said);
  if (NOTE_HYPOTHETICAL_RE.test(asked) || !NOTE_REQUEST_RES.some((re) => re.test(asked))) return { proceed: false, reason: 'note-not-requested' };
  return { proceed: true, reason: 'operator-request' };
}

module.exports = {
  judgeNoteWrite,
  SHORT_INPUT_MAX_WORDS, CONTINUATION_WINDOW_MS, TOOL_OPERATION, KEY_WORDS,
  DENIAL_RE, AFFIRMATIVE_REPLY_RE,
  countWords, hasRequestForm, isAffirmativeReply, yesAndRest, restNamesCall, prohibits,
  judgeTrustedAction, judgeMemoryWrite, findMemoryRequest, unsupportedNumbers, readBackMatches, leadingWords,
};
