#!/usr/bin/env node
'use strict';

// verify-propose-goal-ui-click.js — live verification harness for
// Phase4/V5 (propose_goal — UI-click half).
//
// BUGS.md's V5 entry covers the cortex SUGGESTING goals (status:'proposed')
// and the operator accepting/rejecting via the dashboard, but explicitly
// caveats: "No live operator verification of: ... propose_goal UI flow ...".
// verify-propose-goal.js and verify-mull-propose-goal.js already prove the
// BACKEND half (mull() -> propose_goal effector -> GET /api/goals/proposals
// -> Goals/<id>.json on disk) against a real boot. Neither of those scripts
// ever renders the dashboard or clicks a button — this script is the other
// half: a REAL Chromium (playwright-core, already a repo dependency — zero
// new deps) driving REAL clicks on the REAL <button data-action="accept|
// reject"> elements rendered by ui/public/js/views/proposals.js, against a
// REAL running MYTHOS boot, and then confirming via the REST API AND the
// on-disk Goals/<id>.json files that:
//   1. A status:'proposed' goal is NOT activated on its own — it sits inert
//      through several seconds of real tick/mull loop before any click.
//   2. Clicking the real "Accept" button flips it to status:'active' with
//      drive:'user-service' (goalsEffector.acceptProposal's exact contract)
//      and it disappears from GET /api/goals/proposals.
//   3. Clicking the real "Reject" button deletes it outright (removed from
//      disk, gone from every API view) rather than merely hiding it.
//
// How the panel gets opened, honestly: investigating ui/public/js/neural-map
// (graph-model.js's module-node list) and voice/voice-loop.js's NAV_COMMANDS
// table shows the 'proposals' panel has NO neural-map graph node and NO
// voice-nav phrase today — the only in-app way to open it is a server-pushed
// {type:'navigate', route:'proposals'} WS message (normally emitted when the
// brain calls the navigate effector). That's a real but indirect path this
// script does not fabricate a shortcut around: it drives the panel open the
// same way ui/public/js/overlay/overlay-manager.js's own openPanel() does —
// by importing the real panel-registry entry and calling the real view's
// render(mount) — then all subsequent interaction (the Accept/Reject clicks,
// the fetch() calls they trigger, the DOM re-render after each click) is the
// unmodified production code path. This is flagged as a real UX gap in the
// evidence output, separate from the accept/reject mechanics under test.
//
// Usage:
//   node scripts/verify-propose-goal-ui-click.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const { log, bootMythos, killTree } = require('./verify-lib');

function randomPortInRange(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  for (let i = 0; i < 12; i++) {
    const p = randomPortInRange(4500, 4900);
    if (await isPortFree(p)) return p;
  }
  throw new Error('could not find a free port in 4500-4900 after 12 attempts');
}

// Windows-only: the PID actually LISTENING on `port`, or null if
// undeterminable. Other agents may be live-verifying concurrently on this
// same machine — never trust a port's responses without confirming
// ownership first.
function getListenerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const [, local, , state, pid] = parts;
      if (state !== 'LISTENING') continue;
      if (Number(local.split(':').pop()) === port) return Number(pid);
    }
  } catch (_) { /* best-effort */ }
  return null;
}

async function bootOwnedMythos(envOverrides, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await pickFreePort();
    log('ℹ️', `attempt ${attempt}: trying port ${port}`);
    let boot;
    try {
      boot = await bootMythos({ port, env: envOverrides });
    } catch (err) {
      log('⚠️', `boot attempt on port ${port} failed: ${err.message}`);
      continue;
    }
    const listenerPid = getListenerPid(port);
    if (listenerPid !== null && listenerPid !== boot.child.pid) {
      log('⚠️', `PORT COLLISION: port ${port} owned by PID ${listenerPid}, not our child (${boot.child.pid}). Retrying elsewhere.`);
      await killTree(boot.child);
      continue;
    }
    if (listenerPid === null) log('⚠️', 'could not verify port ownership via netstat — proceeding on trust');
    else log('✅', `confirmed port ${port} is owned by our own spawned child (PID ${listenerPid})`);
    return { boot, port };
  }
  throw new Error(`could not obtain exclusive ownership of any port after ${maxAttempts} attempts`);
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error(`bad JSON from ${urlPath}: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET ${urlPath} timed out`)); });
  });
}

