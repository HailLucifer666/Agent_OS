'use strict';

// effectors/from-docs.js — voice-commanded document generation (Phase 2).
// Three tools, all T2 (sandboxed vault writes, no destructive risk):
//   generate_spreadsheet ({title, sheets})  → .xlsx via exceljs
//   generate_deck         ({title, slides}) → .pptx via pptxgenjs
//   generate_pdf          ({title, markdown|html}) → .pdf via headless Chrome
//                                                        (HTML fallback if no Chrome)
//
// Output is sandboxed under vault/builds/docs/. Titles are sanitized to safe
// filenames via forge-validate's slugify (same path-traversal discipline as
// Forge). No new network/CDN at runtime — libs are pure Node; PDF reuses the
// locally-resolved Chrome binary, degrading honestly to an HTML file + note
// when Chrome is absent.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { effectorFromTool } = require('./adapter');
const validate = require('./forge-validate');

const DOCS_REL = 'builds/docs';

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

// Sanitize a free-text title into a safe filename stem. Reuses forge-validate's
// slugify (already traversal-tested) and caps length.
function titleToStem(title) {
  return validate.slugify(title).slice(0, 60) || 'document';
}

// Resolve the full vault-relative output path for a generated doc. Guards
// against traversal by routing through slugify (rejects ../, control chars,
// path separators) before joining.
function resolveOutputPath(vault, stem, ext) {
  const fileName = stem + '.' + ext;
  const rel = path.join(DOCS_REL, fileName);
  // Defense-in-depth: assert the resolved path stays under DOCS_REL.
  const baseAbs = vault.vaultPath(DOCS_REL);
  const fullAbs = vault.vaultPath(rel);
  const prefix = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (!fullAbs.startsWith(prefix)) throw new Error('path traversal blocked: ' + fileName);
  return { rel: rel, abs: fullAbs };
}

