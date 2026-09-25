'use strict';

// src/core/voice/model-result.js — bound a tool result for the Live model
// WITHOUT cutting serialized text. BUG-445, 2026-09-23.
//
// THE BUG. live-tool-adapter.js's truncateForModel() did
//   JSON.stringify(result).slice(0, 4000) + '…[truncated]'
// so the model received a JSON string cut mid-token. A browser snapshot lost
// everything after its first video; cua_get_window_state (4,3xx chars measured on
// 2026-09-23) lost its tail elements while their indices stayed callable; and a
// screenshot's base64 rode in the same budget and pushed the useful fields out.
//
// THE SHAPE THAT REPLACES IT. The result is bounded as a STRUCTURE, before it is
// serialized:
//   1. binary payloads leave by FIELD IDENTITY, always — base64 is never text a
//      model can use, whatever its size;
//   2. the largest arrays lose items from the END, so the index of everything
//      still shown is unchanged — an element the model sees is still the element
//      it will address (no renumbering);
//   3. over-long strings are shortened, longest first, with an explicit marker.
// Every omission is named in a `_bounded` note the model reads. A result with no
// binary field that already fits is returned untouched — the same object.
//
// WHAT THIS DOES NOT DO: decide what a page shows. browser_snapshot builds its own
// bounded view (effectors/snapshot-view.js) so that the refs it accepts are the
// refs it printed; by the time a snapshot arrives here it already fits.
//
// ATTACK RECORD (rules/core.md §11): Q2 an unserializable result (a cycle, a
// BigInt) is reported by name, never sent raw and never thrown; Q3 the only reader
// is the Live model — the effector's own result, which the HUD, the audit and the
// episodic vault keep, is never modified (we clone); Q5 DEFAULT_BUDGET is the
// 4,000 the adapter always used — changing the SHAPE of the cut, not its size, is
// what this ticket is about; Q9 the loops are bounded by GUARD_STEPS so a
// pathological value cannot spin.

const DEFAULT_BUDGET = 4000;
// Fields that are never text for a model: payloads for the HUD or a file.
const BINARY_FIELDS = new Set(['screenshotBase64', 'imageBase64', 'audioBase64', 'pngBase64', 'jpegBase64', 'base64']);
const MIN_STRING = 120;
const NOTE_RESERVE = 200;
const GUARD_STEPS = 10000;

function size(v) {
  try { return JSON.stringify(v).length; } catch (_) { return Infinity; }
}

function hasBinary(v) {
  if (!v || typeof v !== 'object') return false;
  for (const k of Object.keys(v)) {
    if (BINARY_FIELDS.has(k) && typeof v[k] === 'string') return true;
    if (hasBinary(v[k])) return true;
  }
  return false;
}

// Walk every array and string with a path, so the largest can be trimmed first.
function collect(v, path, out) {
  if (Array.isArray(v)) {
    out.arrays.push({ path, value: v });
    v.forEach((x, i) => collect(x, path.concat(i), out));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) collect(v[k], path.concat(k), out);
  } else if (typeof v === 'string') {
    out.strings.push({ path, value: v });
  }
  return out;
}

function setAt(root, path, value) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
}

/**
 * boundForModel(result, { budget }) -> a value whose JSON fits within budget.
 * Never throws.
 */
function boundForModel(result, opts) {
  const budget = (opts && Number.isFinite(opts.budget) && opts.budget > 400) ? opts.budget : DEFAULT_BUDGET;
  if (result === undefined || result === null) return null;
  if (typeof result === 'string') {
    if (result.length <= budget) return result;
    const keep = budget - 60;
    return result.slice(0, keep) + ` …[${result.length - keep} more characters not shown]`;
  }
  if (typeof result !== 'object') return result;
  const initial = size(result);
  if (initial === Infinity) return { _bounded: 'this result could not be serialized for the model (it contains a cycle or a non-JSON value)' };
  if (initial <= budget && !hasBinary(result)) return result;

  const out = JSON.parse(JSON.stringify(result));
  const note = { omittedFields: [], omittedItems: {}, shortenedStrings: 0 };

  // 1. Binary payloads leave by field identity, wherever they are.
  (function strip(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (BINARY_FIELDS.has(k) && typeof o[k] === 'string') { note.omittedFields.push(k); delete o[k]; } else strip(o[k]);
    }
  })(out);

  // 2. Arrays lose items from the END, largest array first; indices preserved.
  let guard = 0;
  while (size(out) + NOTE_RESERVE > budget && guard++ < GUARD_STEPS) {
    const { arrays } = collect(out, [], { arrays: [], strings: [] });
    const big = arrays.filter((a) => a.value.length > 1).sort((a, b) => size(b.value) - size(a.value))[0];
    if (!big) break;
    big.value.pop();
    const key = big.path.join('.') || '(root)';
    note.omittedItems[key] = (note.omittedItems[key] || 0) + 1;
  }

  // 3. Over-long strings are shortened, longest first, with a marker.
  guard = 0;
  while (size(out) + NOTE_RESERVE > budget && guard++ < GUARD_STEPS) {
    const { strings } = collect(out, [], { arrays: [], strings: [] });
    const big = strings.filter((s) => s.value.length > MIN_STRING).sort((a, b) => b.value.length - a.value.length)[0];
    if (!big) break;
    const keep = Math.max(MIN_STRING, Math.floor(big.value.length / 2));
    setAt(out, big.path, big.value.slice(0, keep) + '…');
    note.shortenedStrings += 1;
  }

  const parts = [];
  if (note.omittedFields.length) parts.push(`binary field(s) ${[...new Set(note.omittedFields)].join(', ')} not sent as text`);
  for (const [k, n] of Object.entries(note.omittedItems)) parts.push(`${n} trailing item(s) of ${k} not shown`);
  if (note.shortenedStrings) parts.push(`${note.shortenedStrings} long text field(s) shortened`);
  const bounded = Array.isArray(out) ? { items: out } : out;
  bounded._bounded = parts.join('; ') + '. Everything shown keeps its original index or ref.';
  if (size(bounded) > budget) {
    return { _bounded: 'this result is too large to show the model even after trimming', keys: Object.keys(result).slice(0, 20) };
  }
  return bounded;
}

module.exports = { boundForModel, BINARY_FIELDS, DEFAULT_BUDGET };
