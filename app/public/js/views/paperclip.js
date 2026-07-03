// paperclip.js — idea-intake agent. No dedicated reference screenshot; extrapolated in-style
// as a lightweight front door into the Pipeline (Paperclip classifies, Pipeline executes).

export async function render(mount) {
  mount.innerHTML = `
    <div class="paperclip-panel fade-in">
      <div class="paperclip-head">
        <span class="paperclip-icon">&#128206;</span>
        <div>
          <div class="paperclip-title">Paperclip</div>
          <div class="paperclip-subtitle text-dim">Drop anything here — Paperclip classifies it and sends it to the Pipeline's Capture stage.</div>
        </div>
      </div>
      <div class="paperclip-row">
        <input type="text" id="paperclip-input" class="paperclip-input" placeholder="Paste a link, an idea, a note — anything..." />
        <button class="paperclip-btn" id="paperclip-send">Send to Pipeline</button>
      </div>
      <div class="paperclip-note text-faint mono" id="paperclip-note" hidden></div>
    </div>
  `;

  const input = document.getElementById('paperclip-input');
  const btn = document.getElementById('paperclip-send');
  const note = document.getElementById('paperclip-note');

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    try {
      await fetch('/api/pipeline/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      input.value = '';
      note.hidden = false;
      note.textContent = 'Sent to Pipeline → Capture. Open Pipeline to route it further.';
      setTimeout(() => { note.hidden = true; }, 4000);
    } catch (err) {
      console.error('paperclip send failed', err);
    }
  }

  btn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}
