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
let wsState = 'idle'; // 'idle' | 'connecting' | 'open' | 'closed' | 'unauthorized'
let consecutiveFailures = 0;
const stateHandlers = new Set();

// BUG-298 — the second half of the comment above, which said reconnect behaviour
// was deliberately left untouched. It was, and it kept retrying forever.
//
// MEASURED, %APPDATA%/MYTHOS/mythos-server.log: 147 ws-upgrade-rejected lines,
// all of them between 2026-08-19T15:23:04.462Z and 15:44:33.465Z — 1289 seconds
// over 147 attempts, one every ~8.8s, with `server.listening` immediately before
// the first. BACKOFF_MAX_MS is 8000. That arithmetic names the client: it is
// THIS file, hammering from the moment the server comes up.
//
// A rejected upgrade reaches the browser as a bare close (code 1006 at best),
// carrying no status — so the socket alone genuinely cannot tell "the server is
// down" from "the server is up and refusing me". It has to ask over HTTP, and
// /api/config/vad is token-gated (server/index.js mounts requireToken on /api,
// exempting only /pin/status, /pin/verify and /auth/session), so its status code
// answers the question directly.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not loosen the server's
// verifyClient, which is refusing correctly — MYTHOS_AUTH_TOKEN is mandatory for
// the phone node. And it does not invent an auth channel for the HUD; the PIN
// session that tokenOk() already accepts is the intended one, and wiring it is a
// feature, not something to improvise inside a retry loop. This fixes only what
// is unambiguously the client's own defect: hammering, and looking frozen while
// doing it.
const UNAUTHORIZED_RETRY_MS = 60000;
// One dropped socket is ordinary — a probe on every close would add an HTTP
// request per reconnect to the exact path that is already too noisy.
const PROBE_AFTER_FAILURES = 3;
const AUTH_PROBE_PATH = '/api/config/vad';
let unauthorized = false;
let probeInFlight = false;
let authGeneration = 0;

// Resolves to 'unauthorized' | 'ok' | 'unreachable'. Never throws: a client-side
// diagnostic that can itself fail is not a diagnostic.
async function probeAuth() {
  try {
    const res = await fetch(AUTH_PROBE_PATH, { method: 'GET' });
    return (res.status === 401 || res.status === 403) ? 'unauthorized' : 'ok';
  } catch (_) {
    return 'unreachable';
  }
}

// Only 'unauthorized' changes behaviour. 'ok' and 'unreachable' both leave the
// fast backoff alone — reporting a cause that was not established is the same
// dishonesty the effector evidence contract exists to prevent, and a developer
// restarting the server must still get a reconnect in seconds.
async function diagnoseIfRefused() {
  if (unauthorized || probeInFlight || consecutiveFailures < PROBE_AFTER_FAILURES) return;
  probeInFlight = true;
  const generation = authGeneration;
  try {
    if (await probeAuth() === 'unauthorized' && generation === authGeneration) {
      unauthorized = true;
      backoffMs = UNAUTHORIZED_RETRY_MS;
      setState('unauthorized');
    }
  } finally {
    probeInFlight = false;
  }
}

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
  // BUG-298: once a 401 is established the interval is already a minute, and
  // doubling toward BACKOFF_MAX_MS would walk it straight back down to 8s.
  backoffMs = unauthorized ? UNAUTHORIZED_RETRY_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  socket = new WebSocket(wsUrl());
  setState('connecting');

  socket.addEventListener('open', () => {
    authGeneration += 1;
    connecting = false;
    backoffMs = 500;
    consecutiveFailures = 0;
    // BUG-298: a successful connection is the only proof the refusal is over.
    // Without this the fix degenerates into "the HUD never reconnects again",
    // which is worse than the bug — the operator may start a PIN session at any
    // moment and the socket has to notice.
    unauthorized = false;
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
    setState(unauthorized ? 'unauthorized' : 'closed');
    scheduleReconnect();
    // BUG-298, fire-and-forget: the reconnect above is already scheduled and a
    // slow probe must not delay it. If the probe comes back 401 the NEXT
    // schedule uses the long interval, which is the whole point.
    diagnoseIfRefused();
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

// G4: `surface` names which UI surface resolved this confirm — 'click' for a
// real pointer on the Approve button, 'gesture' for the Thumb_Up handler that
// synthesizes that click. Without it every accept looked identical in the
// audit no matter what produced it, which is what made the 2026-08-12 incident
// unattributable in principle. Omitted rather than defaulted when the caller
// does not know: the server records 'unknown', because inventing an
// attribution is the exact defect being fixed here.
export function confirmReply(confirmId, accept, surface) {
  sendMessage({ type: 'confirm-reply', confirmId, accept, ...(surface ? { surface } : {}) });
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
