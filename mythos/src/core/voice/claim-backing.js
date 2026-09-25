'use strict';
// claim-backing.js — does THIS action row make THIS sentence true? B2b-2 of the Stage 1 repair
// campaign (2026-09-26), BUG-448. Pure. claim-check.js asks backs(); rows carry `act` from
// action-semantics.js (what the call did, and to what).
//
// WHY. A replay of 2102 Live turns found 29 wrong flags that were about backing, not grammar
// (B2b-1 took the grammar ones). Each one made MYTHOS retract something true, aloud:
//   13  "I've sent the play command to Spotify" was judged as SENDING A MESSAGE;
//    9  opening a finished build, or launching the debug browser, was on no opening list;
//    4  "Opening YouTube in Chrome now" / "I clicked on that spot" over a DELIVERED call that
//       could not be confirmed;
//    1  "Closing the first tab" over a real browser_tabs close.
// And the same replay's 20 correct flags include "Opening YouTube in a debug Brave window right
// now" (only Brave launched; the YouTube open failed). Adding tools by name would silence that
// one, so each rule below reads what the row did.
//
// THE RULES. Each is narrow, and each leaves every other category exactly as it was.
//   - STRENGTH. A completed-effect claim ("I've opened YouTube") needs a PROVEN row (ok:true).
//     A claim about the act itself needs the call DELIVERED: "I clicked", "I pressed", "I've
//     sent the command", and a progressive "opening it now". Operator decision 2026-09-26:
//     "I clicked" is true once the click was delivered; that it WORKED ("it's playing") needs
//     the player's evidence, which is B2b-3. The progressive tier follows the same line, and
//     the adapter already tells the model "your browser is opening it" is sayable (BUG-273 B2).
//   - A LAUNCHED BROWSER backs a claim about the browser only. "launching Chrome now" and
//     "launching the debug browser" yes; "Opening YouTube in a debug Brave window" no: that
//     tool "loads no page" (its own description). A named browser must be the one launched.
//   - A NAMED TARGET must be the row's target. "I've opened YouTube" is not backed by a row
//     that opened reddit.com. Names are what the sentence spells as one: a quote, a capital,
//     a domain ("reddit com"). A described object ("that visual template", "what was built")
//     or a pronoun cannot be checked, and is backed as before. A row with no recorded target
//     (a test fixture, an old row) is backed by its tool name as before.
//   - A TAB CLOSE backs a tab claim, and an ordinal must be its index ("the first tab" = 0).
//     Listing tabs backs nothing.
//   - "I've sent the <command|request|search|click>" is a claim that a CALL went out. It is
//     backed by a delivered row that does the act named (by the noun, "the PLAY command", or
//     "to PAUSE it"), and a name in it ("to Spotify", a quoted song) must be that row's target.
//     "I've sent the click order anyway" over two FAILED see_and_click calls stays a flag.

const { opOf } = require('./action-semantics');
const { BROWSER_ALIASES, normalizeBrowserName } = require('../effectors/browser-target');

const STOP = new Set(('the a an our your my this that these those its it their his her up another more some new '
  + 'fresh real i me you sir ma am them one what was were is are be been built com www http https dot org net '
  + 'in on to for of and or now right just okay ok so very well yes no course').split(' '));
// Every word of every alias the browser driver accepts ("google chrome", "brave browser").
const BROWSER_WORDS = new Set(Object.keys(BROWSER_ALIASES).join(' ').split(/[\s-]+/));
const OP_WORDS = { 'open-folder': 'folder file explorer', 'open-file': 'file', 'open-web': 'browser', 'launch-app': 'app' };

const OPEN_VERB_RE = /\b(?:opened|opening|opens?|launched|launching|launch(?:es)?|navigated(?:\s+to)?|navigating(?:\s+to)?|navigate(?:\s+to)?|went\s+to|loaded|loading|coming\s+up)\b/gi;
const OBJECT_END_RE = /\s+(?:in|on|at|with|for|from|as|so|and|but|because|since|while|via|using|now|right|directly|again|then|after|before|which|who|where|if|to|into|onto|inside|through|by|like)\b|[,;:!?—–()]|\.(?=\s|$)/i;
const CLAUSE_END_RE = /[,;:—–()]|\s+but\b/i;
// A subject ends at a sentence stop even with no space after it ("assist.The build is opening").
const SUBJECT_START_RE = /[,;:!?—–()]|\.(?=\s|[A-Z]|$)/;
const QUOTED_RE = /"([^"]+)"|“([^”]+)”|‘([^’]+)’|(?:^|\s)'([^']+)'(?=[\s,.!?]|$)/g;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