// Locate a Chrome/Chromium binary on this machine. Returns a path string or null.
// Checks the standard Windows install locations + the CHROME_PATH env override.
// No macOS/Linux probe here — this codebase is Windows-first (see CLAUDE.md);
// on other platforms Chrome is typically absent and we degrade to HTML honestly.
function resolveChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function buildTools(ctx) {
  const vault = ctx && ctx.vault ? ctx.vault : (ctx && ctx.fs ? ctx.fs : null);
  if (!vault || typeof vault.writeText !== 'function' || typeof vault.vaultPath !== 'function') {
    throw new Error('from-docs buildTools requires a vault fs-store (vault.writeText + vault.vaultPath)');
  }

  // ---- generate_spreadsheet ----
  // sheets: [{ name, columns: [string], rows: [[cell, ...]] }]
  async function generate_spreadsheet({ title, sheets }) {
    try {
      if (!sheets || !Array.isArray(sheets) || !sheets.length) {
        return fail('At least one sheet is required. Pass sheets:[{name, columns, rows}].');
      }
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      for (let i = 0; i < sheets.length; i++) {
        const s = sheets[i];
        if (!s || !Array.isArray(s.columns)) {
          return fail('Sheet ' + i + ' is missing a columns array.');
        }
        const ws = wb.addWorksheet(String(s.name || ('Sheet' + (i + 1))));
        ws.addRow(s.columns);
        const rows = Array.isArray(s.rows) ? s.rows : [];
        for (const row of rows) {
          if (Array.isArray(row)) ws.addRow(row);
        }
        // Bold the header row for readability.
        ws.getRow(1).font = { bold: true };
      }
      const stem = titleToStem(title);
      const out = resolveOutputPath(vault, stem, 'xlsx');
      fs.mkdirSync(path.dirname(out.abs), { recursive: true });
      await wb.xlsx.writeFile(out.abs);
      const bytes = fs.statSync(out.abs).size;
      return ok({ savedTo: out.rel, format: 'xlsx', bytes: bytes, sheets: sheets.length });
    } catch (err) {
      return fail('generate_spreadsheet failed: ' + err.message);
    }
  }

  // ---- generate_deck ----
  // slides: [{ title, bullets: [string], notes?: string }]
  async function generate_deck({ title, slides }) {
    try {
      if (!slides || !Array.isArray(slides) || !slides.length) {
        return fail('At least one slide is required. Pass slides:[{title, bullets, notes?}].');
      }
      const PptxGenJS = require('pptxgenjs');
      const pres = new PptxGenJS();
      if (title) pres.title = String(title).slice(0, 200);
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        const slide = pres.addSlide();
        slide.addText(String(s.title || ('Slide ' + (i + 1))), {
          x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true, color: '333333',
        });
        const bullets = Array.isArray(s.bullets) ? s.bullets : [];
        if (bullets.length) {
          slide.addText(bullets.map((b) => ({ text: String(b), options: { bullet: true } })), {
            x: 0.5, y: 1.5, w: 9, h: 4.5, fontSize: 18, color: '444444',
          });
        }
        if (s.notes) slide.addNotes(String(s.notes));
      }
      const stem = titleToStem(title);
      const out = resolveOutputPath(vault, stem, 'pptx');
      fs.mkdirSync(path.dirname(out.abs), { recursive: true });
      await pres.writeFile({ fileName: out.abs });
      const bytes = fs.statSync(out.abs).size;
      return ok({ savedTo: out.rel, format: 'pptx', bytes: bytes, slides: slides.length });
    } catch (err) {
      return fail('generate_deck failed: ' + err.message);
    }
  }

  // ---- generate_pdf ----
  // Accepts markdown OR html. Markdown is rendered to a minimal styled HTML
  // wrapper first. Then headless Chrome prints to PDF. If Chrome is absent,
  // we degrade honestly: write the HTML and return its path with a note.
  async function generate_pdf({ title, markdown, html }) {
    try {
      if (!markdown && !html) {
        return fail('Either markdown or html content is required.');
      }
      const stem = titleToStem(title);
      const rendered = markdown ? markdownToHtml(String(markdown), title) : wrapHtml(String(html), title);

      const chromePath = resolveChromePath();
      // No Chrome → honest HTML fallback.
      if (!chromePath) {
        const out = resolveOutputPath(vault, stem, 'html');
        vault.writeText(out.rel, rendered);
        return ok({
          savedTo: out.rel, format: 'html', bytes: fs.statSync(out.abs).size,
          degraded: true,
          note: 'Chrome was not found, so the document was saved as styled HTML instead of PDF. Install Chrome (or set CHROME_PATH) to enable PDF output.',
        });
      }

      // Write HTML to a temp file under the vault, have Chrome print it to PDF,
      // then remove the temp HTML. The PDF stays under builds/docs/.
      const htmlRel = path.join(DOCS_REL, stem + '.src.html');
      const htmlAbs = vault.vaultPath(htmlRel);
      vault.writeText(htmlRel, rendered);
      const pdfOut = resolveOutputPath(vault, stem, 'pdf');
      try {
        await runChromePrintToPdf(chromePath, htmlAbs, pdfOut.abs);
      } finally {
        try { fs.unlinkSync(htmlAbs); } catch (_) {}
      }
      const bytes = fs.statSync(pdfOut.abs).size;
      return ok({ savedTo: pdfOut.rel, format: 'pdf', bytes: bytes, degraded: false });
    } catch (err) {
      return fail('generate_pdf failed: ' + err.message);
    }
  }

  return [
    {
      name: 'generate_spreadsheet',
      description: 'Generate an Excel (.xlsx) spreadsheet. Pass a title and sheets:[{name, columns:[...], rows:[[...]]}]. The brain composes the content; this tool renders it. Output is saved under the vault and the path returned. Aliases: "build a spreadsheet of", "make an excel of", "export a table".',
      params: { title: 'string - document title (becomes filename)', sheets: 'array - [{name, columns:[header...], rows:[[cell...]]}]' },
      danger: false,
      fn: generate_spreadsheet,
    },
    {
      name: 'generate_deck',
      description: 'Generate a PowerPoint (.pptx) slide deck. Pass a title and slides:[{title, bullets:[...], notes?}]. The brain composes the slides; this tool renders them. Output is saved under the vault. Aliases: "make me a deck about", "build slides on", "create a presentation".',
      params: { title: 'string - deck title (becomes filename)', slides: 'array - [{title, bullets:[string], notes?:string}]' },
      danger: false,
      fn: generate_deck,
    },
    {
      name: 'generate_pdf',
      description: 'Generate a PDF document from markdown or HTML. Pass a title and either markdown or html content. Renders to styled HTML then prints to PDF via headless Chrome. If Chrome is not installed, degrades to an HTML file with a note. Aliases: "export a PDF", "make a report", "save as PDF".',
      params: { title: 'string - document title (becomes filename)', markdown: 'string (optional) - markdown content', html: 'string (optional) - raw HTML content' },
      danger: false,
      fn: generate_pdf,
    },
  ];
}

