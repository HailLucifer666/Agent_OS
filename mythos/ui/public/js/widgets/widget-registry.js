// widget-registry.js — declarative widget catalog: {id, title, defaultPos, mount}.
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
// Ported from design/mythos-living-core.html — only the widgets MYTHOS can
// genuinely feed. Its other panels read a hardcoded SIM object that
// random-walks itself to fake liveness; porting those would contradict the
// honest-inert contract in README. Vision/Maps/Files/Email/Calendar/Tasks have
// no backend at all, and Reasoning duplicated tokens.js/spend.js (its other two
// fields — context-window use and chain-of-thought — exist nowhere by design).
import { mountSensors } from './kinds/sensors.js';
import { mountGpu } from './kinds/gpu.js';
import { mountVoice } from './kinds/voice.js';
import { mountTerminal } from './kinds/terminal.js';
import { mountSystem } from './kinds/system.js';
import { mountCores } from './kinds/cores.js';
import { mountMemoryWidget } from './kinds/memory-widget.js';
import { mountAether } from './kinds/aether.js';

// defaultPos: {left|right, top|bottom} offsets in px — corners stay clear of the
// central orb and the radial module ring.
export const WIDGETS = [
  { id: 'clock',     title: 'LOCAL TIME',  defaultPos: { right: 24, top: 24 },     mount: mountClock },
  { id: 'weather',   title: 'WEATHER',     defaultPos: { right: 24, top: 128 },    mount: mountWeather },
  { id: 'agents',    title: 'AGENT ACTIONS', defaultPos: { left: 24, top: 24 },    mount: mountActions },
  { id: 'spend',     title: 'BRAIN SPEND', defaultPos: { left: 24, bottom: 24 },   mount: mountSpend },
  { id: 'tokens',    title: 'TOKEN USAGE', defaultPos: { left: 24, top: 296 },     mount: mountTokens },
  { id: 'wip',       title: 'WORK IN PROGRESS', defaultPos: { right: 24, bottom: 24 }, mount: mountWip },
  { id: 'tick-rate', title: 'TICK RATE',   defaultPos: { left: 24, top: 208 },     mount: mountTickRate },
  { id: 'breakers',  title: 'BREAKERS',    defaultPos: { right: 24, bottom: 168 }, mount: mountBreakers },
  { id: 'news',      title: 'NEWS',        defaultPos: { right: 24, top: 232 },    mount: mountNews },
  { id: 'media',     title: 'NOW PLAYING', defaultPos: { right: 24, bottom: 200 }, mount: mountMedia },
  // /api/status's voiceLatency had no consumer anywhere in ui/ before this —
  // real measured p50/p95 the operator could never see. Bottom-left above
  // BRAIN SPEND, out of the orb's radial ring.
  { id: 'voice-latency', title: 'VOICE LATENCY', defaultPos: { left: 24, bottom: 128 }, mount: mountVoiceLatency },

  // --- Ported from design/mythos-living-core.html ---
  // defaultHidden: these are look-it-up instruments, not permanent-corner
  // tiles. Eleven cards already compete for the two side gutters; adding seven
  // more visible-by-default buried the orb. Reached via voice ("open system")
  // or the hover control like any other widget, and the choice then persists.
  { id: 'system',   title: 'SYSTEM',   defaultPos: { left: 24, top: 384 },     mount: mountSystem,       defaultHidden: true },
  { id: 'cores',    title: 'CORES',    defaultPos: { left: 24, top: 488 },     mount: mountCores,        defaultHidden: true },
  { id: 'gpu',      title: 'GPU',      defaultPos: { left: 200, top: 24 },     mount: mountGpu,          defaultHidden: true },
  { id: 'sensors',  title: 'SENSORS',  defaultPos: { left: 200, top: 128 },    mount: mountSensors,      defaultHidden: true },
  { id: 'voice',    title: 'VOICE',    defaultPos: { left: 200, bottom: 24 },  mount: mountVoice,        defaultHidden: true },
  { id: 'memory',   title: 'MEMORY',   defaultPos: { right: 200, top: 24 },    mount: mountMemoryWidget, defaultHidden: true },
  { id: 'terminal', title: 'TERMINAL', defaultPos: { right: 200, bottom: 24 }, mount: mountTerminal,     defaultHidden: true },
  // Aether-BLE nearest-device chip — opt-in; only meaningful when AETHER_ENABLED
  // and a live aggregator. Hidden by default so a no-Aether setup keeps the
  // gutter uncluttered; toggle via the widget hover control (choice persists).
  { id: 'aether',   title: 'NEAREST DEVICE', defaultPos: { right: 24, top: 320 }, mount: mountAether, defaultHidden: true },
];

export function widgetIds() {
  return WIDGETS.map((w) => w.id);
}