// "I've sent the play command", "I sent a more specific search", "I've sent the click order".
// The noun must END its phrase (a stop, a function word, or another such noun): "I sent the
// search RESULTS to your email" is a message, and a web_search must not back it (found attacking
// this rule, 2026-09-26).
const DISPATCH_NOUNS = 'command|request|search|click|order|instruction|query';
const DISPATCH_OBJECT = "((?:(?:the|a|an|another|that|my|one more)\\s+)?(?:[\\w'-]+\\s+){0,2}?)(" + DISPATCH_NOUNS + ")s?\\b"
  + '(?=\\s*(?:$|[,.;:!?—–]|(?:to|for|of|on|in|with|anyway|again|now|and|but|so|just|this|that)\\b|(?:' + DISPATCH_NOUNS + ')s?\\b))';
const DISPATCH_CLAIM_RE = new RegExp("\\b(?:i(?:'ve| have) |i )sent\\s+" + DISPATCH_OBJECT, 'i');
const ACT_WORDS = [[/\b(?:play|pause|resume|stop|skip|toggle|playback|next|previous)\b/i, 'play'],
  [/\b(?:click|tap)\b/i, 'click'], [/\b(?:search|query|look)\b/i, 'search'],
  [/\b(?:open|launch|load|navigate|go)\b/i, 'open'], [/\bclose\b/i, 'close'],
  [/\b(?:ctrl|control|alt|shift|enter|return|escape|esc|backspace|delete|space|keys?|keystrokes?|shortcut|hotkey|f\d{1,2})\b/i, 'key']];
const ACT_OPS = { play: ['play'], click: ['click'], search: ['search'], close: ['close', 'close-tab'], key: ['key'],
  open: ['open-web', 'launch-app', 'launch-browser', 'open-artifact', 'open-folder', 'open-file', 'open-tab'] };

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

