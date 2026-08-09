// ws.js — CA from app/public/js/ws.js. Keeps: nextReqId/handlers-Map/onBroadcast/
// backoff/sendQueue verbatim. New: subscribe(types, onEvent) for live streaming.

let socket = null;
let connecting = false;
let backoffMs = 500;
const BACKOFF_MAX_MS = 8000;
const sendQueue = [];
const handlers = new Map();
const broadcastHandlers = new Map();
let reqCounter = 0;
// FIX I: every subscribe({types, replay}) call made so far, re-sent on each
// reconnect's 'open' event — without this, a dropped/reconnected socket
// silently stopped receiving 'tick'/'health'/'entity-state' etc. until a full
// page reload, since the original {type:'subscribe'} message was never resent.
const activeSubscriptions = [];

// Connection state, exposed via getState()/onStateChange(). Purely additive —
// reconnect behaviour below is untouched. This exists because the socket used
// to fail completely silently: with MYTHOS_AUTH_TOKEN configured the upgrade
// was rejected outright (no cookie, no ?token=), and this file logged nothing,
// exported nothing, and just kept retrying at up to 8s backoff forever. Every
// WS-fed widget, the core orb, agent actions and token usage simply stopped
// updating, which reads as "the dashboard is frozen", not "it is unauthorized".
let wsState = 'idle'; // 'idle' | 'connecting' | 'open' | 'closed'
let consecutiveFailures = 0;
const stateHandlers = new Set();

function setState(next) {
  wsState = next;
  const snapshot = { state: wsState, consecutiveFailures };
  stateHandlers.forEach((fn) => {
    try { fn(snapshot); } catch (_) { /* one bad listener must not break the socket */ }
  });
}

export function getState() {
  return { state: wsState, consecutiveFailures };
}

export function onStateChange(fn) {
  stateHandlers.add(fn);
  fn(getState());
  return () => stateHandlers.delete(fn);
}

export function offStateChange(fn) {
  stateHandlers.delete(fn);
}

function nextReqId() {
  reqCounter += 1;
  return `r${Date.now()}-${reqCounter}`;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function flushQueue() {
  while (sendQueue.length && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(sendQueue.shift());
  }
}

function scheduleReconnect() {
  if (connecting) return;
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  socket = new WebSocket(wsUrl());
  setState('connecting');

  socket.addEventListener('open', () => {
    connecting = false;
    backoffMs = 500;
    consecutiveFailures = 0;
    setState('open');
    flushQueue();
    // FIX I: resubscribe every live subscription so a reconnect doesn't leave
    // the client deaf to 'tick'/'health'/'entity-state'/etc. broadcasts.
    activeSubscriptions.forEach((sub) => {
      sendMessage({ type: 'subscribe', types: sub.types, replay: sub.replay });
    });
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const handler = handlers.get(msg.reqId);
    if (handler) { handler(msg); return; }
    const listeners = broadcastHandlers.get(msg.type);
    if (listeners) listeners.forEach((fn) => fn(msg));
  });

  socket.addEventListener('close', () => {
    connecting = false;
    socket = null;
    consecutiveFailures += 1;
    setState('closed');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => { if (socket) socket.close(); });
}

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(json);
  } else {
    sendQueue.push(json);
    connect();
  }
}

export { sendMessage };

export function stopRequest(reqId) {
  sendMessage({ type: 'stop', reqId });
}

export function onBroadcast(type, fn) {
  connect();
  if (!broadcastHandlers.has(type)) broadcastHandlers.set(type, new Set());
  broadcastHandlers.get(type).add(fn);
}

export function offBroadcast(type, fn) {
  const listeners = broadcastHandlers.get(type);
  if (!listeners) return;
  listeners.delete(fn);
  if (listeners.size === 0) broadcastHandlers.delete(type);
}

// NEW — subscribe(types, onEvent, opts): sends {type:'subscribe', types} once and
// wires onEvent as the onBroadcast handler for every type in the list, in one call.
// opts.replay:true asks the server to replay its recent history for these types
// (backend-terminal only — replaying 'action' everywhere would re-fire HUD FX).
export function subscribe(types, onEvent, opts) {
  connect();
  const replay = Boolean(opts && opts.replay);
  sendMessage({ type: 'subscribe', types, replay });
  // REMEDIATION P1-6: keep a reference to THIS call's own entry so the
  // returned unsubscribe can prune exactly it — without this, every
  // subscribe()/unsubscribe() pair (a panel or widget opening then closing)
  // left a permanent stale entry, growing activeSubscriptions unboundedly and
  // making a reconnect resend subscriptions for views that no longer exist.
  const entry = { types, replay };
  activeSubscriptions.push(entry);
  types.forEach((t) => onBroadcast(t, onEvent));
  return () => {
    types.forEach((t) => offBroadcast(t, onEvent));
    const idx = activeSubscriptions.indexOf(entry);
    if (idx !== -1) activeSubscriptions.splice(idx, 1);
  };
}

// Shared reply handler for utterance() and visionQuery(): 'speech-chunk'
// messages are routed through onChunk WITHOUT deleting the handler (chunks
// arrive before 'done'); the handler is removed only once 'done' lands.
function makeReplyHandler(reqId, { onDone, onChunk }) {
  return (msg) => {
    if (msg.type === 'speech-chunk') { if (onChunk) onChunk(msg); return; }
    if (msg.type === 'done') { handlers.delete(reqId); if (onDone) onDone(msg); }
  };
}

// micStoppedAt (Task 12, latency instrumentation): optional real client
// timestamp of the true mic-stop moment (voice-loop.js's stopRecording()).
// undefined is dropped by JSON.stringify, so existing callers that omit it
// see zero behavior change.
export function utterance({ text, onDone, onChunk, micStoppedAt }) {
  connect();
  const reqId = nextReqId();
  handlers.set(reqId, makeReplyHandler(reqId, { onDone, onChunk }));
  sendMessage({ type: 'utterance', reqId, text, micStoppedAt });
  return { reqId, stop: () => stopRequest(reqId) };
}

export function visionQuery({ image, text, onDone, onChunk }) {
  connect();
  const reqId = nextReqId();
  handlers.set(reqId, makeReplyHandler(reqId, { onDone, onChunk }));
  sendMessage({ type: 'vision-query', reqId, image, text });
  return { reqId, stop: () => stopRequest(reqId) };
}

export function checkpointReply(id, accept, feedback) {
  sendMessage({ type: 'checkpoint-reply', id, accept, feedback });
}

export function confirmReply(confirmId, accept) {
  sendMessage({ type: 'confirm-reply', confirmId, accept });
}

// Register a reply handler for a server-initiated reqId (proactive speech).
// The server sends 'proactive-speech' (broadcast, carries the text) followed by
// 'speech-chunk' + 'done' messages with the same reqId. Without registering a
// handler, those chunk/done messages would be ignored (no handler in the map).
// Uses the same makeReplyHandler shape as utterance()/visionQuery().
export function registerReplyHandler(reqId, { onDone, onChunk }) {
  handlers.set(reqId, makeReplyHandler(reqId, { onDone, onChunk }));
  return () => handlers.delete(reqId);
}
