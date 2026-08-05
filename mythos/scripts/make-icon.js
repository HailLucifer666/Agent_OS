#!/usr/bin/env node
'use strict';

// mythos/scripts/make-icon.js — generates <repo>/build/icon.ico, the Windows
// application/installer icon electron-builder reads at package time.
//
// Why generate rather than commit a hand-drawn asset: the icon is a binary blob
// nobody can review in a diff, and until now the repo had none at all, so
// `npm run dist` silently shipped Electron's own icon and exited 0. A generator
// makes the asset reproducible and reviewable — you read the drawing code, not
// the bytes — and it keeps the repo dependency-free (zlib is a Node builtin; no
// image library, no ImageMagick, nothing to install).
//
// Deliberately deterministic: no Date, no randomness, no system fonts. The same
// checkout always produces byte-identical output, so a regenerated icon shows a
// zero-length diff unless the drawing actually changed.
//
// Usage:  node mythos/scripts/make-icon.js [--out <path>] [--check]
//   --check  regenerate in memory and compare against the file on disk; exits 1
//            if they differ, so CI can catch an icon edited by hand.
//
// This is a PLACEHOLDER-QUALITY mark, and honestly labelled as such: a dark
// rounded square with a luminous aperture ring. It reads at 16px, which is the
// only hard requirement a taskbar imposes. Replace it with a designed logo when
// the product name (OD-1) is settled — the appId and productName are still
// undecided, so committing to a wordmark now would be premature.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Windows uses each of these; anything missing gets downscaled from a larger
// bitmap and reads as mush in the taskbar and tray.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---- palette ------------------------------------------------------------------
// Near-black plate so the mark sits on any Windows theme, with a cyan core that
// matches the HUD's own accent rather than inventing a second brand colour.
const PLATE_TOP = [0x12, 0x17, 0x20];
const PLATE_BOTTOM = [0x05, 0x07, 0x0a];
const RING = [0x7f, 0xe7, 0xff];
const CORE = [0xe8, 0xfb, 0xff];

// ---- tiny signed-distance renderer --------------------------------------------
// Coverage comes from a signed distance field smoothed over ~1px, which gives
// clean antialiasing without supersampling. Everything is in pixel units.

function smoothCoverage(dist) {
  // dist < 0 is inside. Blend across one pixel centred on the edge.
  const t = 0.5 - dist;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t); // smoothstep
}

function sdRoundRect(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - (halfW - radius);
  const qy = Math.abs(y) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - radius;
}

function over(dst, i, rgb, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  const dstA = dst[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) {
    dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) {
    const src = rgb[c] / 255;
    const d = dst[i + c] / 255;
    dst[i + c] = Math.round(((src * a + d * dstA * (1 - a)) / outA) * 255);
  }
  dst[i + 3] = Math.round(outA * 255);
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const c = (size - 1) / 2;

  // Geometry as fractions of the icon box, so every size is the same drawing.
  const plateHalf = size * 0.470;
  const plateRadius = size * 0.215;
  const ringRadius = size * 0.300;
  // Keep the stroke at least ~1.15px so the ring never vanishes at 16px.
  const ringHalfThickness = Math.max(size * 0.0295, 0.575);
  const coreRadius = Math.max(size * 0.088, 0.9);
  const glowRadius = size * 0.430;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c;
      const dy = y - c;

      // Plate, with a vertical gradient top->bottom.
      const plateCov = smoothCoverage(sdRoundRect(dx, dy, plateHalf, plateHalf, plateRadius));
      if (plateCov > 0) {
        const t = size > 1 ? y / (size - 1) : 0;
        const rgb = [
          Math.round(PLATE_TOP[0] + (PLATE_BOTTOM[0] - PLATE_TOP[0]) * t),
          Math.round(PLATE_TOP[1] + (PLATE_BOTTOM[1] - PLATE_TOP[1]) * t),
          Math.round(PLATE_TOP[2] + (PLATE_BOTTOM[2] - PLATE_TOP[2]) * t),
        ];
        over(px, i, rgb, plateCov);
      }

      const r = Math.hypot(dx, dy);

      // Soft inner glow, clipped to the plate so it never bleeds past the edge.
      if (plateCov > 0 && r < glowRadius) {
        const falloff = 1 - r / glowRadius;
        over(px, i, RING, falloff * falloff * 0.20 * plateCov);
      }

      // Aperture ring.
      const ringCov = smoothCoverage(Math.abs(r - ringRadius) - ringHalfThickness);
      if (ringCov > 0) over(px, i, RING, ringCov * Math.min(1, plateCov + 0.0));

      // Core dot.
      const coreCov = smoothCoverage(r - coreRadius);
      if (coreCov > 0) over(px, i, CORE, coreCov);
    }
  }
  return px;
}

// ---- PNG encoding -------------------------------------------------------------
// 8-bit RGBA, one IDAT, filter type 0 per scanline. Small enough to hand-roll
// and it keeps the script dependency-free.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container ------------------------------------------------------------
// 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per image, then the payloads.
// PNG-compressed entries are valid in ICO on Windows Vista and later, which is
// well below this app's floor (it is an Electron app).

function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, idx) => {
    const o = idx * 16;
    dir[o] = img.size >= 256 ? 0 : img.size;     // 0 means 256
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0; // palette count
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4);  // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

function buildIco() {
  return encodeICO(SIZES.map((size) => ({ size, data: encodePNG(size, renderRGBA(size)) })));
}

// ---- entry point --------------------------------------------------------------

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const repoRoot = path.join(__dirname, '..', '..');
  const out = outIdx !== -1 && argv[outIdx + 1]
    ? path.resolve(argv[outIdx + 1])
    : path.join(repoRoot, 'build', 'icon.ico');

  const ico = buildIco();

  if (argv.includes('--check')) {
    if (!fs.existsSync(out)) {
      console.error('make-icon --check: missing ' + path.relative(repoRoot, out));
      process.exitCode = 1;
      return;
    }
    const onDisk = fs.readFileSync(out);
    if (!onDisk.equals(ico)) {
      console.error('make-icon --check: ' + path.relative(repoRoot, out)
        + ' differs from what this script generates. Re-run without --check to regenerate.');
      process.exitCode = 1;
      return;
    }
    console.log('make-icon --check: up to date (' + SIZES.join(', ') + 'px).');
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, ico);
  console.log('make-icon: wrote ' + path.relative(repoRoot, out)
    + ' (' + ico.length + ' bytes, sizes ' + SIZES.join(', ') + ')');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { buildIco, renderRGBA, encodePNG, encodeICO, SIZES };
