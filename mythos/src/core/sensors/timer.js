// sensors/timer.js — periodic timer perception sensor.
// Emits a 'perception.tick' event every tick cycle. The cortex drains these
// from working memory perception queue.

function createTimerSensor({ bus, config }) {
  let timer = null;
  let generation = 0;
  let running = false;

  function start() {
    generation++;
    const myGen = generation;
    running = true;
    const interval = (config && config.MYTHOS_TICK_MS) || 1000;
    timer = setInterval(function() {
      if (generation !== myGen) return;
      bus.emit('perception.tick', { ts: Date.now(), generation: myGen, kind: 'timer', salienceHint: 0.1 });
    }, interval);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, isRunning: function() { return running; } };
}

module.exports = { createTimerSensor };
