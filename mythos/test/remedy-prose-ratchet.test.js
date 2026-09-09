'use strict';
// BUG-425, 2026-09-10. New tool-call advice in a refusal must be structured.
// Existing prose sites are recorded by content (not line), so moves do not
// create a waiver. The baseline can shrink; additions require fixing the site.
// This lexical scan includes descriptions too, deliberately stricter than the
// minimum: new prose that teaches a tool call has the same argument-copy risk.
// Mutation 2026-09-10: add an unstructured refusal naming browser_navigate -> red.
// Same-date probe restores the unrelated-nearby-remedy waiver; fixture fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const DIR = path.join(__dirname, '../src/core/effectors');
const PROSE_BASELINE = {
  "browser-intent-remedy.js": [
    "49a97d7d71bc722c",
    "50518bdca0531d56"
  ],
  "browser-target.js": [
    "e28da3b6159edf95"
  ],
  "from-android.js": [
    "e9e3096defb727c3",
    "2107eb983ef23338"
  ],
  "from-browser.js": [
    "a975b9905d7d2947",
    "4616d8dcdc63d207",
    "2b2c515678c7e7e2",
    "6284118b408d0d90",
    "c3be4c619e019f7c",
    "7724a1b4e9afb9c6",
    "21d46ff38ac0986d",
    "8965740324ad39b6",
    "78b0a15b6f60706b",
    "ed3abd6be9a23ed6",
    "715c7f0a93be94fc",
    "05adcb641de58fab",
    "6d280d04e5a96480",
    "9a5e2c5afe9d4077",
    "d6786399ff45e777",
    "8d6a3a768e5b668c",
    "968a83af42c67649"
  ],
  "from-calendar.js": [
    "8d2dcf7a97928856",
    "c8d8190cd3986a1b",
    "f486563d8a299dcf"
  ],
  "from-computer.js": [
    "71e2bec2aa22f70c",
    "bfdfd4be06a391b3",
    "09f5a40ee7100b7c",
    "09080c48eaf359ed",
    "e299246974cda7c0",
    "52f45bb33bb4f0c9",
    "b4b209450216ba82",
    "92609290b800395b"
  ],
  "from-cua.js": [
    "609c393db0a597b0",
    "793f16fcf11e8d31",
    "0c8dba7adedbba40",
    "bd0ffbbcc6e9929a",
    "c4b46617ce9e7240",
    "0a6dde98c9bc672c",
    "53800ce7a8fcd53c"
  ],
  "from-dashboard.js": [
    "2c760bc3e3c5687a",
    "eac3216010582e3d",
    "a421def947e484b3",
    "488493dced5847d4",
    "f93aa4b47fef67ed",
    "c66c1c5a23142e85",
    "c23975ac085b0403",
    "6724cb9544588cf0",
    "e49a56e074ae9b25",
    "6575cdb897b1a9f3",
    "13d70aa309e3a77c",
    "31ca6a9b27e07b31",
    "9438aab09588cb62",
    "f22ecd6607c1c160",
    "c98ff81414dec905",
    "ab022fe5b6891ced",
    "09df20a9e8e2d42e",
    "b5344d35b7ba1ec5"
  ],
  "from-desktop.js": [
    "458175d1e982f809"
  ],
  "from-memory.js": [
    "b71a6e6ef0158eaf",
    "9358477ca0a7cc55",
    "f133837a748af9ea"
  ],
  "from-pc.js": [
    "059cedc981388d7f",
    "53064c650ac240b7",
    "c5aa7c5cbc0fa800",
    "5a9c34c38d64387f",
    "6b78d2c777ff3d14",
    "25d8db1367a1b965",
    "6c2bd2fd6ff1cc9b",
    "c206a455ff88c2ca",
    "9ca368ba70bcec8e",
    "13a2bfc237f6a526",
    "08ed606029ae8c3c"
  ],
  "from-runner.js": [
    "b79f4a56b87602a1"
  ],
  "from-skills.js": [
    "65266bcfb3983575"
  ],
  "from-spotify.js": [
    "fe8c593c734928aa"
  ],
  "open-external-route.js": [
    "57276ae7662e8743",
    "3a40639759c6bffa"
  ],
  "ui-target.js": [
    "188f75b50a69d42a",
    "fe40c5688b4af858",
    "0769ef5e681129db",
    "99cfcbaa025ecc39",
    "2562a86dc9c023fe",
    "d5daf7bada6efe3f"
  ],
  "web-search.js": [
    "185525e2053df937"
  ],
  "window-recovery.js": [
    "fd8def33381464cd"
  ]
};

function adviceStrings(source) {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    const quote = source[i];
    if (!['"', "'", '`'].includes(quote)) continue;
    const start = i++;
    for (; i < source.length; i++) { if (source[i] === '\\') { i++; continue; } if (source[i] === quote) break; }
    const text = source.slice(start + 1, i);
    if (!/\b(?:call|use|try|retry)\b/i.test(text)) continue;
    if (!Object.keys(TIER_TABLE).some(tool => new RegExp('\\b' + tool + '\\b').test(text))) continue;
    // A result/text string immediately beside a constructed remedy already
    // carries a call, so it does not require a prose exception.
    if (/^\s*,\s*remedy\s*:\s*remedy\(/.test(source.slice(i + 1))) continue;
    found.push(crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));
  }
  return found;
}
function inventory() {
  const out = {};
  for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.js'))) {
    const entries = adviceStrings(fs.readFileSync(path.join(DIR, file), 'utf8'));
    if (entries.length) out[file] = entries;
  }
  return out;
}
test('only a sibling remedy exempts refusal prose', () => {
  assert.equal(adviceStrings("return { result: 'Call browser_navigate.', remedy: remedy('browser_navigate', {}, 'why') };").length, 0);
  assert.equal(adviceStrings("return { result: 'Call browser_navigate.' }; const other = { remedy: remedy('browser_navigate', {}, 'why') };").length, 1);
});

test('tool-call prose debt never grows', () => {
  const extra = [];
  for (const [file, hashes] of Object.entries(inventory())) {
    const allowed = [...(PROSE_BASELINE[file] || [])];
    for (const hash of hashes) { const i = allowed.indexOf(hash); if (i < 0) extra.push(file + ':' + hash); else allowed.splice(i, 1); }
  }
  assert.deepEqual(extra, [], 'use evidence.remedy(tool, args, why) beside refusal text; do not grow PROSE_BASELINE');
});
module.exports = { inventory, adviceStrings };
