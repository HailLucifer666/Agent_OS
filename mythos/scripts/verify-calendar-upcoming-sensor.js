#!/usr/bin/env node
'use strict';

// verify-calendar-upcoming-sensor.js — live verification harness for
// Phase4/V8a (calendar-upcoming-sensor).
//
// BUGS.md files this under BUG-024's Google-Calendar-OAuth umbrella and
// marks it "blocked" pending real Google credentials. Reading the actual
// code disproves that: src/core/sensors/calendar-upcoming-sensor.js reads
// ONLY calendarWiring.calendar.listReminders() — the vault-backed LOCAL
// reminder store from src/core/effectors/from-calendar.js ("Vault-backed
// local reminder store (zero external deps). Optional Google Calendar
// layer rides on top when env keys are present."). main.js:667 confirms:
// "ON by default (no privacy surface — reads only local reminders.json)."
// Google OAuth is required for BUG-024's Gmail/Calendar READ-FROM-GOOGLE
// piece, not for this sensor's perceive-local-reminders piece. So this is
// fully scriptable without any Google credentials.
//
// What this proves, live, end to end:
//   1. Seed a local reminder (Calendar/reminders.json) due in ~45s.
//   2. Boot MYTHOS with a fast poll/lead window pointed at a throwaway vault.
//   3. The sensor's poll cycle detects it within the lead window and emits
//      'perception.calendar' (observed via the structured JSON log line
//      'sensors.calendar.upcoming' with emitted:1).
//   4. The cortex OODA tick loop (running independently, no brain call
//      needed for this) drains that perception, ranks it above the 0.5
//      episodic-write threshold (default salience 0.6), and writes a
//      {kind:'perception', channel:'calendar', ...} record to
//      Episodic/<today>.jsonl — the concrete "cortex reacts" proof.
//
// Usage:
//   node scripts/verify-calendar-upcoming-sensor.js

const fs = require('fs');
const net = require('net');
const path = require('path');
const { log, killTree, MYTHOS_DIR } = require('./verify-lib');
const { spawn } = require('child_process');
const http = require('http');

