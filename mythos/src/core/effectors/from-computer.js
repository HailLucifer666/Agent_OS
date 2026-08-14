'use strict';

// effectors/from-computer.js — CA of app/lib/voice/tools-computer.js. Function bodies
// (open_folder/list_folder/read_file/compose_email) are verbatim from NOVA; this file
// has no NOVA lib deps to re-point. Registration is the only Phase-7-specific addition.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { effectorFromTool } = require('./adapter');
// Spawning explorer.exe is not a window existing — see evidence.js's header.
const evidence = require('./evidence');
// Task 3 (step 5) — clipboard_read/clipboard_write delegate through pc-child,
// same required-directly convention from-pc.js's own delegate() helper uses
// (dispatch-action.js's real ctx is {signal, bus, goalId} — it never carries
// adapter handles — so these must NOT expect an injected ctx.pcChild).
const pcChild = require('../../../adapters/pc-child');

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

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// win32 paths are case-insensitive; normalize for the prefix comparison.
function forCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function containedIn(candidate, root) {
  const c = forCompare(candidate);
  const r = forCompare(root);
  return c === r || c.startsWith(r + path.sep);
}

// allowedRoots(), plus each root's symlink-resolved form. Without the resolved
// form a root that is itself a junction — or is given as a Windows 8.3 short
// path, which is what os.tmpdir() hands back — would never match the real
// (canonical) path of its own contents, locking legitimate callers out.
function comparableRoots() {
  const out = [];
  for (const root of allowedRoots()) {
    out.push(root);
    const real = realpathOrNull(root);
    if (real && real !== root) out.push(real);
  }
  return out;
}

// Resolves `raw` and verifies it lands inside one of VOICE_ALLOWED_DIRS — both
// lexically AND after symlink resolution (see isInsideAllowedRoots below).
// Returns { ok:true, resolved } or { ok:false, reason }. Never throws.
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
    // `rule`/`allowedRoots` are carried alongside the prose `reason` only for
    // THIS failure (outside the allowlist) — every other resolveSandboxed()
    // caller (list_folder, read_file, ...) still reads .reason as a plain
    // string and is unaffected. open_folder uses the structured fields below
    // so a refusal is a fact the operator can act on rather than "a mystery":
    // narrating a fixed rule as unexplained was the actual bug (2026-08-12,
    // 02:21:27 — the allowlist refusal was explained as a mystery, not a rule).
    const outside = {
      ok: false,
      reason: `"${raw}" is outside the folders I can access. I'm limited to: ${roots.join('; ')}.`,
      rule: 'outside-allowed-roots',
      allowedRoots: roots,
    };
    // Lexical containment first (cheap, no fs access)...
    if (!comparableRoots().some((root) => containedIn(resolved, root))) return outside;
    // ...then the real-path check, so a junction/symlink planted inside an
    // allowed root and pointing outside it cannot smuggle a path past the
    // lexical test. Every caller gets this for free — do NOT drop it in favour
    // of the lexical check alone.
    if (!isInsideAllowedRoots(resolved)) return outside;
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---- open_folder ----

