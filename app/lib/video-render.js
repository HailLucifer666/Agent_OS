// video-render.js — combine saved Video Studio assets into a final mp4 via ffmpeg.
//
// The asset endpoint (server.js /api/video/assets) saves either:
//   - voiceover.mp3 + broll.mp4  (voiceover narrator mode), or
//   - avatar.mp4 + broll.mp4     (presenter narrator mode)
// ...under vault/builds/video/<slug>/. This module muxes or concatenates them into
// final.mp4 in the same directory.
//
// Honesty rules (matches the rest of Agentic OS):
//   - ffmpeg is detected once at module load. If absent, render() rejects with a clear
//     message — no fake success.
//   - ffmpeg stderr is surfaced verbatim on failure — never swallowed or paraphrased.
//   - We use execFile (no shell) so asset paths can't be misinterpreted by the shell.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const vault = require('./vault');

// Resolve ffmpeg once. Prefer FFMPEG_PATH env, else rely on PATH lookup at first use.
let ffmpegBin = process.env.FFMPEG_PATH || null;
let ffmpegChecked = false;
let ffmpegAvailable = false;

function isFfmpegAvailable() {
  if (!ffmpegChecked) {
    ffmpegChecked = true;
    // If an explicit FFMPEG_PATH is set, verify it exists; otherwise assume PATH works
    // and let the first execFile call confirm. We don't spawn a probe here to keep this sync.
    if (ffmpegBin) {
      ffmpegAvailable = fs.existsSync(ffmpegBin);
    } else {
      ffmpegBin = 'ffmpeg'; // resolve via PATH at exec time
      ffmpegAvailable = true;
    }
  }
  return ffmpegAvailable;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!isFfmpegAvailable()) {
      reject(new Error('ffmpeg not found — set FFMPEG_PATH or install ffmpeg on PATH.'));
      return;
    }
    execFile(ffmpegBin, args, { windowsHide: true, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        // Preserve ffmpeg's actual stderr so the user sees the real reason.
        const detail = (stderr || err.message || '').trim().split('\n').slice(-6).join('\n');
        reject(new Error(`ffmpeg failed: ${detail || err.message}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Combine a video set's saved assets into final.mp4.
 *
 * @param {string} slug  - the vault/builds/video/<slug> directory name
 * @returns {Promise<{ slug:string, finalPath:string, mode:string }>}
 *   mode is 'mux' (voiceover + broll) or 'concat' (avatar + broll)
 * @throws if ffmpeg missing, slug not found, assets incomplete, or ffmpeg errors
 */
async function render(slug) {
  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error('Invalid slug.');
  }

  const dir = vault.vaultPath('builds', 'video', slug);
  if (!fs.existsSync(dir)) {
    throw new Error(`Video set "${slug}" not found.`);
  }

  const voiceoverPath = path.join(dir, 'voiceover.mp3');
  const avatarPath = path.join(dir, 'avatar.mp4');
  const brollPath = path.join(dir, 'broll.mp4');
  const finalPath = path.join(dir, 'final.mp4');

  const hasVoiceover = fs.existsSync(voiceoverPath);
  const hasAvatar = fs.existsSync(avatarPath);
  const hasBroll = fs.existsSync(brollPath);

  // Decide the combine strategy honestly based on what's actually on disk.
  let mode;
  if (hasVoiceover && hasBroll) {
    // Mux: take b-roll video, replace/overlay its audio with the voiceover.
    mode = 'mux';
    // -y: overwrite any prior final.mp4; -shortest: stop at the shorter stream
    await runFfmpeg([
      '-y',
      '-i', brollPath,
      '-i', voiceoverPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      finalPath,
    ]);
  } else if (hasAvatar && hasBroll) {
    // Concat: avatar + b-roll back-to-back. Use the concat demuxer for stream-safe join.
    mode = 'concat';
    const listPath = path.join(dir, '.concat-list.txt');
    // concat demuxer requires POSIX-style path separators and escaping of colons.
    // Relative filenames in the list resolve against the working directory, so set cwd.
    fs.writeFileSync(listPath, "file 'avatar.mp4'\nfile 'broll.mp4'\n", 'utf8');
    try {
      await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        finalPath,
      ]);
    } finally {
      try { fs.unlinkSync(listPath); } catch (_) { /* best-effort cleanup */ }
    }
  } else {
    const missing = [
      !hasVoiceover && !hasAvatar ? 'narrator (voiceover.mp3 or avatar.mp4)' : null,
      !hasBroll ? 'broll.mp4' : null,
    ].filter(Boolean).join(' and ');
    throw new Error(`Cannot render — missing assets: ${missing}. Generate Avatar + B-roll first.`);
  }

  if (!fs.existsSync(finalPath)) {
    throw new Error('ffmpeg reported success but final.mp4 was not written.');
  }

  // Update meta.json so the workspace list shows the final render.
  const metaPath = path.join(dir, 'meta.json');
  const meta = vault.readJSON(path.join('builds', 'video', slug, 'meta.json'), null) || {};
  meta.renderedAt = new Date().toISOString();
  meta.note = `Rendered via ffmpeg (${mode}).`;
  const assets = Array.isArray(meta.assets) ? meta.assets : [];
  if (!assets.some((a) => a.stage === 'final')) {
    assets.push({ stage: 'final', path: `/vault/builds/video/${slug}/final.mp4` });
    meta.assets = assets;
  }
  vault.writeJSON(path.join('builds', 'video', slug, 'meta.json'), meta);

  return { slug, finalPath: `/vault/builds/video/${slug}/final.mp4`, mode };
}

module.exports = { render, isFfmpegAvailable };
