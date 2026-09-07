'use strict';
const { parseRequest } = require('./intent');
const clone = (value) => JSON.parse(JSON.stringify(value));
const youtube = (url) => { try { const h = new URL(url).hostname; return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be'; } catch (_) { return false; } };

// executeTool is supplied by the composition root: every leaf checks the current
// leash then shared dispatchAction. No browser adapter or hub is reachable here.
function createDesktopController({ goals, executeTool, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!goals || typeof executeTool !== 'function') throw new Error('Desktop controller requires goals and authorized executeTool');
  const running = new Map();
  const latest = new Map(), connections = new Map(), disconnected = new Set();
  function record(id) { const e = goals.get(id)?.execution; return e?.owner === 'desktop' && e.version === 1 && ['open-youtube', 'play-third', 'pause', 'resume', 'next'].includes(e.intent?.kind) && Number.isInteger(e.steps) ? e : null; }
  function save(id, patch) {
    const e = record(id);
    if (!e) throw new Error('Desktop task no longer exists');
    const next = { ...e, ...patch, updatedAt: now() };
    goals.update(id, { execution: next, status: next.state === 'completed' ? 'done' : next.state === 'running' ? 'active' : 'paused' });
    return next;
  }
  function status({ taskId } = {}, ctx = {}) {
    if (!ctx.connectionId || ctx.connectionId === 'system' || disconnected.has(ctx.connectionId)) return { ok: false, result: 'A current operator connection is required' };
    const recoverable = id => record(id) && !connections.has(id) && !['completed', 'cancelled'].includes(record(id).state);
    const candidate = !taskId && !latest.has(ctx.connectionId) ? goals.list().filter(g => recoverable(g.id)).sort((a, b) => (b.execution.updatedAt || b.updatedAt || 0) - (a.execution.updatedAt || a.updatedAt || 0))[0] : null;
    const id = taskId || latest.get(ctx.connectionId) || candidate?.id, e = record(id);
    const unowned = recoverable(id);
    if (connections.get(id) !== ctx.connectionId && !unowned) return { ok: false, result: 'Task belongs to another connection or requires explicit restart resume' };
    if (!e) return { ok: false, result: 'Desktop task not found' };
    const snapshot = clone(e);
    if (unowned || (!running.has(id) && snapshot.state === 'running')) { snapshot.state = 'paused'; snapshot.reason = 'Restart recovery requires explicit resume and fresh observation'; snapshot.requiresResume = true; }
    return { ok: true, result: { taskId: id, request: goals.get(id).title, ...snapshot } };
  }
  function stopError(message, unknown = false) { return Object.assign(new Error(message), { unknown }); }
  async function run(id, ctx, owner) {
    const live = () => running.get(id) === owner && !owner.abort.signal.aborted && record(id)?.state === 'running';
    const check = () => {
      if (!live()) throw stopError('Execution paused or cancelled', owner.writing);
      const e = record(id), g = goals.get(id);
      if (e.steps >= 16 || now() - owner.startedAt > 30000 || g.spent.actions >= g.budget.actions || g.spent.tokens >= g.budget.tokens) throw stopError('Desktop task budget exhausted');
    };
    async function leaf(name, args, writing = false) {
      check();
      save(id, { steps: record(id).steps + 1, lastTool: name });
      owner.writing = writing;
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(stopError('Execution paused or cancelled', writing));
        owner.abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      let result;
      try { result = await Promise.race([executeTool(name, args, { goalId: id, connectionId: ctx.connectionId, signal: owner.abort.signal }), aborted]); }
      finally { owner.abort.signal.removeEventListener('abort', onAbort); }
      check();
      owner.writing = false;
      if (!result || result.ok !== true || result.unverified || result.abortedInFlight || result.confirmPending) {
        throw stopError(result?.reason || result?.error || (typeof result?.result === 'string' ? result.result : 'Leaf outcome unavailable or unverified'), writing && !result?.notExecuted);
      }
      return result.result;
    }
    async function observe(target) {
      let error;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const o = await leaf('browser_video_list', { browserId: target.browserId, tabId: target.tabId, frameId: 0 });
          if (!o?.target?.observationId || !youtube(o.target.url)) throw stopError('Fresh YouTube observation unavailable');
          save(id, { target: o.target, observation: { at: now(), url: o.target.url, playback: o.playback } });
          return o;
        } catch (e) { error = e; if (!live()) throw e; }
      }
      throw error;
    }
    // Loading observations are pending readiness, not failed steps. Poll reads
    // within existing budgets; observe() retains two recovery attempts per failure.
    async function readiness(target, initial, ready, reason, unknown = false) {
      let o = initial, delay = 300;
      while (true) {
        check();
        if (o && ready(o)) return o;
        if (record(id).steps >= 15 || now() - owner.startedAt + delay >= 30000) throw stopError(reason, unknown);
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(stopError('Execution paused or cancelled', unknown));
          owner.abort.signal.addEventListener('abort', onAbort, { once: true });
        });
        try { await Promise.race([wait(delay), aborted]); }
        finally { owner.abort.signal.removeEventListener('abort', onAbort); }
        check();
        o = await observe(target);
        delay = Math.min(delay * 2, 1500);
      }
    }
    try {
      let e = record(id), target = e.target;
      if (!target) {
        const tabs = await leaf('browser_tabs', {});
        const all = Array.isArray(tabs) ? tabs : tabs?.tabs || [];
        const available = all.filter((t) => youtube(t.url));
        const active = available.filter((t) => t.active);
        target = active.length === 1 ? active[0] : available.length === 1 ? available[0] : null;
        if (!target && !available.length) {
          const primary = all.filter((t) => t.active);
          if (primary.length !== 1 || !primary[0].browserId) throw stopError('Select one primary browser session before starting this task');
          save(id, { phase: 'acting', expected: null });
          const opened = await leaf('browser_tabs', { action: 'new', browserId: primary[0].browserId, url: 'https://www.youtube.com/' }, true);
          target = opened?.target || opened?.tab || opened;
          if (!target?.browserId || target.tabId == null) throw stopError('New YouTube tab identity was not returned', true);
          save(id, { phase: 'observing', target });
        }
        if (!target) throw stopError('Select one YouTube tab before starting this task');
      }
      let o = await observe(target);
      e = record(id);
      if (e.intent.kind === 'open-youtube') {
        save(id, { state: 'completed', phase: 'done', evidence: { oracle: 'page-state', observed: { url: o.target.url, tabId: o.target.tabId }, at: now() }, reason: 'YouTube page independently observed' }); return;
      }
      // A persisted write may have landed before shutdown. Resume only observes;
      // it never repeats a click/next whose outcome was not recorded.
      const recovering = e.phase === 'acting' || e.phase === 'verifying';
      let expected = e.expected;
      if (!recovering) {
        if (e.intent.query) {
          save(id, { phase: 'acting', expected: null });
          await leaf('browser_navigate', { target: o.target, url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(e.intent.query) }, true);
          o = await observe(target);
        }
        const before = o.playback || {};
        if (e.intent.kind === 'play-third') {
          o = await readiness(target, o, (current) => {
            if (current.ambiguous === true) throw stopError('More than one visible video list; select the intended list first');
            return Boolean(current.items?.[2]?.ref && current.items[2].videoId);
          }, 'Three playable results did not become ready within the observation budget');
          const item = o.items[2];
          expected = { kind: 'playing', videoId: item.videoId };
          save(id, { phase: 'acting', expected });
          await leaf('browser_click', { target: o.target, ref: item.ref }, true);
        } else {
          if (!before.videoId || before.ad !== false) throw stopError('Current non-ad video identity is unavailable');
          expected = { kind: e.intent.kind === 'pause' ? 'paused' : 'playing', videoId: e.intent.kind === 'next' ? null : before.videoId, previousVideoId: before.videoId };
          save(id, { phase: 'acting', expected });
          await leaf('browser_media_control', { target: o.target, action: e.intent.kind }, true);
        }
      }
      if (!expected) throw stopError('Interrupted navigation has unknown outcome; start a new explicit task', true);
      save(id, { phase: 'verifying' });
      let previous = null;
      o = await readiness(target, await observe(target), (current) => {
        const p = current.playback || {};
        const identity = expected.videoId ? p.videoId === expected.videoId : p.videoId && p.videoId !== expected.previousVideoId;
        const proved = identity && p.ad === false && (expected.kind === 'paused' ? p.paused === true :
          p.paused === false && previous?.videoId === p.videoId && p.currentTime > previous.currentTime);
        previous = p;
        return proved;
      }, 'Requested player state did not become ready within the observation budget; action will not be repeated', true);
      save(id, { state: 'completed', phase: 'done', evidence: { oracle: 'page-state', observed: o.playback, at: now() }, reason: 'Requested player state independently observed' });
    } catch (error) {
      if (live()) save(id, { state: 'blocked', reason: error.message, unknownWrite: Boolean(error.unknown), phase: error.unknown ? 'verifying' : record(id).phase });
    } finally { clearTimeout(owner.timer); if (running.get(id) === owner) running.delete(id); }
  }
  function launch(id, ctx) {
    const owner = { abort: new AbortController(), startedAt: now(), writing: false };
    running.set(id, owner);
    owner.timer = setTimeout(() => {
      if (running.get(id) !== owner) return;
      save(id, { state: 'blocked', reason: 'Desktop task wall-clock budget exhausted', unknownWrite: owner.writing, phase: owner.writing ? 'verifying' : record(id).phase });
      owner.abort.abort();
    }, 30000);
    owner.promise = Promise.resolve().then(() => run(id, ctx, owner));
  }
  function start({ request } = {}, ctx = {}) {
    if (!ctx.connectionId || ctx.connectionId === 'system' || disconnected.has(ctx.connectionId)) return { ok: false, result: 'A current operator connection is required' };
    if (ctx.requestId !== undefined && (typeof ctx.requestId !== 'string' || !ctx.requestId.trim() || ctx.requestId.length > 160)) return { ok: false, result: 'Request identity must be a nonempty string of at most 160 characters', notExecuted: true };
    if (ctx.requestId) {
      const existing = goals.list().find(g => g.execution?.owner === 'desktop' && g.execution.requestId === ctx.requestId);
      if (existing) return { ok: false, result: 'Request already belongs to desktop task ' + existing.id + '; inspect or explicitly resume that task', taskId: existing.id, notExecuted: true };
    }
    if (running.size) return { ok: false, result: 'Pause or cancel the current desktop task first' };
    const previous = record(latest.get(ctx.connectionId));
    const intent = parseRequest(request, Boolean(previous?.target));
    if (!intent) return { ok: false, result: 'Stage 1 supports only YouTube third-result playback, pause, resume, or next video' };
    const execution = { version: 1, owner: 'desktop', state: 'running', phase: 'observing', intent, steps: 0, target: intent.kind !== 'play-third' || intent.contextual ? previous?.target || null : null, observation: null, evidence: null, createdAt: now(), updatedAt: now() };
    if (ctx.requestId) execution.requestId = ctx.requestId;
    const goal = goals.create({ title: request, status: 'active', execution, budget: { actions: 16 } });
    latest.set(ctx.connectionId, goal.id); connections.set(goal.id, ctx.connectionId);
    launch(goal.id, ctx);
    return { ok: true, started: true, status: 'started', result: { taskId: goal.id, state: 'running', message: 'Desktop task started; completion is not yet verified' } };
  }
  async function control({ taskId, action } = {}, ctx = {}) {
    const e = record(taskId);
    if (!e) return { ok: false, result: 'Desktop task not found' };
    if (!ctx.connectionId || ctx.connectionId === 'system' || disconnected.has(ctx.connectionId)) return { ok: false, result: 'A current operator connection is required' };
    if (connections.has(taskId) && connections.get(taskId) !== ctx.connectionId) return { ok: false, result: 'Task belongs to another operator connection' };
    if (!connections.has(taskId)) {
      if (action !== 'resume') return { ok: false, result: 'Restart recovery requires explicit resume from the current operator' };
      connections.set(taskId, ctx.connectionId); latest.set(ctx.connectionId, taskId);
    }
    if (action === 'cancel' || action === 'pause') {
      const owner = running.get(taskId);
      save(taskId, { state: action === 'cancel' ? 'cancelled' : 'paused', reason: 'Operator ' + action, unknownWrite: Boolean(owner?.writing), phase: owner?.writing ? 'verifying' : e.phase });
      owner?.abort.abort();
      if (owner) await owner.promise;
      return status({ taskId }, ctx);
    }
    if (action !== 'resume' || e.state === 'completed' || e.state === 'cancelled') return { ok: false, result: 'This task cannot be resumed' };
    if (running.size) return { ok: false, result: 'A desktop task is already running' };
    save(taskId, { state: 'running', reason: 'Explicit resume; fresh observation required' });
    launch(taskId, ctx);
    return { ok: true, started: true, result: { taskId, state: 'running' } };
  }
  async function disconnect(connectionId) {
    disconnected.add(connectionId); latest.delete(connectionId);
    for (const [id, ownerConnection] of connections) {
      if (ownerConnection !== connectionId) continue;
      const owner = running.get(id);
      if (owner) {
        save(id, { state: 'paused', reason: 'Operator disconnected; explicit resume required', unknownWrite: Boolean(owner.writing), phase: owner.writing ? 'verifying' : record(id).phase });
        owner.abort.abort();
        await owner.promise;
      }
      connections.delete(id);
    }
  }
  return { start, status, control, disconnect, async settled(taskId) { await running.get(taskId)?.promise; return status({ taskId }, { connectionId: connections.get(taskId) }); } };
}
module.exports = { createDesktopController };
