'use strict';

// test-fixtures/file-sensor-child.js — run in an isolated child process by
// sensors-file.test.js. Exercises the real createFileSensor + real fs.watch against a
// non-ignored write and prints the resulting perception.file event count as JSON.
//
// Isolated on purpose: on this Windows/Node build, a file written directly at the root
// of a directory opened with fs.watch(dir, {recursive:false}) crashes the process with a
// native `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\\win\\fs-event.c`
// — reproducible with zero mythos code (plain fs.watch + fs.writeFileSync), so it is an
// environment/libuv bug, not a defect in sensors/file.js. Running it here means a crash
// only fails this one isolated case instead of aborting the entire test run.

const path = require('path');
const fsNode = require('fs');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createFileSensor } = require('../src/core/sensors/file');

const dir = process.argv[2];

function fakeBus() {
  const events = [];
  return {
    emit: function(type, payload) { events.push({ type, payload }); },
    _events: () => events
  };
}

async function main() {
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const sensor = createFileSensor({ bus, config: { MYTHOS_FILE_DEBOUNCE_MS: 50 }, vault: fs });
  sensor.start();

  fsNode.writeFileSync(path.join(dir, 'Goals.md'), 'hello');
  await new Promise((resolve) => setTimeout(resolve, 250));

  const fileEvents = bus._events().filter((e) => e.type === 'perception.file');
  sensor.stop();
  process.stdout.write(JSON.stringify({ count: fileEvents.length, sample: fileEvents[0] || null }));
}

main();
