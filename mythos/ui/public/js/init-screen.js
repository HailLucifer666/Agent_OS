// init-screen.js — cinematic boot overlay. Real-signal driven where possible:
// WS connect / entity-state / first tick advance the status lines; canned
// fillers pace the gaps. Fast-path when the entity is already alive
// (refresh). Click/Esc skips. Reduced-motion: plain fade, no scan sweep.
//
// TIMING, MEASURED 2026-07-31. This overlay was the whole "the HUD feels slow"
// complaint. The real critical path is 17ms over loopback (1 html + 15 css + 38
// modules, gzipped, warm cache), and server/index.js:1119 sends an entity-state
// snapshot the instant the WS connects — so on a refresh the overlay had nothing
// left to cover and still held the screen for ~1.25s: 1.1s of wordmark intro,
// then a 500ms hold, then a 700ms fade. Every duration below and its CSS twin in
// init.css is now halved, which keeps the cinematic but stops charging the
// operator for it. The numbers are paired: the hold must outlast the wordmark
// intro or the intro visibly cuts, and the removal timeout must match the
// #init-screen opacity/transform transition or the overlay pops instead of fades.
const REVEAL_FAST_MS = 240;   // entity already alive on connect (refresh)
const REVEAL_SLOW_MS = 520;   // cold boot — let the last status line be read
const FADE_MS = 380;          // pairs with init.css #init-screen transition (0.35s)
const FADE_REDUCED_MS = 200;
const FILLER_FIRST_MS = 120;
const FILLER_GAP_MS = 220;
const LINK_TIMEOUT_MS = 3000; // hard ceiling: server down / WS blocked
export function mountInitScreen({ subscribe }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.id = 'init-screen';
  // xss-safe: static template, no interpolation
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
    setTimeout(() => el.remove(), reduced ? FADE_REDUCED_MS : FADE_MS);
  }

  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', dismiss);

  // canned pacing lines (honest filler — no fake metrics)
  const fillers = ['ESTABLISHING NEURAL LINK', 'MOUNTING MEMORY VAULT', 'CALIBRATING SENSOR ARRAY', 'PRIMING EFFECTOR GRID'];
  fillers.forEach((f, i) => setTimeout(() => { if (!sawAlive || i < 2) addLine(f); }, FILLER_FIRST_MS + i * FILLER_GAP_MS));

  const unsub = subscribe(['entity-state', 'tick'], (msg) => {
    if (msg.type === 'entity-state') {
      const status = msg.payload && msg.payload.status;
      if (status === 'alive' && !sawAlive) {
        sawAlive = true;
        addLine('ENTITY ONLINE', 'ok');
        // fast-path: alive within 700ms of load (refresh/reconnect) → short reveal
        const elapsed = performance.now() - t0;
        setTimeout(dismiss, elapsed < 700 ? REVEAL_FAST_MS : REVEAL_SLOW_MS);
      } else if (status && status !== 'alive' && !sawAlive) {
        addLine('COGNITIVE CORE SPINNING UP');
      }
    } else if (msg.type === 'tick' && sawAlive) {
      addLine('HEARTBEAT ACQUIRED', 'ok');
    }
  });

  // hard ceiling — never trap the user on the overlay (server down, WS blocked)
  setTimeout(() => { if (!dismissed) { addLine('LINK TIMEOUT — ENTERING DASHBOARD', 'warn'); setTimeout(dismiss, 400); } }, LINK_TIMEOUT_MS);
  return { dismiss };
}
