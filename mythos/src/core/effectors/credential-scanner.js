'use strict';

// credential-scanner.js — pattern-based secret scanner for effector args.
// Runs before T3/T4 effectors execute. If a credential pattern is detected,
// the leash denies the call and logs it to the audit trail. Output ALWAYS
// redacts the secret — first 4 chars + '***', never the full value.

var PATTERNS = [
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws-secret-key', re: /aws_secret_access_key["'\s:=]+([A-Za-z0-9/+=]{40})/gi },
  { name: 'google-oauth', re: /ya29\.[0-9A-Za-z\-_]{20,}/g },
  { name: 'google-refresh-token', re: /1\/\/[0-9A-Za-z\-_]{30,}/g },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9\-_]{10,}\.eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g },
  { name: 'github-token', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g }, // B2d: gho_/ghu_/ghr_ (GitHub CLI) too
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { name: 'stripe-key', re: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{24,}/g },
  { name: 'connection-string', re: /(?:mongodb|postgresql|postgres|mysql|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi },
  { name: 'api-key-generic', re: /(?:api[_-]?key|secret|token|password|passwd|pwd)["'\s:=]+["']([A-Za-z0-9\-_]{20,})["']/gi },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9\-_\.]{20,}/g },
  // A2 (logger redaction): provider key prefixes that were missing from the
  // original list. Additive — also strengthens the leash scanner that reuses
  // these same patterns via scan().
  //
  // The `openai-key` lookahead exists because MYTHOS collides with its own
  // namespace: memory/skills.js:21 mints procedural-skill ids as
  // `'sk-' + crypto.randomUUID()`, e.g. sk-1ec74737-f6a4-4047-b156-0c645aa9f293,
  // which the bare /sk-[A-Za-z0-9\-_]{20,}/ matched as an OpenAI key. Two
  // consequences, and the smaller one is the one that bites first:
  //   * server/index.js's log redaction rendered every skill id as [REDACTED],
  //     so "which learned skill ran" became unreadable in the HUD log — a fix
  //     that destroys the evidence trail (rules/core.md §11.2).
  //   * leash/index.js:320 scans args for tier >= 3 and DENIES on a match with
  //     reason 'credential-detected'. No effector takes a skill id as an input
  //     arg today and use_skill is T0, so this could not fire yet — but T3
  //     build tools carry large free-text prompts, and a brief that happened to
  //     quote a skill id would have been denied as a credential leak with an
  //     actively misleading reason.
  // The lookahead rejects the UUID shape (8 hex, '-', 4 hex, '-') and nothing
  // else: real keys are `sk-` + alnum, `sk-proj-…` and `sk-svcacct-…`, none of
  // which put a hyphen at that position. Pinned both ways in
  // test/credential-scanner-id-collision.test.js.
  //
  // The (?<![A-Za-z0-9]) was added by B2d's review (2026-09-29): with no left
  // boundary, every word ending in "sk" before a hyphen was a key — web_fetch
  // refused .../risk-management-framework-guide and redaction rewrote prose to
  // "ta[REDACTED:openai-key]". A real key starts after a quote, =, space or :.
  { name: 'openai-key', re: /(?<![A-Za-z0-9])sk-(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-)[A-Za-z0-9\-_]{20,}/g },
  { name: 'groq-key', re: /gsk_[A-Za-z0-9\-_]{20,}/g },
  { name: 'nvidia-key', re: /nvapi-[A-Za-z0-9\-_]{20,}/g },
  // B2d (2026-09-29): Google API keys (GEMINI_API_KEY, GOOGLE_API_KEY) have a
  // fixed shape — "AIza" + 35 — and were the one provider key this list could
  // not see. No MYTHOS id uses the prefix (credential-scanner-id-collision.test.js).
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_\-]{35}/g },
  // B2d review: registry and hub tokens that were invisible to both layers.
  { name: 'gitlab-token', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_\-]{20,}/g },
  { name: 'huggingface-token', re: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g },
  { name: 'npm-token', re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g },
];

