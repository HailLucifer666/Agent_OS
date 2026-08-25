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
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9\-_]{10,}\.eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g },
  { name: 'github-token', re: /gh[ps]_[A-Za-z0-9]{36,}/g },
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
  { name: 'openai-key', re: /sk-(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-)[A-Za-z0-9\-_]{20,}/g },
  { name: 'groq-key', re: /gsk_[A-Za-z0-9\-_]{20,}/g },
  { name: 'nvidia-key', re: /nvapi-[A-Za-z0-9\-_]{20,}/g },
];

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

module.exports = { createCredentialScanner: createCredentialScanner, scan: scan, _PATTERNS: PATTERNS, _redact: redact };
