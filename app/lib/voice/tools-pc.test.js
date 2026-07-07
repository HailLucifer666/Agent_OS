// tools-pc.test.js — unit tests for PC control voice tools.
// Tests validation logic and the tool catalog shape. Does NOT require a real
// PS child process (pc-child is mocked).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock pc-child before requiring tools-pc
const mockPcChild = {
  getStatus: () => ({ state: 'OFFLINE', hint: 'PC automation is OFFLINE.', queueDepth: 0 }),
  sendCommand: async () => ({ ok: false, error: 'mocked' }),
};
require.cache[require.resolve('./pc-child')] = {
  id: require.resolve('./pc-child'),
  filename: require.resolve('./pc-child'),
  loaded: true,
  exports: mockPcChild,
};

const { TOOLS, launch_app, list_windows, focus_window, close_window, media_key, screen_look, ui_elements, ui_click, ui_type, write_note } = require('./tools-pc');

describe('tools-pc', () => {
  describe('catalog shape', () => {
    it('exports 10 tools', () => {
      assert.equal(TOOLS.length, 10);
    });

    it('each tool has name, description, params, danger, fn', () => {
      for (const t of TOOLS) {
        assert.equal(typeof t.name, 'string');
        assert.equal(typeof t.description, 'string');
        assert.equal(typeof t.params, 'object');
        assert.equal(typeof t.danger, 'boolean');
        assert.equal(typeof t.fn, 'function');
      }
    });

    it('has no duplicate tool names', () => {
      const names = TOOLS.map((t) => t.name);
      assert.equal(names.length, new Set(names).size);
    });

    it('danger tools are close_window and ui_click only', () => {
      const dangerTools = TOOLS.filter((t) => t.danger);
      assert.deepEqual(dangerTools.map((t) => t.name).sort(), ['close_window', 'ui_click']);
    });

    it('needs_result tools are list_windows, screen_look, ui_elements', () => {
      const needsResult = TOOLS.filter((t) => t.needs_result);
      assert.deepEqual(needsResult.map((t) => t.name).sort(), ['list_windows', 'screen_look', 'ui_elements']);
    });
  });

  describe('guard: offline child', () => {
    it('launch_app returns offline error when child is OFFLINE', async () => {
      const result = await launch_app({ name: 'notepad' });
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('OFFLINE'));
    });

    it('list_windows returns offline error when child is OFFLINE', async () => {
      const result = await list_windows();
      assert.equal(result.ok, false);
    });

    it('focus_window returns offline error when child is OFFLINE', async () => {
      const result = await focus_window({ pid: 1234 });
      assert.equal(result.ok, false);
    });

    it('close_window returns offline error when child is OFFLINE', async () => {
      const result = await close_window({ pid: 1234 });
      assert.equal(result.ok, false);
    });

    it('media_key returns offline error when child is OFFLINE', async () => {
      const result = await media_key({ key: 'play_pause' });
      assert.equal(result.ok, false);
    });

    it('screen_look returns offline error when child is OFFLINE', async () => {
      const result = await screen_look();
      assert.equal(result.ok, false);
    });

    it('ui_elements returns offline error when child is OFFLINE', async () => {
      const result = await ui_elements({ pid: 1234 });
      assert.equal(result.ok, false);
    });

    it('ui_click returns offline error when child is OFFLINE', async () => {
      const result = await ui_click({ pid: 1234, elementPath: ['0'] });
      assert.equal(result.ok, false);
    });

    it('ui_type returns offline error when child is OFFLINE', async () => {
      const result = await ui_type({ text: 'hello' });
      assert.equal(result.ok, false);
    });

    it('write_note returns offline error when child is OFFLINE', async () => {
      const result = await write_note({ text: 'test note' });
      assert.equal(result.ok, false);
    });
  });

  describe('input validation (even when offline)', () => {
    it('launch_app requires name', async () => {
      const result = await launch_app({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('required'));
    });

    it('focus_window requires pid', async () => {
      const result = await focus_window({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('PID'));
    });

    it('close_window requires pid', async () => {
      const result = await close_window({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('PID'));
    });

    it('media_key rejects invalid key names', async () => {
      const result = await media_key({ key: 'bananaphone' });
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('Invalid media key'));
    });

    it('media_key accepts all valid key names', async () => {
      // These will fail with OFFLINE error, not validation error
      const validKeys = ['play_pause', 'next_track', 'prev_track', 'volume_up', 'volume_down', 'volume_mute'];
      for (const key of validKeys) {
        const result = await media_key({ key });
        // Should NOT get "invalid media key" — should get OFFLINE
        assert.ok(!result.result.includes('Invalid'), `key ${key} should be valid`);
      }
    });

    it('ui_elements requires pid', async () => {
      const result = await ui_elements({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('PID'));
    });

    it('ui_click requires pid and elementPath', async () => {
      const result1 = await ui_click({});
      assert.equal(result1.ok, false);
      assert.ok(result1.result.includes('PID'));

      const result2 = await ui_click({ pid: 1234 });
      assert.equal(result2.ok, false);
      assert.ok(result2.result.includes('elementPath'));
    });

    it('ui_click rejects non-array elementPath', async () => {
      const result = await ui_click({ pid: 1234, elementPath: '0' });
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('array'));
    });

    it('ui_type requires text', async () => {
      const result = await ui_type({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('Text'));
    });

    it('write_note requires text', async () => {
      const result = await write_note({});
      assert.equal(result.ok, false);
      assert.ok(result.result.includes('Note text'));
    });
  });

  describe('online delegation', () => {
    beforeEach(() => {
      // Switch mock to ONLINE
      mockPcChild.getStatus = () => ({ state: 'ONLINE', hint: null, queueDepth: 0 });
      mockPcChild.sendCommand = async (cmdObj) => ({ ok: true, result: cmdObj });
    });

    it('launch_app delegates correct command', async () => {
      const result = await launch_app({ name: 'notepad' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'launch_app', name: 'notepad' });
    });

    it('list_windows delegates correctly', async () => {
      const result = await list_windows();
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'list_windows' });
    });

    it('focus_window delegates with pid', async () => {
      const result = await focus_window({ pid: 12345 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'focus_window', pid: 12345 });
    });

    it('close_window delegates with pid', async () => {
      const result = await close_window({ pid: 42 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'close_window', pid: 42 });
    });

    it('media_key delegates with key', async () => {
      const result = await media_key({ key: 'play_pause' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'media_key', key: 'play_pause' });
    });

    it('ui_elements delegates with pid and depth', async () => {
      const result = await ui_elements({ pid: 99, depth: 3 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'ui_elements', pid: 99, depth: 3 });
    });

    it('ui_elements defaults depth to 2', async () => {
      const result = await ui_elements({ pid: 99 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'ui_elements', pid: 99, depth: 2 });
    });

    it('ui_click delegates with pid and elementPath', async () => {
      const result = await ui_click({ pid: 55, elementPath: ['0', '2', '1'] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'ui_click', pid: 55, elementPath: ['0', '2', '1'] });
    });

    it('ui_type delegates text only', async () => {
      const result = await ui_type({ text: 'hello world' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'ui_type', text: 'hello world' });
    });

    it('ui_type delegates with pid and elementPath when provided', async () => {
      const result = await ui_type({ text: 'test', pid: 123, elementPath: ['0'] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'ui_type', text: 'test', pid: 123, elementPath: ['0'] });
    });

    it('write_note delegates with text and title', async () => {
      const result = await write_note({ text: 'remember this', title: 'My Note' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'write_note', text: 'remember this', title: 'My Note' });
    });

    it('write_note defaults title to null', async () => {
      const result = await write_note({ text: 'quick note' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.result, { cmd: 'write_note', text: 'quick note', title: null });
    });

    it('handles PS error response', async () => {
      mockPcChild.sendCommand = async () => ({ ok: false, error: 'Process not found.' });
      const result = await close_window({ pid: 99999 });
      assert.equal(result.ok, false);
      assert.equal(result.result, 'Process not found.');
    });

    it('handles sendCommand exception', async () => {
      mockPcChild.sendCommand = async () => { throw new Error('child process crashed'); };
      const result = await list_windows();
      assert.equal(result.ok, false);
      assert.equal(result.result, 'child process crashed');
    });
  });
});
