// widget-registry.js — declarative widget catalog: {id, title, column, mount}.
// mount(el, ctx) -> cleanup; ctx = { subscribe, statsBus } injected by widget-host
// (kinds never import ws.js directly — keeps them pure-importable for node:test).

import { mountClock } from './kinds/clock.js';
import { mountWeather } from './kinds/weather.js';
import { mountActions } from './kinds/actions.js';
import { mountSpend } from './kinds/spend.js';
import { mountWip } from './kinds/wip.js';
import { mountTickRate } from './kinds/tick-rate.js';
import { mountBreakers } from './kinds/breakers.js';
import { mountTokens } from './kinds/tokens.js';
import { mountNews } from './kinds/news.js';
import { mountMedia } from './kinds/media.js';
import { mountVoiceLatency } from './kinds/voice-latency.js';
import { mountVoice } from './kinds/voice.js';
import { mountTerminal } from './kinds/terminal.js';
import { mountSystem } from './kinds/system.js';
import { mountMemoryWidget } from './kinds/memory-widget.js';
import { mountAether } from './kinds/aether.js';

// BUG-176 — POSITIONS ARE COMPUTED, NOT DECLARED.
//
// There is no `defaultPos` here any more. Every position used to be a literal
// px offset, and that could not be made correct: .widget-card is content-sized,
// so real cards render 64-413px tall and 170-640px wide and their height moves
// with live data. A hand-written table looked evenly spaced in source and
// overlapped in the browser. auto-layout.js measures the mounted cards and
// flows them down the two gutters instead; `column` is the only placement
// input, and it is explicit rather than inferred from width so a card can never
// silently change sides when its content changes.
//
// A user's dragged position still wins over all of this, and still persists.
//
// CURATION (operator, 2026-08-07). The previous wave made every ported
// living-core widget visible, which reached 17 cards and buried the orb. The
// operator asked for a smaller, deliberate set: one COMPLETE hardware card,
// weather, the media player, token usage and work-in-progress, plus the
// activity cards; explicitly NOT brain spend and NOT breakers.
//
// SYSTEM is now one card with four sections (host / cores / gpu / device) —
// the old CORES, GPU and SENSORS widgets were four gutter slots answering one
// question, and are folded into it. Their pure exports live on at their own
// paths; only their mount* entry points are gone.
//
// Hidden-by-default widgets are NOT deleted: they are one "open <name>" away by
// voice or the hover control, and that choice persists.
export const WIDGETS = [
  // --- left gutter ---
  { id: 'system',    title: 'SYSTEM',          column: 'left',  mount: mountSystem },
  { id: 'tokens',    title: 'TOKEN USAGE',     column: 'left',  mount: mountTokens },
  { id: 'agents',    title: 'AGENT ACTIONS',   column: 'left',  mount: mountActions },
  { id: 'voice',     title: 'VOICE',           column: 'left',  mount: mountVoice },
  { id: 'wip',       title: 'WORK IN PROGRESS', column: 'left', mount: mountWip },

  // --- right gutter ---
  { id: 'clock',     title: 'LOCAL TIME',      column: 'right', mount: mountClock },
  { id: 'weather',   title: 'WEATHER',         column: 'right', mount: mountWeather },
  { id: 'media',     title: 'NOW PLAYING',     column: 'right', mount: mountMedia },
  { id: 'news',      title: 'NEWS',            column: 'right', mount: mountNews },

  // --- available, not shown by default ---
  // Telemetry the operator does not want on screen by default. Every one is a
  // real, live card — this is a curation choice, not a deprecation.
  { id: 'spend',        title: 'BRAIN SPEND',   column: 'left',  mount: mountSpend,        defaultHidden: true },
  { id: 'breakers',     title: 'BREAKERS',      column: 'right', mount: mountBreakers,     defaultHidden: true },
  { id: 'tick-rate',    title: 'TICK RATE',     column: 'left',  mount: mountTickRate,     defaultHidden: true },
  { id: 'voice-latency', title: 'VOICE LATENCY', column: 'left', mount: mountVoiceLatency, defaultHidden: true },
  { id: 'memory',       title: 'MEMORY',        column: 'right', mount: mountMemoryWidget, defaultHidden: true },
  // Unbounded content — a log tail is a look-it-up instrument, not a glanceable
  // readout.
  { id: 'terminal',     title: 'TERMINAL',      column: 'left',  mount: mountTerminal,     defaultHidden: true },
  // Opt-in: only meaningful with AETHER_ENABLED and a live aggregator.
  { id: 'aether',       title: 'NEAREST DEVICE', column: 'right', mount: mountAether,      defaultHidden: true },
];

export function widgetIds() {
  return WIDGETS.map((w) => w.id);
}
