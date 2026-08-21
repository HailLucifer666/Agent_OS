// settings-panel-model.js — the pure decisions behind the Settings panel.
//
// WHY A SETTINGS PANEL EXISTS AT ALL (operator, 2026-08-11): the packaged build
// had NO UI anywhere for a non-secret configuration key. The first-run wizard's
// key store only ever exposed provider API keys, and mythos/.env — the only other
// source — is excluded from package.json build.files. So ~140 schema keys sat at
// their defaults in the install with no way to change them, which is what produced
// four incidents in two minutes on a build whose code was byte-identical to dev's.
//
// The panel renders GET /api/config/settings: every key, its default, its
// effective value, and WHERE that value came from. The origin column is the part
// that matters — "VOICE_S2S_ENABLED is false" and "VOICE_S2S_ENABLED is false
// because nothing ever set it" are different problems, and only the second one
// tells the operator what to do.
//
// Pure/DOM split as in setup-state.js, so node:test covers all of this with no
// browser.

// Ordered so the keys the incidents came from are the ones the operator sees
// first. A flat alphabetical list of 140 keys is technically complete and
// practically useless.
const GROUP_RULES = [
  { id: 'voice', label: 'Voice', match: (n) => /^(VOICE_|WAKEWORD_|VAD_|PIPER_|KOKORO_|EDGE_|GEMINI_LIVE|LIVE_|DUCK_)/.test(n) },
  { id: 'autonomy', label: 'Autonomy & safety', match: (n) => /^(AUTONOMOUS_|LEASH_|PIN_|AUTH_|CONFIRM_)/.test(n) },
  { id: 'brain', label: 'Brain & providers', match: (n) => /^(BRAIN_|LLM_|MODEL_|GOAL_|STRIX_)/.test(n) },
  { id: 'devices', label: 'Devices & integrations', match: (n) => /^(AETHER_|DSH_|ANDROID_|BROWSER_|CUA_|PC_|SPOTIFY_|GMAIL_|GOOGLE_|MCP_|WHATSAPP_)/.test(n) },
  { id: 'server', label: 'Server & storage', match: (n) => /^(MYTHOS_|LOG_|BUS_|SERVER_|VAULT_)/.test(n) },
];
const OTHER_GROUP = { id: 'other', label: 'Everything else' };

// Origins that mean "an operator or an operator's file decided this", as opposed
// to MYTHOS having picked something sensible on its own.
const EXPLICIT_ORIGINS = new Set(['env', 'config.json', '.env', 'voice-choice']);

// buildSettingsView(body, {hasBridge}) -> {groups, counts, editable, file, autonomy}
//
// `body` is the parsed GET /api/config/settings response, or null.
// `hasBridge` — whether window.mythos.setSetting exists. In a plain browser tab
// there is no Electron bridge, so the panel is READ-ONLY and must say so rather
// than offering inputs that would silently do nothing.
export function buildSettingsView(body, opts) {
  const o = opts || {};
  const rows = body && Array.isArray(body.keys) ? body.keys : null;
  if (!rows) {
    return { ok: false, reason: 'indeterminate', groups: [], counts: {}, editable: false, file: null, autonomy: null };
  }

  const editable = Boolean(o.hasBridge);
  const buckets = new Map();
  const counts = { total: 0, explicit: 0, default: 0, derived: 0, secret: 0 };

  for (const row of rows) {
    if (!row || !row.name) continue;
    counts.total += 1;
    if (row.secret) counts.secret += 1;
    if (EXPLICIT_ORIGINS.has(row.origin)) counts.explicit += 1;
    else if (row.origin === 'derived') counts.derived += 1;
    else counts.default += 1;

    const rule = GROUP_RULES.find((g) => g.match(row.name)) || OTHER_GROUP;
    if (!buckets.has(rule.id)) buckets.set(rule.id, { id: rule.id, label: rule.label, rows: [] });
    buckets.get(rule.id).rows.push({
      name: row.name,
      type: row.type,
      value: row.secret ? '' : String(row.value === undefined ? '' : row.value),
      default: String(row.default === undefined ? '' : row.default),
      enum: Array.isArray(row.enum) ? row.enum : null,
      origin: row.origin,
      // A secret is shown as set/unset and nothing else — its value never crosses
      // the wire (server/routes/config.js), so there is nothing to render and no
      // input to offer. It belongs in the key store.
      secret: row.secret === true,
      set: row.secret ? row.set === true : String(row.value || '') !== '',
      // Editing a secret here is refused by settings-store.js anyway; saying so up
      // front is better than an input that fails on submit.
      editable: editable && row.secret !== true,
      // 'default' is not a problem in itself — most keys should be at their
      // default. It IS the thing to look at when a feature is not behaving.
      atDefault: row.origin === 'default',
    });
  }

  const order = [...GROUP_RULES.map((g) => g.id), OTHER_GROUP.id];
  const groups = order
    .map((id) => buckets.get(id))
    .filter(Boolean)
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.name.localeCompare(b.name)) }));

  return {
    ok: true,
    reason: 'ok',
    groups,
    counts,
    editable,
    file: body.file || null,
    autonomy: body.autonomy || null,
    readOnlyReason: editable ? '' : 'This is a browser tab, not the MYTHOS app — settings can be read here but only changed from the app.',
  };
}

// planSettingEdits(view, pending) -> {changes:[{name,value,previous}], unchanged:[names]}
//
// `pending` is {name: newValue} straight off the form. A value equal to what is
// already effective is NOT a change: writing it would pin the key at that value
// in config.json even though nothing needed pinning, which quietly converts a
// derived or default value into a permanent one.
export function planSettingEdits(view, pending) {
  const byName = new Map();
  for (const group of (view && view.groups) || []) {
    for (const row of group.rows) byName.set(row.name, row);
  }

  const changes = [];
  const unchanged = [];
  const rejected = [];
  for (const [name, raw] of Object.entries(pending || {})) {
    const row = byName.get(name);
    if (!row) { rejected.push({ name, reason: 'not a key this server reported' }); continue; }
    if (row.secret) { rejected.push({ name, reason: 'secrets go in the key store, not config.json' }); continue; }
    if (!row.editable) { rejected.push({ name, reason: 'not editable from here' }); continue; }
    const value = String(raw === undefined || raw === null ? '' : raw);
    if (value === row.value) { unchanged.push(name); continue; }
    changes.push({ name, value, previous: row.value });
  }
  return { changes, unchanged, rejected };
}

// describeAutonomy(autonomy) -> one honest sentence, or ''
//
// Incident 3: Tier-1/2 approval prompts on an install configured not to need
// them, because a vault with no Identity/boundaries.md was read as a corrupt one
// and the ceiling was clamped to 1. The panel says the effective ceiling AND its
// source so that clamp can never be invisible again.
export function describeAutonomy(autonomy) {
  const a = autonomy || {};
  if (a.effective === null || a.effective === undefined) return '';
  const base = `Autonomy ceiling: tier ${a.effective}`;
  if (a.source === 'malformed-failsafe') {
    return `${base} — clamped from your configured tier ${a.configCeiling} because Identity/boundaries.md `
      + 'is present but could not be parsed. Fix or delete that file.';
  }
  if (a.source === 'absent-config-ceiling') {
    return `${base} — from your configuration, because there is no Identity/boundaries.md yet.`;
  }
  if (a.effective < a.configCeiling) {
    return `${base} — your configuration allows tier ${a.configCeiling}, but Identity/boundaries.md `
      + `tightens it to ${a.boundariesCeiling}.`;
  }
  return `${base}, from Identity/boundaries.md and your configuration (they agree).`;
}
