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

  socket.addEventListener('open', () => {
    connecting = false;
    backoffMs = 500;
    flushQueue();
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

function stopRequest(reqId) {
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
  sendMessage({ type: 'subscribe', types, replay: Boolean(opts && opts.replay) });
  types.forEach((t) => onBroadcast(t, onEvent));
  return () => types.forEach((t) => offBroadcast(t, onEvent));
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

export function utterance({ text, onDone, onChunk }) {
  connect();
  const reqId = nextReqId();
  handlers.set(reqId, makeReplyHandler(reqId, { onDone, onChunk }));
  sendMessage({ type: 'utterance', reqId, text });
  return { stop: () => stopRequest(reqId) };
}

export function visionQuery({ image, text, onDone, onChunk }) {
  connect();
  const reqId = nextReqId();
  handlers.set(reqId, makeReplyHandler(reqId, { onDone, onChunk }));
  sendMessage({ type: 'vision-query', reqId, image, text });
  return { stop: () => stopRequest(reqId) };
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
