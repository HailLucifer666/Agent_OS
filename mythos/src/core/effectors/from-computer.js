'use strict';

// effectors/from-computer.js — CA of app/lib/voice/tools-computer.js. Function bodies
// (open_folder/list_folder/read_file/compose_email) are verbatim from NOVA; this file
// has no NOVA lib deps to re-point. Registration is the only Phase-7-specific addition.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { effectorFromTool } = require('./adapter');
const { findAppPicker, appPickerNote } = require('./open-file-picker');
const deepBudget = require('./deep-think-budget');
// Spawning explorer.exe is not a window existing — see evidence.js's header.
const evidence = require('./evidence');
// Task 3 (step 5) — clipboard_read/clipboard_write delegate through pc-child,
// same required-directly convention from-pc.js's own delegate() helper uses
// (dispatch-action.js's real ctx is {signal, bus, goalId} — it never carries
// adapter handles — so these must NOT expect an injected ctx.pcChild).
const pcChild = require('../../../adapters/pc-child');
// F6 (2026-08-15 live-session RCA): the SAME vault-relative detector open_artifact
// (from-dashboard.js) already trusts, reused here rather than hand-rolling a
// second pattern — see resolveSandboxed()'s vault branch below for why this file
// needed it too.
const { vaultRelativePath } = require('./vault-url');

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

// Populated by registerFromComputer(hub, ctx) at boot — same ctx.config every
// other module-scope collaborator here reads (deepThinkConfig below is the
// identical object, scoped to think_deeply's own name). resolveSandboxed's
// vault branch needs it because MYTHOS_VAULT_ROOT is not derivable from
// process.cwd() — see the F6 comment there.
let vaultRootConfig = null;

