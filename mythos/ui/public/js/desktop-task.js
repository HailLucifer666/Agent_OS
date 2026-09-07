import { onBroadcast, offBroadcast, sendMessage, getState } from './ws.js';

export function mountDesktopTask({ host = document.body, subscribe = onBroadcast, unsubscribe = offBroadcast, send = sendMessage, connected = () => getState() === 'open' } = {}) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Desktop task');
  section.hidden = true;
  Object.assign(section.style, { position: 'fixed', right: '16px', bottom: '96px', maxWidth: 'min(360px, calc(100vw - 32px))', zIndex: '100', background: 'var(--bg-panel, #151b26)', color: 'var(--text, #eee)', border: '1px solid var(--border, #526075)', borderRadius: '12px', padding: '12px' });
  const title = document.createElement('strong'); title.textContent = 'Desktop task';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const reason = document.createElement('p');
  const identity = document.createElement('p');
  const controls = document.createElement('div');
  let taskId = null, state = null;
  const buttons = ['pause', 'cancel', 'resume'].map((action) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = { pause: 'Pause task', cancel: 'Cancel task', resume: 'Resume task' }[action];
    button.style.marginRight = '8px';
    button.addEventListener('click', () => {
      if (!taskId || !connected()) { reason.textContent = 'Not connected. The task has not been changed.'; return; }
      send({ type: 'desktop-task-control', taskId, action });
      reason.textContent = { pause: 'Pause requested; awaiting confirmation.', cancel: 'Cancellation requested; awaiting confirmation.', resume: 'Resume requested; awaiting confirmation.' }[action];
    });
    controls.appendChild(button); return button;
  });
  section.append(title, identity, status, reason, controls); host.appendChild(section);
  const receive = (message) => {
    if (message?.ok === false) { section.hidden = false; reason.textContent = typeof message.result === 'string' ? message.result : 'Task control was not confirmed.'; return; }
    const task = message?.result;
    if (!task || typeof task.taskId !== 'string' || typeof task.state !== 'string') return;
    taskId = task.taskId; state = task.state; section.hidden = false;
    identity.textContent = (task.request || 'Desktop request') + ' (' + taskId + ')';
    status.textContent = 'State: ' + state;
    reason.textContent = task.reason || task.message || (state === 'completed' ? 'Completion reported; consult task evidence for the observed result.' : 'Completion has not been verified.');
    buttons[0].disabled = state !== 'running';
    buttons[1].disabled = state === 'completed' || state === 'cancelled';
    buttons[2].disabled = state !== 'paused' && state !== 'blocked';
  };
  subscribe('desktop-task', receive);
  return { close() { unsubscribe('desktop-task', receive); section.remove(); } };
}
