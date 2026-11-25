
'use strict';

const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || '').trim();

const enabled = Boolean(ACCOUNT && TOKEN);

async function generate(prompt) {
  if (!enabled) {
    throw new Error('Cloudflare غير مربوط. أضف مفاتيح Cloudflare في Railway.');
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
    '/ai/run/@cf/black-forest-labs/flux-1-schnell';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 2000),
      steps: 8
    }),
    signal: AbortSignal.timeout(90000)
  });

  const type = res.headers.get('content-type') || '';

  if (res.ok && type.startsWith('image/')) {
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length < 2000) {
      throw new Error('الصورة صغيرة جداً');
    }

    return buffer;
  }

  const data = await res.json().catch(() => ({}));

  const message =
    data.errors?.map(e => e.message).join(' | ') ||
    data.error ||
    `HTTP ${res.status}`;

  if (!res.ok || data.success === false) {
    throw new Error(String(message).slice(0, 300));
  }

  const image = data.result?.image;

  if (!image) {
    throw new Error('لم يتم إرجاع صورة من Cloudflare');
  }

  const buffer = Buffer.from(image, 'base64');

  if (buffer.length < 2000) {
    throw new Error('الصورة الناتجة غير صالحة');
  }

  return buffer;
}

module.exports = { enabled, generate };
