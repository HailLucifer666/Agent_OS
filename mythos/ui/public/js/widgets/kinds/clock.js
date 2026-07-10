// clock.js — local time widget. Pure local Date; one 1s interval, cleared on cleanup.

export function mountClock(el) {
  el.innerHTML = `
    <div class="widget-value mono" data-role="time">--:--:--</div>
    <div class="widget-sub mono" data-role="date"></div>
  `;
  const timeEl = el.querySelector('[data-role="time"]');
  const dateEl = el.querySelector('[data-role="date"]');

  function tick() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour12: false });
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
