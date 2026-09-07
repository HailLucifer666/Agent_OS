'use strict';

function parseRequest(request, hasContext = false) {
  const text = typeof request === 'string' ? request.trim() : '';
  if (!text || text.length > 1000) return null;
  const youtube = /\byou\s*tube\b/i.test(text);
  if (/^(?:please\s+)?open\s+you\s*tube[.!]?$/i.test(text)) return { kind: 'open-youtube' };
  const search = /^(?:please\s+)?search\s+youtube\s+for\s+(.{1,250}?)\s+and\s+play\s+(?:the\s+)?(?:third|3rd)(?:\s+(?:video|result))?[.!]?$/i.exec(text);
  if (search) return { kind: 'play-third', query: search[1].trim() };
  const third = /^(?:please\s+)?(?:open\s+youtube\s+and\s+)?play\s+(?:the\s+)?(?:third|3rd)(?:\s+(?:video|result))?(?:\s+(?:on|in|from)\s+youtube)?[.!]?$/i;
  if ((youtube || hasContext) && third.test(text)) return { kind: 'play-third', query: null, contextual: !youtube };
  if (!youtube && !hasContext) return null;
  if (/^(?:please\s+)?pause(?:\s+(?:youtube|the video|it))?[.!]?$/i.test(text)) return { kind: 'pause' };
  if (/^(?:please\s+)?(?:resume|play)(?:\s+(?:youtube|the video|it))?[.!]?$/i.test(text)) return { kind: 'resume' };
  if (/^(?:please\s+)?(?:next(?:\s+(?:youtube\s+)?video)?|skip(?:\s+(?:youtube|the video|it))?)[.!]?$/i.test(text)) return { kind: 'next' };
  return null;
}

module.exports = { parseRequest };
