'use strict';

// effectors/launch-app.js — launch_app, and the two URI launches MYTHOS itself
// needs (2026-09-29 audit, B2a). Moved out of from-pc.js, which is at its size
// ceiling; from-pc.js builds it with createLaunchApp() and registers the tool.
//
// THE DEFECT. launch_app was tier 2 — auto-allowed at the default autonomy
// ceiling on every path: Live voice, the autonomous loop, engagement stages,
// reminders, MCP — and handed the model's string to pc-child, whose last rung was
// `Start-Process -FilePath $name`: ShellExecute on whatever it was given. cmd,
// powershell, a full path, a UNC path, ms-settings:, a .cpl all ran with no
// confirmation.
//
// THE SHAPE NOW. Three steps, and the middle one is not this file's:
//   1. prepare(args)  — ask pc-child which program the name MEANS (resolve_app,
//      read-only: Spotify, KnownApps, App Paths, Start Apps, else unresolved).
//      leash.prepare() stores the record where the model cannot reach it.
//   2. leash.check()  — authorizes on that record via approvalFor(): an ordinary
//      app on launch-policy.js's reviewed list runs as before; a shell, terminal,
//      console, control panel or anything unreviewed needs the operator's per-call
//      approval, which no ceiling, grant or trust shortcut can give; nothing
//      resolved is refused.
//   3. launch_app()   — launches EXACTLY the prepared record (pc-child's
//      launch_app now requires a target and does no name lookup), and for an
//      approval-required record demands the consent token authority-gate.js
//      minted for that record when the operator said yes.
// A direct caller with no leash in front of it (a script, an internal caller)
// prepares here instead, and an approval-required target simply cannot run for
// it: nothing but authority-gate.js can mint the token.

const { classifyLaunchTarget, describeLaunchTarget } = require('./launch-policy');
const { verifyConsent } = require('../leash/consent');
const { PREPARE_TIMEOUT: RESOLVER_BUSY } = require('../leash/prepared');
const { remedy } = require('./evidence');
const { reasonText } = require('../util/reason-text');

// BUG-075 (Stage 5, "open YouTube on the Electron app"). launch_app("youtube")
// was logged failing 3x on 2026-07-31 — correctly, since nothing named
// YouTube is installed on Windows, but three wasted retries with no better
// path offered. These names are web destinations, not executables; route
// them through the SAME 'ui.open-web' signal open_web already emits
// (dispatch-action.js -> server/index.js -> electron/main.js's media-window
// bridge), so they open in a real Electron window instead of failing.
//
// ponytail: intentionally tiny — only the names actually seen failing in the
// transcript. Upgrade path: anything else still gets an explicit pointer to
// open_web below instead of a silent PS-tier failure.
const KNOWN_WEB_APPS = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  maps: 'https://maps.google.com',
};

// BUG-075 (Stage 5). launch_app("explorer.exe \"D:\\...\"") was logged 3x on
// 2026-07-31 — a shape that can never resolve, since launch_app takes an app
// NAME and never parses arguments. open_folder (BUG-058) already exists for
// exactly "open this folder path"; redirect instead of failing a fourth time.
const EXPLORER_PATH_ARG = /^explorer(\.exe)?\s+"?([a-zA-Z]:\\[^"]*?)"?$/i;

// A path, a URI or anything else with a separator is not an application name,
// and is refused rather than resolved: it is exactly what the removed
// Start-Process fallback used to hand to ShellExecute.
const NOT_AN_APP_NAME = /[\\/:]/;
// PowerShell expands these in a registry path and in Start Apps' -like match:
// "p*" resolved PowerShell.exe (B2a review, measured 2026-09-29).
const WILDCARD = /[*?[\]]/;

