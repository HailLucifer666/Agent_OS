# Widget work: local vs origin/main — code-level differences

Generated 2026-08-03. HEAD `e8b9591`, remote `0937602`.

Both sides have the seven ported HUD widgets. The remote committed them
(`e59bd9a`, merged in `0937602`); this machine has an uncommitted variant.
The differences are NOT only comments — the code lines below differ.

Local state is preserved two ways, neither of which touched the worktree:
- tracked modifications: git tag `wip-local-widgets-2026-08-03`
- untracked files: scratchpad copy (see session notes)

## mythos/server/routes/system.js

```diff
const real = (values || []).filter((v) => Number.isFinite(v));
const real = values.filter((v) => Number.isFinite(v));
```

`<` = origin/main, `>` = local working tree.

## mythos/test/widgets-ported.test.js

```diff
const fs = require('fs');
it('measures only the window between the two samples, not since boot', () => {
assert.deepEqual(cpuDeltaPercent(sample(1000, 1000), sample(1100, 1900)), [90]);
it('is a DELTA, not a cumulative read — the same absolute numbers at a later, busier moment give a different answer', () => {
const first = cpuDeltaPercent(sample(1000, 1000), sample(1100, 1900));
assert.deepEqual(first, [90]);
assert.equal(terminal.normalizeLogLine({ ts: 'not-a-date', msg: 'x' }, 0).time, '');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'memory.js'), 'utf8');
const src = require('fs').readFileSync(
path.join(__dirname, '..', 'server', 'routes', 'memory.js'), 'utf8',
);
'routes/memory.js must not emit a score field — it is a constant on the browse path');
'routes/memory.js must not emit a score field — see the comment there');
```

`<` = origin/main, `>` = local working tree.

## mythos/ui/public/js/widgets/kinds/cores.js

```diff
function clear() {
keyedList(list, [], (x) => x, () => h('div'));
}
const cpu = (data && data.cpu) || null;
const perCore = (cpu && Array.isArray(cpu.perCore)) ? cpu.perCore : [];
clear();
keyedList(list, [], (x) => x, () => h('div'));
const cpu = data.cpu || {};
const perCore = Array.isArray(cpu.perCore) ? cpu.perCore : [];
clear();
keyedList(list, [], (x) => x, () => h('div'));
const items = perCore.map((percent, i) => ({ i, percent }));
perCore.map((percent, i) => ({ i, percent })),
items,
```

`<` = origin/main, `>` = local working tree.

## mythos/ui/public/js/widgets/kinds/gpu.js

```diff
let canvas = null;
const canvas = document.createElement('canvas');
canvas = document.createElement('canvas');
```

`<` = origin/main, `>` = local working tree.

## mythos/ui/public/js/widgets/kinds/memory-widget.js

```diff
function clear() {
keyedList(list, [], (x) => x, () => h('div'));
}
clear();
keyedList(list, [], (x) => x, () => h('div'));
clear();
keyedList(list, [], (x) => x, () => h('div'));
```

`<` = origin/main, `>` = local working tree.

## mythos/ui/public/js/widgets/kinds/sensors.js

```diff
if (!Number.isFinite(battery.level)) return UNAVAILABLE;
const pct = `${Math.round(battery.level * 100)}%`;
const pct = Number.isFinite(battery.level) ? `${Math.round(battery.level * 100)}%` : UNAVAILABLE;
if (pct === UNAVAILABLE) return UNAVAILABLE;
```

`<` = origin/main, `>` = local working tree.

## mythos/ui/public/js/widgets/kinds/voice.js

```diff
const hasRecognition = Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
const hasSynthesis = Boolean(w.speechSynthesis);
recognition: (w.SpeechRecognition || w.webkitSpeechRecognition) ? 'available' : UNAVAILABLE,
synthesis: w.speechSynthesis ? 'available' : UNAVAILABLE,
recognition: hasRecognition ? 'available' : UNAVAILABLE,
synthesis: hasSynthesis ? 'available' : UNAVAILABLE,
```

`<` = origin/main, `>` = local working tree.

