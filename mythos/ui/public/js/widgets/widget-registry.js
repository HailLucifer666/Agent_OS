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
];

export function widgetIds() {
  return WIDGETS.map((w) => w.id);
}
