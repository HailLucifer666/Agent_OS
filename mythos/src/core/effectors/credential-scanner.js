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
