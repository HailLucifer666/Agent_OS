// _poll-util.js — shared polling helper for long-running provider jobs
// (Suno, HeyGen, MiniMax, Grok all commission a job then poll for completion).

// Repeatedly calls fn() every intervalMs until it returns a truthy result,
// fn throws, or timeoutMs elapses. Aborts early if signal is aborted.
async function pollUntil(fn, opts = {}) {
  const { intervalMs = 5000, timeoutMs = 300000, signal } = opts;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal && signal.aborted) throw new Error('polling aborted');
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`polling timed out after ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, intervalMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('polling aborted'));
        }, { once: true });
      }
    });
  }
}

module.exports = { pollUntil };
