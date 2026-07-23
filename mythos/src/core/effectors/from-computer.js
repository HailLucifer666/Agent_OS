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
  const roots = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/%USERPROFILE%/gi, os.homedir()))
    .map((s) => path.resolve(s));
  // Always include the project root so the cortex can read its own source tree.
  // from-computer.js is at src/core/effectors/ — 4 levels up reaches the mythos/ root.
  var projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
  if (!roots.some(function(r) { return path.resolve(r) === projectRoot; })) {
    roots.push(projectRoot);
  }
  return roots;
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

    // On win32, a leading "/" is almost always a Linux-trained AI mistake
    // (e.g. "/vault/builds" instead of "vault/builds"). Strip it so
    // path.resolve treats it as relative, not as drive-root absolute.
    var cleaned = String(raw).replace(/^\/+/, '');
    const expanded = cleaned.replace(/%USERPROFILE%/gi, os.homedir());
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

// REMEDIATION P0-1: resolveSandboxed() only resolves a path lexically. A
// directory INSIDE an allowed root that is itself a symlink/junction to
// somewhere outside would otherwise let a write/delete escape the sandbox
// even though the raw path looked contained. The check MUST run before any
// fs mutation (a prior version ran mkdirSync first and checked after — by
// then the mutation had already landed outside the sandbox) and must walk up
// to the NEAREST EXISTING ancestor of the target, not just the immediate
// parent — a not-yet-created leaf segment can't itself be a symlink, but the
// immediate parent is often exactly the segment that doesn't exist yet while
// a symlink sits a few levels further up the chain.
function nearestExistingAncestor(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached a filesystem root; stop
    probe = parent;
  }
  return probe;
}

function isInsideAllowedRoots(dir) {
  let real;
  try {
    real = fs.realpathSync(nearestExistingAncestor(dir));
  } catch {
    return false; // couldn't resolve at all — fail CLOSED, not open
  }
  const roots = allowedRoots();
  const realForCompare = process.platform === 'win32' ? real.toLowerCase() : real;
  return roots.some((root) => {
    const rootForCompare = process.platform === 'win32' ? root.toLowerCase() : root;
    return realForCompare === rootForCompare || realForCompare.startsWith(rootForCompare + path.sep);
  });
}

// ---- write_file ----

function write_file({ path: rawPath, content }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  if (content === undefined || content === null) return fail('Content is required.');
  const dir = path.dirname(sandboxed.resolved);
  // Sandbox check BEFORE any mutation — see isInsideAllowedRoots() above.
  if (!isInsideAllowedRoots(dir)) return fail(`"${rawPath}" resolves outside the allowed folders.`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const overwritten = fs.existsSync(sandboxed.resolved);
    // Atomic write: temp file + renameSync (mirrors memory/fs-store.js's writeText).
    const tmp = `${sandboxed.resolved}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, String(content), 'utf8');
    try {
      fs.renameSync(tmp, sandboxed.resolved);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
    return ok({ path: sandboxed.resolved, bytesWritten: Buffer.byteLength(String(content), 'utf8'), overwritten });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- create_folder ----

function create_folder({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  if (!isInsideAllowedRoots(path.dirname(sandboxed.resolved))) {
    return fail(`"${rawPath}" resolves outside the allowed folders.`);
  }
  try {
    fs.mkdirSync(sandboxed.resolved, { recursive: true });
    return ok({ created: sandboxed.resolved });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- delete_file ----
// Files only — no recursive directory delete in v1 (matches the plan's
// explicitly scoped-down first cut of the write side).

function delete_file({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  try {
    if (!fs.existsSync(sandboxed.resolved)) return fail(`File not found: ${sandboxed.resolved}`);
    const stat = fs.statSync(sandboxed.resolved);
    if (!stat.isFile()) return fail('Not a file — delete_file only removes files, not directories.');
    if (!isInsideAllowedRoots(path.dirname(sandboxed.resolved))) {
      return fail(`"${rawPath}" resolves outside the allowed folders.`);
    }
    fs.unlinkSync(sandboxed.resolved);
    return ok({ deleted: sandboxed.resolved });
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
  { name: 'write_file', description: 'Write text content to a file inside the allowed sandbox (creates missing parent folders; overwrites if the file already exists).', params: { path: 'string', content: 'string' }, danger: true, fn: write_file },
  { name: 'create_folder', description: 'Create a folder (and any missing parent folders) inside the allowed sandbox.', params: { path: 'string' }, danger: true, fn: create_folder },
  { name: 'delete_file', description: 'Permanently delete a file (not a folder) inside the allowed sandbox.', params: { path: 'string' }, danger: true, fn: delete_file },
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
  write_file,
  create_folder,
  delete_file,
  compose_email,
  resolveSandboxed,
  buildMailtoUrl,
  buildGmailUrl,
  truncateBody,
};
