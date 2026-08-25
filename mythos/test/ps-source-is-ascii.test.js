'use strict';

// ps-source-is-ascii.test.js -- every tracked .ps1 file must be pure ASCII.
//
// THE BUG THIS FILE EXISTS FOR (BUG-226, observed 2026-08-14 while fixing BUG-223):
//   close_window's refusal message reached Node -- and the operator's speakers --
//   as "confirmation prompt a<euro>" check the screen" instead of an em dash.
//
//   The corruption is at PARSE time, not output time. ps-automation.ps1 is stored
//   UTF-8 with NO byte-order mark, and Windows PowerShell 5.1 parses a BOM-less
//   script as the ANSI codepage (cp1252). So the source bytes E2 80 94 (U+2014)
//   were read by the parser as three separate cp1252 characters before any string
//   ever reached Write-Response. Proven with the real parser:
//
//     [Parser]::ParseFile(<HEAD version>)  ->  'It may be showing a
//        confirmation prompt <mojibake> check the screen, or ask me to force it.'
//     [Parser]::ParseFile(<fixed version>) ->  'It may be showing a
//        confirmation prompt - check the screen, or ask me to force it.'
//
//   This is why the two encoding guards this repo already has both missed it:
//   the UTF-8 console encoding block and Write-Response's \uXXXX escaping both
//   act on OUTPUT, and they faithfully transmitted a string that was already
//   corrupt in memory. Escaping a mojibaked string preserves the mojibake.
//
// Why ASCII rather than adding a BOM: a BOM is one invisible byte that any
// editor, formatter or tooling pass can silently drop, which would reintroduce
// the bug with no visible diff. ASCII-only is greppable, and correct regardless
// of which PowerShell edition or codepage reads the file. Non-ASCII characters
// in these files buy nothing -- they appear only in comments and in prose the
// operator hears spoken aloud, where a hyphen reads identically.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

function trackedPowerShellFiles() {
  const out = execFileSync('git', ['ls-files', '*.ps1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter(Boolean);
}

describe('tracked PowerShell sources are pure ASCII', () => {
  it('finds .ps1 files to check (an empty list would make this test vacuous)', () => {
    const files = trackedPowerShellFiles();
    assert.ok(files.length > 0, 'no tracked .ps1 files found -- the gate would pass vacuously');
    assert.ok(
      files.includes('mythos/adapters/pc-child/ps-automation.ps1'),
      'ps-automation.ps1 is the file BUG-226 was found in and must be covered',
    );
  });

  for (const rel of trackedPowerShellFiles()) {
    it(`${rel} contains no bytes above 0x7F`, () => {
      const bytes = fs.readFileSync(path.join(REPO_ROOT, rel));
      const offenders = [];
      for (let i = 0; i < bytes.length && offenders.length < 5; i += 1) {
        if (bytes[i] > 0x7f) {
          // Report the surrounding ASCII so the offending line is findable.
          const from = Math.max(0, i - 40);
          const context = bytes
            .slice(from, i + 40)
            .toString('latin1')
            .replace(/[^\x20-\x7e]/g, '.');
          offenders.push(`offset ${i} (0x${bytes[i].toString(16)}): ...${context}...`);
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `${rel} has non-ASCII bytes. Windows PowerShell 5.1 parses BOM-less scripts as cp1252, `
          + 'so these will be read as mojibake by the parser and any string containing them will '
          + 'be corrupt before it is ever escaped for output (BUG-226). Replace with ASCII: '
          + `em dash -> "-", arrow -> "->", curly quotes -> straight.\n${offenders.join('\n')}`,
      );
    });
  }
});
