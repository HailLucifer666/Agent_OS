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
  // These shipped defaultHidden on the theory that they were look-it-up
  // instruments and eleven cards already competed for the two gutters. In
  // practice the port read as never delivered: the operator's 2026-08-07
  // session reported the living-core widgets as missing, because a widget
  // nobody knows exists is not discoverable by "open system". Operator
  // decision the same day: show them by default. terminal and aether stay
  // hidden (see their own notes below).
  //
  // POSITIONS COME FROM MEASURED GEOMETRY, NOT FROM THE DECLARED OFFSETS.
  // These first shipped stacked down the two gutters on a 96px step, which
  // looked separated on paper and overlapped badly in a real browser: a
  // .widget-card is min-width:170px but CONTENT-sized above that, and these
  // six render at 164px (system), 349px (cores), 187px (sensors), 133px
  // (voice) tall and 447-640px wide. Rendering them at 1920x1080 is the only
  // thing that showed it.
  //
  // What the measurement also showed: both gutters are already effectively
  // full at 1080p — news alone is a 640x413 card occupying the right gutter
  // from y232 to y645 — so a seventh and eighth gutter card is not available
  // to be had. The three WIDE readouts therefore sit in the empty band left
  // of centre (x320..960) rather than in a 170px gutter they never fit, and
  // the two narrow ones take the real gaps in the left gutter.
  //
  // Tradeoff, stated rather than hidden: the wide cards now come closer to
  // the central orb than the corner-tiles rule prefers. Verified non-
  // overlapping at 1920x1080; at smaller widths they will collide, as the
  // pre-existing eleven already do. Every position is drag-to-taste and the
  // choice persists, so this is a starting layout, not a constraint.
  { id: 'sensors',  title: 'SENSORS',  defaultPos: { left: 320, top: 24 },     mount: mountSensors },
  { id: 'memory',   title: 'MEMORY',   defaultPos: { left: 320, top: 232 },    mount: mountMemoryWidget },
  { id: 'cores',    title: 'CORES',    defaultPos: { left: 320, top: 384 },    mount: mountCores },
  { id: 'gpu',      title: 'GPU',      defaultPos: { left: 320, top: 760 },    mount: mountGpu },
  { id: 'system',   title: 'SYSTEM',   defaultPos: { left: 24, top: 528 },     mount: mountSystem },
  { id: 'voice',    title: 'VOICE',    defaultPos: { left: 24, top: 704 },     mount: mountVoice },
  // Still hidden: a terminal pane is a genuine look-it-up instrument rather
  // than an at-a-glance readout, and it is the one card whose content grows
  // without bound.
  { id: 'terminal', title: 'TERMINAL', defaultPos: { left: 24, top: 672 },     mount: mountTerminal,     defaultHidden: true },
  // Aether-BLE nearest-device chip — opt-in; only meaningful when AETHER_ENABLED
  // and a live aggregator. Hidden by default so a no-Aether setup keeps the
  // gutter uncluttered; toggle via the widget hover control (choice persists).
  { id: 'aether',   title: 'NEAREST DEVICE', defaultPos: { right: 24, top: 624 }, mount: mountAether, defaultHidden: true },
];

export function widgetIds() {
  return WIDGETS.map((w) => w.id);
}
