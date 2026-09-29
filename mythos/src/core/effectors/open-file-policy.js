'use strict';

// effectors/open-file-policy.js — what open_file may hand to the OS, decided on
// the file's REAL path (2026-09-29 audit, B2c).
//
// THE DEFECT. open_file is tier 2 — no confirmation on any path — and asked the
// shell (Electron's shell.openPath, i.e. ShellExecute) to open whatever the
// sandbox let through, minus a fourteen-entry denylist. ShellExecute RUNS far more
// than fourteen kinds of file: .cpl, .msc, .url, .scf, .settingcontent-ms,
// .appref-ms, .library-ms, .search-ms, .inf, .xll, .msix, .diagcab, .pif,
// .psm1 ... and a denylist over names the attacker chooses is not a boundary.
// The extension was also read off the path as TYPED, so a link named notes.txt
// that points at a .cpl passed.
//
// THE SHAPE NOW. An allowlist of extensions that only DISPLAY — text, documents,
// images, audio, video — opens directly. A short list of extensions that EXECUTE
// is refused outright, approval or not. Everything else (html, svg, macro-enabled
// Office files, archives, anything unknown or extension-less) opens only with the
// operator's per-call approval, through the same prepare/approvalFor path as
// launch_app (B2a). All of it is decided on the canonical path, and an NTFS
// alternate data stream (a ":" after the drive) is refused.
//
// The refuse list holds the kinds of file KNOWN to run; it cannot hold every
// runtime a machine may install, so an unlisted kind falls to approval, and the
// prompt says the program associated with it may run it rather than implying it
// is only a document.
//
// What this cannot see: the operator's own file associations. If .txt has been
// re-associated with a script host on this machine, "display" runs it. A .csv
// opened in Excel can hold formulas; Excel's own settings decide whether they
// may start programs (DDE).

const path = require('path');

// Extensions the default Windows handlers DISPLAY. Deliberately short.
// Not here, on purpose (B2c review, 2026-09-29): .xml — a file whose root element
// is HTML's runs its <script> in Chrome and Edge exactly like .html; .rtf — Word
// decides the format from the CONTENT, so a macro document renamed .rtf opens as
// one. Both now need the operator's approval like .html.
const DISPLAY_EXT = new Set([
  '.txt', '.md', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.ini',
  '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.ico',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.m4v',
]);

// Extensions ShellExecute runs, installs or follows. Never opened by open_file —
// running a program is launch_app (and its approval) or run_command.
const EXECUTE_EXT = new Set([
  '.exe', '.com', '.scr', '.pif', '.cpl', '.msc', '.msi', '.msp', '.mst', '.msix',
  '.msixbundle', '.appx', '.appxbundle', '.appinstaller', '.appref-ms', '.application',
  '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml', '.psc1', '.vbs', '.vbe', '.js',
  '.jse', '.wsf', '.wsh', '.wsc', '.hta', '.jar', '.lnk', '.url', '.website', '.scf',
  '.reg', '.inf', '.gadget', '.xll', '.xla', '.xlam', '.diagcab', '.diagpkg', '.cab',
  '.settingcontent-ms', '.library-ms', '.search-ms', '.searchconnector-ms', '.theme',
  '.themepack', '.deskthemepack', '.sys', '.drv', '.dll', '.ocx', '.shs', '.shb',
  '.chm', '.msh', '.msh1', '.msh2', '.mshxml', '.msh1xml', '.msh2xml',
  '.ws', '.vb', '.vxd', '.cer', '.crt', '.der', '.p7b', '.p7c', '.pfx', '.p12',
  // B2c review (2026-09-29): read from this machine's own associations, each one
  // a program that RUNS or installs what it is given — python.exe for .py,
  // PresentationHost for .xbap, wusa for .msu, provtool for .ppkg, mstsc for .rdp,
  // winhlp32 for .hlp, Explorer MOUNTS .iso/.img/.vhd/.vhdx — plus the other
  // script runtimes a machine may have installed, and Windows Sandbox's .wsb,
  // whose config carries a logon command.
  '.py', '.pyw', '.pyc', '.pyo', '.pyz', '.pyzw', '.pl', '.rb', '.rbw', '.ahk', '.au3',
  '.sh', '.bash', '.jnlp', '.xbap', '.msu', '.ppkg', '.rdp', '.hlp', '.iso', '.img',
  '.vhd', '.vhdx', '.wsb', '.job',
]);

// "<drive>:<folder>\notes.txt:evil" — anything after a ":" beyond the drive letter names an
// NTFS alternate data stream, a place the file's visible name says nothing about.
function hasStreamSyntax(p) {
  const s = String(p);
  const rest = /^[A-Za-z]:/.test(s) ? s.slice(2) : s;
  return rest.includes(':');
}

// The extension the way WINDOWS reads it: everything from the last dot, even
// when the dot is the first character. path.extname('.cpl') is '' — Node treats
// a leading dot as part of the name — but ShellExecute runs a file named ".cpl"
// as a Control Panel item (B2c review, 2026-09-29: PathFindExtension returns
// ".cpl" for it, and the association lookup names control.exe).
function windowsExtension(base) {
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

// classifyOpenTarget(realPath) -> { kind: 'display'|'approval'|'refuse', ext, reason }
function classifyOpenTarget(realPath) {
  const p = String(realPath || '');
  if (!p) return { kind: 'refuse', ext: '', reason: 'no path' };
  if (hasStreamSyntax(p)) return { kind: 'refuse', ext: '', reason: 'an alternate data stream' };
  const base = path.basename(p);
  // A file can be CREATED with a trailing dot or space (Node writes "run.exe."
  // literally), but the shell's path handling drops them, so it would open a
  // DIFFERENT file — "page.html" beside the "page.html." that was checked.
  if (/[. ]$/.test(base)) return { kind: 'refuse', ext: '', reason: 'a name ending in a dot or a space, which Windows would open as a different file' };
  const ext = windowsExtension(base);
  if (EXECUTE_EXT.has(ext)) return { kind: 'refuse', ext, reason: `a ${ext} file, which Windows runs rather than displays` };
  if (DISPLAY_EXT.has(ext)) return { kind: 'display', ext, reason: `a ${ext} file` };
  return { kind: 'approval', ext, reason: ext
    ? `a ${ext} file, which is not on the display-only list — Windows hands it to whatever program this machine associates with ${ext}, and that program may run it`
    : 'a file with no extension' };
}

module.exports = { classifyOpenTarget, hasStreamSyntax, windowsExtension, DISPLAY_EXT, EXECUTE_EXT };
