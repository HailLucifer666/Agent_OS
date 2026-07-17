'use strict';

// sensors/screen-sensor.js — ambient screen awareness (Phase 2, Jarvis upgrade).
// Periodically screenshots the desktop via pc-child, hash-gates identical
// screens so an unchanged screen costs zero vision calls, and describes
// genuinely changed screens through the vision brain lane. Emits
// 'perception.screen' — cortex drains it from working memory exactly like
// every other sensor (bus.subscribe('perception.*') in main.js's 'sensors'
// boot step).
//
// PRIVACY (binding, spec §3): the base64/PNG screenshot bytes NEVER touch
// disk or a log line — only the text description the vision brain returns
// flows onward. There is no writeFile/appendLine/artPath/fs call anywhere in
// this file; the raw `b64` variable is used only to compute a sha1 hash and
// to build an in-memory data URL passed straight to brain.think().
//
// Pattern mirrors sensors/timer.js + sensors/reminder-sensor.js + sensors/
// gmail-sensor.js: generation token + unref'd setInterval, closures over an
// injected bus (start() takes no `emit` argument). Failure honesty mirrors
// sensors/metric.js's poll: pcChild offline, no brain, or a vision error are
// all silent skips (honest-inert) — never a throw.

const crypto = require('crypto');

function createScreenSensor({ bus, config, brain, pcChild, logger }) {
  if (!bus) throw new Error('createScreenSensor requires bus');

  var generation = 0;
  var timer = null;
  var running = false;
  var lastHash = null;

  function poll(myGen) {
    if (!pcChild || typeof pcChild.sendCommand !== 'function') return Promise.resolve();
    return Promise.resolve()
      .then(function () { return pcChild.sendCommand({ cmd: 'screen_look' }); })
      .then(function (shot) {
        if (generation !== myGen) return; // stopped/restarted mid-flight
        if (!shot || shot.ok === false) return; // pc-child offline/failed — silent skip
        var b64 = shot.result && (shot.result.image || shot.result.base64 || shot.result.png);
        if (typeof b64 !== 'string' || !b64) return; // no screenshot data — silent skip

        // Token discipline: an unchanged screen carries no new information —
        // skip the vision call entirely rather than re-describing the same frame.
        var hash = crypto.createHash('sha1').update(b64).digest('hex');
        if (hash === lastHash) return;
        lastHash = hash;

        if (!brain || typeof brain.think !== 'function') return; // no vision brain — silent skip

        return brain.think({
          lane: 'vision',
          source: 'screen-sensor',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'In one sentence: what is the user doing on this screen right now? Name the app and the activity. No preamble.' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
            ],
          }],
        }).then(function (result) {
          if (generation !== myGen) return; // stopped/restarted mid-flight
          if (!result || result.offline || !result.content) return; // vision offline/empty — silent skip
          var description = String(result.content).trim();
          if (!description) return;
          bus.emit('perception.screen', {
            ts: Date.now(),
            kind: 'screen',
            channel: 'ambient-screen',
            summary: description.slice(0, 200),
            salience: (config && typeof config.SCREEN_AWARENESS_SALIENCE === 'number') ? config.SCREEN_AWARENESS_SALIENCE : 0.3,
            detail: { description: description },
          });
        });
      })
      .catch(function (err) {
        // honest-inert: a failed poll (pc-child offline rejection, vision error,
        // etc.) is not a crash. Best-effort log only, never a throw.
        if (logger && typeof logger.warn === 'function') {
          try { logger.warn('sensors.screen.poll-failed', { error: err && err.message }); } catch (_) { /* best-effort */ }
        }
      });
  }

  function start() {
    generation++;
    var myGen = generation;
    running = true;
    var pollMs = (config && config.SCREEN_AWARENESS_POLL_MS) || 30000;
    timer = setInterval(function () {
      if (generation !== myGen) return;
      try { poll(myGen); } catch (_) { /* best-effort */ }
    }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    _internal: { poll: poll }, // test hook — mirrors sensors/metric.js's _internal.poll
  };
}

module.exports = { createScreenSensor: createScreenSensor };
