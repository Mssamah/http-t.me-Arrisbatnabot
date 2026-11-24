'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// Railway Variables
// ======================================
// BOT_TOKEN        : مطلوب
// ALLOWED_USER_ID  : اختياري. إن وضعته يعمل البوت لك وحدك، وإن تركته فارغاً يعمل للجميع
// DAILY_LIMIT      : اختياري. عدد الصور اليومي لكل مستخدم (الافتراضي 15)

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 15;
const COOLDOWN_MS = 10 * 1000;
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
  none:    { label: '✨ حر',        suffix: '' },
  real:    { label: '📷 واقعي',     suffix: ', photorealistic, ultra detailed, natural lighting, 8k' },
  anime:   { label: '🎌 أنمي',      suffix: ', anime style, vibrant colors, detailed illustration' },
  render:  { label: '🧊 ثلاثي الأبعاد', suffix: ', 3d render, soft lighting, high detail, pixar style' },
  paint:   { label: '🎨 لوحة فنية', suffix: ', oil painting, artistic brushstrokes, museum quality' },
  logo:    { label: '🔷 شعار',      suffix: ', minimalist vector logo, flat design, clean white background' }
};

const SIZES = {
  square:    { label: '⬜ مربع',  w: 1024, h: 1024 },
  portrait:  { label: '📱 طولي',  w: 768,  h: 1024 },
  landscape: { label: '🖥 عرضي', w: 1024, h: 768 }
};

// ======================================
// حالة المستخدمين (في الذاكرة)
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
    '🎨 <b>مولّد الصور</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    `🖌 الأسلوب: <b>${STYLES[u.style].label}</b>\n` +
    `📐 الحجم: <b>${SIZES[u.size].label}</b>\n\n` +
    '✍️ <b>اكتب وصف الصورة الآن</b> وسأولّدها لك.\n' +
    '💡 الوصف بالإنجليزية يعطي نتائج أدق.\n\n' +
    `🎟 المتبقي اليوم: <b>${Math.max(0, DAILY_LIMIT - (u.day === today() ? u.count : 0))}</b> من ${DAILY_LIMIT}`
  );
}

const afterImageKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('🔄 نسخة جديدة', 'regen'),
    Markup.button.callback('⚙️ الإعدادات', 'settings')
  ]
]);

// ======================================
// توليد الصورة
// ======================================

async function generateImage(prompt, u) {
  const full = prompt + STYLES[u.style].suffix;
  const { w, h } = SIZES[u.size];
  const seed = Math.floor(Math.random() * 1e9);

  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(full) +
    `?width=${w}&height=${h}&seed=${seed}&model=flux&nologo=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });

  if (!res.ok) throw new Error(`Image service error ${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('Invalid response from image service');

  return Buffer.from(await res.arrayBuffer());
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
    const image = await generateImage(prompt, u);

    u.count += 1;

    await ctx.replyWithPhoto(
      { source: image },
      {
        caption: `🖼 ${prompt.slice(0, 200)}\n🖌 ${STYLES[u.style].label}  •  📐 ${SIZES[u.size].label}`,
        ...afterImageKeyboard
      }
    );
  } catch (e) {
    console.error('Generate error:', e.message);
    await ctx.reply('❌ تعذر توليد الصورة. جرّب وصفاً آخر أو أعد المحاولة بعد قليل.');
  } finally {
    u.busy = false;
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id);
    } catch {}
  }
}

// ======================================
// الأوامر
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
    console.log('Image bot started');
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
