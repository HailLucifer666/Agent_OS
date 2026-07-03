// thumbnail-studio.js — Thumbnail Studio surface: reference dropzone + instructions +
// versions/checkboxes + generate. Generate calls POST /api/thumbnail/generate
// (OpenAI gpt-image-1, key-gated — honest-inert without OPENAI_API_KEY).

const CHECKBOX_CONFIG = [
  { key: 'redesign', label: 'Redesign from scratch', caption: '(off = faithful edit of your image, like ChatGPT — keeps it clean)', defaultChecked: false },
  { key: 'preventGrid', label: 'Prevent 4-in-1 grid', caption: '(recommended · uncheck for 100% raw prompt)', defaultChecked: true },
  { key: 'varyEach', label: 'Vary each version', caption: '(different layouts/colours/backgrounds, not all the same)', defaultChecked: false },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

export async function render(mount) {
  const state = {
    files: [], // { file, url }
    versions: 3,
  };

  mount.innerHTML = `
    <div class="thumb-surface fade-in">
      <div class="thumb-panel thumb-left-rail">
        <div class="thumb-section-label mono">1 &middot; REFERENCE IMAGES &middot; OPTIONAL</div>
        <div class="thumb-dropzone" id="thumb-dropzone" tabindex="0" role="button" aria-label="Upload reference images">
          <span class="thumb-dropzone-icon">&#8593;</span>
          <div class="thumb-dropzone-text">Drop image(s) or click &mdash; screenshots, a logo, your photo&hellip;</div>
          <div class="thumb-dropzone-helper">Add as many as you like, or skip it and just use a prompt.</div>
          <div class="thumb-dropzone-previews" id="thumb-dropzone-previews"></div>
          <input type="file" accept="image/*" multiple hidden id="thumb-file-input" />
        </div>

        <div class="thumb-section-label mono">2 &middot; INSTRUCTIONS</div>
        <textarea class="thumb-instructions-textarea" id="thumb-instructions-textarea" rows="4"
          placeholder="e.g. Make the text way bigger and bolder, add more contrast, put my shocked face on the right, brighter background&hellip;"></textarea>

        <div class="thumb-versions-row">
          <span class="thumb-versions-label">Versions</span>
          <div class="thumb-versions-buttons" id="thumb-versions-buttons">
            ${[1, 2, 3, 4].map((n) => `<button type="button" class="thumb-version-btn${n === 3 ? ' active' : ''}" data-version="${n}">${n}</button>`).join('')}
          </div>
        </div>

        <div class="thumb-checkbox-list">
          ${CHECKBOX_CONFIG.map((cfg) => `
            <label class="thumb-checkbox-row">
              <input type="checkbox" class="thumb-checkbox" data-key="${cfg.key}" ${cfg.defaultChecked ? 'checked' : ''} />
              <div class="thumb-checkbox-text">
                <span class="thumb-checkbox-label">${escapeHtml(cfg.label)}</span>
                <span class="thumb-checkbox-caption">${escapeHtml(cfg.caption)}</span>
              </div>
            </label>
          `).join('')}
        </div>

        <button type="button" class="thumb-generate-btn" id="thumb-generate-btn">
          <span class="thumb-generate-icon">&#10024;</span> Generate better versions
        </button>
      </div>

      <div class="thumb-panel thumb-right-panel" id="thumb-right-panel">
        <div class="thumb-empty">
          Upload a thumbnail, say what to improve, and hit generate.<br />
          Better versions appear here &mdash; and every round teaches it your taste.
        </div>
      </div>
    </div>
  `;

  const dropzone = mount.querySelector('#thumb-dropzone');
  const fileInput = mount.querySelector('#thumb-file-input');
  const previewsEl = mount.querySelector('#thumb-dropzone-previews');
  const instructionsTextarea = mount.querySelector('#thumb-instructions-textarea');
  const versionsButtons = mount.querySelectorAll('.thumb-version-btn');
  const generateBtn = mount.querySelector('#thumb-generate-btn');
  const rightPanel = mount.querySelector('#thumb-right-panel');

  function renderPreviews() {
    previewsEl.innerHTML = state.files.map((f, i) => `
      <div class="thumb-preview-thumb" data-index="${i}">
        <img src="${f.url}" alt="${escapeHtml(f.file.name)}" />
        <button type="button" class="thumb-preview-remove" data-index="${i}" aria-label="Remove">&times;</button>
      </div>
    `).join('');
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      state.files.push({ file, url: URL.createObjectURL(file) });
    });
    renderPreviews();
  }

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('.thumb-preview-remove')) return;
    fileInput.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('thumb-dropzone-dragging');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('thumb-dropzone-dragging');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  previewsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.thumb-preview-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    URL.revokeObjectURL(state.files[idx].url);
    state.files.splice(idx, 1);
    renderPreviews();
  });

  versionsButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      versionsButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.versions = Number(btn.dataset.version);
    });
  });

  function getCheckboxState() {
    const result = {};
    mount.querySelectorAll('.thumb-checkbox').forEach((cb) => {
      result[cb.dataset.key] = cb.checked;
    });
    return result;
  }

  function setRightPanelMessage(text) {
    rightPanel.textContent = '';
    const div = document.createElement('div');
    div.className = 'thumb-empty';
    div.textContent = text;
    rightPanel.appendChild(div);
  }

  function renderGallery(images) {
    rightPanel.textContent = '';
    const grid = document.createElement('div');
    grid.className = 'thumb-gallery-grid';
    images.forEach((img) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-gallery-item';
      const el = document.createElement('img');
      el.src = img.path;
      el.alt = 'Generated thumbnail';
      wrap.appendChild(el);
      grid.appendChild(wrap);
    });
    rightPanel.appendChild(grid);
  }

  let generating = false;
  generateBtn.addEventListener('click', async () => {
    if (generating) return;
    generating = true;
    generateBtn.disabled = true;
    setRightPanelMessage('Generating…');
    try {
      const checks = getCheckboxState();
      const filesBase64 = await Promise.all(state.files.map((f) => fileToBase64(f.file)));
      const res = await fetch('/api/thumbnail/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instructions: instructionsTextarea.value.trim(),
          files: filesBase64,
          versions: state.versions,
          redesignFromScratch: checks.redesign,
          preventGrid: checks.preventGrid,
          varyEach: checks.varyEach,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `generate failed (${res.status})`);
      renderGallery(data.images || []);
    } catch (err) {
      setRightPanelMessage(err.message);
    } finally {
      generating = false;
      generateBtn.disabled = false;
    }
  });
}
