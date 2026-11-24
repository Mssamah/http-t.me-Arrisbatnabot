'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// Railway Variables
// ======================================
// BOT_TOKEN           : مطلوب
// OPENAI_API_KEY      : اختياري (إن وُجد يعمل OpenAI، وإلا الخدمة المجانية)
// OPENAI_IMAGE_MODEL  : اختياري (الافتراضي gpt-image-1، أو dall-e-3)
// ALLOWED_USER_ID     : اختياري (يقيّد البوت عليك وحدك)
// DAILY_LIMIT         : اختياري (الافتراضي 15 مجاناً، و5 عند استخدام OpenAI)

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || (OPENAI_KEY ? 5 : 15);
const COOLDOWN_MS = 8 * 1000;
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

if (ALLOWED) {
  bot.use((ctx, next) => {
    if (ctx.from?.id !== ALLOWED) return;
    return next();
  });
}

// ======================================
// الخيارات
// ======================================

const STYLES = {
  none:   { label: '✨ حر',            suffix: '' },
  real:   { label: '📷 واقعي',         suffix: ', photorealistic, highly detailed, natural lighting, sharp focus' },
  anime:  { label: '🎌 أنمي',          suffix: ', anime style, vibrant colors, detailed illustration' },
  render: { label: '🧊 ثلاثي الأبعاد', suffix: ', 3d render, soft lighting, high detail' },
  paint:  { label: '🎨 لوحة فنية',     suffix: ', oil painting, artistic brushstrokes, rich textures' },
  logo:   { label: '🔷 شعار',          suffix: ', minimalist vector logo, flat design, clean white background' }
};

const SIZES = {
  square:    { label: '⬜ مربع', w: 1024, h: 1024 },
  portrait:  { label: '📱 طولي', w: 768,  h: 1024 },
  landscape: { label: '🖥 عرضي', w: 1024, h: 768 }
};

// ======================================
// حالة المستخدمين
// ======================================

const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      style: 'none',
      size: 'square',
      lastPrompt: null,
      lastRequest: 0,
      day: '',
      count: 0,
      busy: false
    });
  }
  return users.get(id);
}

const today = () => new Date().toISOString().slice(0, 10);

function remaining(u) {
  return Math.max(0, DAILY_LIMIT - (u.day === today() ? u.count : 0));
}

// ======================================
// الواجهة
// ======================================

function settingsKeyboard(u) {
  const mark = (on, text) => (on ? '✅ ' : '') + text;

  const styleButtons = Object.entries(STYLES).map(([key, s]) =>
    Markup.button.callback(mark(u.style === key, s.label), `style:${key}`)
  );

  const sizeButtons = Object.entries(SIZES).map(([key, s]) =>
    Markup.button.callback(mark(u.size === key, s.label), `size:${key}`)
  );

  return Markup.inlineKeyboard([
    styleButtons.slice(0, 2),
    styleButtons.slice(2, 4),
    styleButtons.slice(4),
    sizeButtons,
    [Markup.button.callback('🔄 إعادة آخر وصف', 'regen')]
  ]);
}

function settingsText(u) {
  return (
    '🎨 <b>مولّد الصور الذكي</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    `🤖 المحرك: <b>${OPENAI_KEY ? 'OpenAI' : 'FLUX (مجاني)'}</b>\n` +
    `🖌 الأسلوب: <b>${STYLES[u.style].label}</b>\n` +
    `📐 الحجم: <b>${SIZES[u.size].label}</b>\n\n` +
    '✍️ <b>اكتب وصف الصورة بأي لغة</b> وسأولّدها لك.\n' +
    '💡 كلما كان الوصف أدق (الشكل، الألوان، المكان، الإضاءة) كانت النتيجة أفضل.\n\n' +
    `🎟 المتبقي اليوم: <b>${remaining(u)}</b> من ${DAILY_LIMIT}`
  );
}

const afterImageKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('🔄 نسخة جديدة', 'regen'),
    Markup.button.callback('⚙️ الإعدادات', 'settings')
  ]
]);

// ======================================
// الترجمة إلى الإنجليزية (للمحرك المجاني فقط)
// ======================================

async function toEnglishPrompt(text) {
  if (/^[\x00-\x7F]+$/.test(text)) return text;

  const system =
    'Convert the user idea into ONE detailed English image-generation prompt. ' +
    'Translate from any language. Keep every detail the user specified exactly ' +
    '(subject, count, colors, positions, clothing, setting, mood). ' +
    'Do not add new subjects or remove any. ' +
    'You may add lighting, composition and quality details. ' +
    'Output only the prompt, maximum 80 words, no quotes, no explanation.';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url =
        'https://text.pollinations.ai/' +
        encodeURIComponent(text) +
        '?model=openai&system=' +
        encodeURIComponent(system);

      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`Translate error ${res.status}`);

      const out = (await res.text()).trim().replace(/^["']|["']$/g, '');
      if (out && out.length < 1200) return out;
    } catch (e) {
      console.error(`Translate attempt ${attempt} failed:`, e.message);
    }
  }

  return text;
}

// ======================================
// المحرك المجاني (FLUX)
// ======================================

async function requestFree(prompt, u) {
  const full = prompt + STYLES[u.style].suffix;
  const { w, h } = SIZES[u.size];
  const seed = Math.floor(Math.random() * 1e9);

  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(full) +
    `?width=${w}&height=${h}&seed=${seed}&model=flux&nologo=true&enhance=false`;

  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`Image service error ${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('Invalid response from image service');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 2000) throw new Error('Image too small');

  return buffer;
}

// ======================================
// محرك OpenAI
// ======================================

async function requestOpenAI(prompt, u) {
  const isDalle3 = OPENAI_MODEL.startsWith('dall-e-3');

  const sizes = isDalle3
    ? { square: '1024x1024', portrait: '1024x1792', landscape: '1792x1024' }
    : { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' };

  const body = {
    model: OPENAI_MODEL,
    prompt: prompt + STYLES[u.style].suffix,
    size: sizes[u.size],
    n: 1
  };

  if (isDalle3) {
    body.response_format = 'b64_json';
    body.quality = 'standard';
  } else {
    body.quality = 'medium';
  }

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || `OpenAI error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const item = data.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');

  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error('Failed to download image');
    return Buffer.from(await img.arrayBuffer());
  }

  throw new Error('No image returned');
}

// ======================================
// التوليد مع إعادة المحاولة
// ======================================

async function generateImage(prompt, u) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await (OPENAI_KEY ? requestOpenAI(prompt, u) : requestFree(prompt, u));
    } catch (e) {
      lastError = e;
      console.error(`Image attempt ${attempt} failed:`, e.message);

      // لا فائدة من إعادة المحاولة عند أخطاء المفتاح أو الرصيد أو سياسة المحتوى
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;

      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  throw lastError;
}