// F6: the forked server process's cwd is pinned by Electron to MYTHOS_DIR
// (resources\app.asar.unpacked\mythos in the packaged app) — the
// PRE-MIGRATION vault location (schema.js's DEFAULT_VAULT_ROOT comment) — so
// path.resolve()ing a vault-relative path against cwd lands in the wrong,
// stale tree. MYTHOS_VAULT_ROOT is injected correctly (Electron sets it to
// %APPDATA%\MYTHOS\vault) but nothing here ever consulted it. Returns null,
// never a guess, when no config was ever handed to registerFromComputer.
function realVaultRoot() {
  const configured = vaultRootConfig && vaultRootConfig.MYTHOS_VAULT_ROOT;
  return configured ? path.resolve(configured) : null;
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

    // F6 (2026-08-15 live-session RCA, measured): read_file({path:
    // "vault/builds/job-1786743287677-62/index.html"}) ENOENT'd under
    // ...\app.asar.unpacked\mythos\vault\builds\... because the generic branch
    // below resolves relative paths against process.cwd() — and in the
    // packaged app that cwd IS app.asar.unpacked\mythos, not the real vault.
    // A vault-relative path must resolve against MYTHOS_VAULT_ROOT instead,
    // exactly like open_artifact already does via this same vaultRelativePath()
    // call. Checked BEFORE the generic branch so a vault reference can never
    // fall through to the cwd-relative path.resolve() that produced F6.
    const vaultRel = vaultRelativePath(cleaned);
    if (vaultRel !== null) {
      const vaultRoot = realVaultRoot();
      if (!vaultRoot) {
        return {
          ok: false,
          reason: `"${raw}" names a path inside the vault, but no vault root reached this resolver ` +
            `(registerFromComputer was never given ctx.config) — refusing rather than guessing.`,
        };
      }
      const vaultResolved = path.resolve(vaultRoot, vaultRel);
      if (hasReservedDeviceName(vaultResolved)) {
        return { ok: false, reason: 'That path name is reserved by Windows and cannot be used.' };
      }
      // Escape check, lexical then realpath (mirrors isInsideAllowedRoots below) —
      // a vault root that is itself a junction, or a vaultRel containing enough
      // "../" to walk out, must still be caught. Named loudly with BOTH roots:
      // the process cwd is exactly what the pre-fix code resolved against, so a
      // future divergence between the two is legible here instead of surfacing
      // as a bare ENOENT the way F6 did.
      const vaultRootReal = realpathOrNull(vaultRoot) || vaultRoot;
      const ancestorReal = realpathOrNull(nearestExistingAncestor(vaultResolved));
      // BUG-247 campaign: both boundaries must hold. OR let an in-vault
      // junction expose an outside file through read_file/list_folder; the
      // reverse also passed (lexical traversal through an outside alias back
      // into the vault). A configured vault junction remains valid because
      // physical containment is against its canonical root. The nearest
      // existing ancestor also covers targets whose leaf does not exist yet.
      const insideVault = containedIn(vaultResolved, vaultRoot) &&
        ancestorReal && containedIn(ancestorReal, vaultRootReal);
      if (!insideVault) {
        return {
          ok: false,
          reason: `"${raw}" escapes the vault. Resolved against MYTHOS_VAULT_ROOT ("${vaultRoot}") it points to ` +
            `"${vaultResolved}"; its existing ancestor resolves to "${ancestorReal || 'unavailable'}". ` +
            `Both the lexical path and real ancestor must stay inside the vault (canonical root "${vaultRootReal}"). ` +
            `(This process's cwd is "${process.cwd()}" — the two roots ` +
            `diverging is exactly what caused F6, so both are named here rather than one being silently assumed.)`,
          rule: 'outside-vault-root',
        };
      }
      return { ok: true, resolved: vaultResolved };
    }

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
    // BUG-283 (2026-08-20): a file path used to be refused outright, with a
    // message naming open_artifact. Measured against the audited session: the
    // model did not take the pointer. open_folder was handed
    // Desktop\capabilities.txt, got exactly that refusal, and later — asked to
    // reopen a saved recipe — told the operator "Cannot open that specific file.
    // System limitation." while open_artifact sat declared in the Live allowlist,
    // uncalled, for the entire session.
    //
    // This is the third time this tool has lost a tool-selection race for this
    // intent (see the launch_app('explorer.exe "D:\\..."') history above), and
    // the second time the remedy was prose. Prose lost twice, so the dead end
    // goes: a file path now REVEALS the file — Explorer opens the containing
    // folder with the file selected, which is what "open the folder" means when
    // you are pointed at a file — and the result still names open_artifact for
    // opening the file itself.
    //
    // Deliberately NOT a silent delegation to open_artifact. This tool opens
    // Explorer; launching a document from something called open_folder would
    // trade one dishonesty for another. `opened` and `revealed` stay separate
    // fields for the same reason.
    const isFile = Boolean(stat && !stat.isDirectory());
    // `/select,<path>` must be ONE argument — split in two, Explorer quietly
    // opens the wrong thing and the spawn still succeeds.
    const spawnArgs = isFile ? [`/select,${sandboxed.resolved}`] : [sandboxed.resolved];
    const child = spawn('explorer.exe', spawnArgs, { detached: true, stdio: 'ignore' });
    child.unref();

    // The window that appears is the CONTAINING folder's, so the oracle below
    // must look for that name, not the file's.
    const openedPath = isFile ? path.dirname(sandboxed.resolved) : sandboxed.resolved;
    const leaf = path.basename(openedPath);
    const base = isFile
      ? {
        ok: true,
        result: {
          opened: openedPath,
          name: leaf,
          revealed: sandboxed.resolved,
          note: 'That path is a file, so I opened its folder with the file selected. '
            + 'Call open_artifact on the same path to open the file itself.',
        },
      }
      : { ok: true, result: { opened: sandboxed.resolved, name: leaf } };

    // Explorer needs a moment to create and title the window — and a single
    // check after a fixed 700ms was a coin flip on a busy machine, reporting
    // real successes as unverified. Bounded poll instead (fix-plan 2.2): four
    // tries, 400ms apart, stopping at the first hit. from-pc is required
    // lazily (circular dep) and its absence costs only the oracle, never the
    // open itself.
    let locate = null;
    try { locate = require('./from-pc').findExplorerWindow; } catch (_) { /* pc-child offline costs only the oracle */ }
    let located = null;
    if (typeof locate === 'function') {
      for (let attempt = 0; attempt < 4 && !(located && located.window); attempt++) {
        await new Promise((r) => setTimeout(r, 400));
        try { located = await locate(leaf); } catch (_) { located = null; }
      }
    }

    if (located && located.window) {
      return evidence.verifiedOk(base, {
        oracle: 'window-title',
        expected: leaf,
        observed: String(located.window.title) + ' (pid ' + located.window.pid + ')'
          + (located.matchedBy === 'contains' ? ' [title-match: contains]' : ''),
      });
    }
    if (located && !located.online) {
      return evidence.unverified(base,
        'asked Explorer to open ' + leaf + ', but pc-child is not running, so I could not verify the window');
    }
    return evidence.unverified(base,
      'asked Explorer to open ' + leaf + ', but no window with that name showed up — it may have ' +
      'reused a window you already had open');
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
const { walkBreadthFirst } = require('./file-walk');

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
  let walked;
  try {
    // BUG-362: this used to be a depth-first walk declared inline, which
    // recursed into each subdirectory before testing the next sibling and
    // charged everything to one budget — so a dependency tree early in the
    // listing starved every shallow match. file-walk.js has the measurements.
    walked = walkBreadthFirst(sandboxed.resolved, {
      match: (name) => matcher.test(name),
      maxDepth: MAX_SEARCH_DEPTH, maxScan: MAX_SEARCH_SCAN, maxEntries: MAX_LIST_ENTRIES,
    });
  } catch (err) {
    return fail(err.message);
  }
  const entries = walked.entries.map((hit) => {
    let size = null;
    let mtime = null;
    try {
      const stat = fs.statSync(hit.full);
      size = hit.dirent.isDirectory() ? null : stat.size;
      mtime = stat.mtime.toISOString();
    } catch {
      // best-effort — a race (entry deleted mid-walk) shouldn't fail the whole tool
    }
    return { name: hit.name, path: hit.full, isDirectory: hit.dirent.isDirectory(), size, mtime };
  });
  // A walk that gave up having found nothing is NOT "no such file", and
  // ok:true made the two indistinguishable to every caller. An honest miss
  // still returns ok:true with truncated:false.
  if (!entries.length && walked.truncated) {
    return fail('Searched ' + walked.scanned + ' entries under ' + sandboxed.resolved + ' without finding "' +
      String(pattern) + '", then stopped at the ' + MAX_SEARCH_SCAN + '-entry limit with the tree not fully ' +
      'covered. This is NOT "no such file" — search a narrower root to get an answer that means something.');
  }
  return { ok: true, result: { root: sandboxed.resolved, pattern: String(pattern), entries, truncated: walked.truncated }, needs_result: true };
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

// ---- think_deeply (2026-08-14) -------------------------------------------
// The only route from a conversation to a strong reasoning model. See
// deep-think.js's header for why a TOOL is the mechanism rather than a lane
// change: the Live voice path makes no brain.think calls at all, so nothing in
// lanes.default.js can reach it.
//
// Collaborators arrive through registerFromComputer(hub, ctx) rather than a
// closure factory, because TOOLS is a module-level const this file exports and
// four other modules import from. Held in module scope, which is exactly the
// shape that made camera_look's brain "always null" for weeks — so the failure
// below is explicit and named, and test/think-deeply.test.js pins that main.js
// actually passes it.
let deepThinkBrain = null;
let deepThinkConfig = null;
let deepThinkLogger = null;

// BUG-287 + BUG-398 row 13: the think_deeply budget lives in
// deep-think-budget.js — one shared clock, its 60s rationale, and the refusal
// that names which surface consumed it.
async function think_deeply({ question, context }, ctx) {
  if (!deepThinkBrain || typeof deepThinkBrain.think !== 'function') {
    deepBudget.logRefusal(deepThinkLogger, 'no-brain'); // BUG-478 2026-10-06
    return fail('No brain is wired for deep reasoning, so I cannot think this through properly.');
  }
  // Checked AFTER the brain check on purpose: telling the operator to wait 45
  // seconds for a lane that is not wired at all would be a confident wrong
  // answer, and "no brain" is the more actionable of the two.
  // The `minIntervalMs > 0` clause below is an EQUIVALENT MUTANT under testing:
  // with the interval at 0, `sinceLast < 0` is already false for any forward
  // clock, so flipping it to >= 0 changes nothing a test can observe. It is kept
  // deliberately — it is what makes the 0 opt-out true even if the system clock
  // steps backwards mid-session, which is the one case where sinceLast can go
  // negative. Recorded so the next reader does not delete it as dead.
  const minIntervalMs = deepBudget.deepThinkMinIntervalMs(deepThinkConfig, deepThinkLogger);
  const lastDeepThinkAt = deepBudget.deepThinkState().lastDeepThinkAt;
  const sinceLast = Date.now() - lastDeepThinkAt;
  if (minIntervalMs > 0 && lastDeepThinkAt > 0 && sinceLast < minIntervalMs) {
    deepBudget.logRefusal(deepThinkLogger, 'cooldown', { sinceLastMs: sinceLast }); // BUG-478 2026-10-06
    return fail(deepBudget.cooldownRefusal(sinceLast, minIntervalMs, (ctx && ctx.channel) || null));
  }
  // Stamped BEFORE the call, not after. A lane that is down burns the full
  // timeout on every attempt, so a failing call is the one most worth spacing
  // out; stamping on success only would leave a broken lane hammerable.
  deepBudget.stampDeepThink((ctx && ctx.channel) || null);
  const { deepThink } = require('./deep-think');
  try {
    const r = await deepThink(deepThinkBrain, {
      question: question,
      context: context,
      source: 'think-deeply',
      timeoutMs: deepThinkConfig && deepThinkConfig.DEEP_THINK_TIMEOUT_MS,
      attemptTimeoutMs: deepThinkConfig && deepThinkConfig.DEEP_THINK_ATTEMPT_TIMEOUT_MS,
      logger: deepThinkLogger,
    });
    // Degrade HONESTLY and specifically. "Failed" would be indistinguishable
    // between "no provider alive", "took too long" and "you gave me nothing to
    // think about", and the operator can act on all three differently.
    if (r.reason && !r.content) return fail(r.reason);
    if (r.offline || !r.content) return fail('The reasoning lane did not return an answer.');
    return ok({ answer: r.content, provider: r.provider, model: r.model, ms: r.ms });
  } catch (err) {
    return fail(err.message);
  }
}

// open_file needs the Electron shell to ask the OS to open a document, and
// the effector layer has no way to reach it directly. src/main.js injects
// serverHandle.requestOpenPath here once the server exists. Left null under a
// batch/dev boot on purpose: open_file then says the shell is absent instead
// of reporting an open that nothing performed.
let openPathProvider = null;
function setOpenPathProvider(fn) { openPathProvider = typeof fn === 'function' ? fn : null; }

// Extensions where the shell EXECUTES rather than displays. Refused by NAME,
// matching the posture of isUncPath/hasReservedDeviceName above: name the
// risk shape rather than trusting one layer to have caught it.
//
// Q1 — WHAT ELSE MATCHES THIS? This is a denylist, and a denylist over
// attacker-chosen extensions is not a security boundary; the real boundary is
// resolveSandboxed(), which runs first and confines every path to the allowed
// roots. This list exists so that a file the OPERATOR names by voice inside
// their own sandbox cannot turn "show me that" into "run that" by accident —
// a different and much narrower job. .lnk is here because a shortcut executes
// whatever it points at, and .js because Windows hands it to wscript.
const OPEN_FILE_BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.com', '.vbs', '.js',
  '.jar', '.wsf', '.hta', '.lnk', '.reg',
]);

