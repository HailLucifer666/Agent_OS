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
      return { ok: false, reason: `"${raw}" is outside the folders I can access. I'm limited to: ${roots.join('; ')}.` };
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
  if (!isInsideAllowedRoots(dir)) return fail(`"${rawPath}" is outside the folders I can access. I'm limited to: ${allowedRoots().join('; ')}.`);
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
    return fail(`"${rawPath}" is outside the folders I can access. I'm limited to: ${allowedRoots().join('; ')}.`);
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
      return fail(`"${rawPath}" is outside the folders I can access. I'm limited to: ${allowedRoots().join('; ')}.`);
    }
    fs.unlinkSync(sandboxed.resolved);
    return ok({ deleted: sandboxed.resolved });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- move_file / copy_file / rename_file ----
// Task 4 (file-management tools): the source AND destination both go through
// resolveSandboxed() (lexical check) then isInsideAllowedRoots() on the
// resolved PARENT directory (realpath check, defeats a symlink placed inside
// an allowed root) BEFORE any mutation — same two-step pattern write_file/
// create_folder/delete_file already use above. A destination outside the
// sandbox is rejected even when the source is safely inside — that is the
// whole point of checking both sides, not just one.

function sandboxParent(rawPath) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return sandboxed;
  if (!isInsideAllowedRoots(path.dirname(sandboxed.resolved))) {
    return { ok: false, reason: `"${rawPath}" is outside the folders I can access. I'm limited to: ${allowedRoots().join('; ')}.` };
  }
  return sandboxed;
}

function move_file({ from, to }) {
  const src = sandboxParent(from);
  if (!src.ok) return fail(src.reason);
  const dst = sandboxParent(to);
  if (!dst.ok) return fail(dst.reason);
  try {
    if (!fs.existsSync(src.resolved)) return fail(`File not found: ${src.resolved}`);
    fs.mkdirSync(path.dirname(dst.resolved), { recursive: true });
    const overwritten = fs.existsSync(dst.resolved);
    fs.renameSync(src.resolved, dst.resolved);
    return ok({ from: src.resolved, to: dst.resolved, overwritten });
  } catch (err) {
    return fail(err.message);
  }
}

// Files only — same scoped-down v1 as delete_file (no recursive directory copy).
function copy_file({ from, to }) {
  const src = sandboxParent(from);
  if (!src.ok) return fail(src.reason);
  const dst = sandboxParent(to);
  if (!dst.ok) return fail(dst.reason);
  try {
    if (!fs.existsSync(src.resolved)) return fail(`File not found: ${src.resolved}`);
    const stat = fs.statSync(src.resolved);
    if (!stat.isFile()) return fail('Not a file — copy_file only copies files, not folders.');
    fs.mkdirSync(path.dirname(dst.resolved), { recursive: true });
    const overwritten = fs.existsSync(dst.resolved);
    fs.copyFileSync(src.resolved, dst.resolved);
    return ok({ from: src.resolved, to: dst.resolved, overwritten });
  } catch (err) {
    return fail(err.message);
  }
}

// rename_file is the same-parent case of move_file: it validates that `from`
// and `to` resolve to the same parent directory, then delegates to
// move_file's own sandboxing + fs.renameSync. Moving across folders is
// move_file's job, not rename_file's.
function rename_file({ from, to }) {
  const src = resolveSandboxed(from);
  if (!src.ok) return fail(src.reason);
  const dst = resolveSandboxed(to);
  if (!dst.ok) return fail(dst.reason);
  const srcDir = path.dirname(src.resolved);
  const dstDir = path.dirname(dst.resolved);
  const sameParent = process.platform === 'win32' ? srcDir.toLowerCase() === dstDir.toLowerCase() : srcDir === dstDir;
  if (!sameParent) {
    return fail('rename_file only renames within the same folder — use move_file to move across folders.');
  }
  return move_file({ from, to });
}

// ---- search_files ----

const MAX_SEARCH_DEPTH = 6; // safety cap — matches the "depth-capped walk" requirement
const MAX_SEARCH_SCAN = 5000; // safety cap on total entries examined, independent of the 50-result cap below

// Turns a simple glob (`*` = any run of chars, `?` = one char) into an
// anchored, case-insensitive RegExp. Deliberately minimal — no brace/bracket
// expansion, matching this file's "no new deps" constraint.
function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function search_files({ root: rawRoot, pattern }) {
  const sandboxed = resolveSandboxed(rawRoot);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  if (!pattern || !String(pattern).trim()) return fail('A search pattern is required.');
  const matcher = wildcardToRegExp(pattern);
  const entries = [];
  let truncated = false;
  let scanned = 0;

  function walk(dir, depth) {
    if (truncated || depth > MAX_SEARCH_DEPTH) return;
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) — best-effort, skip it
    }
    for (const entry of dirEntries) {
      if (truncated) return;
      scanned++;
      if (scanned > MAX_SEARCH_SCAN) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (matcher.test(entry.name)) {
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
        let size = null;
        let mtime = null;
        try {
          const stat = fs.statSync(full);
          size = entry.isDirectory() ? null : stat.size;
          mtime = stat.mtime.toISOString();
        } catch {
          // best-effort — a race (entry deleted mid-walk) shouldn't fail the whole tool
        }
        entries.push({ name: entry.name, path: full, isDirectory: entry.isDirectory(), size, mtime });
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  }

  try {
    walk(sandboxed.resolved, 0);
    return { ok: true, result: { root: sandboxed.resolved, pattern: String(pattern), entries, truncated }, needs_result: true };
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
  { name: 'move_file', description: 'Move (or rename) a file or folder from one location to another inside the allowed sandbox.', params: { from: 'string', to: 'string' }, danger: true, fn: move_file },
  { name: 'copy_file', description: 'Copy a file (not a folder) to a new location inside the allowed sandbox, leaving the original in place.', params: { from: 'string', to: 'string' }, danger: true, fn: copy_file },
  { name: 'rename_file', description: 'Rename a file or folder in place (same folder only — use move_file to relocate across folders).', params: { from: 'string', to: 'string' }, danger: true, fn: rename_file },
  { name: 'search_files', description: 'Search for files/folders by name (supports * and ? wildcards) under a folder inside the allowed sandbox (max depth 6, max 50 results).', params: { root: 'string', pattern: 'string' }, danger: false, fn: search_files },
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
  move_file,
  copy_file,
  rename_file,
  search_files,
  compose_email,
  resolveSandboxed,
  isInsideAllowedRoots,
  allowedRoots,
  buildMailtoUrl,
  buildGmailUrl,
  truncateBody,
};
