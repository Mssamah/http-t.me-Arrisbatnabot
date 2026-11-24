'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// Railway Variables
// ======================================
// BOT_TOKEN             : مطلوب
// GROQ_API_KEY          : مطلوب (مجاني من console.groq.com/keys)
// GROQ_MODEL            : اختياري (نموذج يُجرَّب أولاً للنصوص)
// GROQ_VISION_MODEL     : اختياري (نموذج فهم الصور)
// POLLINATIONS_API_KEY  : اختياري (لتحسين ثبات الرسم)
// ALLOWED_USER_ID       : اختياري (يقيّد البوت عليك وحدك)
// DAILY_LIMIT           : اختياري (رسائل يومية لكل مستخدم، الافتراضي 60)

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
const COOLDOWN_MS = 1500;
const MAX_HISTORY = 20;
const OVERALL_TIMEOUT_MS = 60000;
const PORT = Number(process.env.PORT) || 3000;

const unique = (arr) => [...new Set(arr.filter(Boolean))];

const TEXT_MODELS = unique([
  (process.env.GROQ_MODEL || '').trim(),
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant'
]);

const VISION_MODELS = unique([
  (process.env.GROQ_VISION_MODEL || '').trim(),
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct'
]);

if (!BOT_TOKEN || !GROQ_KEY) {
  console.error('Missing BOT_TOKEN or GROQ_API_KEY');
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
// حالة المستخدمين
// ======================================

const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, { history: [], lastRequest: 0, day: '', count: 0, busy: false });
  }
  return users.get(id);
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================
// Groq
// ======================================

function systemPrompt() {
  const date = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Africa/Algiers',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return (
    'You are a smart, friendly AI assistant inside a Telegram bot. ' +
    'Answer any topic helpfully and accurately. ' +
    'ALWAYS reply in the same language the user writes in (Arabic, French, English, etc.). ' +
    'Be clear and reasonably concise; use short paragraphs and simple lists. ' +
    'Avoid heavy markdown (no tables, no headers). ' +
    'If you are not sure about something, say so instead of inventing facts. ' +
    `Today is ${date}. ` +
    'IMAGE GENERATION: when the user asks you to draw, create, design or generate an image, ' +
    'write one short sentence in the user language, then add on a new line exactly this marker: ' +
    '[[IMAGE: <detailed English description keeping every detail the user asked for> | <square or portrait or landscape>]] ' +
    'Use the marker only when the user explicitly asks for an image. Never say you cannot draw.'
  );
}

async function callModel(model, messages) {
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt() }, ...messages],
    temperature: 0.7,
    max_tokens: 2048
  };

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_KEY}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = new Error(data.error?.message || `Groq error ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        const err = new Error('Empty response');
        err.blocked = true;
        throw err;
      }

      return text;
    } catch (e) {
      lastError = e;
      console.error(`Groq [${model}] attempt ${attempt} failed:`, e.message);

      const retryable = !e.status || e.status >= 500;
      if (!retryable || e.blocked) break;

      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

async function callGroq(messages, hasImage = false) {
  const models = hasImage ? VISION_MODELS : TEXT_MODELS;
  let lastError;

  for (const model of models) {
    try {
      return await callModel(model, messages);
    } catch (e) {
      lastError = e;

      // جرّب النموذج التالي عند: غير موجود، تجاوز الحد، ضغط، أو نموذج متوقف
      if (e.status === 404 || e.status === 429 || e.status >= 500) continue;
      if (e.status === 400 && /model|decommission/i.test(e.message)) continue;
      if (!e.status) continue;

      throw e;
    }
  }

  throw lastError;
}

// ======================================
// الرسم
// ======================================

const SIZES = {
  square: { w: 1024, h: 1024 },
  portrait: { w: 768, h: 1024 },
  landscape: { w: 1024, h: 768 }
};

async function requestImage(prompt, aspect) {
  const size = SIZES[aspect] || SIZES.square;
  const seed = Math.floor(Math.random() * 1e9);

  const base = POLL_KEY
    ? 'https://gen.pollinations.ai/image/'
    : 'https://image.pollinations.ai/prompt/';

  const url =
    base +
    encodeURIComponent(prompt) +
    `?width=${size.w}&height=${size.h}&seed=${seed}&model=flux&nologo=true`;

  const res = await fetch(url, {
    headers: POLL_KEY ? { Authorization: `Bearer ${POLL_KEY}` } : {},
    signal: AbortSignal.timeout(90000)
  });

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Image service ${res.status}: ${body}`);
  }

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('Invalid response from image service');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 2000) throw new Error('Image too small');

  return buffer;
}