const MAIN_PATH = path.join(MYTHOS_DIR, 'src', 'main.js');
const REMINDER_ID = 'verify-cal-' + Date.now();
const REMINDER_TEXT = 'MYTHOS_VERIFY_CALENDAR_UPCOMING_' + Date.now();

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickFreePort(min, max) {
  for (let i = 0; i < 30; i++) {
    const p = min + Math.floor(Math.random() * (max - min));
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port found in [${min}, ${max}) after 30 tries`);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Boot MYTHOS pointed at a specific vault + port, without verify-lib's
// hardcoded DEFAULT_PORT/health-poll opinion getting in the way of the
// extra env keys this test needs (MYTHOS_VAULT_ROOT, CALENDAR_UPCOMING_*).
function bootAt(port, vaultDir, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {}, {
    MYTHOS_PORT: String(port),
    MYTHOS_BIND: '127.0.0.1',
    MYTHOS_VAULT_ROOT: vaultDir,
    BOOT_GREETING: 'false',
    BROWSER_AUTOMATION: 'false',
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_PATH], {
      cwd: MYTHOS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let booted = false;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { if (!booted) reject(new Error(`spawn error: ${err.message}`)); });
    child.on('close', (code) => {
      if (!booted) reject(new Error(`MYTHOS exited before /health responded (code=${code}). stderr:\n${stderr.slice(-2000)}`));
    });
    const deadline = Date.now() + 30000;
    const pollHealth = () => {
      if (Date.now() > deadline) { reject(new Error(`boot timed out. stdout tail:\n${stdout.slice(-2000)}`)); return; }
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) { booted = true; resolve({ child, getStdout: () => stdout }); }
          else setTimeout(pollHealth, 500);
        });
      });
      req.on('error', () => setTimeout(pollHealth, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(pollHealth, 500); });
    };
    setTimeout(pollHealth, 800);
  });
}

async function main() {
  log('🧪', 'Phase4/V8a calendar-upcoming-sensor verification starting');

  const port = await pickFreePort(4500, 4900);
  const vaultDir = path.join(MYTHOS_DIR, 'vault_test_calendar_upcoming_' + Date.now());
  const calDir = path.join(vaultDir, 'Calendar');
  fs.mkdirSync(calDir, { recursive: true });

  // Seed one local reminder due 45s from now — inside a 60s lead window,
  // with plenty of margin over the 10s poll interval for boot-time jitter.
  const dueAt = Date.now() + 45000;
  fs.writeFileSync(
    path.join(calDir, 'reminders.json'),
    JSON.stringify([{ id: REMINDER_ID, text: REMINDER_TEXT, dueAt, createdAt: Date.now(), fired: false }], null, 2),
    'utf8'
  );
  log('📝', `seeded local reminder "${REMINDER_TEXT}" due in 45s at ${vaultDir}`);

  let boot;
  try {
    boot = await bootAt(port, vaultDir, {
      CALENDAR_UPCOMING_ENABLED: 'true',
      CALENDAR_UPCOMING_POLL_MS: '10000',   // schema min — fastest allowed poll
      CALENDAR_UPCOMING_LEAD_MS: '60000',   // schema min — fastest allowed lead window
    });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }
  log('✅', `MYTHOS booted on port ${port}, vault=${vaultDir}`);

  let pass = true;
  let reason = '';
  try {
    // Confirm the sensor actually started (boot-time log line).
    await new Promise((r) => setTimeout(r, 1500));
    const startedLog = boot.getStdout().split('\n').find((l) => l.indexOf('"sensors.calendar-upcoming.started"') !== -1);
    if (startedLog) {
      log('✅', `sensor started: ${startedLog.trim()}`);
    } else {
      log('❌', 'sensor did NOT log a start event — CALENDAR_UPCOMING_ENABLED wiring may be broken');
      pass = false;
      reason = 'sensor never started';
    }

    // Wait through poll cycles for the perception-emit log line
    // ('sensors.calendar.upcoming' with emitted:1), up to ~50s (5 polls).
    log('⏳', 'waiting up to 50s for the sensor to poll and perceive the seeded reminder...');
    let emittedLog = null;
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline && !emittedLog) {
      await new Promise((r) => setTimeout(r, 2000));
      emittedLog = boot.getStdout().split('\n').find((l) => l.indexOf('"sensors.calendar.upcoming"') !== -1);
    }

    if (emittedLog) {
      log('✅', `sensor emitted perception.calendar: ${emittedLog.trim()}`);
    } else {
      log('❌', 'sensor never logged an emission — perception.calendar was not raised within the poll window');
      pass = false;
      reason = reason || 'no perception.calendar emission observed';
    }

    if (pass) {
      // Give the cortex tick loop (1s cadence) a moment to drain + rank +
      // write the episodic record, then read the vault file directly.
      await new Promise((r) => setTimeout(r, 3000));
      const epFile = path.join(vaultDir, 'Episodic', todayKey() + '.jsonl');
      let lines = [];
      try {
        lines = fs.readFileSync(epFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
      } catch (err) {
        log('❌', `could not read episodic file ${epFile}: ${err.message}`);
        pass = false;
        reason = 'episodic file missing';
      }
      // cortex/index.js's orient loop writes `detail: ranked[i].perception` —
      // the WHOLE bus payload the sensor emitted (which itself nests the
      // reminder under `.detail`), so the reminder id lives two levels down:
      // record.detail.detail.id, not record.detail.id.
      const match = lines.find((e) => e && e.kind === 'perception' && e.channel === 'calendar' &&
        e.detail && e.detail.detail && e.detail.detail.id === REMINDER_ID);
      if (match) {
        log('✅', `cortex reacted: episodic record written — ${JSON.stringify({ kind: match.kind, channel: match.channel, summary: match.summary, salience: match.salience })}`);
      } else {
        log('❌', `no matching episodic 'perception'/'calendar' record for reminder id ${REMINDER_ID} found in ${epFile}`);
        pass = false;
        reason = reason || 'perception emitted but cortex never wrote it to episodic memory';
      }
    }
  } finally {
    await killTree(boot.child);
    // Best-effort cleanup of the throwaway vault (temp scratch, not evidence).
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (pass) {
    log('🎉', 'Phase4/V8a calendar-upcoming-sensor: PASS');
    process.exit(0);
  } else {
    log('💀', `Phase4/V8a calendar-upcoming-sensor: FAIL (${reason})`);
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