// The two URIs MYTHOS opens for itself: from-spotify.js's track/search links and
// from-whatsapp.js's chat link. Mirrored by ps-automation.ps1's
// $script:AllowedUriPatterns, which re-checks them (test-pinned). The search cap
// is 2000 ENCODED characters: 300 refused a 40-character Bengali query, which
// encodes to 414 (B2a review, 2026-09-29).
const SPOTIFY_URI = /^spotify:(track:[A-Za-z0-9]{22}|search:[A-Za-z0-9%._~!*'()-]{1,2000})$/;
const WHATSAPP_URI = /^whatsapp:\/\/send\?phone=[1-9][0-9]{7,14}$/;

// Only these fields of a resolve_app reply are carried; anything else pc-child
// might add stays out of the record the operator approves.
const TARGET_FIELDS = ['resolved', 'kind', 'identity', 'executable', 'appId', 'startName', 'fixedArgs', 'procName', 'reason'];

function createLaunchApp(deps) {
  const { ok, fail, delegate, open_folder, implicitTarget, evidence, SESSION_RESTORING_APPS } = deps;

  async function prepare(args, ctx) {
    const name = String((args && args.name) || '').trim();
    if (!name) return { resolved: false, reason: 'App name is required.' };
    const explorerMatch = EXPLORER_PATH_ARG.exec(name);
    if (explorerMatch) return { resolved: true, kind: 'folder', path: explorerMatch[2] };
    const webApp = KNOWN_WEB_APPS[name.toLowerCase()];
    if (webApp) return { resolved: true, kind: 'web', url: webApp, title: name };
    // BUG-353 "clear on launch": a launch ATTEMPT invalidates the old target even
    // when it FAILS, or "open Spotify" that did not open types into Notepad. It
    // lives HERE, not in launch_app(): the leash refuses an unresolved name and
    // holds an approval-required one before the effector ever runs, so the body
    // was too late on every leash path (B2a review, measured 2026-09-29).
    // leash.prepare() passes no ctx, which is never INTERNAL. Full reasoning on
    // forget() in implicit-target.js.
    if (!implicitTarget.isInternal(ctx)) implicitTarget.forget();
    if (NOT_AN_APP_NAME.test(name)) return { resolved: false, reason: 'not-an-app-name' };
    if (WILDCARD.test(name)) return { resolved: false, reason: 'wildcard-in-name' };
    const res = await delegate({ cmd: 'resolve_app', name });
    const t = res.ok ? res.result : null;
    if (!t || typeof t !== 'object' || typeof t.resolved !== 'boolean') {
      return { resolved: false, reason: res.ok ? 'pc-child returned no resolution' : (reasonText(res.result) || 'resolution failed') };
    }
    const target = {};
    for (const k of TARGET_FIELDS) if (t[k] !== undefined && t[k] !== null) target[k] = t[k];
    if (target.fixedArgs !== undefined) target.fixedArgs = Array.isArray(target.fixedArgs) ? target.fixedArgs.map(String) : [];
    return target;
  }

  // A refusal's detail is the whole sentence the model will read, naming the next
  // tool: the leash's deny reason is the only text Live and the voice agent pass
  // on, so a bare code there ("not-an-app-name") named nothing (Refusals rule 1;
  // B2a review, 2026-09-29).
  function approvalFor(target, args) {
    if (target && target.resolved === true && (target.kind === 'web' || target.kind === 'folder')) return { approval: 'none', detail: target.kind };
    const c = classifyLaunchTarget(target);
    if (c.kind === 'unresolved') {
      const refusal = unresolvedRefusal(String((args && args.name) || '').trim(), target || { reason: c.reason });
      return { approval: 'refuse', detail: refusal.result, remedy: refusal.remedy };
    }
    if (c.kind === 'ordinary') return { approval: 'none', detail: describeLaunchTarget(target) };
    return { approval: 'required', detail: `${c.kind} (${c.reason}): ${describeLaunchTarget(target)}` };
  }

  // The refusal names the next tool in the message AND carries it as a structured
  // remedy chosen from what was typed (src/core/CLAUDE.md, Refusals): a link goes
  // to open_web with that url, a path to open_file with that path, a name nothing
  // matched to list_windows in case it is already open.
  function unresolvedRefusal(name, target) {
    if (target.reason === 'not-an-app-name') {
      if (/^[a-z][a-z0-9+.-]*:/i.test(name) && !/^[a-z]:[\\/]/i.test(name)) {
        return { ok: false, result: `launch_app takes an application NAME, and "${name}" is a link. Use open_web for it.`, remedy: remedy('open_web', { url: name }, 'a link opens in the browser, not as an application') };
      }
      return { ok: false, result: `launch_app takes an application NAME, and "${name}" is a path. Use open_file for a file, or open_folder for a folder.`, remedy: remedy('open_file', { path: name }, 'a file path is opened, not launched') };
    }
    if (target.reason === RESOLVER_BUSY) {
      return { ok: false, result: `Could not check which program "${name}" is: the desktop helper did not answer in time (it runs one thing at a time). Call launch_app again in a moment.`, remedy: remedy('launch_app', { name }, 'retry once the desktop helper is free') };
    }
    return { ok: false, result: `No application called "${name}" could be found (${target.reason || 'unresolved'}). If it is already open, call list_windows; if it is a website, use open_web.`, remedy: remedy('list_windows', {}, 'see whether it is already open under another name') };
  }

  async function launch_app(args, ctx) {
    const { name, existing } = args || {};
    if (!name) return fail('App name is required.');
    const trimmed = String(name).trim();
    // Narrow internal operations (B2a). from-spotify.js and from-whatsapp.js pass
    // the INTERNAL singleton ITSELF — compared by identity, not by its flag, so
    // only code that imports it can take this path — with a URI matching one of
    // the two fixed patterns, which pc-child's open_uri checks again. A model call
    // never carries that object (dispatch-action.js builds its ctx field by field),
    // and a URI from the model is refused below as not-an-app-name.
    if (ctx === implicitTarget.INTERNAL && (SPOTIFY_URI.test(trimmed) || WHATSAPP_URI.test(trimmed))) {
      return delegate({ cmd: 'open_uri', uri: trimmed });
    }
    // An internal caller's link that fits neither pattern is a bug in that caller,
    // not a model mistake — say so, instead of the "takes an application NAME"
    // advice below, which spotify_play would hand the model word for word.
    if (ctx === implicitTarget.INTERNAL && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return fail(`MYTHOS's own link was refused: it is not a Spotify track, a Spotify search of at most 2000 encoded characters, or a WhatsApp chat link (${trimmed.slice(0, 60)}).`);
    }
    const target = (ctx && ctx.prepared) || await prepare(args, ctx);
    if (target.kind === 'folder') return open_folder({ path: target.path });
    if (target.kind === 'web') {
      const payload = { widgetType: 'web', embedUrl: target.url, title: target.title };
      if (ctx && ctx.bus && typeof ctx.bus.emit === 'function') ctx.bus.emit('ui.open-web', payload);
      // Same shape/oracle-honesty as open_web (from-dashboard.js): opening a
      // dashboard/Electron UI surface is not itself evidence-contract "world
      // changing" state, so it is not wrapped in evidence.js either.
      return ok(payload);
    }
    // (BUG-353's forget() ran in prepare(), on this path or the leash's.)
    const verdict = approvalFor(target, args);
    if (verdict.approval === 'refuse') return unresolvedRefusal(trimmed, target);
    if (verdict.approval === 'required') {
      const consent = verifyConsent(ctx && ctx.consent, 'launch_app', { target });
      if (!consent.ok) {
        const refused = fail(`launch_app did NOT start "${trimmed}": it resolves to ${verdict.detail}, which runs only with `
          + 'the operator\'s approval for this one launch. Tell the operator what it is and ask; it starts only after they say yes.');
        return Object.assign(refused, { requiresApproval: true, reason: consent.reason });
      }
    }

    const res = await delegate({ cmd: 'launch_app', name: trimmed, target });
    return launchEvidence(res, trimmed, existing, ctx);
  }

  // Unchanged from from-pc.js (BUG-272 T1, BUG-353, WAVE 1/9): what the launch
  // actually produced, never the request echoed back.
  async function launchEvidence(res, name, existing, ctx) {
    // WAVE 1. ps-automation.ps1 distinguishes a real resolution
    // (matchedBy:'process') from a mere window-TITLE coincidence
    // (matchedBy:'title', reported as candidatePid with NO pid field). The title
    // case is why launch_app("notepad") returned the operator's IDE and two
    // ui_type calls typed into it.
    const r = res.result || {};
    // BUG-272 T1: 'partial' joins 'title' as a CANDIDATE, not a resolution.
    const byProcess = typeof r.pid === 'number' && r.matchedBy !== 'title' && r.matchedBy !== 'partial';
    // BUG-272 T1: does the process we actually landed on match what was asked
    // for? Compared case-insensitively with .exe and whitespace stripped: the
    // requested name must be the WHOLE resolved name, not merely inside it.
    // Absent resolvedName (an older adapter build) the check abstains.
    const resolvedName = typeof r.resolvedName === 'string' && r.resolvedName ? r.resolvedName : null;
    const normName = (v) => String(v || '').trim().replace(/\.exe$/i, '').replace(/\s+/g, '').toLowerCase();
    const nameAgrees = !(byProcess && resolvedName) || normName(resolvedName) === normName(name);

    if (res.ok && byProcess) {
      // BUG-353: internal launches resolve a window they then drive by explicit
      // pid, so they do not become the operator's implicit target.
      if (!implicitTarget.isInternal(ctx)) implicitTarget.remember(r.pid);
      // WAVE 9 (BUG-062): a fresh Notepad document through UIA's Add-New-Tab,
      // claimed only when the tab count rose and the document is empty.
      if (!existing && SESSION_RESTORING_APPS.test(name)) {
        const focused = await delegate({ cmd: 'focus_window', pid: r.pid });
        if (focused.ok) {
          const fresh = await delegate({ cmd: 'new_document', pid: r.pid });
          res.result.freshDocument = Boolean(fresh.ok && fresh.result && fresh.result.fresh);
          if (!res.result.freshDocument) {
            res.result.freshDocumentError = String((fresh.result && fresh.result.error) || fresh.result || 'could not confirm a blank document');
          } else if (fresh.result.via) {
            res.result.freshDocumentVia = String(fresh.result.via);
          }
        } else {
          res.result.freshDocument = false;
          res.result.freshDocumentError = String(focused.result || 'could not focus the window to open a new document');
        }
      }
    }
    if (!res.ok) return res;
    if (byProcess && nameAgrees) {
      return evidence.verifiedOk(res, {
        oracle: 'process-window',
        expected: name,
        observed: String(resolvedName || r.name || name) + ' (pid ' + r.pid + ')',
      });
    }
    // BUG-272 T1: a pid belonging to a DIFFERENT application is worse than no pid.
    if (byProcess && !nameAgrees) {
      implicitTarget.forgetIf(r.pid);
      return evidence.unverified(res, 'asked for "' + name + '" but the windowed process ' +
        'that came up is "' + resolvedName + '" (pid ' + r.pid + '), a different application — not ' +
        'targeting it. Call list_windows to see what is actually open.');
    }
    if (r.matchedBy === 'partial') {
      return evidence.unverified(res, 'no process is named exactly "' + name + '" — the closest was "' +
        (resolvedName || 'an unrelated process') + '", whose name merely contains it, so I am not ' +
        'targeting it');
    }
    return evidence.unverified(res, r.candidateTitle
      ? 'no process named like "' + name + '" owns a window — the only match was an unrelated window titled "' +
        r.candidateTitle + '", which I am not targeting'
      : String(r.note || 'launched, but no windowed process matching the name could be confirmed'));
  }

  return { launch_app, prepare, approvalFor };
}

module.exports = { createLaunchApp, KNOWN_WEB_APPS, SPOTIFY_URI, WHATSAPP_URI };