async function generateImage(prompt, aspect) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await requestImage(prompt, aspect);
    } catch (e) {
      lastError = e;
      console.error(`Image attempt ${attempt} failed:`, e.message);
      await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

// ======================================
// إرسال النصوص
// ======================================

const clean = (t) =>
  t
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^(\s*)\*\s+/gm, '$1• ')
    .replace(/^#{1,6}\s+/gm, '');

async function sendLong(ctx, text) {
  let rest = clean(text).trim();

  while (rest.length > 0) {
    let chunk = rest.slice(0, 4000);
    if (rest.length > 4000) {
      const cut = chunk.lastIndexOf('\n');
      if (cut > 2000) chunk = chunk.slice(0, cut);
    }
    await ctx.reply(chunk);
    rest = rest.slice(chunk.length).trimStart();
  }
}

const IMAGE_MARKER = /\[\[\s*IMAGE\s*:\s*([\s\S]+?)\s*(?:\|\s*(square|portrait|landscape)\s*)?\]\]/i;

function parseReply(raw) {
  const m = raw.match(IMAGE_MARKER);
  if (!m) return { text: raw.trim(), prompt: null, aspect: 'square' };

  return {
    text: raw.replace(IMAGE_MARKER, '').trim(),
    prompt: m[1].trim().slice(0, 900),
    aspect: (m[2] || 'square').toLowerCase()
  };
}

// ======================================
// المعالجة الرئيسية
// ======================================

async function respond(ctx, userContent, historyText, hasImage = false) {
  const u = getUser(ctx.from.id);

  if (u.busy) {
    return ctx.reply('⏳ ما زلت أجيب على رسالتك السابقة، انتظر قليلاً.');
  }

  if (Date.now() - u.lastRequest < COOLDOWN_MS) return;

  if (u.day !== today()) {
    u.day = today();
    u.count = 0;
  }
  if (u.count >= DAILY_LIMIT) {
    return ctx.reply('🚫 وصلت للحد اليومي من الرسائل. عُد غداً.');
  }

  u.busy = true;
  u.lastRequest = Date.now();

  const typing = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);
  ctx.sendChatAction('typing').catch(() => {});

  try {
    const messages = [...u.history, { role: 'user', content: userContent }];

    const raw = await Promise.race([
      callGroq(messages, hasImage),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('انتهت المهلة: Groq لا يستجيب')), OVERALL_TIMEOUT_MS)
      )
    ]);

    const { text, prompt, aspect } = parseReply(raw);
    let saved = text;

    if (text) await sendLong(ctx, text);

    if (prompt) {
      await ctx.sendChatAction('upload_photo').catch(() => {});

      try {
        const image = await generateImage(prompt, aspect);
        await ctx.replyWithPhoto({ source: image }, { caption: `🎨 ${prompt}`.slice(0, 900) });
        saved = `${text ? text + '\n' : ''}[رسمتُ صورة بالوصف: ${prompt}]`;
      } catch (e) {
        console.error('Image failed:', e.message);
        await ctx.reply('❌ تعذر رسم الصورة الآن.\n\n' + String(e.message).slice(0, 250));
        saved = `${text ? text + '\n' : ''}[فشل رسم الصورة]`;
      }
    }

    u.count += 1;

    u.history.push({ role: 'user', content: historyText });
    u.history.push({ role: 'assistant', content: saved || '...' });

    if (u.history.length > MAX_HISTORY) {
      u.history = u.history.slice(-MAX_HISTORY);
    }
    while (u.history.length && u.history[0].role !== 'user') {
      u.history.shift();
    }
  } catch (e) {
    console.error('Respond error:', e.message);

    let msg = '❌ حدث خطأ، أعد المحاولة بعد قليل.';
    if (e.blocked) msg = '🚫 لا أستطيع الإجابة على هذا الطلب. جرّب صياغة أخرى.';
    else if (e.status === 401) msg = '❌ مفتاح Groq غير صحيح.';
    else if (e.status === 403) msg = '❌ مفتاح Groq غير مفعّل أو الوصول محجوب من منطقة الخادم.';
    else if (e.status === 404) msg = '❌ لا يوجد نموذج متاح لمفتاحك.';
    else if (e.status === 413) msg = '❌ الطلب كبير جداً.';
    else if (e.status === 429) msg = '⏱ تجاوزنا الحد المجاني لحظياً. انتظر دقيقة وأعد المحاولة.';

    // يعرض سبب الخطأ الحقيقي للمساعدة في التشخيص (احذف السطر التالي لاحقاً إن أردت)
    await ctx.reply(msg + '\n\n' + String(e.message).slice(0, 300));
  } finally {
    clearInterval(typing);
    u.busy = false;
  }
}

