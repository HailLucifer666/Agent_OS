'use strict';

// sensors/file.js — File Sensor: fs.watch over the vault root + any extra directories
// listed in MYTHOS_WATCH_DIRS (semicolon-separated), debounced, ignoring self-write
// dirs (Checkpoints, Audit) so the entity never perceives its own bookkeeping writes
// as an external event — an unfiltered watch here would let cortex talk to itself.

var fs = require('fs');
var path = require('path');

var IGNORED_DIRS = ['Checkpoints', 'Audit'];
var USER_FACING_DIRS = ['Goals', 'Pipeline'];   // slightly higher salience — see below

function createFileSensor({ bus, config, vault }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createFileSensor requires a bus');
  }
  if (!vault || typeof vault.vaultPath !== 'function') {
    throw new Error('createFileSensor requires a vault fs-store with vaultPath()');
  }

  var debounceMs = (config && config.MYTHOS_FILE_DEBOUNCE_MS) || 500;
  var extraDirs = ((config && config.MYTHOS_WATCH_DIRS) || '')
    .split(';').map(function(s) { return s.trim(); }).filter(Boolean);

  var watchers = [];
  var pending = new Map();   // absPath -> timer
  var running = false;

  function isIgnored(absPath) {
    for (var i = 0; i < IGNORED_DIRS.length; i++) {
      if (absPath.indexOf(path.sep + IGNORED_DIRS[i] + path.sep) !== -1) return true;
    }
    return false;
  }

  function salienceFor(absPath) {
    for (var i = 0; i < USER_FACING_DIRS.length; i++) {
      if (absPath.indexOf(path.sep + USER_FACING_DIRS[i] + path.sep) !== -1) return 0.6;
    }
    return 0.4;
  }

  function emitChange(eventType, absPath) {
    if (!running || isIgnored(absPath)) return;
    bus.emit('perception.file', {
      kind: 'file',
      summary: eventType + ' ' + absPath,
      channel: 'file',
      salience: salienceFor(absPath),
      path: absPath,
      eventType: eventType
    });
  }

  function watchDir(dir) {
    if (!fs.existsSync(dir)) return null;
    // Windows/libuv fix: os.tmpdir() (and some HOME/profile paths) can resolve to an
    // 8.3 short-name form (e.g. "ARGHYA~1"). Watching that short-name path crashes
    // node with a native `fs-event.c` assertion the moment a second watcher is opened
    // in-process, because ReadDirectoryChangesW reports back the long-form path and
    // libuv's internal prefix check (`_wcsnicmp`) never matches. Resolving to the real
    // long-form path before watching avoids the mismatch entirely.
    var watchPath = dir;
    try { watchPath = fs.realpathSync(dir); } catch (_) { /* keep raw dir if realpath fails */ }
    try {
      var watcher = fs.watch(watchPath, { recursive: false }, function(eventType, filename) {
        if (!filename) return;
        var absPath = path.join(watchPath, filename);
        if (pending.has(absPath)) clearTimeout(pending.get(absPath));
        var timer = setTimeout(function() {
          pending.delete(absPath);
          emitChange(eventType, absPath);
        }, debounceMs);
        if (timer.unref) timer.unref();
        pending.set(absPath, timer);
      });
      return watcher;
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'file-watch-failed', dir: dir, error: err.message });
      return null;
    }
  }

  function start() {
    running = true;
    var vaultRoot = vault.vaultPath('.');
    var dirs = [vaultRoot].concat(extraDirs);
    for (var i = 0; i < dirs.length; i++) {
      var w = watchDir(dirs[i]);
      if (w) watchers.push(w);
    }
  }

  function stop() {
    running = false;
    for (var i = 0; i < watchers.length; i++) {
      try { watchers[i].close(); } catch (_) { /* already closed */ }
    }
    watchers = [];
    pending.forEach(function(timer) { clearTimeout(timer); });
    pending.clear();
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; }
  };
}

module.exports = { createFileSensor };
