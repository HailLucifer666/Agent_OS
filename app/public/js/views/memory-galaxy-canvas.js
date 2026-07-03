// memory-galaxy-canvas.js — 2D-canvas starfield renderer for the Memory Galaxy view.
// No three.js: plain canvas 2D with a deterministic radial layout, slow drift,
// drag-to-pan, scroll-to-zoom, hover tooltip, click-to-select.

/**
 * Build star nodes from real notes, positioned via a deterministic
 * golden-angle spiral (index-seeded, not real physics — spreads notes into a
 * roughly circular/clustered pattern without needing a force simulation).
 */
function buildStars(notes, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) * 0.44;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5deg

  const now = Date.now();
  const times = notes.map((n) => (n.modified ? new Date(n.modified).getTime() : 0));
  const minT = Math.min(...times, now);
  const maxT = Math.max(...times, now);
  const span = Math.max(maxT - minT, 1);

  return notes.map((note, i) => {
    // sqrt spacing keeps density roughly even from center outward
    const r = maxRadius * Math.sqrt((i + 0.5) / notes.length);
    const angle = i * goldenAngle;
    const recency = times[i] ? (times[i] - minT) / span : 0; // 0..1, 1 = most recent
    return {
      note,
      baseX: cx + Math.cos(angle) * r,
      baseY: cy + Math.sin(angle) * r,
      angle,
      radius: r,
      recency,
      size: 1.6 + recency * 2.8,
    };
  });
}

/** Match note.links entries to other notes by name, case-insensitive. */
function buildLinks(stars) {
  const byName = new Map(stars.map((s) => [s.note.name.toLowerCase(), s]));
  const links = [];
  const seen = new Set();
  stars.forEach((s) => {
    (s.note.links || []).forEach((target) => {
      const t = byName.get(String(target).toLowerCase());
      if (!t || t === s) return;
      const key = [s.note.name, t.note.name].sort().join('||');
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ a: s, b: t });
    });
  });
  return links;
}

export function createGalaxy(canvas, tooltipEl, { onSelect } = {}) {
  const ctx = canvas.getContext('2d');
  let stars = [];
  let links = [];
  let width = 0;
  let height = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // view transform: pan offset + zoom scale
  let offsetX = 0;
  let offsetY = 0;
  let scale = 1;
  let rotation = 0;

  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;
  let hovered = null;
  let rafId = null;
  let paused = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (stars.length) {
      stars = buildStars(stars.map((s) => s.note), width, height);
      links = buildLinks(stars);
    }
  }

  function setNotes(notes) {
    stars = buildStars(notes, canvas.getBoundingClientRect().width || 800, canvas.getBoundingClientRect().height || 500);
    links = buildLinks(stars);
  }

  function toScreen(star) {
    // slow global rotation for subtle drift, matching "brighter/whiter = recent" spec
    const rot = rotation;
    const dx = star.baseX - width / 2;
    const dy = star.baseY - height / 2;
    const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
    const x = (width / 2 + rx) * scale + offsetX;
    const y = (height / 2 + ry) * scale + offsetY;
    return { x, y };
  }

  function draw() {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // background glow
    const grad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.6);
    grad.addColorStop(0, 'rgba(139,92,246,0.10)');
    grad.addColorStop(1, 'rgba(19,16,25,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // links
    ctx.lineWidth = 0.6;
    links.forEach(({ a, b }) => {
      const pa = toScreen(a);
      const pb = toScreen(b);
      ctx.strokeStyle = 'rgba(180,160,220,0.10)';
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });

    // stars
    stars.forEach((star) => {
      const p = toScreen(star);
      const r = star.size * scale;
      const isHovered = star === hovered;
      const white = 0.55 + star.recency * 0.45;
      const tint = star.recency > 0.66 ? [255, 255, 255] : star.recency > 0.33 ? [190, 170, 255] : [110, 190, 220];
      const alpha = isHovered ? 1 : 0.55 + star.recency * 0.4;

      if (isHovered || star.recency > 0.7) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${alpha * 0.18})`;
        ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${alpha})`;
      ctx.arc(p.x, p.y, Math.max(0.8, r * white), 0, Math.PI * 2);
      ctx.fill();
    });

    // persistent labels for a few brightest stars (matches reference screenshot)
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const labeled = [...stars].sort((a, b) => b.recency - a.recency).slice(0, 5);
    labeled.forEach((star) => {
      const p = toScreen(star);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(star.note.name, p.x, p.y - star.size * scale - 6);
    });

    ctx.restore();
  }

  function tick() {
    if (!paused) rotation += 0.00012;
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function findHover(px, py) {
    let closest = null;
    let closestDist = 14; // hit radius in px
    stars.forEach((star) => {
      const p = toScreen(star);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < closestDist) {
        closest = star;
        closestDist = d;
      }
    });
    return closest;
  }

  function localPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      offsetX += dx;
      offsetY += dy;
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    const { x, y } = localPos(e);
    const hit = findHover(x, y);
    hovered = hit;
    if (hit && tooltipEl) {
      tooltipEl.textContent = hit.note.name;
      tooltipEl.style.left = `${x + 14}px`;
      tooltipEl.style.top = `${y + 10}px`;
      tooltipEl.hidden = false;
    } else if (tooltipEl) {
      tooltipEl.hidden = true;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hovered = null;
    if (tooltipEl) tooltipEl.hidden = true;
  });

  canvas.addEventListener('click', (e) => {
    if (dragMoved) return; // was a drag, not a click
    const { x, y } = localPos(e);
    const hit = findHover(x, y);
    if (hit && onSelect) onSelect(hit.note);
  });

  canvas.addEventListener('dblclick', () => {
    paused = !paused;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      scale = Math.min(4, Math.max(0.35, scale * delta));
    },
    { passive: false }
  );

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);
  resize();
  tick();

  return {
    setNotes,
    linkCount: () => links.length,
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    },
  };
}
