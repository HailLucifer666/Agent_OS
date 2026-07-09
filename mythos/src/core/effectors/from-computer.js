'use strict';

// effectors/from-computer.js — CA of app/lib/voice/tools-computer.js. Function bodies
// (open_folder/list_folder/read_file/compose_email) are verbatim from NOVA; this file
// has no NOVA lib deps to re-point. Registration is the only Phase-7-specific addition.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { effectorFromTool } = require('./adapter');

const MAX_LIST_ENTRIES = 50;
const MAX_READ_BYTES = 1 * 1024 * 1024; // 1MB cap
const READ_HEAD_BYTES = 16 * 1024; // 16KB head for summarization
const MAX_EMAIL_BODY_CHARS = 1800;

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

function allowedRoots() {
  const raw = process.env.VOICE_ALLOWED_DIRS || '%USERPROFILE%';
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/%USERPROFILE%/gi, os.homedir()))
    .map((s) => path.resolve(s));
}

// Rejects UNC paths (\\host\share or //host/share) before resolution — path.resolve()
// would otherwise happily normalize a UNC path into something that superficially looks
// safe. Checked on the raw input, prior to any other processing.
function isUncPath(raw) {
  return /^\\\\[^\\]+\\/.test(raw) || /^\/\/[^/]+\//.test(raw);
}

// Rejects reserved Windows device names anywhere in the path's segments (case-insensitive,
// with or without an extension — CON, CON.txt, etc. are all reserved).
function hasReservedDeviceName(resolved) {
  const segments = resolved.split(path.sep);
  return segments.some((seg) => {
    const base = seg.split('.')[0].toUpperCase();
    return RESERVED_DEVICE_NAMES.has(base);
  });
}

// Resolves `raw` and verifies it lands inside one of VOICE_ALLOWED_DIRS. Returns
// { ok:true, resolved } or { ok:false, reason }. Never throws.
function resolveSandboxed(raw) {
  try {
    if (!raw || !String(raw).trim()) return { ok: false, reason: 'A path is required.' };
    if (isUncPath(raw)) return { ok: false, reason: 'Network (UNC) paths are not allowed.' };

    const expanded = String(raw).replace(/%USERPROFILE%/gi, os.homedir());
    const resolved = path.resolve(expanded);
    if (hasReservedDeviceName(resolved)) {
      return { ok: false, reason: 'That path name is reserved by Windows and cannot be used.' };
    }

    const roots = allowedRoots();
    // win32 paths are case-insensitive; normalize for the prefix comparison.
    const resolvedForCompare = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const inside = roots.some((root) => {
      const rootForCompare = process.platform === 'win32' ? root.toLowerCase() : root;
      return resolvedForCompare === rootForCompare || resolvedForCompare.startsWith(rootForCompare + path.sep);
    });
    if (!inside) {
      return { ok: false, reason: `"${raw}" is outside the allowed folders.` };
    }
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---- open_folder ----

function open_folder({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  try {
    if (!fs.existsSync(sandboxed.resolved)) return fail(`Folder not found: ${sandboxed.resolved}`);
    const child = spawn('explorer.exe', [sandboxed.resolved], { detached: true, stdio: 'ignore' });
    child.unref();
    return ok({ opened: sandboxed.resolved });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- list_folder ----

function list_folder({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  try {
    const entries = fs.readdirSync(sandboxed.resolved, { withFileTypes: true });
    const capped = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => {
      const full = path.join(sandboxed.resolved, entry.name);
      let size = null;
      let mtime = null;
      try {
        const stat = fs.statSync(full);
        size = entry.isDirectory() ? null : stat.size;
        mtime = stat.mtime.toISOString();
      } catch {
        // best-effort — a race (file deleted mid-listing) shouldn't fail the whole tool
      }
      return { name: entry.name, isDirectory: entry.isDirectory(), size, mtime };
    });
    return { ok: true, result: { path: sandboxed.resolved, entries: capped, truncated: entries.length > MAX_LIST_ENTRIES, totalCount: entries.length }, needs_result: true };
  } catch (err) {
    return fail(err.message);
  }
}

// ---- read_file ----

function read_file({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  try {
    const stat = fs.statSync(sandboxed.resolved);
    if (!stat.isFile()) return fail(`Not a file: ${sandboxed.resolved}`);
    if (stat.size > MAX_READ_BYTES) {
      return fail(`File is too large to read (${Math.round(stat.size / 1024)}KB, limit 1MB).`);
    }
    const fd = fs.openSync(sandboxed.resolved, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, READ_HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return { ok: true, result: { path: sandboxed.resolved, text, truncated: stat.size > READ_HEAD_BYTES }, needs_result: true };
  } catch (err) {
    return fail(err.message);
  }
}

// ---- compose_email ----

// Truncates BEFORE encoding, not after — encoding a truncated string never risks cutting
// a multi-byte %XX escape sequence in half.
function truncateBody(body) {
  const text = String(body || '');
  if (text.length <= MAX_EMAIL_BODY_CHARS) return text;
  return text.slice(0, MAX_EMAIL_BODY_CHARS);
}

function buildMailtoUrl({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', truncateBody(body));
  const query = params.toString();
  const toPart = to ? encodeURIComponent(to) : '';
  return `mailto:${toPart}${query ? `?${query}` : ''}`;
}

function buildGmailUrl({ to, subject, body }) {
  const params = new URLSearchParams();
  if (to) params.set('to', to);
  if (subject) params.set('subject', subject);
  if (body) params.set('body', truncateBody(body));
  params.set('view', 'cm');
  params.set('fs', '1');
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function compose_email({ to, subject, body }) {
  try {
    if (!subject && !body) return fail('An email needs at least a subject or a body.');
    // Default is 'gmail' (opens a browser compose tab) rather than the OS mail app —
    // no desktop mail client is set up/connected yet. Set VOICE_EMAIL_MODE=mailto to
    // use the default mail app instead once one is configured.
    const mode = process.env.VOICE_EMAIL_MODE === 'mailto' ? 'mailto' : 'gmail';
    const url = mode === 'gmail' ? buildGmailUrl({ to, subject, body }) : buildMailtoUrl({ to, subject, body });
    spawn('cmd', ['/c', 'start', '', url], { shell: false });
    return ok({ mode, url, to: to || null, subject: subject || null });
  } catch (err) {
    return fail(err.message);
  }
}

const TOOLS = [
  { name: 'open_folder', description: 'Open a folder in Windows Explorer.', params: { path: 'string' }, danger: false, fn: open_folder },
  { name: 'list_folder', description: 'List files/folders inside a directory (max 50 entries).', params: { path: 'string' }, danger: false, fn: list_folder },
  { name: 'read_file', description: 'Read a text file (head 16KB, max 1MB).', params: { path: 'string' }, danger: false, fn: read_file },
  { name: 'compose_email', description: "Draft an email and open it in a browser Gmail compose tab (or the OS mail app if VOICE_EMAIL_MODE=mailto). Does NOT send it — human must click Send.", params: { to: 'string (optional)', subject: 'string', body: 'string' }, danger: false, fn: compose_email },
];

function registerFromComputer(hub) {
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromComputer,
  TOOLS,
  open_folder,
  list_folder,
  read_file,
  compose_email,
  resolveSandboxed,
  buildMailtoUrl,
  buildGmailUrl,
  truncateBody,
};
