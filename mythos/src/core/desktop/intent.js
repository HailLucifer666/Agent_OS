'use strict';

// A Stage 1 phrase may end with the browser it targets, or with "please". Until
// 2026-09-08 every pattern below was anchored straight to `[.!]?$`, so the spoken
// "open YouTube on Brave browser" — the exact workflow Stage 1 exists for — was refused
// as unsupported. One fragment, appended to every pattern by stage1(); add a browser
// here, never in an individual pattern. A qualifier is only a known Chromium browser
// (the extension bridge is Chromium-only) or "please": "on firefox", "on the", and
// "and delete files" still reject. Pinned in test/desktop-intent-trailing-qualifier.test.js.
const QUALIFIER = '(?:\\s+(?:on|in|using)\\s+(?:the\\s+|my\\s+)?(?:(?:brave|chrome|edge)(?:\\s+browser)?|browser))?(?:,?\\s+please)?';
const stage1 = (body) => new RegExp('^(?:please\\s+)?' + body + QUALIFIER + '[.!]?$', 'i');
const OPEN = stage1('open\\s+you\\s*tube');
const SEARCH = stage1('search\\s+youtube\\s+for\\s+(.{1,250}?)\\s+and\\s+play\\s+(?:the\\s+)?(?:third|3rd)(?:\\s+(?:video|result))?');
const THIRD = stage1('(?:open\\s+youtube\\s+and\\s+)?play\\s+(?:the\\s+)?(?:third|3rd)(?:\\s+(?:video|result))?(?:\\s+(?:on|in|from)\\s+youtube)?');
const PAUSE = stage1('pause(?:\\s+(?:youtube|the video|it))?');
const RESUME = stage1('(?:resume|play)(?:\\s+(?:youtube|the video|it))?');
const NEXT = stage1('(?:next(?:\\s+(?:youtube\\s+)?video)?|skip(?:\\s+(?:youtube|the video|it))?)');

function parseRequest(request, hasContext = false) {
  const text = typeof request === 'string' ? request.trim() : '';
  if (!text || text.length > 1000) return null;
  const youtube = /\byou\s*tube\b/i.test(text);
  if (OPEN.test(text)) return { kind: 'open-youtube' };
  const search = SEARCH.exec(text);
  if (search) return { kind: 'play-third', query: search[1].trim() };
  if ((youtube || hasContext) && THIRD.test(text)) return { kind: 'play-third', query: null, contextual: !youtube };
  if (!youtube && !hasContext) return null;
  if (PAUSE.test(text)) return { kind: 'pause' };
  if (RESUME.test(text)) return { kind: 'resume' };
  if (NEXT.test(text)) return { kind: 'next' };
  return null;
}

module.exports = { parseRequest };
