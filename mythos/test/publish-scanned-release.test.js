'use strict';

// test/publish-scanned-release.test.js — the upload step may only send the bytes
// the package scan passed, under the names the updater requests, and must prove
// GitHub holds them afterwards (2026-09-29 audit, B1).
//
// Every refusal is asserted on the MECHANISM: the injected `gh` records every
// call, and a refused upload must leave no "release create/upload" call in that
// record — not merely return non-zero.
//
// PROVEN ABLE TO FAIL, 2026-09-29: nine mutations — ignore a post-scan change;
// ignore a digest mismatch; accept a missing digest; accept a forbidden receipt;
// allow an existing draft; upload under the on-disk (spaced) names; skip the
// read-back; accept a path in the receipt; skip the dist re-hash. All nine now
// turn a test here red. The missing-digest one SURVIVED the first version of
// its test (the mismatch branch also fired, so the exit code was still 1); the
// test now pins the reason as well.
//
// After independent review (Opus), same day: the upload onto an existing
// release used --clobber, and a test here REQUIRED it. Six more mutations, each
// red: --clobber restored; conflicts ignored; every file uploaded instead of the
// missing ones; the idempotent "already holds these bytes" exit removed; an
// existing file with no digest accepted; the draft refusal telling the operator
// to publish.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pub = require('../../scripts/publish-scanned-release.js');
const { sha256File } = require('../scripts/verify-package-contents.js');

const PKG = { build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } };
const ARTIFACTS = [
  { file: 'MYTHOS Setup 9.9.9.exe', name: 'MYTHOS-Setup-9.9.9.exe', body: 'installer-bytes' },
  { file: 'MYTHOS Setup 9.9.9.exe.blockmap', name: 'MYTHOS-Setup-9.9.9.exe.blockmap', body: 'blockmap-bytes' },
  { file: 'latest.yml', name: 'latest.yml', body: 'version: 9.9.9\npath: MYTHOS-Setup-9.9.9.exe\n' },
];

function fakeDist(t, { receiptOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-publish-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir);
  for (const a of ARTIFACTS) fs.writeFileSync(path.join(distDir, a.file), a.body);
  const receipt = {
    schema: 1,
    status: 'clean',
    version: '9.9.9',
    scannedAt: '2026-09-29T00:00:00.000Z',
    artifacts: ARTIFACTS.map((a) => ({
      name: a.name, file: a.file, size: Buffer.byteLength(a.body), sha256: sha256File(path.join(distDir, a.file)),
    })),
    ...receiptOverrides,
  };
  fs.writeFileSync(path.join(distDir, 'package-scan.json'), JSON.stringify(receipt));
  const notesFile = path.join(root, 'release-notes.md');
  fs.writeFileSync(notesFile, '## MYTHOS 9.9.9\n');
  return { root, distDir, notesFile, receipt };
}

// A recording gh. `releases` is what the list call returns before the upload;
// after a successful upload the release reads back with `remoteAssets`.
function fakeGh({ releases = [], uploadOk = true, remoteAssets = null, draftAfter = false } = {}) {
  const calls = [];
  let uploaded = false;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api') {
      const list = uploaded
        ? [{ tag_name: 'v9.9.9', draft: draftAfter, assets: remoteAssets }]
        : releases;
      return { ok: true, status: 0, stdout: JSON.stringify([list]), stderr: '' };
    }
    if (args[0] === 'release') {
      uploaded = uploadOk;
      return uploadOk ? { ok: true, status: 0, stdout: '', stderr: '' } : { ok: false, status: 1, stdout: '', stderr: 'HTTP 422' };
    }
    throw new Error('unexpected gh call ' + args.join(' '));
  };
  return { gh, calls, uploads: () => calls.filter((c) => c[0] === 'release') };
}

function digestsFor(receipt) {
  return receipt.artifacts.map((a) => ({ name: a.name, size: a.size, digest: `sha256:${a.sha256}` }));
}

function runMain(env, gh, tag = 'v9.9.9') {
  const lines = [];
  const code = pub.main([tag], { gh, distDir: env.distDir, notesFile: env.notesFile, pkg: PKG, log: (l) => lines.push(l) });
  return { code, lines };
}

