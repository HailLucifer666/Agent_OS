// brain/index.js — unified think interface.
// CA from NOVA: absorbs reasoning.js (DELETED) into think({ lane: 'build' }).
// Uses chain.complete for cooldown/failover/key-rotation.
// Records spend via brain/spend.js (CA from activity-log.js).

// REMEDIATION P1-3: doubles every LONE backslash — one that is not already
// the second half of a pre-existing "\\" pair — so a raw Windows path like
// "D:\Agent OS" (illegal \A escape) or "D:\temp"/"D:\node_modules" becomes
// valid JSON instead of failing every parse strategy below (bug 12). The
// previous version used a negative lookahead that skipped doubling whenever
// the backslash was followed by "\"\\/bfnrtu" on the theory those were
// "already a valid JSON escape" — but for a RAW unescaped path those are
// exactly the common first letters of real folder names (temp, node_modules,
// backup, foo, run...), and \t \n \b \f \r \u ARE syntactically valid JSON
// escapes, so plain JSON.parse doesn't even throw on them — it SILENTLY
// SUCCEEDS with a corrupted value (a real tab/newline/etc. swallowing the
// following letter). A pre-existing genuine "\\" pair is left untouched (both
// characters consumed together) so already-correctly-escaped input is a no-op.
function sanitizeLoneBackslashes(content) {
  const str = String(content);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      out += '\\\\';
      if (str[i + 1] === '\\') i++; // consume the pair together, don't re-double it
    } else {
      out += str[i];
    }
  }
  return out;
}

function tryParseWithRepair(content) {
  if (!content) return null;
  // REMEDIATION P1-3b: direct parse FIRST. Valid JSON — including string values
  // that legitimately contain \n \t \" etc. (e.g. a write_file `content` arg
  // with real line breaks) — must round-trip untouched. A repair pass must
  // never corrupt VALID input; an earlier revision ran the backslash-doubling
  // sanitizer first and turned every "line1\nline2" into a literal backslash-n.
  try { return JSON.parse(content); } catch {}
  // Direct parse threw: the model likely emitted a raw Windows path with an
  // ILLEGAL escape such as "D:\Agent OS" (\A is not a JSON escape). Double every
  // lone backslash and retry — recovers bug 12's reported case with no reprompt.
  // Known residual: a raw path whose segment begins with t/n/r/b/f/u after a
  // lone backslash (e.g. "D:\temp") is itself VALID JSON (\t == a tab), so the
  // direct parse above already consumed it — to a corrupted value. That
  // ambiguity is unfixable by a purely syntactic pass without breaking
  // legitimate escapes, so we favour not corrupting valid JSON; a well-behaved
  // model escapes its paths ("D:\\temp").
  const sanitized = sanitizeLoneBackslashes(content);
  if (sanitized !== content) {
    try { return JSON.parse(sanitized); } catch {}
  }
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

function createBrain({ config, bus, identity }) {
  const registry = require('./registry');
  const chain = require('./chain');
  const spend = require('./spend');
  const version = require('../identity/version');

  // Resolve the version context line once: config override wins, else auto-detect.
  // This runs at brain construction (boot), not per-call — the context is stable
  // for the process lifetime. Call version.refresh() after a code update to reset.
  var versionLine = (config && config.MYTHOS_VERSION)
    ? 'MYTHOS v' + config.MYTHOS_VERSION + '.'
    : version.contextLine();

  return {
    async think({ lane, messages, schemaHint, budget, signal, source, onToken, persona }) {
      // 1. Embed lane is placeholder — clean offline
      if (lane === 'embed') {
        return { content: null, offline: true, lane };
      }

      // 1b. Budget exhaustion check — defense-in-depth
      if (budget && ((typeof budget.tokens === 'number' && budget.tokens <= 0) ||
                     (typeof budget.actions === 'number' && budget.actions <= 0))) {
        return { content: null, offline: true, lane, budgetExhausted: true };
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
        // Per-call persona override — when the caller passes a `persona` string,
        // use it instead of the global identity persona. This enables specialized
        // agent seats (frontend-builder, backend-builder, reviewer) without
        // changing the global identity. When persona is absent, keep the default.
        var personaLine;
        if (persona) {
          personaLine = persona + ' ' + versionLine + ' Be concise and actionable.';
        } else if (identity && typeof identity.persona === 'function') {
          personaLine = identity.persona() + ' ' + versionLine + ' Be concise and actionable.';
        } else {
          personaLine = 'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + '. ' + versionLine + ' Be concise and actionable.';
        }
        msgs = [
          { role: 'system', content: personaLine },
          ...msgs
        ];
      }

      // 3. chain.complete
      try {
        const result = await chain.complete({
          messages: msgs,
          brain: lane === 'embed' ? 'simple' : lane,
          signal,
          onAttempt: function({ provider, model }) {
            if (bus) bus.emit('brain-spend', { provider, model, lane, source });
          },
          onToken,
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
