'use strict';

// effectors/messaging-enter.js - BUG-476: the one decision for send_key('enter')
// with a messaging app in front.
//
// WHY THIS IS ITS OWN MODULE. The question is "may a raw Enter go to the verified
// submit ladder, or is a WhatsApp send still unresolved?". That judgement belongs
// at from-pc.js's raw-Enter door, NOT inside submitMessage: the ladder is also
// whatsapp_send's own submit, and that send holds its own fence entry, so a check
// inside the ladder would refuse the very send that is running. from-pc.js is at
// its file-size ceiling (test/file-size-ratchet.test.js, "do not raise it to make
// this pass - move the new code somewhere else"), so the guard lives here and
// from-pc.js calls it from the line it already had.
//
// guardedSubmit deliberately adds no behaviour of its own. Everything it decides
// is either send-fence.js's refusal or from-pc.js's submitMessage.
const sendFence = require('./send-fence');

// guard  - { messaging, app, pid } from from-pc's guardMessagingEnter()
// submit - from-pc's submitMessage(pid): the verified ladder
// refuse - from-pc's fail(text): the shape every other refusal in send_key returns
async function guardedSubmit(guard, submit, refuse) {
  const fenced = sendFence.refuseRawSubmit(guard && guard.app);
  if (fenced) return refuse(fenced);
  return submit(guard && guard.pid);
}

module.exports = { guardedSubmit };
