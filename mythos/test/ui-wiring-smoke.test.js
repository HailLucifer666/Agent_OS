'use strict';
// test/ui-wiring-smoke.test.js — the HONEST CEILING for the browser-shell
// halves of three newly-wired features (S2S bridge, voice-latency tile, PIN
// lock screen). There is no browser, no microphone and no speaker in this
// environment, so this file asserts EXACTLY these things and nothing more:
//
//   1. every module in the new import chain parses and evaluates under Node;
//   2. no undefined symbol is referenced at MODULE SCOPE (an evaluation-time
//      typo — the single most likely way this wiring breaks silently, since a
//      broken ES-module import aborts app.js's entire boot);
//   3. the exported factories exist with the expected arity/shape.
//
// This is NOT end-to-end verification. It does not prove a live-open frame
// ever reaches the server, that any audio is captured or played, that the
// latency tile paints, or that the lock overlay traps focus. Those require a
// human at a real browser — see the report accompanying this change.
//
// Method: node:test + dynamic import(), the pattern already used by
// test/voice-barge-in-decision.test.js and test/pcm-resample.test.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const PUBLIC_JS = path.join(__dirname, '..', 'ui', 'public', 'js');
const url = (...parts) => pathToFileURL(path.join(PUBLIC_JS, ...parts)).href;

// s2s-bridge.js and pin-lock-screen.js reach for browser globals *inside*
// their functions, but their import chain (ws.js, focus-trap.js) evaluates at
// module scope. ws.js declares module-scope state only — no `location`/
// `WebSocket` access until connect() runs — and focus-trap.js only declares a
// selector string. These two stubs exist purely so that if either file ever
// grows a module-scope browser access, THIS test fails loudly instead of the
// real HUD failing silently at boot.
// Only keys this file actually assigns are recorded, so teardown never tries
// to write back a getter-only host global (globalThis.navigator is one).
const installed = [];

function stub(key, value) {
  if (globalThis[key] !== undefined) return;
  globalThis[key] = value;
  installed.push(key);
}

before(() => {
  stub('window', {});
  stub('document', {
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    getElementById: () => null, activeElement: null,
    createElement: () => ({
      style: {}, classList: { toggle() {}, add() {} }, setAttribute() {},
      appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    }),
    createTextNode: (s) => ({ nodeValue: s }),
  });
});

after(() => {
  while (installed.length) delete globalThis[installed.pop()];
});

