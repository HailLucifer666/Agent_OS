// A successful PIN exchange changes API authorization without reloading the HUD.
// Share refreshed facts with all consumers; an older request cannot undo them.
export function createVoiceConfigStore(fetchImpl) {
  let generation = 0, snapshot = null, ready = Promise.resolve(null);
  const listeners = new Set();
  async function read(name) {
    try {
      const response = await fetchImpl('/api/config/' + name);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice configuration');
      return { value, error: null };
    } catch (error) { return { value: null, error: error.message || String(error) }; }
  }
  return {
    get ready() { return ready; },
    refresh() {
      const revision = ++generation;
      ready = Promise.all(['vad', 'wakeword', 's2s'].map(read)).then(([vad, wakeword, s2s]) => {
        if (revision !== generation) return ready;
        snapshot = { vad, wakeword, s2s };
        for (const listener of listeners) listener(snapshot);
        return snapshot;
      });
      return ready;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (snapshot) listener(snapshot);
      return () => listeners.delete(listener);
    },
  };
}

export const voiceConfiguration = createVoiceConfigStore((...args) => fetch(...args));
