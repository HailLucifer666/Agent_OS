// voice-picker.js — hear a voice, then keep it.
//
// WHY THIS EXISTS (operator, 2026-08-11): the packaged app spoke with the
// browser's flat speechSynthesis voice and there was no way to change it, because
// every voice id is an environment variable in mythos/.env — a file the installer
// does not ship. The operator's ask was exactly two things: "if I select play,
// that voice should play, and I can select what voice I want to keep as default."
//
// Two mounts, one component. The first-run wizard mounts it compact (the operator
// has just typed a key and wants to know what they will hear); the HUD's VOICE
// panel mounts it in full. Both go through createVoicePicker.
//
// HONESTY RULES, inherited from setup-state.js's interpretStoreResult:
//   * never claim a voice is live before the server says so — the POST answers
//     applied:true only when the chain was actually rebuilt;
//   * an engine this machine does not have is SHOWN as missing, not hidden. An
//     absent piper row reads as "piper was never an option"; a greyed one reads
//     as "install it" — which is the true statement;
//   * when nothing server-side can speak, say that the browser voice is what will
//     be heard and name the key that changes it, rather than rendering an empty
//     picker that looks broken.

const SAMPLE_TEXT = 'This is how I will sound when I speak to you.';

// Pure. Exported for node:test. Turns GET /api/tts/voices into what the screen
// needs to say, including the case that matters most on a fresh install: nothing
// here can speak at all.
export function summarizeEngines(body) {
  const engines = (body && Array.isArray(body.engines)) ? body.engines : [];
  const usable = engines.filter((e) => e && e.available && Array.isArray(e.voices) && e.voices.length > 0);
  const chosen = (body && body.default) || null;
  return {
    engines,
    usable,
    chosen,
    anyUsable: usable.length > 0,
    // The truthful floor when no engine can speak. Same wording as the wizard's
    // key step, deliberately — one sentence for one fact.
    emptyMessage: 'No speech engine is available on this machine, so replies use the browser\'s built-in voice. Store a GOOGLE_API_KEY to speak in the Gemini voices.',
  };
}

// Pure. Exported for node:test. The row the entity would use right now.
export function isCurrent(chosen, provider, voiceId) {
  if (!chosen) return false;
  return chosen.provider === provider && String(chosen.voice || '') === String(voiceId);
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// createVoicePicker(container, opts) -> { dispose }
//   opts.compact   — wizard mode: current voice plus a disclosure holding the list
//   opts.fetchImpl — injectable fetch, same convention as first-run-wizard.js
//   opts.onChange  — (provider, voice) => void, after a POST the server accepted
export function createVoicePicker(container, opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || ((...args) => fetch(...args));
  const compact = o.compact === true;
  let disposed = false;
  // One <audio> for the whole picker: pressing play on a second voice must
  // replace the first, not talk over it.
  let sample = null;

  const root = h('div', compact ? 'vpick vpick-compact' : 'vpick');
  const status = h('p', 'vpick-status');
  status.setAttribute('role', 'status');
  const list = h('div', 'vpick-list');
  root.append(status, list);
  container.appendChild(root);

  function stopSample() {
    if (sample) { try { sample.pause(); } catch (_) { /* already gone */ } sample = null; }
  }

  async function audition(provider, voice, btn) {
    stopSample();
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await doFetch('/api/tts/audition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, voice, text: SAMPLE_TEXT }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.audioB64) {
        setStatus((body && body.error) || `That sample could not be played (HTTP ${res.status}).`, true);
        return;
      }
      if (disposed) return;
      sample = new Audio('data:' + (body.mime || 'audio/mpeg') + ';base64,' + body.audioB64);
      sample.play().catch(() => setStatus('The browser refused to play that sample.', true));
      setStatus('');
    } catch (err) {
      setStatus('The server did not answer: ' + ((err && err.message) || 'unknown error'), true);
    } finally {
      if (!disposed) { btn.disabled = false; btn.textContent = was; }
    }
  }

  async function choose(provider, voice, btn) {
    btn.disabled = true;
    try {
      const res = await doFetch('/api/tts/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, voice }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        setStatus((body && body.error) || `That voice could not be set (HTTP ${res.status}).`, true);
        return;
      }
      // applied:false means stored-but-not-live. Say which one it was.
      setStatus(body.applied === false
        ? 'Saved. It needs a restart to take effect.'
        : 'Saved. The next reply speaks in this voice.');
      if (typeof o.onChange === 'function') o.onChange(provider, voice);
      await load();
    } catch (err) {
      setStatus('The server did not answer: ' + ((err && err.message) || 'unknown error'), true);
    } finally {
      if (!disposed) btn.disabled = false;
    }
  }

  function setStatus(text, isError) {
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(isError));
  }

  function renderVoiceRow(engine, voice, chosen) {
    const row = h('div', 'vpick-row');
    const current = isCurrent(chosen, engine.provider, voice.id);
    if (current) row.classList.add('is-current');
    const name = h('span', 'vpick-voice', voice.label || voice.id);
    const detail = h('span', 'vpick-detail mono', voice.detail || engine.short);
    const play = h('button', 'vpick-play', '▶');
    play.type = 'button';
    play.setAttribute('aria-label', `Play a sample of ${voice.label || voice.id}`);
    play.addEventListener('click', () => audition(engine.provider, voice.id, play));
    const use = h('button', 'vpick-use', current ? 'in use' : 'use');
    use.type = 'button';
    use.disabled = current;
    use.setAttribute('aria-label', `Speak in ${voice.label || voice.id} from now on`);
    use.addEventListener('click', () => choose(engine.provider, voice.id, use));
    row.append(name, detail, play, use);
    return row;
  }

  function render(summary) {
    list.textContent = '';
    if (!summary.anyUsable) {
      list.appendChild(h('p', 'vpick-empty', summary.emptyMessage));
      // Still name the engines that exist but are not installed — "piper is
      // missing" is actionable, "piper was never mentioned" is not.
      const missing = summary.engines.filter((e) => !e.available).map((e) => e.short);
      if (missing.length) list.appendChild(h('p', 'vpick-detail mono', 'Not installed here: ' + missing.join(', ') + '.'));
      return;
    }
    for (const engine of summary.usable) {
      const group = h('div', 'vpick-engine');
      group.appendChild(h('h3', 'vpick-engine-name', engine.short));
      for (const voice of engine.voices) group.appendChild(renderVoiceRow(engine, voice, summary.chosen));
      list.appendChild(group);
    }
    const missing = summary.engines.filter((e) => !e.available).map((e) => e.short);
    if (missing.length) list.appendChild(h('p', 'vpick-detail mono', 'Not installed here: ' + missing.join(', ') + '.'));
  }

  async function load() {
    setStatus('Reading the voices this machine can speak with…');
    try {
      const res = await doFetch('/api/tts/voices');
      const body = await res.json().catch(() => null);
      if (disposed) return;
      if (!res.ok || !body) {
        setStatus(`The voice list could not be read (HTTP ${res.status}).`, true);
        return;
      }
      const summary = summarizeEngines(body);
      render(summary);
      setStatus(summary.chosen && summary.chosen.voice
        ? `Currently speaking as ${summary.chosen.voice}.`
        : '');
    } catch (err) {
      if (!disposed) setStatus('The server did not answer: ' + ((err && err.message) || 'unknown error'), true);
    }
  }

  load();

  return {
    reload: load,
    dispose() {
      disposed = true;
      stopSample();
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