// ======================================
// الأوامر
// ======================================

const startKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🧹 محادثة جديدة', 'new')]
]);

bot.start((ctx) =>
  ctx.reply(
    '🤖 أهلاً بك! أنا مساعد ذكي.\n\n' +
      '• اسألني عن أي موضوع وبأي لغة\n' +
      '• اطلب مني رسم أي صورة، مثل: ارسم لي قطة على القمر\n' +
      '• أرسل لي صورة واسألني عنها\n' +
      '• /new لبدء محادثة جديدة\n' +
      '• /test لفحص الاتصال',
    startKeyboard
  )
);

function resetChat(ctx) {
  getUser(ctx.from.id).history = [];
}

bot.command('new', async (ctx) => {
  resetChat(ctx);
  await ctx.reply('🧹 بدأنا محادثة جديدة.');
});

bot.action('new', async (ctx) => {
  resetChat(ctx);
  await ctx.answerCbQuery('تم مسح المحادثة');
  await ctx.reply('🧹 بدأنا محادثة جديدة.');
});

bot.command('test', async (ctx) => {
  const lines = ['🔎 فحص الاتصال...'];
  const msg = await ctx.reply(lines.join('\n'));

  const update = async () => {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, lines.join('\n'));
    } catch {}
  };

  try {
    const started = Date.now();
    const text = await callGroq([{ role: 'user', content: 'Reply with the single word: OK' }]);
    lines.push(`✅ Groq يعمل (${((Date.now() - started) / 1000).toFixed(1)} ث): ${text.slice(0, 30)}`);
  } catch (e) {
    lines.push(`❌ Groq: ${String(e.message).slice(0, 200)}`);
  }
  await update();

  try {
    const img = await requestImage('a small red apple on a table', 'square');
    lines.push(`✅ الرسم يعمل (${Math.round(img.length / 1024)} KB)`);
  } catch (e) {
    lines.push(`❌ الرسم: ${String(e.message).slice(0, 200)}`);
  }
  await update();
});

bot.on('photo', async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const MAX_BYTES = 2.5 * 1024 * 1024;

    const best =
      [...photos].reverse().find((p) => !p.file_size || p.file_size <= MAX_BYTES) || photos[0];

    const link = await ctx.telegram.getFileLink(best.file_id);
    const res = await fetch(link.href, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('Download failed');

    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    const caption = (ctx.message.caption || 'صف هذه الصورة وأجب عن أي سؤال عنها.').slice(0, 1000);

    await respond(
      ctx,
      [
        { type: 'text', text: caption },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }
      ],
      `[أرسل المستخدم صورة] ${caption}`,
      true
    );
  } catch (e) {
    console.error('Photo error:', e.message);
    await ctx.reply('❌ تعذر قراءة الصورة.');
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) return;

  if (text.length > 4000) {
    return ctx.reply('✂️ الرسالة طويلة جداً، اختصرها.');
  }

  await respond(ctx, text, text, false);
});

bot.catch((e) => console.error('Bot error:', e.message));

// ======================================
// سيرفر Railway
// ======================================

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('AI Bot is Running!');
});
server.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log(`AI bot started. Text models: ${TEXT_MODELS.join(', ')}`);
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
