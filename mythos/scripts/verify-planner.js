#!/usr/bin/env node
'use strict';

// verify-planner.js — live verification harness for BUG-041.
//
// BUG-041: the daily planner (morning brief + check-ins + evening review).
// Code is in src/core/planner/daily.js, exhaustively unit-tested in
// test/planner-daily.test.js (13 cases including the idempotent-restart
// scenario). This script verifies the planner fires correctly in a REAL
// boot and survives a restart without double-firing.
//
// What it checks:
//   1. With PLANNER_ENABLED=true + PLANNER_MORNING_HOUR=<current hour>, the
//      planner fires plan.morning-brief on its first tick.
//   2. A vault/Plans/YYYY-MM-DD.json file is written with morningFiredAt set.
//   3. After killing + restarting MYTHOS, the planner does NOT re-fire
//      (the day file's morningFiredAt is the idempotence guard).
//
// Usage:
//   node scripts/verify-planner.js

const fs = require('fs');
const path = require('path');
const { log, bootMythos, killTree, captureEvents, vaultPath, DEFAULT_PORT } = require('./verify-lib');

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
}

function readPlanFile() {
  const p = path.join(vaultPath(), 'Plans', `${todayDateStr()}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

async function main() {
  log('🧪', 'BUG-041 daily-planner verification starting');

  // Force the morning hour to the current hour so the brief fires immediately
  const currentHour = new Date().getHours();
  const plansDir = path.join(vaultPath(), 'Plans');
  // Clean any stale plan file for today so we start fresh
  try { fs.unlinkSync(path.join(plansDir, `${todayDateStr()}.json`)); } catch (_) {}

  // Boot #1
  let boot1;
  try {
    boot1 = await bootMythos({
      env: {
        PLANNER_ENABLED: 'true',
        PLANNER_MORNING_HOUR: String(currentHour),
      }
    });
  } catch (err) {
    log('❌', `boot #1 failed: ${err.message}`);
    process.exit(1);
  }

  let pass = true;
  try {
    log('⏳', 'waiting for plan.morning-brief (capture 30s of bus events)...');
    const events = await captureEvents(DEFAULT_PORT, ['plan.morning-brief', 'plan.checkin', 'plan.evening-review'], 30000);
    if (events.length > 0) {
      log('✅', `planner fired ${events.length} event(s): ${events.map(e => e.type).join(', ')}`);
    } else {
      log('❌', 'planner did NOT fire any events within 30s');
      pass = false;
    }

    // Check the day file was written
    const plan = readPlanFile();
    if (plan && plan.morningFiredAt) {
      log('✅', `vault/Plans/${todayDateStr()}.json written, morningFiredAt=${plan.morningFiredAt}`);
    } else {
      log('❌', `vault/Plans/${todayDateStr()}.json missing or morningFiredAt unset`);
      pass = false;
    }
  } finally {
    await killTree(boot1.child);
  }

  if (!pass) {
    log('💀', 'BUG-041 planner: FAIL (boot #1 checks failed, skipping restart idempotence check)');
    process.exit(1);
  }

  // Boot #2 — restart idempotence check
  log('🔄', 'restarting MYTHOS to verify idempotence...');
  await new Promise(r => setTimeout(r, 1500));
  let boot2;
  try {
    boot2 = await bootMythos({
      env: {
        PLANNER_ENABLED: 'true',
        PLANNER_MORNING_HOUR: String(currentHour),
      }
    });
  } catch (err) {
    log('❌', `boot #2 failed: ${err.message}`);
    process.exit(1);
  }

  try {
    log('⏳', 'waiting 20s to confirm NO morning-brief re-fires...');
    const events2 = await captureEvents(DEFAULT_PORT, ['plan.morning-brief'], 20000);
    if (events2.length === 0) {
      log('✅', 'NO morning-brief re-fire on restart (idempotence holds)');
    } else {
      log('❌', `morning-brief re-fired ${events2.length} time(s) on restart — idempotence BROKEN`);
      pass = false;
    }
  } finally {
    await killTree(boot2.child);
  }

  if (pass) {
    log('🎉', 'BUG-041 daily-planner: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-041 daily-planner: FAIL');
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
