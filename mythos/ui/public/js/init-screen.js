// init-screen.js — cinematic boot overlay. Real-signal driven where possible:
// WS connect / entity-state / first tick advance the status lines; canned
// fillers pace the gaps. Fast-path when the entity is already alive
// (refresh). Click/Esc skips. Reduced-motion: plain fade, no scan sweep.
export function mountInitScreen({ subscribe }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.id = 'init-screen';
  el.innerHTML = `
    <div class="init-sweep"></div>
    <div class="init-center">
      <div class="init-wordmark">M Y T H O S</div>
      <div class="init-lines mono" id="init-lines"></div>
    </div>
    <div class="init-scanline"></div>
    <div class="init-skip mono">ESC TO SKIP</div>
  `;
  document.body.appendChild(el);
  const linesEl = el.querySelector('#init-lines');

  let dismissed = false;
  let sawAlive = false;
  const t0 = performance.now();

  function addLine(text, tone) {
    if (dismissed) return;
    const div = document.createElement('div');
    div.className = 'init-line' + (tone ? ' ' + tone : '');
    div.textContent = text;
    linesEl.appendChild(div);
    while (linesEl.children.length > 6) linesEl.removeChild(linesEl.firstChild);
  }

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    unsub();
    document.removeEventListener('keydown', onKey);
    el.classList.add('init-out');
    setTimeout(() => el.remove(), reduced ? 300 : 750);
  }

  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', dismiss);

  // canned pacing lines (honest filler — no fake metrics)
  const fillers = ['ESTABLISHING NEURAL LINK', 'MOUNTING MEMORY VAULT', 'CALIBRATING SENSOR ARRAY', 'PRIMING EFFECTOR GRID'];
  fillers.forEach((f, i) => setTimeout(() => { if (!sawAlive || i < 2) addLine(f); }, 250 + i * 420));

  const unsub = subscribe(['entity-state', 'tick'], (msg) => {
    if (msg.type === 'entity-state') {
      const status = msg.payload && msg.payload.status;
      if (status === 'alive' && !sawAlive) {
        sawAlive = true;
        addLine('ENTITY ONLINE', 'ok');
        // fast-path: alive within 700ms of load (refresh/reconnect) → short reveal
        const elapsed = performance.now() - t0;
        setTimeout(dismiss, elapsed < 700 ? 500 : 1100);
      } else if (status && status !== 'alive' && !sawAlive) {
        addLine('COGNITIVE CORE SPINNING UP');
      }
    } else if (msg.type === 'tick' && sawAlive) {
      addLine('HEARTBEAT ACQUIRED', 'ok');
    }
  });

  // hard ceiling — never trap the user on the overlay (server down, WS blocked)
  setTimeout(() => { if (!dismissed) { addLine('LINK TIMEOUT — ENTERING DASHBOARD', 'warn'); setTimeout(dismiss, 600); } }, 6000);
  return { dismiss };
}