async function handleGenerate(ctx, prompt) {
  const u = getUser(ctx.from.id);

  if (u.busy) {
    return ctx.reply('⏳ لديك صورة قيد التوليد، انتظر قليلاً.');
  }

  const wait = COOLDOWN_MS - (Date.now() - u.lastRequest);
  if (wait > 0) {
    return ctx.reply(`⏱ انتظر ${Math.ceil(wait / 1000)} ثانية قبل الطلب التالي.`);
  }

  if (u.day !== today()) {
    u.day = today();
    u.count = 0;
  }
  if (u.count >= DAILY_LIMIT) {
    return ctx.reply('🚫 وصلت للحد اليومي. عُد غداً.');
  }

  u.busy = true;
  u.lastRequest = Date.now();
  u.lastPrompt = prompt;

  const status = await ctx.reply('🎨 جاري توليد الصورة... قد يستغرق حتى دقيقة.');

  try {
    await ctx.sendChatAction('upload_photo');

    const finalPrompt = OPENAI_KEY ? prompt : await toEnglishPrompt(prompt);
    const image = await generateImage(finalPrompt, u);

    u.count += 1;

    const caption =
      `🖼 ${finalPrompt.slice(0, 700)}\n\n` +
      `🖌 ${STYLES[u.style].label}  •  📐 ${SIZES[u.size].label}  •  🎟 ${remaining(u)}`;

    await ctx.replyWithPhoto(
      { source: image },
      { caption: caption.slice(0, 1000), ...afterImageKeyboard }
    );
  } catch (e) {
    console.error('Generate error:', e.message);

    let msg = '❌ تعذر توليد الصورة. أعد المحاولة بعد قليل أو غيّر الوصف.';
    if (e.status === 401) msg = '❌ مفتاح OpenAI غير صحيح.';
    else if (e.status === 403) msg = '❌ حسابك في OpenAI غير مفعّل لهذا النموذج (قد يحتاج توثيق المنظمة).';
    else if (e.status === 429) msg = '❌ الرصيد نفد أو الطلبات كثيرة. تحقق من رصيد OpenAI.';
    else if (/safety|content_policy|moderation/i.test(e.message)) msg = '🚫 الوصف مرفوض من سياسة المحتوى. جرّب وصفاً آخر.';

    await ctx.reply(msg);
  } finally {
    u.busy = false;
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id);
    } catch {}
  }
}

// ======================================
// الأوامر والأزرار
// ======================================

bot.start((ctx) => {
  const u = getUser(ctx.from.id);
  return ctx.reply(settingsText(u), { parse_mode: 'HTML', ...settingsKeyboard(u) });
});

bot.command('settings', (ctx) => {
  const u = getUser(ctx.from.id);
  return ctx.reply(settingsText(u), { parse_mode: 'HTML', ...settingsKeyboard(u) });
});

bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(ctx.from.id);
  await ctx.reply(settingsText(u), { parse_mode: 'HTML', ...settingsKeyboard(u) });
});

async function refreshSettings(ctx, u) {
  try {
    await ctx.editMessageText(settingsText(u), {
      parse_mode: 'HTML',
      ...settingsKeyboard(u)
    });
  } catch (e) {
    if (!String(e.message).includes('message is not modified')) {
      console.error('Edit error:', e.message);
    }
  }
}

bot.action(/^style:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!STYLES[key]) return ctx.answerCbQuery();
  const u = getUser(ctx.from.id);
  u.style = key;
  await ctx.answerCbQuery(STYLES[key].label);
  await refreshSettings(ctx, u);
});

bot.action(/^size:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!SIZES[key]) return ctx.answerCbQuery();
  const u = getUser(ctx.from.id);
  u.size = key;
  await ctx.answerCbQuery(SIZES[key].label);
  await refreshSettings(ctx, u);
});

bot.action('regen', async (ctx) => {
  const u = getUser(ctx.from.id);
  if (!u.lastPrompt) {
    return ctx.answerCbQuery('اكتب وصفاً أولاً', { show_alert: true });
  }
  await ctx.answerCbQuery('جاري التوليد...');
  await handleGenerate(ctx, u.lastPrompt);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (text.length < 3) {
    return ctx.reply('✍️ اكتب وصفاً أطول قليلاً للصورة.');
  }
  if (text.length > 500) {
    return ctx.reply('✂️ الوصف طويل جداً، الحد 500 حرف.');
  }

  await handleGenerate(ctx, text);
});

bot.catch((e) => console.error('Bot error:', e.message));

// ======================================
// سيرفر Railway
// ======================================

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Image Bot is Running!');
});
server.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log(`Image bot started (engine: ${OPENAI_KEY ? 'OpenAI ' + OPENAI_MODEL : 'free FLUX'})`);
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
