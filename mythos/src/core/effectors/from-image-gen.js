'use strict';

// effectors/from-image-gen.js — voice-commanded image generation (§7.10).
// One tool, T2 (sandboxed vault write, no destructive risk):
//   generate_image ({prompt, title}) → .png via Gemini's native image-gen
//                                       endpoint (NOT the OpenAI-compat shim
//                                       providers/google.js wraps — that shim
//                                       is chat-only; image bytes only come
//                                       back from the native generateContent
//                                       endpoint below).
//
// Verified live 2026-07-30: generativelanguage.googleapis.com's native
// generateContent endpoint (docs: https://ai.google.dev/gemini-api/docs/
// generate-content/image-generation) accepts
//   POST /v1beta/models/{model}:generateContent?key=<GOOGLE_API_KEY>
//   { contents: [{ parts: [{ text: <prompt> }] }],
//     generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }
// and — when it produces an image — returns base64 bytes at
// candidates[0].content.parts[].inlineData.data (mimeType alongside it).
// `gemini-3.1-flash-image` is Google's current "nano banana" general-purpose
// native image model (confirmed against ai.google.dev docs fetched live, and
// empirically: this repo's real GOOGLE_API_KEY got a 429 RESOURCE_EXHAUSTED
// quota error naming that exact model — proving the id is recognized and
// routable — not a 404 model-not-found). Google's docs additionally note a
// newer "Interactions API" (POST /v1beta/interactions) is now recommended for
// new integrations, but generateContent remains live and undeprecated; this
// file uses generateContent to match this codebase's existing native-Gemini
// call in scripts/verify-gemini-live.js and stay off a second, less-proven
// surface.
//
// Real-key finding (also 2026-07-30, see session's live-verification
// transcript): the GOOGLE_API_KEY configured in mythos/.env is a free-tier
// key, and Google's free tier currently grants ZERO quota
// (GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 0) for every
// image-generation model tried (gemini-3.1-flash-image,
// gemini-3.1-flash-lite-image, gemini-3-pro-image, gemini-2.5-flash-image) —
// this is a permanent per-key entitlement gap, not a transient rate limit.
// generate_image is implemented and verified end-to-end (model id valid,
// request shape accepted, response shape parses); it will only actually
// produce an image once the Google AI Studio project attached to this key has
// billing enabled. Until then it degrades honestly via the same
// {ok:false, result:'...'} path as every other from-*.js tool — it does not
// fabricate a fake image or a false success.
//
// Output is sandboxed under vault/builds/images/, same traversal-guard
// discipline as from-docs.js (reuses forge-validate's slugify). Binary bytes
// are written via raw fs, same precedent as from-pc.js's capture_screenshot
// (vault.vaultPath() resolves+guards the path; fs does the actual write).

const path = require('path');
const fs = require('fs');
const { effectorFromTool } = require('./adapter');
const validate = require('./forge-validate');

const routePolicy = require('../brain/route-policy');

const IMAGES_REL = 'builds/images';
const IMAGE_MODEL = 'gemini-3.1-flash-image';
const IMAGE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// The one route this tool calls — also what brain/model-choice.js reports and
// validates an 'image' choice against, so the two cannot disagree.
function billingRoute() {
  return { provider: 'google', model: IMAGE_MODEL, endpoint: IMAGE_BASE, mode: 'image' };
}

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

// Sanitize free-text (title, or the prompt when no title is given) into a
// safe filename stem. Reuses forge-validate's slugify (already
// traversal-tested by from-docs.js) and caps length.
function titleToStem(text) {
  return validate.slugify(text).slice(0, 60) || 'image';
}

// Resolve the full vault-relative output path for a generated image. Guards
// against traversal by routing through slugify (rejects ../, control chars,
// path separators) before joining, plus a defense-in-depth prefix assertion —
// same pattern as from-docs.js's resolveOutputPath.
function resolveOutputPath(vault, stem, ext) {
  const fileName = stem + '.' + ext;
  const rel = path.join(IMAGES_REL, fileName);
  const baseAbs = vault.vaultPath(IMAGES_REL);
  const fullAbs = vault.vaultPath(rel);
  const prefix = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (!fullAbs.startsWith(prefix)) throw new Error('path traversal blocked: ' + fileName);
  return { rel: rel, abs: fullAbs };
}

function buildTools(ctx) {
  const vault = ctx && ctx.vault ? ctx.vault : (ctx && ctx.fs ? ctx.fs : null);
  if (!vault || typeof vault.vaultPath !== 'function') {
    throw new Error('from-image-gen buildTools requires a vault fs-store (vault.vaultPath)');
  }

  // GAP-ANALYSIS-2026-08-24 H1: this fetch previously had no signal, so a hung
  // Gemini call ignored dispatch-action's 30s budget entirely (hub now enforces
  // it structurally, but forwarding the signal still cancels the actual socket
  // instead of orphaning it).
  async function generate_image({ prompt, title }, ctx) {
    if (!prompt || !String(prompt).trim()) {
      return fail('A prompt describing the image is required.');
    }
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return fail('Image generation is unavailable (GOOGLE_API_KEY is not configured).');
    }
    // Wave 0c (2026-09-24): IMAGE_MODEL has NO free tier — Google's pricing page
    // lists it "Not available" there, read that day. Since 2026-10-06 this tool
    // refuses before any request, and says why, until the operator has chosen
    // this model for the 'image' job (brain/model-choice.js).
    const billing = routePolicy.decide(billingRoute());
    if (!billing.allowed) return fail('Image generation is unavailable: ' + billing.reason + '.');
    try {
      const url = IMAGE_BASE + '/' + IMAGE_MODEL +
        ':generateContent?key=' + encodeURIComponent(apiKey);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctx && ctx.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: String(prompt).trim() }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      });
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try {
          const errBody = await res.json();
          if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
        } catch (_) { /* body wasn't JSON — keep the HTTP status */ }
        throw new Error(detail);
      }
      const data = await res.json();
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) || [];
      const imagePart = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!imagePart) {
        const textPart = parts.find((p) => p.text);
        throw new Error('the model returned no image data' + (textPart ? (' (it said: "' + textPart.text.slice(0, 150) + '")') : ''));
      }
      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const stem = titleToStem(title || prompt);
      const out = resolveOutputPath(vault, stem, 'png');
      fs.mkdirSync(path.dirname(out.abs), { recursive: true });
      fs.writeFileSync(out.abs, buffer, 'binary');
      const bytes = fs.statSync(out.abs).size;
      return ok({ savedTo: out.rel, format: 'png', bytes: bytes });
    } catch (err) {
      return fail('Image generation is unavailable (' + err.message + ').');
    }
  }

  return [
    {
      name: 'generate_image',
      description: 'Generate an image from a text description via Gemini native image generation, saved as a PNG under the vault. Pass prompt (what to draw) and optionally title (becomes the filename). Aliases: "draw me", "generate a picture of", "make an image of".',
      params: { prompt: 'string - description of the image to generate', title: 'string (optional) - title, becomes filename' },
      danger: false,
      fn: generate_image,
    },
  ];
}

function registerFromImageGen(hub, ctx) {
  const tools = buildTools(ctx);
  for (let i = 0; i < tools.length; i += 1) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromImageGen, buildTools, billingRoute };
