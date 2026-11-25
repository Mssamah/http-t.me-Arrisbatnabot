'use strict';

// محرك رسم مجاني: Cloudflare Workers AI (FLUX.1 schnell)
// المتغيرات: CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN

const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || '').trim();

const enabled = Boolean(ACCOUNT && TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(prompt) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
    '/ai/run/@cf/black-forest-labs/flux-1-schnell';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt: String(prompt).slice(0, 2000), steps: 8 }),
    signal: AbortSignal.timeout(60000)
  });

  const type = res.headers.get('content-type') || '';

  if (res.ok && type.startsWith('image/')) {
    return Buffer.from(await res.arrayBuffer());
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.success === false) {
    const msg =
      data.errors?.map((e) => e.message).join(' | ') ||
      data.error ||
      `HTTP ${res.status}`;
    throw new Error(`${res.status} ${String(msg).slice(0, 200)}`);
  }

  const b64 = data.result?.image;
  if (!b64) throw new Error('لم تُرجع الخدمة صورة');

  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 2000) throw new Error('صورة صغيرة');

  return buffer;
}

async function generate(prompt) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await request(prompt);
    } catch (e) {
      lastError = e;
      console.error(`Cloudflare attempt ${attempt} failed:`, e.message);

      // لا فائدة من الإعادة عند أخطاء المفتاح أو الحصة
      if (/^(400|401|403|404|429)\b/.test(e.message) || /4006|allocation|quota/i.test(e.message)) break;

      await sleep(1500);
    }
  }

  throw lastError;
}

module.exports = { enabled, generate };
