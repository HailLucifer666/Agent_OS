// brain/index.js — unified think interface.
// CA from NOVA: absorbs reasoning.js (DELETED) into think({ lane: 'build' }).
// Uses chain.complete for cooldown/failover/key-rotation.
// Records spend via brain/spend.js (CA from activity-log.js).

function tryParseWithRepair(content) {
  if (!content) return null;
  // Try direct parse first
  try { return JSON.parse(content); } catch {}
  // Fence-strip: extract JSON from markdown code fences
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = fenceRe.exec(content)) !== null) {
    try { return JSON.parse(match[1]); } catch {}
  }
  // Try finding first { ... } or [ ... ]
  const braceStart = content.indexOf('{');
  const bracketStart = content.indexOf('[');
  let start = -1;
  if (braceStart !== -1 && bracketStart !== -1) start = Math.min(braceStart, bracketStart);
  else if (braceStart !== -1) start = braceStart;
  else if (bracketStart !== -1) start = bracketStart;
  if (start === -1) return null;
  // Find matching close
  const open = content[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    if (content[i] === open) depth++;
    if (content[i] === close) depth--;
    if (depth === 0) {
      try { return JSON.parse(content.slice(start, i + 1)); } catch {}
      break;
    }
  }
  return null;
}

function createBrain({ config, bus }) {
  const registry = require('./registry');
  const chain = require('./chain');
  const spend = require('./spend');

  return {
    async think({ lane, messages, schemaHint, budget, signal, source }) {
      // 1. Embed lane is placeholder — clean offline
      if (lane === 'embed') {
        return { content: null, offline: true, lane };
      }

      // 2. Add schemaHint + persona injection
      let msgs = messages;
      if (schemaHint) {
        msgs = [
          { role: 'system', content: 'You must respond with valid JSON matching this schema: ' + schemaHint },
          ...messages
        ];
      }
      if (['voice', 'build', 'simple'].indexOf(lane) !== -1) {
        const persona = (config && config.MYTHOS_NAME) || 'MYTHOS';
        msgs = [
          { role: 'system', content: 'You are ' + persona + '. Be concise and actionable.' },
          ...msgs
        ];
      }

      // 3. chain.complete
      try {
        const result = await chain.complete({
          messages: msgs,
          kind: lane === 'embed' ? 'simple' : lane,
          signal,
          onAttempt: function({ provider, model }) {
            if (bus) bus.emit('brain.spend', { provider, model, lane, source });
          }
        });

        // 4. Parse with repair
        const parsed = tryParseWithRepair(result.content);

        // 5. Record spend
        const inputText = msgs.map(function(m) { return m.content || ''; }).join('');
        const spentTokens = spend.estimate(result.content) + spend.estimate(inputText);
        spend.recordCall({
          provider: result.provider, model: result.model, source: source || 'brain',
          ok: true, inputTokens: Math.round(spentTokens * 0.6),
          outputTokens: Math.round(spentTokens * 0.4),
        });

        return {
          content: result.content, parsed: parsed || null,
          provider: result.provider, model: result.model,
          spentTokens, offline: false, lane,
        };
      } catch (err) {
        if (err.chainExhausted) {
          return { content: null, offline: true, lane };
        }
        if (err.name === 'AbortError') {
          return { content: null, aborted: true, lane };
        }
        throw err;
      }
    },

    async probe() {
      await registry.refresh(true);
    },

    tryParseWithRepair: tryParseWithRepair,
  };
}

module.exports = { createBrain, tryParseWithRepair };
