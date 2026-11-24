'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// Railway Variables
// ======================================
// BOT_TOKEN             : مطلوب
// GEMINI_API_KEY        : مطلوب (مجاني من aistudio.google.com/apikey)
// GEMINI_MODEL          : اختياري (الافتراضي gemini-flash-latest)
// POLLINATIONS_API_KEY  : اختياري (لتحسين ثبات الرسم)
// ALLOWED_USER_ID       : اختياري (يقيّد البوت عليك وحدك)
// DAILY_LIMIT           : اختياري (رسائل يومية لكل مستخدم، الافتراضي 60)

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
const COOLDOWN_MS = 2000;
const MAX_HISTORY = 24;
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN || !GEMINI_KEY) {
  console.error('Missing BOT_TOKEN or GEMINI_API_KEY');
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

// ======================================
// Gemini
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
    'When the user asks you to draw, create, design or generate an image, ' +
    'call the generate_image function. Write its prompt in detailed English, ' +
    'keeping every detail the user asked for (subject, colors, setting, style). ' +
    'Never say you cannot draw. After calling it, you may add one short sentence.'
  );
}

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'generate_image',
        description: 'Generate an image from a detailed English description.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: {
              type: 'STRING',
              description: 'Detailed English description of the image to generate.'
            },
            aspect: {
              type: 'STRING',
              enum: ['square', 'portrait', 'landscape'],
              description: 'Image shape. Default square.'
            }
          },
          required: ['prompt']
        }
      }
    ]
  }
];

async function callGemini(contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    tools: TOOLS,
    generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
  };

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_KEY
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = new Error(data.error?.message || `Gemini error ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
      const call = parts.find((p) => p.functionCall)?.functionCall;

      if (!text && !call) {
        const reason = data.promptFeedback?.blockReason || cand?.finishReason || 'EMPTY';
        const err = new Error(`No content: ${reason}`);
        err.blocked = true;
        throw err;
      }

      return { text, call };
    } catch (e) {
      lastError = e;
      console.error(`Gemini attempt ${attempt} failed:`, e.message);

      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable || e.blocked) break;

      await new Promise((r) => setTimeout(r, 1500 * attempt));
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
      await new Promise((r) => setTimeout(r, 2000 * attempt));
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

// ======================================
// المعالجة الرئيسية
// ======================================

async function respond(ctx, userParts, historyText) {
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
    const contents = [...u.history, { role: 'user', parts: userParts }];
    const { text, call } = await callGemini(contents);

    let saved = text || '';

    if (call?.name === 'generate_image' && call.args?.prompt) {
      if (text) await sendLong(ctx, text);

      await ctx.sendChatAction('upload_photo').catch(() => {});

      try {
        const image = await generateImage(call.args.prompt, call.args.aspect);
        await ctx.replyWithPhoto(
          { source: image },
          { caption: `🎨 ${call.args.prompt}`.slice(0, 900) }
        );
        saved = `${text ? text + '\n' : ''}[رسمتُ صورة بالوصف: ${call.args.prompt}]`;
      } catch (e) {
        console.error('Image failed:', e.message);
        await ctx.reply('❌ تعذر رسم الصورة الآن. أعد المحاولة بعد قليل.');
        saved = `${text ? text + '\n' : ''}[فشل رسم الصورة]`;
      }
    } else {
      await sendLong(ctx, text);
    }

    u.count += 1;

    u.history.push({ role: 'user', parts: [{ text: historyText }] });
    u.history.push({ role: 'model', parts: [{ text: saved || '...' }] });

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
    else if (e.status === 400 && /api key/i.test(e.message)) msg = '❌ مفتاح Gemini غير صحيح.';
    else if (e.status === 403) msg = '❌ مفتاح Gemini غير مفعّل أو بلد الخادم غير مدعوم.';
    else if (e.status === 404) msg = '❌ النموذج غير موجود. غيّر المتغير GEMINI_MODEL.';
    else if (e.status === 429) msg = '⏱ تجاوزنا الحد المجاني لحظياً. انتظر دقيقة وأعد المحاولة.';

    await ctx.reply(msg);
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
      '• /new لبدء محادثة جديدة',
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

bot.on('photo', async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];

    if (best.file_size && best.file_size > 8 * 1024 * 1024) {
      return ctx.reply('الصورة كبيرة جداً، أرسل صورة أصغر.');
    }

    const link = await ctx.telegram.getFileLink(best.file_id);
    const res = await fetch(link.href, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('Download failed');

    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    const caption = (ctx.message.caption || 'صف هذه الصورة وأجب عن أي سؤال عنها.').slice(0, 1000);

    await respond(
      ctx,
      [{ inlineData: { mimeType: 'image/jpeg', data } }, { text: caption }],
      `[أرسل المستخدم صورة] ${caption}`
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

  await respond(ctx, [{ text }], text);
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
    console.log(`AI bot started (model: ${GEMINI_MODEL})`);
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
