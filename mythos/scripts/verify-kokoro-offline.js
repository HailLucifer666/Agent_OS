'use strict';

// scripts/verify-kokoro-offline.js — prove the Kokoro cache is self-sufficient,
// by loading it with the network genuinely unavailable.
//
// WHY A SCRIPT AND NOT A TEST. The model is 92,361,116 bytes. It cannot live in
// the suite, and a unit test that checks filenames proves only that files have
// the right names — which is exactly the mistake BUG-372 was filed for, where a
// doctor row reported asset presence and was read as "TTS works". The only thing
// that proves a cache is complete is loading from it.
//
// TWO INDEPENDENT PROOFS, because one flag is not proof.
//   1. transformers' own `env.allowRemoteModels = false`, set on the instance
//      resolved through kokoro-js (a real lever, honoured inside getModelFile).
//   2. net.Socket.prototype.connect and dns.lookup patched to THROW. If anything
//      reaches for the network despite (1), it fails loudly and names itself
//      instead of quietly succeeding and making this script a liar.
//   providers/piper-tts.js records the same double-proof reasoning for Piper.
//
// AND A SECOND PROCESS. A warm in-process instance proves nothing about
// persistence, so this re-executes itself once with --child. The parent's result
// and the child's result are both required.
//
// Usage:  cd mythos && node scripts/verify-kokoro-offline.js
// Output is meant to be pasted into a commit message or a BUGS.md entry.

const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const { spawnSync } = require('node:child_process');

const IS_CHILD = process.argv.includes('--child');
const TEXT = 'The quick brown fox jumps over the lazy dog.';

function severNetwork() {
  const blocked = [];
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function blockedConnect(...args) {
    blocked.push('net.connect ' + JSON.stringify(args[0]).slice(0, 120));
    throw new Error('NETWORK BLOCKED by verify-kokoro-offline: net.Socket.connect');
  };
  const realLookup = dns.lookup;
  dns.lookup = function blockedLookup(hostname, ...rest) {
    blocked.push('dns.lookup ' + hostname);
    const cb = rest[rest.length - 1];
    const err = new Error('NETWORK BLOCKED by verify-kokoro-offline: dns.lookup ' + hostname);
    if (typeof cb === 'function') { cb(err); return undefined; }
    throw err;
  };
  return { blocked, restore() { net.Socket.prototype.connect = realConnect; dns.lookup = realLookup; } };
}

function decodeWav(buf) {
  const out = { bytes: buf.length, riff: buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE' };
  if (!out.riff) return out;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      out.audioFormat = buf.readUInt16LE(off + 8);
      out.channels = buf.readUInt16LE(off + 10);
      out.sampleRate = buf.readUInt32LE(off + 12);
      out.bitsPerSample = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      out.dataBytes = size;
      const start = off + 8;
      const end = Math.min(start + size, buf.length);
      let peak = 0;
      if (out.audioFormat === 3 && out.bitsPerSample === 32) {
        for (let i = start; i + 3 < end; i += 4) { const s = Math.abs(buf.readFloatLE(i)); if (s > peak) peak = s; }
      } else if (out.audioFormat === 1 && out.bitsPerSample === 16) {
        for (let i = start; i + 1 < end; i += 2) { const s = Math.abs(buf.readInt16LE(i)) / 32768; if (s > peak) peak = s; }
      } else { out.silent = null; return out; }
      out.peak = Number(peak.toFixed(6));
      out.silent = peak === 0;
      const bytesPerFrame = (out.bitsPerSample / 8) * out.channels;
      out.durationMs = Math.round((size / bytesPerFrame / out.sampleRate) * 1000);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  return out;
}

async function run(label) {
  process.env.KOKORO_OFFLINE = 'true';
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
  const provider = require(path.join(__dirname, '..', 'providers', 'kokoro-tts.js'));
  const modelDir = provider.modelCacheDir();
  const severed = severNetwork();
  const t0 = Date.now();
  let available = false;
  let wav = null;
  let error = null;
  try {
    available = await provider.isAvailable();
    if (!available) throw new Error('isAvailable() said no: ' + provider.unavailableReason());
    const buf = await provider.synthesize({ text: TEXT });
    wav = decodeWav(buf);
  } catch (err) {
    error = (err && err.message) || String(err);
  }
  const ms = Date.now() - t0;
  severed.restore();
  await provider.shutdown();

  const ok = !error && wav && wav.riff && wav.bytes > 0 && wav.silent === false;
  console.log('[' + label + '] modelDir      : ' + modelDir);
  console.log('[' + label + '] node          : ' + process.version + (process.versions.electron ? ' (electron ' + process.versions.electron + ')' : ''));
  console.log('[' + label + '] elapsed       : ' + ms + ' ms');
  console.log('[' + label + '] network calls : ' + (severed.blocked.length ? severed.blocked.join(' | ') : 'NONE — nothing reached for the network'));
  console.log('[' + label + '] audio         : ' + (wav ? JSON.stringify(wav) : 'none'));
  if (error) console.log('[' + label + '] ERROR         : ' + error);
  console.log('[' + label + '] RESULT        : ' + (ok ? 'PASS' : 'FAIL'));
  return ok;
}

(async () => {
  if (IS_CHILD) { process.exitCode = (await run('child')) ? 0 : 1; return; }

  const parentOk = await run('parent');

  // A SECOND PROCESS against the same canonical cache. A warm in-process
  // instance says nothing about whether the bytes on disk are enough.
  console.log('--- re-executing as a second process ---');
  const child = spawnSync(process.execPath, [__filename, '--child'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.stdout.write(child.stdout || '');
  if (child.stderr && child.stderr.trim()) process.stderr.write(child.stderr);
  const childOk = child.status === 0;

  console.log('');
  console.log('OVERALL: ' + (parentOk && childOk ? 'PASS' : 'FAIL')
    + ' (parent ' + (parentOk ? 'pass' : 'fail') + ', second process ' + (childOk ? 'pass' : 'fail') + ')');
  process.exitCode = parentOk && childOk ? 0 : 1;
})();
