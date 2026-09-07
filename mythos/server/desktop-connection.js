'use strict';
const { parseRequest } = require('../src/core/desktop/intent');
const { randomUUID } = require('node:crypto');
const CONVERSATION_TOOLS = new Set(['get_time', 'get_weather', 'web_search', 'web_fetch', 'read_status', 'self_capabilities', 'recall_memory', 'note_read', 'note_search', 'desktop_task_status']);
function classify(text, hasContext) {
  const value = String(text || '').trim().replace(/^(?:(?:can|could|would|will) you\s+(?:please\s+)?|(?:I want|I need|I'd like) you to\s+)/i, '').replace(/\?$/, '');
  if (/^(?:please\s+)?(?:stop|cancel)(?:\s+(?:it|that|the task|the desktop task))?[.!]?$/i.test(value)) return { control: 'cancel' };
  if (/^(?:please\s+)?pause (?:the )?(?:desktop )?task[.!]?$/i.test(value)) return { control: 'pause' };
  if (/^(?:please\s+)?resume (?:the )?(?:desktop )?task[.!]?$/i.test(value)) return { control: 'resume' };
  if (parseRequest(value, hasContext)) return { request: value };
  if (/\b(?:open|launch|click|type|scroll|navigate|draft|send|buy|order|edit|save|build|create|play|pause|resume|skip|youtube)\b/i.test(value) || (hasContext && /\b(?:next one|change that|same again|do that again)\b/i.test(value))) return { unsupported: true };
  return null;
}
function outcomeText(task) {
  if (!task?.ok) return String(task?.result || 'Desktop task status is unavailable.');
  const e = task.result;
  if (e.state !== 'completed' || !e.evidence) return e.state === 'cancelled' ? 'Desktop task cancelled.' : e.state === 'paused' ? 'Desktop task paused.' : 'Desktop task blocked: ' + (e.reason || 'The requested outcome was not verified.');
  if (e.intent.kind === 'open-youtube') return 'YouTube is open in the selected browser.';
  if (e.intent.kind === 'pause') return 'The selected video is paused.';
  return 'The selected video is playing. I verified its identity and advancing playback time.';
}
function createDesktopConnection({ runtime, connectionId, leash, dispatch, reply, speak, send, historyAppend, cancelSpeech, logger = {} }) {
  const ctx = { connectionId };
  let generation = 0, closed = false;
  const seen = new Set();
  const receipts = new Map();
  function releaseReceipts() { for (const release of [...receipts.values()]) release(); }
  function waitForDrain(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { receipts.delete(id); reject(new Error('Desktop speech playback was not confirmed')); }, 15000);
      receipts.set(id, () => { clearTimeout(timer); receipts.delete(id); resolve(); });
    });
  }
  runtime.bind(connectionId);
  const unwatch = runtime.watch?.(connectionId, result => send({ type: 'desktop-task', ...result }));
  async function call(tool, args, requestId) {
    const decision = { tool, args };
    const verdict = leash.check(decision, ctx);
    if (!verdict.allow) return { ok: false, result: verdict.reason || 'Desktop request requires confirmation' };
    return dispatch(decision, { ...ctx, requestId, traceId: requestId, tier: verdict.tier, channel: 'desktop-request' });
  }
  async function execute(msg, intent, token) {
    const current = () => !closed && token === generation;
    historyAppend('user', String(msg.text || ''));
    const prior = runtime.controller.status({}, ctx);
    let accepted;
    if (intent.control) {
      cancelSpeech();
      accepted = prior.ok ? await call('desktop_task_control', { taskId: prior.result.taskId, action: intent.control }) : { ok: false, result: 'There is no active desktop task.' };
    } else if (intent.unsupported) accepted = { ok: false, result: 'This desktop workflow is not supported by the current YouTube qualification stage.' };
    else accepted = await call('desktop_task_start', { request: intent.request }, msg.reqId);
    if (!current()) return;
    send({ type: 'desktop-task', ...accepted });
    const started = accepted?.started === true;
    const acknowledgement = started ? 'Checking the selected browser. Completion is not verified yet.' : outcomeText(accepted);
    historyAppend('assistant', acknowledgement);
    const speechId = randomUUID(), drained = waitForDrain(speechId);
    // Attach the rejection handler before synthesis; the player may time out first.
    drained.catch(() => {});
    await reply(msg.reqId, acknowledgement, { verifiedDesktop: true, isCurrent: current, desktopSpeechId: speechId });
    await drained;
    if (!started || !current()) return;
    const final = await runtime.controller.settled(accepted.result.taskId);
    if (!current()) return;
    send({ type: 'desktop-task', ...final });
    const text = outcomeText(final);
    historyAppend('assistant', text);
    await speak(text, { isCurrent: current });
  }
  return {
    handle(msg) {
      if (msg.type === 'desktop-speech-drained') { receipts.get(msg.speechId)?.(); return true; }
      if (msg.type === 'desktop-task-control') {
        if (!['pause', 'resume', 'cancel'].includes(msg.action) || typeof msg.taskId !== 'string') return true;
        generation++; releaseReceipts(); cancelSpeech();
        call('desktop_task_control', { taskId: msg.taskId, action: msg.action }).then(result => send({ type: 'desktop-task', ...result })).catch(error => logger.warn?.('desktop.control-failed', { error: error.message }));
        return true;
      }
      if (msg.type !== 'utterance') return false;
      const intent = classify(msg.text, runtime.controller.status({}, ctx).ok);
      if (!intent) { generation++; releaseReceipts(); cancelSpeech({ preserveCompletedLive: true }); return false; }
      if (typeof msg.reqId !== 'string' || !msg.reqId || seen.has(msg.reqId)) return true;
      seen.add(msg.reqId); if (seen.size > 256) seen.delete(seen.values().next().value);
      const token = ++generation;
      releaseReceipts();
      cancelSpeech();
      execute(msg, intent, token).catch(error => { logger.warn?.('desktop.request-failed', { error: error.message }); if (!closed && token === generation) send({ type: 'done', reqId: msg.reqId, say: 'Desktop request failed: ' + error.message }); });
      return true;
    },
    async stop() {
      generation++; releaseReceipts(); cancelSpeech();
      const task = runtime.controller.status({}, ctx);
      if (task.ok && task.result.state === 'running') await call('desktop_task_control', { taskId: task.result.taskId, action: 'pause' });
    },
    async close() { closed = true; generation++; releaseReceipts(); unwatch?.(); await runtime.unbind(connectionId); },
    epoch: () => generation,
  };
}
async function conversationTools(calls, handlers, adapter) {
  const allowed = calls.filter(call => CONVERSATION_TOOLS.has(call.name));
  const blocked = calls.filter(call => !CONVERSATION_TOOLS.has(call.name));
  if (blocked.length) handlers.sendToolResponse(blocked.map(call => ({ id: call.id, name: call.name, response: { status: 'blocked', message: 'Desktop actions require a completed operator utterance routed through the desktop task owner. No action executed.' } })));
  if (allowed.length) return adapter.handleLiveToolCalls(allowed, handlers);
}
async function routeConversation(msg, { router, getLive, send, sanitize, onStart = () => {} }) {
  const epoch = router.epoch();
  try {
    const session = await getLive();
    if (router.epoch() !== epoch) return;
    if (!session) { send({ type: 'done', reqId: msg.reqId, say: 'Native conversation voice is unavailable. Desktop task controls remain available.' }); return; }
    onStart(msg.reqId);
    session.sendText(String(msg.text || ''), { site: 'operator-completed-transcript', operator: true });
    send({ type: 'done', reqId: msg.reqId, say: '', routedToLive: true });
  } catch (error) {
    if (router.epoch() === epoch) send({ type: 'done', reqId: msg.reqId, say: 'Native conversation voice failed: ' + sanitize(error) });
  }
}
module.exports = { createDesktopConnection, classify, outcomeText, conversationTools, routeConversation, conversationToolAllowed: name => CONVERSATION_TOOLS.has(name) };