// WAVE 6. This tool already existed — the Trust Plan's assumption that it was
// missing is wrong, and adding a second one would have collided on the name. What
// was actually wrong is two things:
//
//   1. It returned ok({opened: path}) on the strength of having spawned
//      explorer.exe. That is the Wave 0 defect exactly: the spawn succeeding is
//      not a window existing, and explorer.exe exits non-zero even when it works,
//      so its exit code is not evidence either. The oracle is a real Explorer
//      window whose title is the folder's leaf name.
//   2. Its description was one terse sentence, which is why the model reached for
//      launch_app('explorer.exe "D:\\..."') three times in the 2026-07-31 session
//      instead — a shape that cannot work, since launch_app takes an app NAME and
//      never parsed arguments.
async function open_folder({ path: rawPath }) {
  if (!rawPath) return fail('A folder path is required.');
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) {
    // Carry the rule and the allowed roots as fields the model can act on
    // (e.g. "open X inside <one of allowedRoots>"), not only prose it has to
    // parse back apart — see the WAVE comment above resolveSandboxed's
    // `outside` object for why this is open_folder-specific.
    if (sandboxed.rule) {
      return fail({ error: sandboxed.reason, rule: sandboxed.rule, allowedRoots: sandboxed.allowedRoots });
    }
    return fail(sandboxed.reason);
  }
  try {
    if (!fs.existsSync(sandboxed.resolved)) return fail(`Folder not found: ${sandboxed.resolved}`);
    let stat;
    try { stat = fs.statSync(sandboxed.resolved); } catch (_) { stat = null; }
    if (stat && !stat.isDirectory()) {
      return fail(`That is a file, not a folder: ${sandboxed.resolved}. Use open_artifact for files.`);
    }

    const child = spawn('explorer.exe', [sandboxed.resolved], { detached: true, stdio: 'ignore' });
    child.unref();

    const leaf = path.basename(sandboxed.resolved);
    const base = { ok: true, result: { opened: sandboxed.resolved, name: leaf } };

    // Explorer needs a moment to create and title the window.
    await new Promise((r) => setTimeout(r, 700));
    let win = null;
    try {
      const fromPc = require('./from-pc');
      if (typeof fromPc.findExplorerWindow === 'function') win = await fromPc.findExplorerWindow(leaf);
    } catch (_) { /* pc-child may be offline; that only costs us the oracle */ }

    if (win) {
      return evidence.verifiedOk(base, {
        oracle: 'window-title',
        expected: leaf,
        observed: String(win.title) + ' (pid ' + win.pid + ')',
      });
    }
    return evidence.unverified(base,
      'asked Explorer to open ' + leaf + ', but no window with that name showed up — it may have ' +
      'reused a window you already had open, or pc-child is not running to check');
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

// REMEDIATION P0-1: a directory INSIDE an allowed root that is itself a
// symlink/junction to somewhere outside would otherwise let a write/delete
// escape the sandbox even though the raw path looked contained. (As of the
// Task-10 review follow-up resolveSandboxed() calls this itself, so every
// caller is covered; the explicit calls below are kept because they check the
// resolved PARENT before a mutation.) The check MUST run before any
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
  const real = realpathOrNull(nearestExistingAncestor(dir));
  if (!real) return false; // couldn't resolve at all — fail CLOSED, not open
  return comparableRoots().some((root) => containedIn(real, root));
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

// ---- clipboard_read / clipboard_write (Task 3, step 5 desktop gaps) ----
// Delegates through the same pcChild.sendCommand path from-pc.js's own
// delegate() helper uses (ctx.pcChild is injected the same way ctx.brain
// and ctx.fs already are for this file's siblings).

function requireClipboardOnline() {
  const status = pcChild.getStatus();
  if (status.state !== 'ONLINE') {
    return fail(`PC automation is ${status.state}. ${status.hint || 'Cannot execute commands.'}`);
  }
  return null;
}

async function clipboard_read() {
  const guard = requireClipboardOnline();
  if (guard) return guard;
  try {
    const resp = await pcChild.sendCommand({ cmd: 'get_clipboard' });
    if (!resp.ok) return fail(resp.error || 'Clipboard read failed.');
    return ok(resp.result);
  } catch (err) {
    return fail(err.message);
  }
}

async function clipboard_write({ text }) {
  if (text === undefined || text === null) return fail('text is required.');
  const guard = requireClipboardOnline();
  if (guard) return guard;
  try {
    const resp = await pcChild.sendCommand({ cmd: 'set_clipboard', text: String(text) });
    if (!resp.ok) return fail(resp.error || 'Clipboard write failed.');
    return ok(resp.result);
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
  { name: 'open_folder', description: 'Open a folder in Windows Explorer. Use for "open my downloads folder", "show me that directory", "open the vault folder", "open D:\\projects". Takes a folder PATH. This is the ONLY way to open a folder — never pass a path to launch_app, which takes an app name only and cannot open directories.', params: { path: 'string - the folder path to open' }, danger: false, fn: open_folder },
  { name: 'list_folder', description: 'List files/folders inside a directory (max 50 entries).', params: { path: 'string' }, danger: false, fn: list_folder },
  { name: 'read_file', description: 'Read a text file (head 16KB, max 1MB).', params: { path: 'string' }, danger: false, fn: read_file },
  // 2026-08-14 (BUG-219): the description now names the phrasing that should reach
  // it. Asked to "save it", the model went after a Save dialog it cannot drive on
  // MSIX Notepad — five minutes of ctrl+s and File-menu clicks, then it closed the
  // window and the text was gone. Writing the content to a file was available the
  // whole time. The rule of thumb is the operator's intent: they want the CONTENT
  // kept, not a particular dialog operated.
  { name: 'write_file', description: 'Write text content to a file inside the allowed sandbox (creates missing parent folders; overwrites if the file already exists). Use this — not a Save dialog, ctrl+s, or menu clicking — whenever the user says "save it", "save this as X", "keep this", or "put that in a file" and a specific path or filename matters; for a plain titled note with no path, use note_take instead. If a save keystroke or Save menu has already failed in an app, do NOT retry it: write the content here and say where it went.', params: { path: 'string', content: 'string' }, danger: true, fn: write_file },
  { name: 'create_folder', description: 'Create a folder (and any missing parent folders) inside the allowed sandbox.', params: { path: 'string' }, danger: true, fn: create_folder },
  { name: 'delete_file', description: 'Permanently delete a file (not a folder) inside the allowed sandbox.', params: { path: 'string' }, danger: true, fn: delete_file },
  { name: 'move_file', description: 'Move (or rename) a file or folder from one location to another inside the allowed sandbox.', params: { from: 'string', to: 'string' }, danger: true, fn: move_file },
  { name: 'copy_file', description: 'Copy a file (not a folder) to a new location inside the allowed sandbox, leaving the original in place.', params: { from: 'string', to: 'string' }, danger: true, fn: copy_file },
  { name: 'rename_file', description: 'Rename a file or folder in place (same folder only — use move_file to relocate across folders).', params: { from: 'string', to: 'string' }, danger: true, fn: rename_file },
  { name: 'search_files', description: 'Search for files/folders by name (supports * and ? wildcards) under a folder inside the allowed sandbox (max depth 6, max 50 results).', params: { root: 'string', pattern: 'string' }, danger: false, fn: search_files },
  { name: 'compose_email', description: "Draft an email and open it in a browser Gmail compose tab (or the OS mail app if VOICE_EMAIL_MODE=mailto). Does NOT send it — human must click Send.", params: { to: 'string (optional)', subject: 'string', body: 'string' }, danger: false, fn: compose_email },
  { name: 'clipboard_read', description: 'Read the current text on the Windows clipboard.', params: {}, danger: false, fn: clipboard_read, needs_result: true },
  // danger:false (not true) is deliberate: this repo's own invariant test
  // (effectors-hub.test.js "danger:true -> tier>=3") requires danger:true
  // tools to sit at T3+. clipboard_write is tiered T2 — same "local action
  // touching real system state, not MYTHOS's own store" class as
  // set_volume/media_key (both danger:false) below — not the T3 class of
  // write_file/delete_file. See tiers.js's clipboard_write comment for the
  // full conflict-resolution reasoning (Task 3 proposed T1, V2 §7.8 proposed
  // T2; resolved T2, which requires danger:false to stay consistent here).
  { name: 'clipboard_write', description: 'Overwrite the Windows clipboard with the given text.', params: { text: 'string' }, danger: false, fn: clipboard_write },
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
  clipboard_read,
  clipboard_write,
  compose_email,
  resolveSandboxed,
  isInsideAllowedRoots,
  allowedRoots,
  buildMailtoUrl,
  buildGmailUrl,
  truncateBody,
};
