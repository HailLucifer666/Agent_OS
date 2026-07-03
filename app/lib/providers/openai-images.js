// openai-images.js — OpenAI Images provider (Thumbnail Studio), gpt-image-1.
// generateImage: text-to-image. editImage: image+text edit (reference images present).
// Both return an array of Buffer (decoded from b64_json) — the API never returns a url.

function keyOrThrow() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing — add it to app/.env');
  return apiKey;
}

async function parseImagesResponse(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || detail;
    } catch {
      // ignore parse failure, keep statusText
    }
    throw new Error(`openai images failed: ${res.status} ${detail}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => Buffer.from(d.b64_json, 'base64'));
}

async function generateImage(prompt, opts = {}) {
  const apiKey = keyOrThrow();
  const { n = 1, size = '1024x1024', quality = 'auto' } = opts;

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, n, size, quality, output_format: 'png' }),
  });

  return parseImagesResponse(res);
}

async function editImage(prompt, imageBuffers, opts = {}) {
  const apiKey = keyOrThrow();
  const { n = 1, size = '1024x1024', quality = 'auto' } = opts;

  const form = new FormData();
  imageBuffers.forEach((buf, i) => {
    form.append('images[]', new Blob([buf]), `reference-${i}.png`);
  });
  form.append('prompt', prompt);
  form.append('model', 'gpt-image-1');
  form.append('n', String(n));
  form.append('size', size);
  form.append('quality', quality);
  form.append('output_format', 'png');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  return parseImagesResponse(res);
}

module.exports = { generateImage, editImage };
