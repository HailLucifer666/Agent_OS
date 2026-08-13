'use strict';

const crypto = require('crypto');

// Semantic memory — human-readable markdown with parseable sidecar
// vault/Semantic/<topic>.md
// Format:
//   ## Topic Title
//   <!-- {id: 'sem-abc123', ts: 1700000000, confidence: 0.8, sources: ['ep-001']} -->
//   - Fact one
//   - Fact two

function createSemanticStore({ fs, config, bus, logger }) {
  const SIDECAR_RE = /<!--\s*(\{[^}]+\})\s*-->/g;
  const BULLET_RE = /^-\s+(.+)$/gm;

  function parseSidecar(content) {
    const matches = [];
    let m;
    while ((m = SIDECAR_RE.exec(content)) !== null) {
      try {
        matches.push(JSON.parse(m[1]));
      } catch (_) {
        // Skip malformed sidecars
      }
    }
    return matches;
  }

  function parseFacts(content) {
    const facts = [];
    let m;
    const re = new RegExp(BULLET_RE.source, BULLET_RE.flags);
    while ((m = re.exec(content)) !== null) {
      facts.push(m[1].trim());
    }
    return facts;
  }

  function generateId() {
    return 'sem-' + crypto.randomUUID();
  }

  // BUG-080 (Stage 6, item #18): every semantic.write() caller funnels
  // through here — from-memory.js's remember() tool already quarantines
  // identity claims (its own IDENTITY_CLAIM_RE), but memory/index.js's
  // conversation-distillation loop (3b) writes straight to 'user-facts' at
  // confidence 0.7 with NO such check. That is how "The user's name is Alex"
  // (mined from MYTHOS's OWN typed Notepad probe text, "Hi Alex, this is
  // Mythos") and "operator really enjoys playing jazz piano" (an inference
  // right after a "soft jazz" query, not a stated fact) ended up as durable
  // facts contradicting Identity/operator-profile.txt ("Address them with
  // 'Sir'"). One guard here catches it regardless of which caller forgot it.
  //
  // Root-cause note: the specific Notepad-probe example above most likely
  // entered via a DIFFERENT, already-fixed bug — Stage 2 of this same plan
  // found MYTHOS's own TTS bleeding back into its own Live mic, which Gemini's
  // STT then transcribed as the OPERATOR speaking. That means the userText
  // itself was contaminated upstream of this function, not just mis-labeled
  // here. Stage 2 closes that specific hole; this guard is defense-in-depth
  // for the class of bug (self-authored/inferred text becoming a durable
  // identity fact), not a re-fix of the same line.
  const IDENTITY_CLAIM_RE = /\b(call (?:me|the operator|him|her|them)\b|my name is\b|the operator'?s? name is\b|the user'?s? name is\b|prefers? to be called\b|address (?:me|the operator|the user) as\b|will call me\b)/i;
  const IDENTITY_UNCONFIRMED_CONFIDENCE = 0.2;

  function isConfirmedOperatorUtterance(sources) {
    return Array.isArray(sources) && sources.includes('voice-explicit') && !sources.includes('identity-unconfirmed');
  }

  function contradictsOperatorProfile(fact) {
    try {
      const profile = fs.readText('Identity/operator-profile.txt', '');
      if (!profile.trim()) return false; // nothing on file to contradict
      // Cheap check, deliberately not NLP: an identity-class claim that
      // shares no words with the profile on file is treated as a possible
      // contradiction rather than silently trusted.
      const profileWords = new Set(profile.toLowerCase().match(/[a-z]{3,}/g) || []);
      const factWords = (fact.toLowerCase().match(/[a-z]{3,}/g) || []).filter(function(w) {
        return !['the', 'user', 'name', 'call', 'operator', 'address', 'prefers', 'will'].includes(w);
      });
      if (!factWords.length) return false;
      return !factWords.some(function(w) { return profileWords.has(w); });
    } catch (_) {
      return false; // fs error — degrade honestly, don't block the write over it
    }
  }

  function write(topic, facts, opts) {
    opts = opts || {};
    const id = opts.id || generateId();
    let confidence = opts.confidence || 0.5;
    let sources = opts.sources || [];
    const identityClaim = Array.isArray(facts) && facts.some(function(f) { return IDENTITY_CLAIM_RE.test(String(f)); });
    if (identityClaim) {
      const unconfirmed = !isConfirmedOperatorUtterance(sources);
      const contradiction = facts.some(function(f) { return IDENTITY_CLAIM_RE.test(String(f)) && contradictsOperatorProfile(String(f)); });
      if (unconfirmed || contradiction) {
        confidence = Math.min(confidence, IDENTITY_UNCONFIRMED_CONFIDENCE);
        sources = sources.includes('identity-unconfirmed') ? sources : sources.concat('identity-unconfirmed');
        if (bus && typeof bus.emit === 'function') {
          bus.emit('health.anomaly', {
            kind: 'semantic-identity-claim-quarantined',
            topic: topic, reason: contradiction ? 'contradicts-operator-profile' : 'not-a-confirmed-operator-utterance',
          });
        }
      }
    }
    const relPath = 'Semantic/' + sanitizeFilename(topic) + '.md';

    // Append mode (opt-in via opts.append): read existing facts, dedup against
    // the new ones, and write the merged set. Without this, every distillation
    // call clobbers the previous — user-facts.md would only ever hold the last
    // fact written. Default mode (overwrite) is unchanged for existing callers.
    // REMEDIATION P3-9: dedupe was exact-match-after-trim/lowercase only, so
    // "The operator really enjoys playing jazz piano" and the same sentence
    // with a trailing period were treated as different facts (confirmed
    // duplicate in the 2026-07-29 audit's user-facts.md). Also strip
    // trailing punctuation before comparing.
    function normalizeFact(f) { return String(f).trim().toLowerCase().replace(/[.!?]+$/, ''); }
    let allFacts = facts;
    if (opts.append) {
      const existing = fs.readText(relPath, '');
      const newTriggers = facts.map(directiveTriggerOf).filter(Boolean);
      const existingFacts = parseFacts(existing).filter(function(f) {
        // Exact-match dedup (P3-9) — unchanged.
        if (facts.some(function(nf) { return normalizeFact(nf) === normalizeFact(f); })) return false;
        // BUG-160 supersede: a DIRECTIVE fact ("when the operator asks X, do Y")
        // whose trigger clause matches an incoming fact's trigger is replaced by
        // it, not kept beside it. Before this, a spoken correction with different
        // wording never matched the exact-dedup above, so contradictory rules
        // accumulated — vault evidence: user-facts.md held three conflicting
        // "open World Monitor" directives at once, and which URL won was a coin
        // flip per conversation. Deliberately narrow: only when-clause directives
        // supersede; observational facts still accumulate as before.
        const trig = directiveTriggerOf(f);
        if (trig && newTriggers.indexOf(trig) !== -1) return false;
        return true;
      });
      allFacts = existingFacts.concat(facts);
    }

    const sidecar = JSON.stringify({ id: id, ts: Date.now(), confidence: confidence, sources: sources });
    const bulletLines = allFacts.map(function(f) { return '- ' + f; }).join('\n');
    const content = '## ' + topic + '\n\n<!-- ' + sidecar + ' -->\n' + bulletLines + '\n';

    try {
      fs.writeText(relPath, content);
      return { ref: id, degraded: false };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'semantic', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function sanitizeFilename(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // BUG-160: canonical trigger clause of a directive-shaped fact, or null.
  // "When the operator asks to \"open World Monitor\", open <url>" and
  // "When asked to 'open world monitor': launch the app" must both yield
  // the same trigger, so the second supersedes the first. Only the clause
  // BEFORE the first comma/colon counts, and only when it starts with
  // "when"/"whenever" — everything else is not a directive and never
  // supersedes. Subject/verb variance ("the operator asks" / "asked" /
  // "the user says") is canonicalized to keep the match honest across the
  // phrasings one operator actually produces; anything smarter (embeddings,
  // fuzzy similarity) is deliberately out of scope.
  function directiveTriggerOf(fact) {
    const n = String(fact).trim().toLowerCase();
    const clause = n.split(/[,:]/, 1)[0];
    if (!/^when(ever)?\b/.test(clause)) return null;
    return clause
      .replace(/["'“”‘’]/g, '')
      .replace(/\b(the )?(operator|user)\b/g, '')
      .replace(/\b(asks?|asked|asking|says?|said|saying|tells?|told|requests?|requested)\b/g, 'asks')
      .replace(/\bwhenever\b/, 'when')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeTokens(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  // Remove the ONE bullet whose trimmed text equals `text` in the given
  // topic file. Used by forget()'s fuzzy-match auto-resolve below — the
  // fuzzy pass already knows exactly which line it means, so this is a
  // targeted removal, not another search.
  function removeExactLine(topicName, text) {
    const path = 'Semantic/' + topicName + '.md';
    const content = fs.readText(path, '');
    if (!content) return { removed: [], error: 'topic file unreadable' };
    const lines = content.split('\n');
    let removedLine = null;
    const kept = lines.filter(function(line) {
      const m = line.match(/^-\s+(.+)$/);
      if (m && m[1].trim() === text && !removedLine) { removedLine = m[1].trim(); return false; }
      return true;
    });
    if (!removedLine) return { removed: [], error: 'fact no longer present' };
    try {
      fs.writeText(path, kept.join('\n'));
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'semantic', error: err.message });
      return { removed: [], error: 'write failed: ' + err.message };
    }
    return { removed: [removedLine], topic: topicName };
  }

  // BUG-160: remove stored fact bullet(s) matching a query — the missing
  // counterpart to write(). Until this existed there was NO way, by voice or
  // by tool, to retire a wrong fact: corrections could only pile a new fact
  // next to the one they contradicted ("two brains"). Line-filter rewrite on
  // purpose — everything that is not a removed bullet (header, sidecars,
  // other facts) survives byte-for-byte.
  //
  // Wave 4 (2026-08-13): exact substring was the ONLY match mode, so a
  // spoken correction phrased differently than the stored fact ("forget
  // that I said kids come first" vs the stored "children/family priority")
  // was a dead end — reported as "No stored fact contains ..." even though
  // the intended fact was right there. When exact substring finds nothing,
  // fall back to a normalized token-overlap pass (same half-the-terms floor
  // recall() already uses, MIN_RECALL_SCORE below) across every candidate
  // bullet. Exactly one match above the floor auto-resolves (same effect as
  // an exact match); more than one comes back as `candidates` instead of
  // deleting anything, so the caller can ask "which one?" rather than
  // guessing at a fact the operator didn't actually mean.
  function forget(query, opts) {
    opts = opts || {};
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 3) return { removed: [], searched: [], error: 'query too short' };
    const MAX_REMOVALS = 5; // a query matching more than this is too broad to trust
    const files = opts.topic
      ? [{ name: sanitizeFilename(opts.topic) + '.md', path: 'Semantic/' + sanitizeFilename(opts.topic) + '.md' }]
      : activeTopicFiles();
    const searched = [];
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      searched.push(files[i].name.replace('.md', ''));
      if (!content) continue;
      const lines = content.split('\n');
      const removed = [];
      const kept = lines.filter(function(line) {
        const m = line.match(/^-\s+(.+)$/);
        if (m && m[1].toLowerCase().includes(q)) { removed.push(m[1].trim()); return false; }
        return true;
      });
      if (!removed.length) continue;
      if (removed.length > MAX_REMOVALS) {
        return { removed: [], searched: searched, error: 'query matches ' + removed.length + ' facts in ' + files[i].name + ' — too broad, be more specific' };
      }
      try {
        fs.writeText(files[i].path, kept.join('\n'));
      } catch (err) {
        bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'semantic', error: err.message });
        return { removed: [], searched: searched, error: 'write failed: ' + err.message };
      }
      return { removed: removed, topic: files[i].name.replace('.md', ''), searched: searched };
    }

    // Fuzzy fallback — nothing matched by exact substring in any searched file.
    const qTokens = normalizeTokens(q);
    if (qTokens.length) {
      const candidates = [];
      for (let i = 0; i < files.length; i++) {
        const content = fs.readText(files[i].path, '');
        if (!content) continue;
        const topicName = files[i].name.replace('.md', '');
        content.split('\n').forEach(function(line) {
          const m = line.match(/^-\s+(.+)$/);
          if (!m) return;
          const factText = m[1].trim();
          const factTokens = normalizeTokens(factText);
          if (!factTokens.length) return;
          const overlap = qTokens.filter(function(t) { return factTokens.indexOf(t) !== -1; }).length;
          const score = overlap / qTokens.length;
          if (score >= MIN_RECALL_SCORE) candidates.push({ text: factText, topic: topicName, score: score });
        });
      }
      if (candidates.length === 1) {
        const resolved = removeExactLine(candidates[0].topic, candidates[0].text);
        if (resolved.error) return { removed: [], searched: searched, error: resolved.error };
        return { removed: resolved.removed, topic: resolved.topic, searched: searched, matchedBy: 'fuzzy' };
      }
      if (candidates.length > 1) {
        candidates.sort(function(a, b) { return b.score - a.score; });
        return {
          removed: [], searched: searched,
          candidates: candidates.slice(0, 5).map(function(c) { return { text: c.text, topic: c.topic }; }),
        };
      }
    }

    return { removed: [], searched: searched };
  }

  function activeTopicFiles() {
    return fs.listFiles('Semantic', '.md').filter(function(f) { return f.name !== '_archive.md'; });
  }

  // BUG-172: the score is (query terms appearing anywhere in the file) /
  // (query terms), by plain substring. Accepting anything above zero meant a
  // single common word carried a hit: live-verifying this wave, the query
  // "zzz nothing about this topic exists zzz" matched an unrelated incidents
  // file on "about"/"this" alone and came back looking like a real
  // recollection. That is worse than an empty result, because the caller has
  // no way to tell a coincidence from a memory. Half the query's terms is the
  // floor. It cannot break the deliberate empty-query browse path used by
  // routes/memory.js — ''.split(/\s+/) is [''], which every file contains, so
  // that path scores exactly 1.
  const MIN_RECALL_SCORE = 0.5;

  function recall(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 20;
    const minScore = (typeof opts.minScore === 'number') ? opts.minScore : MIN_RECALL_SCORE;
    const files = activeTopicFiles();
    const hits = [];

    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;

      const terms = query.toLowerCase().split(/\s+/);
      const lower = content.toLowerCase();
      const matched = terms.filter(function(t) { return lower.includes(t); }).length;
      const score = terms.length > 0 ? matched / terms.length : 0;

      if (score >= minScore && score > 0) {
        const sidecars = parseSidecar(content);
        const facts = parseFacts(content);
        const sc = sidecars[0] || {};
        // BUG-172: a topic file that MATCHES the query but parses to zero
        // facts (header-only, or every fact archived) produced a hit whose
        // snippet was the empty string. Callers then dropped it downstream and
        // were left holding count:0 from a call that had reported hits —
        // which is how recall_memory came to answer "I recalled that" with
        // nothing to say. A hit with no text is not a hit; drop it here, at
        // the one place that knows WHY it is empty.
        const snippet = facts.slice(0, 3).join('; ').slice(0, 200);
        if (!snippet) continue;
        hits.push({
          ref: sc.id || files[i].name,
          score: score,
          record: { topic: files[i].name.replace('.md', ''), sidecar: sc, facts: facts },
          snippet: snippet,
          store: 'semantic'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function get(ref) {
    // Search all semantic files for a sidecar id match
    const files = activeTopicFiles();
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      const sidecars = parseSidecar(content);
      for (let j = 0; j < sidecars.length; j++) {
        if (sidecars[j].id === ref) {
          return {
            ref: ref,
            topic: files[i].name.replace('.md', ''),
            content: content,
            sidecar: sidecars[j],
            facts: parseFacts(content)
          };
        }
      }
    }
    return null;
  }

  const ARCHIVE_PATH = 'Semantic/_archive.md';

  function pruneLowConfidence(threshold) {
    threshold = threshold || 0.2;
    const files = activeTopicFiles();
    let archived = 0;
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      const sidecars = parseSidecar(content);
      const sc = sidecars[0];
      if (sc && sc.confidence < threshold) {
        const existing = fs.readText(ARCHIVE_PATH, '');
        const stamped = '<!-- archived ' + new Date().toISOString() + ' from ' + files[i].name + ' -->\n' + content + '\n';
        fs.writeText(ARCHIVE_PATH, existing + stamped);
        fs.removeFile(files[i].path);
        archived++;
      }
    }
    return archived;
  }

  function consolidate() {
    const pruned = pruneLowConfidence();
    return { moved: 0, distilled: 0, archived: pruned };
  }

  function stats() {
    return { count: activeTopicFiles().length };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Semantic'));
  }

  return { write, forget, recall, get, pruneLowConfidence, consolidate, stats, init };
}

module.exports = { createSemanticStore };