// ---- PDF helpers ----

// Minimal, dependency-free markdown → HTML. Covers headings, bold/italic,
// code, lists, and paragraphs — enough for a readable report. Deliberately
// not a full CommonMark implementation; complex markdown should pass html=
// directly. Escapes HTML-dangerous chars in non-code text first.
function markdownToHtml(md, title) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const body = [];
  let inList = false;
  let inCode = false;
  const closeList = () => { if (inList) { body.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) { inCode = !inCode; body.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
    if (inCode) { body.push(esc(line)); continue; }
    if (/^###\s+/.test(line)) { closeList(); body.push('<h3>' + esc(line.replace(/^###\s+/, '')) + '</h3>'); continue; }
    if (/^##\s+/.test(line)) { closeList(); body.push('<h2>' + esc(line.replace(/^##\s+/, '')) + '</h2>'); continue; }
    if (/^#\s+/.test(line)) { closeList(); body.push('<h1>' + esc(line.replace(/^#\s+/, '')) + '</h1>'); continue; }
    if (/^[-*]\s+/.test(line)) { if (!inList) { body.push('<ul>'); inList = true; } body.push('<li>' + inlineMd(esc(line.replace(/^[-*]\s+/, ''))) + '</li>'); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    body.push('<p>' + inlineMd(esc(line)) + '</p>');
  }
  closeList();
  return wrapHtml(body.join('\n'), title);
}

// Inline markdown: **bold** and *italic* and `code`. Run AFTER escaping.
function inlineMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function wrapHtml(body, title) {
  const safeTitle = String(title || 'Document').replace(/</g, '&lt;');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + safeTitle + '</title>' +
    '<style>' +
    'body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:780px;margin:40px auto;color:#222;line-height:1.5;padding:0 24px;}' +
    'h1,h2,h3{color:#111;}h1{border-bottom:2px solid #eee;padding-bottom:8px;}' +
    'code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-family:Consolas,monospace;}' +
    'pre{background:#f5f5f5;padding:14px;border-radius:5px;overflow:auto;}' +
    'pre code{background:none;padding:0;}ul{padding-left:22px;}' +
    '</style></head><body>' + body + '</body></html>';
}

// Spawn headless Chrome to print a file URL to PDF. 30s timeout — a one-shot
// print of a local file should never take longer; if it does we fail honestly.
function runChromePrintToPdf(chromePath, htmlAbs, pdfAbs) {
  return new Promise((resolve, reject) => {
    const fileUrl = 'file:///' + htmlAbs.replace(/\\/g, '/');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--print-to-pdf=' + pdfAbs,
      fileUrl,
    ];
    const child = execFile(chromePath, args, { timeout: 30000, windowsHide: true }, (err) => {
      if (err) return reject(new Error('Chrome print-to-pdf failed: ' + err.message));
      if (!fs.existsSync(pdfAbs)) return reject(new Error('Chrome exited but produced no PDF.'));
      resolve();
    });
    // Best-effort: don't let a stuck Chrome keep the process alive.
    if (child && typeof child.unref === 'function') {
      try { child.unref(); } catch (_) {}
    }
  });
}

function registerFromDocs(hub, ctx) {
  const tools = buildTools(ctx);
  for (let i = 0; i < tools.length; i += 1) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromDocs, buildTools };