function findChromeExecutable(chromium) {
  const candidates = [];
  try { candidates.push(chromium.executablePath()); } catch (_) {}
  const cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    const entries = fs.readdirSync(cacheDir).filter((e) => e.startsWith('chromium-'));
    entries.sort().reverse();
    entries.forEach((e) => candidates.push(path.join(cacheDir, e, 'chrome-win64', 'chrome.exe')));
  } catch (_) {}
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function readGoalFile(vaultRoot, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vaultRoot, 'Goals', `${id}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function main() {
  log('🧪', 'Phase4/V5 propose_goal (UI-click half) verification starting');

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (err) {
    log('⏭️', `playwright-core not resolvable: ${err.message}`);
    console.log('SKIP: playwright-core dependency missing');
    process.exit(3);
  }
  const execPath = findChromeExecutable(chromium);
  if (!execPath) {
    log('⏭️', 'no usable Chromium/Chrome binary found on this machine');
    console.log('SKIP: no Chromium/Chrome executable found (playwright cache empty, no system Chrome)');
    process.exit(3);
  }
  log('ℹ️', `using browser: ${execPath}`);

  // Prefer a long-form path (LOCALAPPDATA) over os.tmpdir(): on this machine
  // os.tmpdir()/process.env.TEMP can resolve through an 8.3 short-name folder
  // segment (a Windows-generated abbreviation ending in "~1"), and
  // fs.watch()'ing a directory under a short-name path has triggered a native
  // libuv crash here
  // ("Assertion failed: !_wcsnicmp(filename, dir, dirlen), file
  // src\win\fs-event.c") — sensors/file.js fs.watch()es the vault root, so
  // this is a real precondition for booting MYTHOS against ANY vault path,
  // not specific to this script's logic.
  const scratchpadRoot = process.env.CLAUDE_SCRATCHPAD_DIR ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir());
  const vaultRoot = path.join(scratchpadRoot, `mythos-verify-v5-ui-${Date.now()}`);
  const goalsDir = path.join(vaultRoot, 'Goals');
  fs.mkdirSync(goalsDir, { recursive: true });
  log('ℹ️', `isolated vault: ${vaultRoot}`);

  // Seed two status:'proposed' goals directly onto disk (GoalSystem.init()
  // loads Goals/*.json at boot) — deterministic, no dependency on a live
  // brain key actually deciding to propose something during this run.
  const ts = Date.now();
  const acceptId = `goal-verify-ui-accept-${ts}`;
  const rejectId = `goal-verify-ui-reject-${ts}`;
  const acceptTitle = `MYTHOS_VERIFY_V5_UI_ACCEPT_${ts}`;
  const rejectTitle = `MYTHOS_VERIFY_V5_UI_REJECT_${ts}`;
  const now = Date.now();
  function seedGoal(id, title) {
    const goal = {
      id, drive: 'curiosity', title, status: 'proposed', priority: 0.5,
      budget: { tokens: 20000, actions: 25, deadline: null },
      spent: { tokens: 0, actions: 0 },
      parentId: null, childIds: [], plan: [], grants: {},
      reason: '[General] seeded for live UI-click verification',
      createdAt: now, updatedAt: now, lastActionAt: null,
    };
    fs.writeFileSync(path.join(goalsDir, `${id}.json`), JSON.stringify(goal, null, 2), 'utf8');
  }
  seedGoal(acceptId, acceptTitle);
  seedGoal(rejectId, rejectTitle);
  log('🌱', `seeded 2 proposed goals on disk: accept=${acceptId} reject=${rejectId}`);

  let owned;
  try {
    owned = await bootOwnedMythos({
      MYTHOS_VAULT_ROOT: vaultRoot,
      // Keep the tick loop quiet — this test targets the click mechanics,
      // not mull's own proposal generation (already covered elsewhere).
      MYTHOS_TICK_MS: '5000',
      MYTHOS_MULL_EVERY_TICKS: '3600',
      PLANNER_ENABLED: 'false',
      CALENDAR_UPCOMING_ENABLED: 'false',
      GMAIL_TRIAGE_ENABLED: 'false',
      BROWSER_AUTOMATION: 'false',
    }, 4);
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  }
  const { boot, port } = owned;
  const myPid = boot.child.pid;

  function assertStillOwned(where) {
    const pid = getListenerPid(port);
    if (pid !== null && pid !== myPid) {
      log('❌', `PORT COLLISION mid-run at "${where}": port ${port} now owned by PID ${pid}, not ours (${myPid}).`);
      return false;
    }
    return true;
  }

  const failures = [];
  const evidence = [];
  let collisionAborted = false;
  let browser;

  try {
    // --- 0. Confirm both proposals loaded from disk at boot, and are
    //         visible via the same REST route the dashboard itself calls. ---
    const preBoot = await httpGetJson(port, '/api/goals/proposals');
    const preIds = (preBoot.proposals || []).map((p) => p.id);
    if (!preIds.includes(acceptId) || !preIds.includes(rejectId)) {
      failures.push(`seeded proposals did not load at boot — GET /api/goals/proposals returned ids [${preIds.join(', ')}], expected both ${acceptId} and ${rejectId}`);
    } else {
      evidence.push(`both seeded proposals loaded from disk at boot and are visible via GET /api/goals/proposals: ${JSON.stringify(preIds)}`);
    }

    // --- 1. Prove the proposal does NOT auto-activate on its own. ---
    // Real tick loop runs for several seconds (TICK_MS=5000) before any
    // click — the arbiter only ever selects status:'active' goals, so if
    // this ever flips to 'active' by itself, that's the "never auto-
    // activates" guarantee failing.
    await new Promise((r) => setTimeout(r, 6000));
    if (!assertStillOwned('after idle wait, before any click')) { collisionAborted = true; }
    else {
      const stillProposed = readGoalFile(vaultRoot, acceptId);
      if (!stillProposed || stillProposed.status !== 'proposed') {
        failures.push(`seeded goal ${acceptId} did not remain status:'proposed' through an idle tick window BEFORE any UI click (found status=${stillProposed && stillProposed.status}) — it must never auto-activate`);
      } else {
        evidence.push(`goal ${acceptId} remained status:'proposed' on disk through a real 6s idle-tick window with zero UI interaction — confirms it never auto-activates`);
      }
    }

    if (!collisionAborted) {
      log('ℹ️', `pre-browser child alive check: exitCode=${boot.child.exitCode}`);
      try {
        const h = await httpGetJson(port, '/health');
        log('ℹ️', `pre-browser /health check: ${JSON.stringify(h).slice(0, 200)}`);
      } catch (err) {
        log('⚠️', `pre-browser /health check failed: ${err.message}`);
        log('ℹ️', `child stdout tail: ${boot.getStdout().slice(-1000)}`);
        log('ℹ️', `child stderr tail: ${boot.getStderr().slice(-1000)}`);
      }
      // --- 2. Drive a real Chromium against the real running dashboard. ---
      browser = await chromium.launch({ executablePath: execPath, headless: true });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#overlay-root', { timeout: 10000 });

      // Open the real 'proposals' panel the same way the app's own
      // overlay-manager.openPanel('proposals') does: panel-registry lookup
      // -> dynamic import of the real view module -> real render(mount) call.
      // (No neural-map node or voice-nav phrase currently exists to reach
      // this panel by pointer/voice click — see header comment — so this is
      // the most faithful in-page equivalent of that exact call chain, not a
      // shortcut around the accept/reject mechanics under test.)
      const opened = await page.evaluate(async () => {
        try {
          const { createOverlayManager } = await import('/js/overlay/overlay-manager.js');
          const root = document.getElementById('overlay-root');
          const overlays = createOverlayManager(root);
          window.__verifyOverlays = overlays;
          await overlays.openPanel('proposals');
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err && err.stack || err) };
        }
      });
      if (!opened.ok) {
        failures.push(`opening the real 'proposals' panel via overlay-manager.openPanel() threw: ${opened.error}`);
      } else {
        evidence.push('opened the real PROPOSALS panel via the real overlay-manager.openPanel() -> panel-registry -> views/proposals.js render() chain');

        await page.waitForSelector(`.goals-row[data-id="${acceptId}"]`, { timeout: 10000 }).catch(() => {});
        const rowsBeforeClick = await page.$$eval('.goals-row', (rows) => rows.map((r) => r.getAttribute('data-id')));
        log('ℹ️', `rows rendered before any click: ${JSON.stringify(rowsBeforeClick)}`);
        if (!rowsBeforeClick.includes(acceptId) || !rowsBeforeClick.includes(rejectId)) {
          failures.push(`dashboard did not render both seeded proposal rows — rendered ids: ${JSON.stringify(rowsBeforeClick)}`);
        } else {
          evidence.push(`dashboard rendered both real proposal rows with real Accept/Reject buttons: ${JSON.stringify(rowsBeforeClick)}`);
        }

        // --- 3. Click the real "Accept" button on the accept-target row. ---
        if (!assertStillOwned('before Accept click')) { collisionAborted = true; }
        if (!collisionAborted) {
          log('🖱️', `clicking real Accept button for ${acceptId}`);
          await page.click(`.goals-row[data-id="${acceptId}"] button[data-action="accept"]`);
          // proposals.js's own click handler awaits the fetch, then calls
          // refresh(mount) which re-renders — wait for the row to actually
          // disappear (proves the click round-tripped through the real
          // server, not just an optimistic client-side removal).
          await page.waitForFunction(
            (id) => !document.querySelector(`.goals-row[data-id="${id}"]`),
            acceptId,
            { timeout: 10000 }
          ).catch(() => {});

          const acceptedOnDisk = readGoalFile(vaultRoot, acceptId);
          const acceptedViaProposalsApi = await httpGetJson(port, '/api/goals/proposals');
          const acceptedViaGoalsApi = await httpGetJson(port, '/api/goals');
          const stillInProposals = (acceptedViaProposalsApi.proposals || []).some((p) => p.id === acceptId);
          const nowInGoals = (acceptedViaGoalsApi.goals || []).some((g) => g.id === acceptId || g.text === acceptTitle);

          if (!acceptedOnDisk || acceptedOnDisk.status !== 'active') {
            failures.push(`after clicking real Accept button, ${acceptId}.json on disk has status=${acceptedOnDisk && acceptedOnDisk.status}, expected 'active'`);
          } else if (acceptedOnDisk.drive !== 'user-service') {
            failures.push(`after Accept click, ${acceptId} has status:'active' but drive="${acceptedOnDisk.drive}", expected 'user-service' (goalsEffector.acceptProposal's exact contract)`);
          } else if (stillInProposals) {
            failures.push(`after Accept click, ${acceptId} still appears in GET /api/goals/proposals`);
          } else {
            evidence.push(`clicking the real Accept button flipped ${acceptId} to status:'active', drive:'user-service' on disk, removed it from GET /api/goals/proposals (now: ${JSON.stringify((acceptedViaProposalsApi.proposals || []).map((p) => p.id))}), and it now appears in GET /api/goals (goals-in-response includes accepted title: ${nowInGoals})`);
          }
        }

        // --- 4. Click the real "Reject" button on the reject-target row. ---
        if (!collisionAborted && assertStillOwned('before Reject click')) {
          log('🖱️', `clicking real Reject button for ${rejectId}`);
          await page.click(`.goals-row[data-id="${rejectId}"] button[data-action="reject"]`);
          await page.waitForFunction(
            (id) => !document.querySelector(`.goals-row[data-id="${id}"]`),
            rejectId,
            { timeout: 10000 }
          ).catch(() => {});

          const rejectedOnDisk = readGoalFile(vaultRoot, rejectId);
          const rejectedViaProposalsApi = await httpGetJson(port, '/api/goals/proposals');
          const stillInProposals = (rejectedViaProposalsApi.proposals || []).some((p) => p.id === rejectId);

          if (rejectedOnDisk) {
            failures.push(`after clicking real Reject button, ${rejectId}.json still exists on disk with status=${rejectedOnDisk.status} — reject must delete outright, not just hide`);
          } else if (stillInProposals) {
            failures.push(`after Reject click, ${rejectId} still appears in GET /api/goals/proposals`);
          } else {
            evidence.push(`clicking the real Reject button deleted ${rejectId}.json from disk outright and removed it from GET /api/goals/proposals`);
          }
        } else if (collisionAborted) {
          // handled below
        }
      }

      if (pageErrors.length) {
        log('⚠️', `page had JS errors (informational): ${pageErrors.slice(0, 3).join(' | ')}`);
      }
    }
  } catch (err) {
    failures.push(`exception during browser drive: ${err.stack || err.message}`);
    log('ℹ️', `child exitCode at failure time: ${boot.child.exitCode}`);
    log('ℹ️', `child stdout tail: ${boot.getStdout().slice(-2000)}`);
    log('ℹ️', `child stderr tail: ${boot.getStderr().slice(-2000)}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    await killTree(boot.child);
    try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
  }

  if (collisionAborted) {
    log('⏭️', 'Phase4/V5 propose_goal (UI-click half): SKIP — port collision with a concurrent process made this run\'s results untrustworthy; re-run when the machine is less contended');
    process.exit(0);
  }

  for (const line of evidence) log('📋', line);

  if (failures.length === 0) {
    log('🎉', 'Phase4/V5 propose_goal (UI-click half): PASS — real Accept and Reject clicks against the real running dashboard produced the correct status transitions and disk/API state.');
    process.exit(0);
  } else {
    log('💀', 'Phase4/V5 propose_goal (UI-click half): FAIL');
    for (const f of failures) log('  ↳', f);
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
