'use strict';

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const ordinalTokens = ORDINAL_WORDS.flatMap((word, index) => {
  const n = index + 1;
  return [[word, n], [String(n), n], [n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'), n]];
});
const ordinals = new Map(ordinalTokens);
const ordinalPattern = '(' + ordinalTokens.map(([token]) => token).join('|') + ')';
const searchPattern = new RegExp('^(?:please\\s+)?search\\s+youtube\\s+for\\s+(.{1,250}?)\\s+and\\s+play\\s+(?:the\\s+)?' + ordinalPattern + '(?:\\s+(?:video|result))?[.!]?$', 'i');
const playPattern = new RegExp('^(?:please\\s+)?(?:open\\s+youtube\\s+and\\s+)?play\\s+(?:the\\s+)?' + ordinalPattern + '(?:\\s+(?:video|result))?(?:\\s+(?:on|in|from)\\s+youtube)?[.!]?$', 'i');
function selection(token, fields) {
  const ordinal = ordinals.get(token.toLowerCase());
  // Keep historical version-1 third requests and their persisted shape valid.
  return ordinal === 3 ? { kind: 'play-third', ...fields } : { kind: 'play-index', ordinal, ...fields };
}
function selectionOrdinal(intent) {
  if (intent?.kind === 'play-third') return 3;
  return intent?.kind === 'play-index' && Number.isInteger(intent.ordinal) && intent.ordinal >= 1 && intent.ordinal <= 20 ? intent.ordinal : null;
}

function parseRequest(request, hasContext = false) {
  const text = typeof request === 'string' ? request.trim() : '';
  if (!text || text.length > 1000) return null;
  const youtube = /\byou\s*tube\b/i.test(text);
  if (/^(?:please\s+)?open\s+you\s*tube[.!]?$/i.test(text)) return { kind: 'open-youtube' };
  const search = searchPattern.exec(text);
  if (search) return selection(search[2], { query: search[1].trim() });
  const play = playPattern.exec(text);
  if ((youtube || hasContext) && play) return selection(play[1], { query: null, contextual: !youtube });
  if (!youtube && !hasContext) return null;
  if (/^(?:please\s+)?pause(?:\s+(?:youtube|the video|it))?[.!]?$/i.test(text)) return { kind: 'pause' };
  if (/^(?:please\s+)?(?:resume|play)(?:\s+(?:youtube|the video|it))?[.!]?$/i.test(text)) return { kind: 'resume' };
  if (/^(?:please\s+)?(?:next(?:\s+(?:youtube\s+)?video)?|skip(?:\s+(?:youtube|the video|it))?)[.!]?$/i.test(text)) return { kind: 'next' };
  return null;
}

module.exports = { parseRequest, selectionOrdinal };
