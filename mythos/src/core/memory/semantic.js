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
      const existingFacts = parseFacts(existing).filter(function(f) {
        return !facts.some(function(nf) {
          return normalizeFact(nf) === normalizeFact(f);
        });
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

  function activeTopicFiles() {
    return fs.listFiles('Semantic', '.md').filter(function(f) { return f.name !== '_archive.md'; });
  }

  function recall(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 20;
    const files = activeTopicFiles();
    const hits = [];

    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;

      const terms = query.toLowerCase().split(/\s+/);
      const lower = content.toLowerCase();
      const matched = terms.filter(function(t) { return lower.includes(t); }).length;
      const score = terms.length > 0 ? matched / terms.length : 0;

      if (score > 0) {
        const sidecars = parseSidecar(content);
        const facts = parseFacts(content);
        const sc = sidecars[0] || {};
        hits.push({
          ref: sc.id || files[i].name,
          score: score,
          record: { topic: files[i].name.replace('.md', ''), sidecar: sc, facts: facts },
          snippet: facts.slice(0, 3).join('; ').slice(0, 200),
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

  return { write, recall, get, pruneLowConfidence, consolidate, stats, init };
}

module.exports = { createSemanticStore };