async function open_file({ path: raw }) {
  const sandboxed = resolveSandboxed(raw);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  const resolved = sandboxed.resolved;
  let st;
  try { st = fs.statSync(resolved); }
  catch { return fail('File not found: ' + resolved); }
  if (st.isDirectory()) {
    return fail('That is a folder, not a file — use open_folder for folders: ' + resolved);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (OPEN_FILE_BLOCKED_EXT.has(ext)) {
    return fail('Refusing to open "' + ext + '" — Windows would EXECUTE it, not display it. ' +
      'If running it is genuinely what you want, that is run_command, which asks first.');
  }
  if (!openPathProvider) {
    return fail('open_file needs the MYTHOS desktop shell, and it is not running.');
  }
  const verdict = await openPathProvider(resolved);
  if (!verdict || !verdict.opened) {
    return fail('Could not open ' + resolved + ': ' + ((verdict && verdict.reason) || 'unknown'));
  }
  // 2026-08-21, operator ticket, their words: "why can't you confirm? ... Just
  // tell me in short that I have opened it." The first version of this said
  // there was no oracle for whether the app rendered anything. That was wrong:
  // open_folder, forty lines up, has polled findExplorerWindow for exactly this
  // since it was written. The window that appears here belongs to the
  // ASSOCIATED app rather than Explorer, so this uses findWindowByTitle — but
  // it is the same oracle, and not looking for it was a sibling-parity miss.
  //
  // The verbosity the operator objected to is downstream of the same defect:
  // the paragraph about Windows accepting a command is what
  // evidence.unverified() emits. Confirm the open and those fields disappear on
  // their own. Shortening the text WITHOUT the oracle would have meant claiming
  // an open nobody had checked, which is the one thing the contract forbids.
  //
  // Bounded poll, four tries 400ms apart, mirroring open_folder: a single
  // fixed-delay check is a coin flip on a busy machine. from-pc is required
  // lazily (circular dep); its absence costs the oracle, never the open.
  const leaf = path.basename(resolved);
  const base = ok({ opened: resolved, name: leaf });
  let locate = null;
  try { locate = require('./from-pc').findWindowByTitle; } catch (_) { /* offline costs only the oracle */ }
  // BUG-398 row 11: the picker check is inside the poll and ends it — see
  // open-file-picker.js.
  let located = null;
  let picker = null;
  if (typeof locate === 'function') {
    for (let attempt = 0; attempt < 4 && !(located && located.window) && !picker; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      try { located = await locate(leaf); } catch (_) { located = null; }
      if (located && located.window) break;
      picker = await findAppPicker(() => require('./from-pc').list_windows());
    }
  }
  if (picker && !(located && located.window)) return evidence.unverified(base, appPickerNote(picker, leaf));

  if (located && located.window) {
    // "and focus it on front" was part of the same request. Advisory: Windows
    // can refuse the foreground change (BUG-272 T3, ladder documented as
    // exhausted), and a refused focus must not turn a confirmed open into a
    // failure — the file IS open either way.
    try {
      const pcFocus = require('./from-pc').focus_window;
      if (typeof pcFocus === 'function') await pcFocus({ pid: located.window.pid });
    } catch (_) { /* the window is open regardless of whether it came forward */ }
    return evidence.verifiedOk(base, {
      oracle: 'window-title',
      expected: leaf,
      observed: String(located.window.title) + ' (pid ' + located.window.pid + ')'
        + (located.matchedBy === 'contains' ? ' [title-match: contains]' : ''),
    });
  }
  if (located && !located.online) {
    return evidence.unverified(base,
      'asked Windows to open ' + leaf + ', but pc-child is not running, so I could not verify the window');
  }
  return evidence.unverified(base,
    'asked Windows to open ' + leaf + ', but no window with that name showed up — the app may still ' +
    'be starting, or it may have opened the file in a window that is titled differently');
}

const TOOLS = [
  { name: 'open_file', description: 'Open a FILE in whatever application Windows associates with it — a .txt in Notepad, a .pdf in the PDF viewer, a .png in Photos. Use for "open that file", "open the report on my desktop", "open notes.txt". Takes a full file PATH. For a FOLDER use open_folder; for a build MYTHOS itself produced in the vault use open_artifact. Refuses executables (.exe/.bat/.ps1 and similar) because Windows would run them rather than show them.', params: { path: 'string - the full path of the file to open' }, danger: false, fn: open_file },
  { name: 'open_folder', description: 'Open a folder in Windows Explorer. Use for "open my downloads folder", "show me that directory", "open the vault folder", "open D:\\projects". Takes a folder PATH. Given a FILE path it opens that file\'s folder with the file selected — to open the file itself in its app, call open_file instead (until 2026-08-21 this said open_artifact, which only serves builds out of the vault over HTTP and could not open a file on disk at all). This is the ONLY way to open a folder — never pass a path to launch_app, which takes an app name only and cannot open directories.', params: { path: 'string - a folder path, or a file path to reveal in its folder' }, danger: false, fn: open_folder },
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
  { name: 'search_files', description: 'Search for files/folders by name (supports * and ? wildcards) under a folder inside the allowed sandbox (max depth 6, max 50 results). Dependency and build folders (node_modules, .venv, dist, .git and similar) are not searched. Shallowest matches are returned first. If it cannot cover the whole tree it FAILS saying so rather than reporting an empty result as "not found".', params: { root: 'string', pattern: 'string' }, danger: false, fn: search_files },
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
  // The description has to say WHEN to reach for this, not what it is. A vague
  // one is how open_web got `query` where its contract demanded `url`, five
  // times out of five (docs/free-tier-model-map.md's J probe is a miniature of
  // that failure). Two failure modes are named explicitly: reaching for it on
  // small talk (burns a slow call and a scarce 5/min budget) and NOT reaching
  // for it on a question the conversation model will otherwise answer badly
  // from its own Flash-tier depth.
  // BUG-255: the first wording named the two failure modes but framed CALLING as
  // the normal move — "comparing options, planning an approach, checking whether
  // an argument holds" describes most of a conversation, and a measured session
  // reached for it 10 times out of 34 total tool calls, more than every other
  // tool combined. Each call is two inference passes (call, then re-reason over
  // the result), which on a rate-limited free tier is the dominant latency the
  // operator feels — a turn that stalled 19s after the tool itself answered in
  // 580ms. So the default is now ANSWERING, and calling requires a positive
  // test the model can actually apply: would you otherwise guess?
  { name: 'think_deeply', description: 'Hand a hard question to a stronger reasoning model and get its answer back. DEFAULT TO ANSWERING IT YOURSELF — you are capable, and this call is expensive: it costs a scarce rate-limited request and roughly doubles how long the operator waits. Only reach for it when you would otherwise GUESS: a genuinely multi-step problem you cannot hold in one pass, a real trade-off between options where being wrong matters, or a described failure whose cause you cannot name. If you already know the shape of the answer, say it — a fast good answer beats a slow better one. Never for chat, opinions, recall, or anything you could answer in a sentence. Not for looking something up (use web_search) or anything on screen (use screen_look). Pass the FULL question plus any facts in `context` — it cannot see the conversation. It takes several seconds, so say you are thinking first. It is limited to about one call a minute system-wide; if it says it is cooling down, that is normal — answer it yourself, do not retry or apologise.', params: { question: 'string - the full question, self-contained', context: 'string (optional) - facts, prior findings or constraints it should reason from' }, danger: false, fn: think_deeply, needs_result: true },
];

// ctx (optional) — { brain, config, logger }. think_deeply needs ctx.brain;
// resolveSandboxed's vault branch (F6, 2026-08-15) needs ctx.config for
// MYTHOS_VAULT_ROOT. Every other tool here is dependency-free, which is why
// this stayed a plain (hub) call until 2026-08-14. A call with no ctx still
// registers every tool: think_deeply fails with a named reason instead of
// throwing, and a vault-relative path fails loudly instead of silently
// resolving against cwd (see realVaultRoot()'s null case above).
function registerFromComputer(hub, ctx) {
  deepThinkBrain = (ctx && ctx.brain) || null;
  deepThinkConfig = (ctx && ctx.config) || null;
  deepThinkLogger = (ctx && ctx.logger) || null;
  vaultRootConfig = (ctx && ctx.config) || null;
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromComputer,
  open_file,
  setOpenPathProvider,
  // BUG-287 test seam: lets the suite assert the schema default and the code
  // default are the same number, since the reasoning for 60s lives in both.
  // BUG-398 row 13: the constant moved to deep-think-budget.js; this seam still
  // answers for it so test/bug-287's schema-agreement check keeps working.
  _deepThinkMinIntervalDefaultMs: () => deepBudget.DEEP_THINK_MIN_INTERVAL_DEFAULT_MS,
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
  think_deeply,
  compose_email,
  resolveSandboxed,
  isInsideAllowedRoots,
  allowedRoots,
  buildMailtoUrl,
  buildGmailUrl,
  truncateBody,
};