// The words a sentence spells as a NAME: inside quotes, capitalised, or a domain.
function nameTokens(text) {
  const names = new Set();
  const add = (w) => { for (const t of tokens(w)) names.add(t); };
  const rest = String(text || '').replace(QUOTED_RE, (m, a, b, c, d) => { add(a || b || c || d); return ' '; });
  const words = rest.split(/\s+/);
  words.forEach((w, i) => {
    const bare = w.replace(/^[^\w]+|[^\w.]+$/g, '');
    if (!bare || /^i(?:'|$)/i.test(bare)) return;
    if (/[A-Z]/.test(bare) || /[a-z]\.[a-z]/i.test(bare) || /^com$/i.test(words[i + 1] || '')) add(bare);
  });
  return names;
}

function openingClaim(sentence, match) {
  let verb = null;
  for (const v of match[0].matchAll(OPEN_VERB_RE)) verb = v;
  if (!verb) return { names: new Set(), clauseNames: new Set(), mentionsBrowser: false };
  const start = match.index + verb.index;
  const end = start + verb[0].length;
  const before = sentence.slice(0, start);
  // "Google News is opening" names its target BEFORE the verb.
  let object = /\b(?:is|are|was|were)\s+(?:now\s+|just\s+)?$/i.test(before)
    ? before.replace(/\s*\b(?:is|are|was|were)\s+(?:now\s+|just\s+)?$/i, '').split(SUBJECT_START_RE).pop()
    : sentence.slice(end).split(OBJECT_END_RE)[0];
  // "I'm working on getting reddit com open for real": the target sits inside the claim.
  if (!tokens(object).size) object = match[0].slice(0, verb.index).replace(/^.*?\b(?:working on|retrying)\b\s*(?:\w+ing\s+)?/i, '');
  // After the verb: a capitalised "Opening" at the start of a sentence is not a name.
  const clause = sentence.slice(end).split(CLAUSE_END_RE)[0];
  return { names: nameTokens(object), clauseNames: nameTokens(clause), mentionsBrowser: /\bbrowser\b/i.test(object) };
}

function dispatchClaim(sentence, match) {
  const after = sentence.slice(match.index + match[0].length);
  const toVerb = (/^\s+to\s+((?:\S+\s+){0,3}\S+)/i.exec(after) || [])[1] || '';
  // "search" and "click" name their act; a command or request names it in its words.
  const noun = match[2].toLowerCase();
  const named = ACT_WORDS.find(([re]) => re.test(/^(?:command|request|order|instruction)$/.test(noun) ? match[1] + ' ' + toVerb : noun));
  const clause = sentence.slice(match.index).replace(QUOTED_RE, (m) => m.replace(/[,;]/g, ' ')).split(CLAUSE_END_RE)[0];
  return { act: named ? named[1] : null, names: nameTokens(clause.replace(/^\s*i(?:'ve| have)?\s+sent\b/i, '')) };
}

// null when the row recorded no target: it cannot contradict a name, so it backs by kind.
function targetOf(row) {
  const act = row.act || null;
  if (!act || !act.target) return null;
  const text = act.target + ' ' + row.tool + ' ' + (OP_WORDS[act.op] || '');
  return { words: tokens(text), squashed: text.toLowerCase().replace(/[^a-z0-9]/g, '') };
}
// "Y Combinator" names ycombinator.com: a name of 3+ letters may sit inside the target.
const overlaps = (names, target) => !names.size || !target
  || [...names].some((n) => target.words.has(n) || (n.length >= 3 && target.squashed.includes(n)));
const OPENS_PAGE = ['open-web', 'launch-app'];

// The OBJECT must be the browser ("launching Chrome", "the debug browser"); the tool "loads no
// page", so a destination in the same clause ("…to open YouTube") needs a row of its own.
function launchedBrowserFits(claim, row, rows, strongEnough) {
  const names = [...claim.names];
  if (!(claim.mentionsBrowser || names.length) || names.some((n) => !BROWSER_WORDS.has(n))) return false;
  const named = names.map(normalizeBrowserName).filter(Boolean);
  const launched = row.act ? [...tokens(row.act.target)].map(normalizeBrowserName).find(Boolean) : null;
  if (named.length && launched && !named.includes(launched)) return false;
  const destinations = new Set([...claim.clauseNames].filter((n) => !BROWSER_WORDS.has(n)));
  return !destinations.size || rows.some((b) => b && b !== row && strongEnough(b)
    && OPENS_PAGE.includes(b.act ? b.act.op : opOf(b.tool, {})) && overlaps(destinations, targetOf(b)));
}

// A completed claim may recap an act older than the 120 s window ("I launched Brave, opened the
// YouTube search…", 2026-08-05 21:13:09, eight minutes after the launch), so only THIS turn's
// rows can contradict its name. A progressive claim is about now, and every row can.
function namesContradict(claim, row, t) {
  if (!t.progressive && t.current && !t.current.includes(row)) return false;
  return !overlaps(claim.names, targetOf(row));
}

function fits(category, sentence, match, row, rows, strongEnough, t) {
  const op = row.act ? row.act.op : opOf(row.tool, {});
  if (category.name === 'opening') {
    const claim = openingClaim(sentence, match);
    return op === 'launch-browser' ? launchedBrowserFits(claim, row, rows, strongEnough) : !namesContradict(claim, row, t);
  }
  if (category.name === 'window-control' && row.tool === 'browser_tabs') {
    if (op !== 'close-tab' || !/\btabs?\b/i.test(sentence)) return false;
    const ordinal = ORDINALS.findIndex((w) => new RegExp('\\b' + w + '\\b', 'i').test(sentence));
    return ordinal < 0 || row.act.index === undefined || ordinal === row.act.index;
  }
  if (category.byOp) {
    const claim = dispatchClaim(sentence, match);
    const acts = claim.act === 'search' && row.act && row.act.searched;
    if (!acts && (claim.act ? !ACT_OPS[claim.act].includes(op) : op === 'other' || op === 'list-tabs')) return false;
    // A key is spelled many ways ("Control A", ctrl+a), so a key act is not name-checked.
    return claim.act === 'key' || overlaps(claim.names, targetOf(row));
  }
  return true;
}

// ---------------------------------------------------------------------------
// B2b-3 (2026-09-26) — "it's playing" is a claim about the PLAYER. Before this, nothing judged
// it at all (the KNOWN GAP pinned in bug-448-460-a-claim-is-judged-by-what-it-claims.test.js).
// Replayed first: 81 Live sentences of this shape, 63 flat claims, labelled by reading each turn
// against the player readings and the operator's next words. Most were true and read back by
// Spotify's own check. The false ones read nothing:
//   2026-07-31 00:26:21 "Spotify is showing that "THE KID LAROI - COME DOWN" is indeed playing."
//                        (Spotify read "SHE DON'T NEED TO KNOW"; the operator said so)
//   2026-08-05 21:04:31 "I've got "Blinding Lights" playing on the dashboard for you instead"
//   2026-08-05 21:12:12 ""Blinding Lights" is playing …"  (operator: "Where is it playing?")
//   2026-09-24 09:41:33 "It should be starting up now."   (BUG-462's 15:11:33; nothing played)
// THE RULE: backed by a player reading that says PLAYING (the latest reading of each player in
// this turn and the 120 s window; a pause read after a play wins), matching what the sentence
// names; or by the operator's own words this turn saying it is playing. The operator is the
// only witness for a player MYTHOS cannot read, and is kept apart from the machine reading on
// purpose: only a statement with a subject counts ("it's playing", "it just play"), never an
// instruction ("yes, play it") and never a question.
// THE COST, measured and accepted: a browser reading is one sample a moment after the click,
// and YouTube often starts a second later. Three true "It should be playing now" sentences had
// only a paused sample. So the correction never says it did not play: it says "not confirmed",
// and names media_status / browser_media_state, both reachable by voice (refusal rule 2).
const PLAY_WORD = 'playing(?!\\s+(?:coy|dumb|games?|along|nice|tricks?|around|hard|catch|the\\s+part|a\\s+role|up)\\b)';
const PLAYBACK_RE = new RegExp([
  "\\b(?:is|are|'s)\\s+(?:(?:now|still|indeed|already|again|finally|actually|currently|officially|definitely|really|\\w+ly)\\s+){0,2}" + PLAY_WORD,
  '\\b(?:now|currently|still)\\s+' + PLAY_WORD,
  '\\bplaying\\s+now\\b',
  '\\bshould\\s+(?:now\\s+)?be\\s+(?:\\w+\\s+(?:and\\s+)?){0,2}?(?:playing|starting|started)\\b',
  '\\b(?:got|have|has)\\b[^.,;]{0,60}?\\b' + PLAY_WORD,
  '\\bplayback\\s+has\\s+(?:started|begun|resumed)\\b',
].join('|'), 'i');
// Tested BEFORE the claim: a negation, a hedge, an attempt or a future anywhere in the sentence.
// "I cannot pretend it's playing", "hopefully the music is playing", "nothing's playing yet",
// "Should be able to get that playing now", "should be playing momentarily". Favours misses.
const NOT_A_PLAYBACK_CLAIM_RE = /\b(?:not|never|no longer|nothing|pretend|unless|hopefully|hope|hoping|maybe|perhaps|might|whether|if|try|trying|tried|attempt(?:s|ed|ing)?|able to|unsure|soon|shortly|momentarily)\b|n't\b|\bin a (?:moment|second|few)\b/i;
// "should be starting up" is about media only when the sentence is: "A separate Brave instance
// should be starting up for you" is a browser launch (2026-09-23 08:31:48).
// A quoted title counts too: ""Starboy" should be starting on YouTube right about now".
const MEDIA_RE = /\b(?:it|video|song|music|track|playback|stream|episode|trailer|mix|playlist|album|podcast|audio|youtube|spotify)\b|["“‘]/i;
const blankQuotes = (s) => s.replace(QUOTED_RE, (m) => ' '.repeat(m.length));
// A `re`-shaped matcher, so claim-check.js runs it like any category. Quotes are blanked first
// (same length, so the index holds): "a 'NOW PLAYING' widget" names a label, not a player.
const PLAYBACK_CLAIM = {
  exec(sentence) {
    const s = String(sentence || '');
    if (NOT_A_PLAYBACK_CLAIM_RE.test(s)) return null;
    const m = PLAYBACK_RE.exec(blankQuotes(s));
    if (!m || (/start/i.test(m[0]) && !MEDIA_RE.test(s))) return null;
    const out = [s.slice(m.index, m.index + m[0].length)];
    out.index = m.index;
    return out;
  },
};

// What the sentence says is playing: each quoted title, and the capitalised words of its own
// clause (the clause's first word dropped: "Soft jazz is playing" names no player).
function playbackTargets(sentence, match) {
  const quoted = [];
  sentence.replace(QUOTED_RE, (m, a, b, c, d) => { const g = tokens(a || b || c || d); if (g.size) quoted.push(g); return m; });
  const flat = blankQuotes(sentence);
  const from = Math.max(-1, ...[',', ';', ':', '—', '–', '('].map((c) => flat.lastIndexOf(c, match.index))) + 1;
  const tail = flat.slice(match.index).split(CLAUSE_END_RE)[0];
  const words = (flat.slice(from, match.index) + tail).split(/\s+/).filter(Boolean).slice(1);
  const loose = new Set();
  for (const w of words) if (/[A-Z]/.test(w) && !/^i(?:'|$)/i.test(w)) for (const t of tokens(w)) loose.add(t);
  return { quoted, loose };
}
// A quoted title must be mostly there ("THE KID LAROI - COME DOWN" is not "The Kid LAROI - SHE
// DON'T NEED TO KNOW": the artist alone is half); a loose name needs one word.
function fitsPlayback(targets, text) {
  const words = tokens(text);
  if (targets.quoted.length) return targets.quoted.some((g) => [...g].filter((w) => words.has(w)).length * 2 > g.size);
  return !targets.loose.size || [...targets.loose].some((w) => words.has(w));
}
// Present tense only: "it was playing before you paused it" is not "it is playing" (found
// attacking this rule, 2026-09-26). "it just play" is how the ASR wrote 09-24's confirmation.
// Only these adverbs may stand between, so a denial ("it's not playing", "isn't") cannot match
// at all; a separate denial check here was proved unreachable by mutation and deleted.
const OPERATOR_SAYS_PLAYING_RE = /\b(?:it|that|this|music|song|video|track)(?:'s|\s+is)?(?:\s+(?:now|just|still|really|actually|definitely|finally|already))*\s+(?:play(?:s|ing)?|working)\b/i;
function operatorSaysPlaying(text, targets) {
  const s = String(text || '');
  const m = OPERATOR_SAYS_PLAYING_RE.exec(s);
  if (!m || /\?\s*$/.test(s)) return false;
  return fitsPlayback(targets, s);
}
function playerBacks(sentence, match, rows, t) {
  const targets = playbackTargets(sentence, match);
  const current = t.current || [];
  const latest = new Map(); // player source -> its newest reading; the ledger is older than this turn
  for (const a of rows.filter((r) => r && !current.includes(r)).concat(current)) if (a && a.act && a.act.player) latest.set(a.act.player.source, a);
  for (const a of latest.values()) if (a.act.player.playing && fitsPlayback(targets, a.act.player.what + ' ' + a.tool)) return true;
  return operatorSaysPlaying(t.operatorText, targets);
}
function playbackNotice(phrase) {
  return {
    message: `CORRECTION of your own prior statement — you said "${phrase}" but nothing has observed the player playing: no reading in this turn or the last two minutes says so, and the operator has not.`,
    instruction: 'Tell the operator plainly that you have NOT confirmed it is playing. Do not say it failed and do not say it is playing. If they want to know, read it with media_status, or browser_media_state for a browser video, and report what that says.',
  };
}

const proven = (a) => a.ok === true;
const delivered = (a) => a.ok === true || a.unverified === true || a.dispatchOk === true || a.status === 'unverified';

// tier: { elliptical, progressive, pending, current, operatorText }. `rows` are this turn's and
// the recent ledger's; `current` is this turn's alone; `operatorText` is this turn's words.
function backs(category, sentence, match, rows, tier) {
  const t = tier || {};
  if (category.byPlayer) return playerBacks(sentence, match, rows || [], t);
  const own = category.byOp ? null : new Set(((category.gateTools && category.gateTools.length) ? category.gateTools : category.tools)
    .concat(t.elliptical ? [] : (category.backingTools || [])));
  const strongEnough = t.pending ? () => true
    : (category.backedByDispatch || category.byOp || t.progressive) ? delivered : proven;
  const all = rows || [];
  return all.some((a) => a && a.tool && (!own || own.has(a.tool)) && strongEnough(a) && fits(category, sentence, match, a, all, strongEnough, t));
}

module.exports = { backs, DISPATCH_OBJECT, DISPATCH_CLAIM_RE, PLAYBACK_CLAIM, playbackNotice };
