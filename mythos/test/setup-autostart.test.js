'use strict';

// test/setup-autostart.test.js — unit tests for scripts/setup-autostart.js's
// pure argv-building logic. Does NOT touch the real Task Scheduler (that's
// covered by live verification, run by hand — see Task 7 in the roadmap).

const { test } = require('node:test');
const assert = require('node:assert');
const { buildSchtasksArgs } = require('../scripts/setup-autostart.js');

test('buildSchtasksArgs produces correct schtasks /create arguments', () => {
  const testBatPath = 'C:\\Users\\TestUser\\repo\\Start Agent OS.bat';
  const taskName = 'TestTask';

  const args = buildSchtasksArgs(testBatPath, taskName);

  assert.deepStrictEqual(args, [
    '/create',
    '/tn',
    'TestTask',
    '/tr',
    '"C:\\Users\\TestUser\\repo\\Start Agent OS.bat"',
    '/sc',
    'onlogon',
    '/rl',
    'limited',
    '/f',
  ]);
});

test('buildSchtasksArgs quotes the path to handle spaces', () => {
  const testBatPath = 'D:\\Agen OS\\Agent_OS-main\\Start Agent OS.bat';
  const taskName = 'MythosAgentOS';

  const args = buildSchtasksArgs(testBatPath, taskName);
  const trIndex = args.indexOf('/tr');
  const commandPart = args[trIndex + 1];

  assert.strictEqual(commandPart.startsWith('"'), true);
  assert.strictEqual(commandPart.endsWith('"'), true);
  assert.strictEqual(commandPart, `"${testBatPath}"`);
});

test('buildSchtasksArgs never produces hardcoded absolute paths', () => {
  const testBatPath = '/arbitrary/path/to/Start Agent OS.bat';
  const taskName = 'SomeTask';

  const args = buildSchtasksArgs(testBatPath, taskName);
  const argsStr = args.join(' ');

  assert.strictEqual(argsStr.includes(testBatPath), true);
  assert.strictEqual(argsStr.includes('D:\\Agen OS'), false);
  assert.strictEqual(argsStr.includes('C:\\Users\\'), false);
});

test('buildSchtasksArgs works with different repo locations', () => {
  const paths = [
    'E:\\code\\mythos\\Start Agent OS.bat',
    '/home/user/mythos/Start Agent OS.bat',
    'C:\\Program Files (x86)\\MyApp\\Start Agent OS.bat',
  ];

  for (const batPath of paths) {
    const args = buildSchtasksArgs(batPath, 'TestTask');
    const trIndex = args.indexOf('/tr');
    const commandPart = args[trIndex + 1];
    assert.strictEqual(commandPart, `"${batPath}"`);
  }
});

test('buildSchtasksArgs preserves task name', () => {
  const testBatPath = 'C:\\test\\Start Agent OS.bat';
  const taskNames = ['MythosAgentOS', 'MyCustomTask', 'Mythos Agent'];

  for (const taskName of taskNames) {
    const args = buildSchtasksArgs(testBatPath, taskName);
    assert.strictEqual(args.includes(taskName), true);
  }
});
