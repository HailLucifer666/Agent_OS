// ws.js — singleton WebSocket client for chat + Mastermind room streaming.
// Lazy-connects, auto-reconnects with capped backoff, queues sends until open.

let socket = null;
let connecting = false;
let backoffMs = 500;
const BACKOFF_MAX_MS = 8000;
const sendQueue = [];
const handlers = new Map(); // reqId -> handler callbacks
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
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const handler = handlers.get(msg.reqId);
    if (handler) handler(msg);
  });

  socket.addEventListener('close', () => {
    connecting = false;
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    if (socket) socket.close();
  });
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

function stopRequest(reqId) {
  sendMessage({ type: 'stop', reqId });
}

export function chatStream({ agent, convId, model, messages, onToken, onDone, onError }) {
  connect();
  const reqId = nextReqId();

  handlers.set(reqId, (msg) => {
    if (msg.type === 'token') {
      if (onToken) onToken(msg.token);
    } else if (msg.type === 'done') {
      handlers.delete(reqId);
      if (onDone) onDone(msg);
    } else if (msg.type === 'error') {
      handlers.delete(reqId);
      if (onError) onError(msg.message);
    }
  });

  sendMessage({ type: 'chat', reqId, convId, agent, model, messages });

  return { stop: () => stopRequest(reqId) };
}

export function roomStream({ convId, text, mention, onSeatStart, onToken, onSeatDone, onSeatSkip, onError, onRoomDone }) {
  connect();
  const reqId = nextReqId();

  handlers.set(reqId, (msg) => {
    if (msg.type === 'seat-start') {
      if (onSeatStart) onSeatStart(msg);
    } else if (msg.type === 'token') {
      if (onToken) onToken(msg);
    } else if (msg.type === 'seat-done') {
      if (onSeatDone) onSeatDone(msg);
    } else if (msg.type === 'seat-skip') {
      if (onSeatSkip) onSeatSkip(msg);
    } else if (msg.type === 'error') {
      if (onError) onError(msg);
    } else if (msg.type === 'room-done') {
      handlers.delete(reqId);
      if (onRoomDone) onRoomDone(msg);
    }
  });

  sendMessage({ type: 'room', reqId, convId, text, mention });

  return { stop: () => stopRequest(reqId) };
}
