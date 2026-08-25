// version-badge.js — "which build am I actually looking at", in the corner of
// the HUD.
//
// WHY (operator, 2026-08-12): four separate builds carried the version 0.1.4
// that day, and the installed app turned out to be a day older than the fixes
// it was believed to contain — an evening spent re-diagnosing bugs that were
// already fixed in the repo. Nothing in the running app said which build it
// was. A version number alone would NOT have prevented it (all four said
// 0.1.4), so the badge shows a build identity: the version plus the git ref in
// a dev checkout, or the version plus the build's own timestamp in a packaged
// install, where no .git exists to describe.
//
// Deliberately tiny and quiet. It is a label, not a control: no click handler,
// no polling, one fetch at mount. Screen readers get it as ordinary text rather
// than a live region — it never changes while the app runs.

// Pure view model, so the wording is testable without a DOM
// (test/version-badge-model.test.js).
export function versionBadgeModel(build) {
  if (!build || !build.version) {
    // The status call failed or predates the build block. Say nothing rather
    // than render "unknown" — a badge that reports its own ignorance is noise,
    // and the absence is itself visible (no badge = a server that couldn't say).
    return { hidden: true, text: '', title: '' };
  }
  const version = String(build.version);
  const ref = String(build.gitRef || '');
  const packaged = !!build.packaged;
  // A dev checkout has a real git ref, which beats a timestamp: it names the
  // commit. version.js falls back to 'v<version>' when git is unavailable, so
  // that placeholder must not be shown as if it were a ref.
  const refIsReal = ref && ref !== `v${version}`;
  const stamp = packaged ? shortBuildTime(build.buildTime) : '';

  let text = `v${version}`;
  if (refIsReal) text += ` · ${ref}`;
  else if (stamp) text += ` · ${stamp}`;

  const detail = [
    `MYTHOS v${version}`,
    refIsReal ? `git ${ref}` : null,
    packaged ? 'packaged install' : 'dev checkout',
    build.buildTime ? `built ${build.buildTime}` : null,
  ].filter(Boolean);

  return { hidden: false, text, title: detail.join(' — ') };
}

// "08-12 21:08" — local, minute resolution. Enough to tell two builds of the
// same version apart, which is the whole job; the full ISO string stays in the
// tooltip for when an exact answer is needed.
export function shortBuildTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function mountVersionBadge(root, deps = {}) {
  const el = root || document.getElementById('version-badge');
  if (!el) return () => {};
  const doFetch = deps.fetch || ((...a) => fetch(...a));

  let build = null;
  try {
    const res = await doFetch('/api/status');
    // A 401 here is the ordinary pre-auth state, not a fault: the auth gate is
    // still up and will reload the HUD once satisfied. Nothing to render yet.
    if (res && res.ok) build = (await res.json()).build;
  } catch (_) {
    // Server not up yet / offline. The badge is the least important thing on
    // screen; it must never surface an error of its own.
  }

  const model = versionBadgeModel(build);
  if (model.hidden) {
    el.textContent = '';
    el.hidden = true;
    return () => {};
  }
  el.textContent = model.text;
  el.title = model.title;
  el.hidden = false;
  return () => { el.textContent = ''; el.hidden = true; };
}