describe('publish-scanned-release', () => {
  test('a clean receipt uploads the scanned bytes under the updater\'s names, then verifies GitHub\'s digests', (t) => {
    const env = fakeDist(t);
    const g = fakeGh({ remoteAssets: digestsFor(env.receipt) });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 0, lines.join('\n'));
    const [create] = g.uploads();
    assert.deepEqual(create.slice(0, 3), ['release', 'create', 'v9.9.9']);
    assert.deepEqual(create.slice(3, 6).map((f) => path.basename(f)),
      ['MYTHOS-Setup-9.9.9.exe', 'MYTHOS-Setup-9.9.9.exe.blockmap', 'latest.yml'],
      'asset names must be the ones latest.yml tells electron-updater to fetch');
    for (const flag of ['--verify-tag', '--repo', '--title', '--notes-file']) assert.ok(create.includes(flag), flag);
    assert.equal(create[create.indexOf('--title') + 1], '9.9.9');
    // The staged copies are the bytes that leave: same content as the scan saw.
    for (const f of create.slice(3, 6)) {
      const a = env.receipt.artifacts.find((x) => x.name === path.basename(f));
      assert.equal(sha256File(f), a.sha256);
    }
    // Read back AFTER the upload, not only before it.
    assert.equal(g.calls[g.calls.length - 1][0], 'api');
  });

  // Independent review, 2026-09-29: the first version of this script uploaded
  // with --clobber onto any published release, which removed electron-builder's
  // refusal to touch a release published over two hours ago — and this test used
  // to REQUIRE that --clobber. A published file is now never replaced.
  test('an existing release missing a file gets ONLY that file, never with --clobber', (t) => {
    const env = fakeDist(t);
    const partial = digestsFor(env.receipt).filter((a) => a.name !== 'latest.yml');
    const g = fakeGh({ releases: [{ tag_name: 'v9.9.9', draft: false, assets: partial }], remoteAssets: digestsFor(env.receipt) });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 0, lines.join('\n'));
    const [up] = g.uploads();
    assert.deepEqual(up.slice(0, 3), ['release', 'upload', 'v9.9.9']);
    assert.deepEqual(up.slice(3).filter((a) => fs.existsSync(a)).map((f) => path.basename(f)), ['latest.yml']);
    assert.equal(up.includes('--clobber'), false, 'gh must refuse, not replace, a same-named file');
  });

  test('an existing release already holding the scanned bytes is left alone — a re-run uploads nothing and succeeds', (t) => {
    const env = fakeDist(t);
    const g = fakeGh({ releases: [{ tag_name: 'v9.9.9', draft: false, assets: digestsFor(env.receipt) }] });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 0, lines.join('\n'));
    assert.deepEqual(g.uploads(), []);
    assert.match(lines.join('\n'), /already holds exactly the 3 scanned artifacts/);
  });

  // The collision the review named: `release.js --yes` uploads locally, and the
  // tag push also starts release.yml, whose own (non-reproducible) build then
  // meets a published release holding different bytes.
  test('an existing release holding OTHER bytes for any file is refused, and nothing is uploaded', (t) => {
    const env = fakeDist(t);
    const other = digestsFor(env.receipt).map((a) => (a.name === 'MYTHOS-Setup-9.9.9.exe' ? { ...a, digest: `sha256:${'1'.repeat(64)}` } : a))
      .filter((a) => a.name !== 'latest.yml');
    const g = fakeGh({ releases: [{ tag_name: 'v9.9.9', draft: false, assets: other }] });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.deepEqual(g.uploads(), [], 'not even the missing latest.yml may go up beside a mismatched installer');
    assert.match(lines.join('\n'), /MYTHOS-Setup-9\.9\.9\.exe is already published with different bytes/);
    assert.match(lines.join('\n'), /never replaced — cut a new version/);
  });

  test('an existing file GitHub gives no digest for cannot be compared, so it is refused', (t) => {
    const env = fakeDist(t);
    const noDigest = digestsFor(env.receipt).map(({ digest, ...rest }) => rest);
    const g = fakeGh({ releases: [{ tag_name: 'v9.9.9', draft: false, assets: noDigest }] });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.deepEqual(g.uploads(), []);
    assert.match(lines.join('\n'), /reports no digest for it/);
  });

  test('an artifact that changed after the scan is refused, and gh uploads nothing', (t) => {
    const env = fakeDist(t);
    fs.writeFileSync(path.join(env.distDir, 'MYTHOS Setup 9.9.9.exe'), 'rebuilt-after-the-scan');
    const g = fakeGh();
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.deepEqual(g.calls, [], 'nothing may reach gh — not even the release lookup');
    assert.match(lines.join('\n'), /changed after the scan/);
  });

  test('a missing artifact is refused before gh is called', (t) => {
    const env = fakeDist(t);
    fs.rmSync(path.join(env.distDir, 'MYTHOS Setup 9.9.9.exe.blockmap'));
    const g = fakeGh();
    assert.equal(runMain(env, g.gh).code, 1);
    assert.deepEqual(g.calls, []);
  });

  for (const [label, overrides, pattern] of [
    ['a forbidden scan', { status: 'forbidden' }, /status is "forbidden"/],
    ['a receipt for another version', { version: '9.9.8' }, /receipt is for 9\.9\.8/],
    ['an unknown schema', { schema: 2 }, /schema 2/],
    ['a receipt without the blockmap', { artifacts: [] }, /must list the installer/],
  ]) {
    test(`${label} cannot vouch for the upload`, (t) => {
      const env = fakeDist(t, { receiptOverrides: overrides });
      const g = fakeGh();
      const { code, lines } = runMain(env, g.gh);
      assert.equal(code, 1);
      assert.deepEqual(g.calls, []);
      assert.match(lines.join('\n'), pattern);
    });
  }

  test('no receipt at all is refused', (t) => {
    const env = fakeDist(t);
    fs.rmSync(path.join(env.distDir, 'package-scan.json'));
    const g = fakeGh();
    assert.equal(runMain(env, g.gh).code, 1);
    assert.deepEqual(g.calls, []);
  });

  test('a receipt that names a path instead of a file is refused (no escaping dist/)', () => {
    const receipt = {
      schema: 1, status: 'clean', version: '9.9.9',
      artifacts: [
        { name: '../MYTHOS-Setup-9.9.9.exe', file: 'x.exe', size: 1, sha256: 'a'.repeat(64) },
        { name: 'MYTHOS-Setup-9.9.9.exe.blockmap', file: '..\\y', size: 1, sha256: 'a'.repeat(64) },
        { name: 'latest.yml', file: 'latest.yml', size: 1, sha256: 'a'.repeat(64) },
      ],
    };
    const problems = pub.receiptProblems(receipt, '9.9.9');
    assert.equal(problems.filter((p) => /names a path/.test(p)).length, 2);
  });

  test('an existing DRAFT is refused — the updater cannot see drafts', (t) => {
    const env = fakeDist(t);
    const g = fakeGh({ releases: [{ tag_name: 'v9.9.9', draft: true, assets: [] }] });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.deepEqual(g.uploads(), []);
    assert.match(lines.join('\n'), /DRAFT\. Delete it by hand/);
    assert.doesNotMatch(lines.join('\n'), /publish or delete/, 'publishing a half-uploaded draft is the 0.1.10 failure');
  });

  test('missing release notes are refused before anything is looked up', (t) => {
    const env = fakeDist(t);
    fs.rmSync(env.notesFile);
    const g = fakeGh();
    assert.equal(runMain(env, g.gh).code, 1);
    assert.deepEqual(g.calls, []);
  });

  test('a failed gh upload is a failure — the exit code electron-builder\'s own publish would have hidden', (t) => {
    const env = fakeDist(t);
    const g = fakeGh({ uploadOk: false });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /HTTP 422/);
  });

  test('GitHub holding different bytes after the upload is a failure, with the asset named', (t) => {
    const env = fakeDist(t);
    const wrong = digestsFor(env.receipt).map((a) => (a.name === 'latest.yml' ? { ...a, digest: `sha256:${'0'.repeat(64)}` } : a));
    const g = fakeGh({ remoteAssets: wrong });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /latest\.yml: GitHub's digest/);
  });

  test('no digest from GitHub means the upload is unproven, not proven', (t) => {
    const env = fakeDist(t);
    const noDigest = digestsFor(env.receipt).map(({ digest, ...rest }) => rest);
    const g = fakeGh({ remoteAssets: noDigest });
    const { code, lines } = runMain(env, g.gh);
    assert.equal(code, 1);
    // The reason is pinned, not only the exit code: "GitHub reported no hash" and
    // "GitHub holds other bytes" need different responses, and the mismatch line
    // below it would otherwise fire for both. Mutation-probed 2026-09-29: deleting
    // the no-digest branch left the exit code at 1 and passed the old version of
    // this test (probe P3).
    assert.match(lines.join('\n'), /reported no digest, so the upload cannot be proven/);
  });

  test('a release that reads back as a draft is a failure', (t) => {
    const env = fakeDist(t);
    const g = fakeGh({ remoteAssets: digestsFor(env.receipt), draftAfter: true });
    assert.equal(runMain(env, g.gh).code, 1);
  });

  test('a tag that is not vX.Y.Z is refused before anything runs', (t) => {
    const env = fakeDist(t);
    const g = fakeGh();
    for (const tag of ['9.9.9', 'v9.9', 'v9.9.9; rm -rf /', '']) {
      assert.equal(runMain(env, g.gh, tag).code, 2, tag);
    }
    assert.deepEqual(g.calls, []);
  });
});