// Strip comments before scanning source for forbidden APIs — the point of
// those assertions is what the CODE does, and a header comment that says
// "never uses localStorage" must not read as a violation of itself.
function codeOnly(file) {
  return require('fs').readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// app.js itself cannot be imported here — its chain (hud-canvas.js, core-orb.js,
// compose-bar.js …) touches document/canvas at construction time. What CAN be
// checked, statically and cheaply, is the one failure mode that would abort the
// entire HUD boot with a blank screen: a static import in app.js naming a file
// that isn't there, or a binding that module doesn't export.
describe('app.js static import chain resolves (guards a blank-screen boot)', () => {
  const fs = require('fs');
  const APP = path.join(PUBLIC_JS, 'app.js');

  function staticImports(file) {
    const src = codeOnly(file);
    const out = [];
    const re = /import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s+'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const named = (m[1] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      out.push({ names: m[2] ? [] : named, spec: m[3], defaultName: m[2] || null });
    }
    return out;
  }

  it('every statically imported file exists on disk', () => {
    const imports = staticImports(APP);
    assert.ok(imports.length >= 10, `expected app.js to have many static imports, found ${imports.length}`);
    imports.forEach(({ spec }) => {
      assert.ok(spec.startsWith('./'), `unexpected non-relative specifier ${spec}`);
      const target = path.join(PUBLIC_JS, spec);
      assert.ok(fs.existsSync(target), `app.js imports '${spec}' but ${target} does not exist`);
    });
  });

  it('every named binding app.js imports is actually exported by the target module', () => {
    staticImports(APP).forEach(({ names, spec }) => {
      if (!names.length) return;
      const src = codeOnly(path.join(PUBLIC_JS, spec));
      names.forEach((name) => {
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`).test(src)
          || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(src);
        assert.ok(exported, `app.js imports { ${name} } from '${spec}', which does not export it`);
      });
    });
  });

  it('the three newly wired entry points are present in app.js', async () => {
    const src = codeOnly(APP);
    assert.match(src, /decideVoiceTransport/, 'S2S transport routing must be wired');
    assert.match(src, /import\('\.\/voice\/s2s-bridge\.js'\)/, 'the S2S bridge must be lazily imported');
    assert.match(src, /voiceConfiguration\.subscribe\(/, 'app must consume shared authenticated voice facts');
    assert.match(src, /_s2sEnabled\s*=\s*Boolean\(s2s\.value\s*&&\s*s2s\.value\.enabled\)/,
      'the shared S2S flag must drive transport selection');
    assert.match(src, /voiceConfiguration\.refresh\(/, 'app must request shared voice facts');
    const { createVoiceConfigStore } = await import(url('voice', 'voice-config.js'));
    const fetched = [];
    await createVoiceConfigStore(async endpoint => {
      fetched.push(endpoint);
      return { ok: true, json: async () => ({ enabled: true }) };
    }).refresh();
    assert.ok(fetched.includes('/api/config/s2s'), 'the shared loader must fetch VOICE_S2S_ENABLED');
    assert.match(src, /mountPinLockScreen\(/, 'the PIN lock screen must be mounted');
  });

  it('index.html loads app.js and provides the pin-root the lock screen mounts into', () => {
    const html = fs.readFileSync(path.join(PUBLIC_JS, '..', 'index.html'), 'utf8');
    assert.match(html, /src="\/js\/app\.js"/);
    assert.match(html, /id="pin-root"/);
    assert.match(html, /href="\/css\/pin\.css"/);
  });
});

describe('S2S bridge module chain (ceiling: imports + constructs, NOT verified in a browser)', () => {
  it('s2s-bridge.js evaluates and exports createS2SBridge', async () => {
    const mod = await import(url('voice', 's2s-bridge.js'));
    assert.equal(typeof mod.createS2SBridge, 'function');
  });

  it('createS2SBridge() constructs its API without touching the mic', async () => {
    const { createS2SBridge } = await import(url('voice', 's2s-bridge.js'));
    const bridge = createS2SBridge({ onState() {}, onCaption() {} });
    ['start', 'stop', 'isActive', 'isSpeaking'].forEach((k) => {
      assert.equal(typeof bridge[k], 'function', `bridge.${k} must exist`);
    });
    // Construction alone must not have opened anything.
    assert.equal(bridge.isActive(), false);
    assert.equal(bridge.isSpeaking(), false);
  });

  it('voice-transport.js — the module app.js imports statically — evaluates and exports the decision fn', async () => {
    const mod = await import(url('voice', 'voice-transport.js'));
    assert.equal(typeof mod.decideVoiceTransport, 'function');
  });

  it('the capture worklet the bridge loads at runtime is actually present on disk at the served path', async () => {
    // s2s-bridge.js calls audioWorklet.addModule('/js/voice/pcm-capture-worklet.js');
    // a missing file there is a runtime-only failure no import test would catch.
    const fs = require('fs');
    const worklet = path.join(PUBLIC_JS, 'voice', 'pcm-capture-worklet.js');
    assert.ok(fs.statSync(worklet).size > 0, 'pcm-capture-worklet.js must exist and be non-empty');
  });
});

describe('voice-latency tile module chain (ceiling: imports + registry shape)', () => {
  it('voice-latency.js evaluates and exports mountVoiceLatency', async () => {
    const mod = await import(url('widgets', 'kinds', 'voice-latency.js'));
    assert.equal(typeof mod.mountVoiceLatency, 'function');
  });

  it('widget-registry.js still evaluates with the new tile, and the tile is registered exactly once', async () => {
    const { WIDGETS, widgetIds } = await import(url('widgets', 'widget-registry.js'));
    const ids = widgetIds();
    assert.equal(ids.filter((id) => id === 'voice-latency').length, 1);
    assert.equal(ids.length, new Set(ids).size, 'no duplicate widget ids');
    const tile = WIDGETS.find((w) => w.id === 'voice-latency');
    assert.equal(tile.title, 'VOICE LATENCY');
    assert.equal(typeof tile.mount, 'function');
    // BUG-176: defaultPos replaced by a column hint (auto-layout.js computes
    // the position from the card's measured size).
    assert.ok(['left', 'right'].includes(tile.column));
  });

  it('the tile id matches manage_widget\'s server-side BOOT_WIDGET_IDS (voice control stays in sync)', async () => {
    const { widgetIds } = await import(url('widgets', 'widget-registry.js'));
    const src = require('fs').readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-widgets.js'), 'utf8');
    const line = /const BOOT_WIDGET_IDS = \[([^\]]*)\]/.exec(src);
    assert.ok(line, 'BOOT_WIDGET_IDS must still be a flat literal array');
    const bootIds = line[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual(bootIds.slice().sort(), widgetIds().slice().sort(),
      'from-widgets.js BOOT_WIDGET_IDS and widget-registry.js must list the same ids');
  });
});

describe('PIN lock screen module chain (ceiling: imports + reuses the shared focus trap)', () => {
  it('pin-lock-screen.js evaluates and exports mountPinLockScreen', async () => {
    const mod = await import(url('pin', 'pin-lock-screen.js'));
    assert.equal(typeof mod.mountPinLockScreen, 'function');
  });

  it('pin-gate.js evaluates and exports all three decisions', async () => {
    const mod = await import(url('pin', 'pin-gate.js'));
    ['derivePinGate', 'interpretVerifyResponse', 'validatePinInput'].forEach((k) => {
      assert.equal(typeof mod[k], 'function', `${k} must be exported`);
    });
  });

  it('reuses the existing a11y/focus-trap.js helper instead of hand-rolling a new trap', () => {
    const src = codeOnly(path.join(PUBLIC_JS, 'pin', 'pin-lock-screen.js'));
    assert.match(src, /from '\.\.\/a11y\/focus-trap\.js'/);
    assert.match(src, /trapFocus\(/);
    // A lock screen must not be dismissible with Escape.
    assert.equal(/onEscape:/.test(src), false, 'the lock screen must not wire an Escape dismissal');
  });

  it('never persists the PIN client-side', () => {
    const src = codeOnly(path.join(PUBLIC_JS, 'pin', 'pin-lock-screen.js'));
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), false,
      'the entered PIN (or an unlock flag) must never be stored client-side');
  });

  it('mountPinLockScreen() with an injected fetch does NOT lock when no PIN is configured', async () => {
    const { mountPinLockScreen } = await import(url('pin', 'pin-lock-screen.js'));
    const calls = [];
    const fetchImpl = async (path_) => {
      calls.push(path_);
      return { ok: true, status: 200, json: async () => ({ configured: false, hasWindowsHello: false }) };
    };
    const root = { appendChild() { throw new Error('must not paint an overlay when no PIN is configured'); } };
    const screen = mountPinLockScreen(root, { fetchImpl });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['/api/pin/status']);
    assert.equal(screen.isLocked(), false);
    screen.cleanup();
  });
});
