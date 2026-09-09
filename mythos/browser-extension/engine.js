(function (root) {
  'use strict';
  // Fixed code runs in a CDP isolated world. Page scripts never receive commands,
  // task IDs, provider credentials, or access to the observation's node map.
  function snapshot(observationId) {
    const nodes = new Map(), refs = new Map();
    const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
    const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const videoId = href => { try { const u = new URL(href); return /(^|\.)youtube\.com$/.test(u.hostname) ? (u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null)) : u.hostname === 'youtu.be' ? u.pathname.slice(1) : null; } catch { return null; } };
    const targets = [], items = [], seen = new Set();
    for (const el of document.querySelectorAll('a[href],button,[role="button"],input,select,textarea,video')) {
      if (!visible(el) || targets.length >= 300) continue;
      const ref = 'e' + targets.length, text = label(el), href = el.href || null;
      nodes.set(ref, { el, text, href });
      refs.set(el, ref);
      targets.push({ ref, targetId: ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), label: text, href });
    }
    // A watch-link is not a ranked result: navigation, ads and Shorts also link
    // to videos. Rank only observed normal cards in one relevant list region.
    const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
    const roots = youtube ? [...document.querySelectorAll('ytd-search,ytd-browse[page-subtype="home"] ytd-rich-grid-renderer')].filter(visible) : [];
    const ambiguous = roots.length !== 1;
    // BUG-417 (2026-09-09): rank EVERY card in the region, not only the ones in
    // the viewport.
    //
    // Before this, the card loop required visible(card) and refs.has(el) — and
    // `refs` only holds elements the targets loop above accepted, which also
    // requires visible(). So the list handed to the controller was viewport-only
    // and `ordinal` indexed into it. Two consequences, both measured by reading
    // this code against the tool description shipped the same day: a search page
    // shows roughly four or five cards, so "play the sixth result" polled until
    // the observation budget ran out and blocked — honestly, but for a reason the
    // operator reads as a bug, since the tool advertises 1 through 20. And on an
    // already-scrolled page "the second video" selected the second card CURRENTLY
    // IN VIEW, which might be result seven; verification could never catch that,
    // because the expected identity is derived from the same observation that
    // made the wrong choice.
    //
    // An off-screen card is now ranked with `ref: null` plus `visible:false` and
    // its `top` offset, so the controller can scroll to reveal it. A null ref is
    // structurally unclickable: `actOnNode` looks the ref up in `nodes`, which
    // only ever contains visible elements, and additionally refuses any target
    // whose rect is outside the viewport. Making the bad state unrepresentable
    // rather than merely detectable — the ordinal can name a card that cannot yet
    // be clicked, and there is no path that clicks it anyway.
    if (!ambiguous) for (const card of roots[0].querySelectorAll('ytd-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer')) {
      if (card.closest('ytd-ad-slot-renderer,ytd-promoted-video-renderer,ytd-display-ad-renderer,ytd-in-feed-ad-layout-renderer,[is-ad]') || card.querySelector('[class*="badge-style-type-ad"],[aria-label="Sponsored"],[aria-label="Ad"]')) continue;
      const el = card.querySelector('a#video-title[href],a#video-title-link[href]');
      if (!el || /\/shorts\//.test(el.href)) continue;
      const id = videoId(el.href), text = label(el);
      if (!id || !text || seen.has(id)) continue;
      // A card whose renderer has not laid out yet has no position worth
      // reporting; it is still ranked so the ordinal stays stable as the page
      // fills in, which is the whole point of ranking beyond the fold.
      const rect = card.getBoundingClientRect();
      const onScreen = refs.has(el) && visible(card);
      seen.add(id);
      items.push({ ref: onScreen ? refs.get(el) : null, videoId: id, title: text, href: el.href,
        ordinal: items.length + 1, visible: onScreen, top: Math.round(rect.top) });
    }
    globalThis.__mythosObservation = { observationId, nodes };
    return { url: location.href, title: document.title, targets, items, ambiguous,
      ambiguityReason: ambiguous ? 'No single visible supported YouTube result region; do not choose an ordinal from generic links' : null };
  }
  function playback() {
    const v = [...document.querySelectorAll('video')].find(el => el.getBoundingClientRect().width > 0) || document.querySelector('video');
    const u = new URL(location.href), youtube = /(^|\.)youtube\.com$/.test(u.hostname);
    return { url: location.href, title: document.title, videoId: youtube ? (u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null)) : null,
      paused: v ? v.paused : null, currentTime: v && Number.isFinite(v.currentTime) ? v.currentTime : null,
      duration: v && Number.isFinite(v.duration) ? v.duration : null, ended: v ? v.ended : null,
      ad: youtube ? !!document.querySelector('.html5-video-player.ad-showing,.html5-video-player.ad-interrupting') : null };
  }
  function actOnNode(observationId, ref) {
    if (globalThis.__mythosTakenOver) throw Error('User took control of this tab');
    const store = globalThis.__mythosObservation;
    if (!store || store.observationId !== observationId) throw Error('Stale observation');
    const item = store.nodes.get(ref); if (!item || !item.el.isConnected) throw Error('Observed target disappeared');
    const el = item.el;
    const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if ((el.href || null) !== item.href || text !== item.text) throw Error('Observed target changed identity');
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.top < 0 || r.bottom > innerHeight) throw Error('Observed target is no longer visible; observe after scrolling');
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) throw Error('Observed target is obscured');
    // Atomic identity check and DOM activation; provider state readback, not this
    // delivery result, determines whether the requested action took effect.
    el.click(); return { commandAccepted: true };
  }
  async function mediaAction(action) {
    if (globalThis.__mythosTakenOver) throw Error('User took control of this tab');
    const v = [...document.querySelectorAll('video')].find(el => el.getBoundingClientRect().width > 0) || document.querySelector('video');
    if (action === 'next') {
      if (!/(^|\.)youtube\.com$/.test(location.hostname)) throw Error('No observed next-video control for this site');
      const button = document.querySelector('.ytp-next-button');
      if (!button || !button.getBoundingClientRect().width || button.getAttribute('aria-disabled') === 'true') throw Error('Next-video control unavailable');
      button.click();
    } else {
      if (!v) throw Error('No video player in selected frame');
      if (action === 'pause') v.pause(); else if (action === 'play' || action === 'resume') await v.play(); else throw Error('Unsupported media action');
    }
    return { commandAccepted: true };
  }
  function installTakeoverWatcher(nonce) {
    const old = globalThis.__mythosTakeoverWatcher;
    if (old?.nonce === nonce) return;
    if (old) for (const type of ['pointerdown', 'keydown', 'wheel']) document.removeEventListener(type, old.listener, true);
    globalThis.__mythosTakenOver = false;
    const listener = event => {
      if (!event.isTrusted || globalThis.__mythosTakenOver) return;
      globalThis.__mythosTakenOver = true;
      globalThis.__mythosOperatorInput(JSON.stringify({ inputType: event.type }));
    };
    globalThis.__mythosTakeoverWatcher = { nonce, listener };
    for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, listener, true);
  }
  function createExtensionEngine(chrome, { notify = () => {}, uuid = () => crypto.randomUUID() } = {}) {
    const states = new Map(), cancelled = new Set(), cancelling = new Map(); let browserId = null;
    const invalidate = (tabId, reason) => { const s = states.get(tabId); if (s) { s.generation++; s.observationId = null; } notify({ type: 'invalidated', tabId, reason }); };
    chrome.debugger.onDetach.addListener((source, reason) => {
      const state = states.get(source.tabId);
      if (state && reason === 'canceled_by_user') cancelled.add(state.taskId);
      invalidate(source.tabId, 'debugger detached'); states.delete(source.tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method === 'Page.frameNavigated' && !params.frame.parentId || method === 'Page.navigatedWithinDocument') invalidate(source.tabId, 'navigation');
      if (method === 'Runtime.bindingCalled' && params.name === '__mythosOperatorInput') {
        const state = states.get(source.tabId);
        if (!state || params.executionContextId !== state.contextId) return;
        let input; try { input = JSON.parse(params.payload); } catch { return; }
        if (!['pointerdown', 'keydown', 'wheel'].includes(input.inputType)) return;
        notify({ type: 'user-takeover', taskId: state.taskId, tabId: source.tabId, inputType: input.inputType }); void cancel(state.taskId);
      }
    });
    chrome.tabs.onRemoved.addListener(tabId => { invalidate(tabId, 'tab closed'); states.delete(tabId); });
    function live(taskId, state) { if (cancelled.has(taskId) || (state && (states.get(state.tabId) !== state || state.taskId !== taskId))) throw Error('Task cancelled, ownership changed or debugger detached'); }
    async function send(state, taskId, method, params = {}) { live(taskId, state); const result = await chrome.debugger.sendCommand({ tabId: state.tabId }, method, params); live(taskId, state); return result; }
    async function evaluate(state, taskId, fn, args = []) {
      const result = await send(state, taskId, 'Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + args.map(x => JSON.stringify(x)).join(',') + ')', contextId: state.contextId, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page operation failed');
      return result.result?.value;
    }
    async function attach(tabId, taskId) {
      let state = states.get(tabId);
      if (!state) {
        await chrome.debugger.attach({ tabId }, '1.3');
        if (cancelled.has(taskId)) { await chrome.debugger.detach({ tabId }); throw Error('Task cancelled during attach'); }
        state = { tabId, generation: 0, observationId: null, taskId, nonce: uuid() }; states.set(tabId, state);
        await send(state, taskId, 'Page.enable');
        await send(state, taskId, 'Runtime.enable');
      }
      if (state.taskId !== taskId) { invalidate(tabId, 'new task ownership'); state.taskId = taskId; }
      return state;
    }
    async function documentFor(state, taskId) {
      const tree = await send(state, taskId, 'Page.getFrameTree'); return tree.frameTree.frame;
    }
    async function execute(operation, args, taskId) {
      if (operation === 'resumeTask') { await cancelling.get(taskId); cancelled.delete(taskId); return { resumed: true }; }
      live(taskId); if (!browserId) throw Error('Native bridge not connected');
      if (operation === 'tabs') return { tabs: (await chrome.tabs.query({})).filter(t => !t.incognito).map(t => ({ tabId: t.id, frameId: 0, url: t.url || '', title: t.title || '', active: t.active })) };
      if (operation === 'createTab') {
        if (args.browserId !== browserId) throw Error('Wrong browser instance');
        const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('New tab requires a credential-free HTTP(S) URL');
        live(taskId); const tab = await chrome.tabs.create({ url: url.href, active: true });
        return { browserId, tabId: tab.id, frameId: 0, url: tab.url || url.href, title: tab.title || '', active: true, target: { browserId, tabId: tab.id, frameId: 0 } };
      }
      const target = args.target || args;
      if (target.browserId !== browserId || !Number.isInteger(target.tabId) || target.frameId !== 0) throw Error('Wrong browser/tab/frame; nested frames require separate support');
      const tab = await chrome.tabs.get(target.tabId);
      if (tab.incognito || !/^https?:\/\//i.test(tab.url || '')) throw Error('Only explicitly selected non-incognito HTTP(S) tabs are supported');
      const observing = operation === 'observe' || operation === 'videoList';
      if (!observing && !states.has(target.tabId)) throw Error('Debugger detached; explicit fresh observation required');
      const state = observing ? await attach(target.tabId, taskId) : states.get(target.tabId);
      const frame = await documentFor(state, taskId);
      if (operation === 'observe' || operation === 'videoList') {
        state.documentId = frame.loaderId; state.url = frame.url;
        const world = await send(state, taskId, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'mythos-browser-operator', grantUniveralAccess: false });
        state.contextId = world.executionContextId; state.generation++; state.observationId = uuid();
        await send(state, taskId, 'Runtime.addBinding', { name: '__mythosOperatorInput', executionContextId: state.contextId });
        await evaluate(state, taskId, installTakeoverWatcher, [state.nonce]);
        const generation = state.generation, observationId = state.observationId;
        const result = await evaluate(state, taskId, snapshot, [observationId]);
        const player = await evaluate(state, taskId, playback);
        if (generation !== state.generation) throw Error('Document changed during observation');
        const capsule = { browserId, tabId: target.tabId, frameId: 0, documentId: frame.loaderId, url: result.url, observationId, generation };
        state.url = result.url; return { ...result, videos: result.items, playback: player, target: capsule };
      }
      if (state.taskId !== taskId || state.observationId !== target.observationId || state.generation !== target.generation || frame.loaderId !== target.documentId || frame.url !== target.url) throw Error('Stale task/document/observation; observe again');
      if (operation === 'playbackState' || operation === 'mediaState') return { playback: await evaluate(state, taskId, playback), target };
      let result;
      if (operation === 'navigate') {
        const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Navigation requires a credential-free HTTP(S) URL');
        await evaluate(state, taskId, function () { if (globalThis.__mythosTakenOver) throw Error('User took control of this tab'); });
        result = await send(state, taskId, 'Page.navigate', { url: url.href }); if (result.errorText) throw Error(result.errorText);
      } else if (operation === 'selectTab') { live(taskId, state); await chrome.tabs.update(target.tabId, { active: true }); result = {}; }
      else if (operation === 'click') result = await evaluate(state, taskId, actOnNode, [target.observationId, args.ref || args.targetId]);
      else if (operation === 'scroll') {
        if (!Number.isFinite(args.deltaY) || Math.abs(args.deltaY) > 3000) throw Error('Scroll delta must be bounded to 3000 pixels');
        result = await evaluate(state, taskId, function (delta) { if (globalThis.__mythosTakenOver) throw Error('User took control of this tab'); scrollBy(0, delta); return { commandAccepted: true }; }, [args.deltaY]);
      } else result = await evaluate(state, taskId, mediaAction, [operation === 'mediaControl' ? args.action : operation]);
      invalidate(target.tabId, 'action consumed observation'); return { commandAccepted: true, delivery: result };
    }
    function cancel(taskId) {
      cancelled.add(taskId);
      const detach = [];
      for (const [tabId, state] of states) if (state.taskId === taskId) { invalidate(tabId, 'task cancelled'); states.delete(tabId); detach.push(chrome.debugger.detach({ tabId }).catch(() => {})); }
      const done = Promise.all(detach); cancelling.set(taskId, done); return done;
    }
    return { execute, cancel, welcome: id => { browserId = id; }, disconnect: async () => { for (const state of [...states.values()]) await cancel(state.taskId); browserId = null; } };
  }
  if (typeof module !== 'undefined') module.exports = { createExtensionEngine, snapshot, playback, actOnNode };
  else root.MythosBrowserEngine = { createExtensionEngine };
})(globalThis);