// ---- redaction (B2d, 2026-09-29 audit) -------------------------------------
// redactText(text) -> the same text with every secret this module can recognise
// replaced by "[REDACTED:<kind>]". Applied to CONTENT the file tools read —
// before it is truncated, chunked, stored, embedded or handed to a model — not
// to every tool result (a blanket pass would rewrite MYTHOS's own ids; see the
// openai-key note above).
//   - high confidence: every PATTERNS shape, and a private key as a WHOLE block
//     (the scan pattern above only sees the header line);
//   - broad NAME=value assignments with a secret-looking UPPER_CASE name — the
//     .env shape — have their VALUE redacted. Redact-only: never a scan hit, so
//     never a leash denial, because "PASSWORD=" appears in plenty of harmless
//     text. Lower-case code (`const token = getToken()`) is left alone.
// Pattern matching cannot catch every secret; this narrows the leak, it does not
// close it.
var PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
var SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))(\s*[=:]\s*)(["']?)([^\s"'#,;]{8,})\3/g;

// Not secrets although the name ends in KEY: database and data-structure keys
// (PRIMARY_KEY: user_id_column was being redacted — B2d review, 2026-09-29).
var NOT_A_SECRET_NAME = /(?:PRIMARY|FOREIGN|SORT|PARTITION|UNIQUE|COMPOSITE|PUBLIC|CACHE|LOOKUP|HOT|SHORTCUT)_?KEY$/;
// A value that is code, not a literal: a dotted reference (process.env.X,
// config.apiKey) or a call. "const API_KEY = config.apiKey" was
// being turned into "[REDACTED]" — and read, edit, write_file would have saved it.
var CODE_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|\(/;

// redactCounted(text) -> { text, count }: redactText plus how many values it
// replaced, so a caller can SAY that the text is not the file verbatim.
function redactCounted(text) {
  if (typeof text !== 'string' || !text) return { text: text, count: 0 };
  var count = 0;
  var tally = function (label) { return function () { count += 1; return label; }; };
  var out = text.replace(PRIVATE_KEY_BLOCK, tally('[REDACTED:private-key]'));
  for (var i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].name === 'private-key') continue;
    PATTERNS[i].re.lastIndex = 0;
    out = out.replace(PATTERNS[i].re, tally('[REDACTED:' + PATTERNS[i].name + ']'));
  }
  out = out.replace(SECRET_ASSIGNMENT, function(m, name, sep, quote, value) {
    if (/^\[REDACTED/.test(value) || NOT_A_SECRET_NAME.test(name) || CODE_VALUE.test(value)) return m;
    count += 1;
    return name + sep + quote + '[REDACTED]' + quote;
  });
  return { text: out, count: count };
}

function redactText(text) {
  return redactCounted(text).text;
}

function redact(value) {
  if (!value || value.length <= 4) return '***';
  return value.slice(0, 4) + '***';
}

// Recursively extract all string values from an object
function extractStrings(obj, depth) {
  depth = depth || 0;
  if (depth > 5) return []; // prevent infinite recursion on circular refs
  if (typeof obj === 'string') return [obj];
  if (typeof obj !== 'object' || obj === null) return [];
  var results = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    results = results.concat(extractStrings(obj[keys[i]], depth + 1));
  }
  return results;
}

function scan(args) {
  if (!args || typeof args !== 'object') return { found: false, matches: [] };
  var strings = extractStrings(args);
  var matches = [];

  for (var i = 0; i < strings.length; i++) {
    var str = strings[i];
    for (var j = 0; j < PATTERNS.length; j++) {
      var p = PATTERNS[j];
      p.re.lastIndex = 0; // reset regex state for global flag
      var m = p.re.exec(str);
      if (m) {
        matches.push({
          name: p.name,
          sample: redact(m[0]), // NEVER echo the full secret
        });
      }
    }
  }

  return { found: matches.length > 0, matches: matches };
}

function createCredentialScanner() {
  return { scan: scan };
}

module.exports = { createCredentialScanner: createCredentialScanner, scan: scan, redactText: redactText, redactCounted: redactCounted, _PATTERNS: PATTERNS, _redact: redact };
