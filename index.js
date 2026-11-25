
'use strict';

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

const imageEngine = require('./image');
const registerClip = require('./clip');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();

const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;

const CHAT_MODEL =
  process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN غير موجود في Railway Variables');
}

if (!GROQ_KEY) {
  throw new Error('GROQ_API_KEY غير موجود في Railway Variables');
}

const bot = new Telegraf(BOT_TOKEN);

const histories = new Map();
const busyUsers = new Set();

const MAX_HISTORY = 20;

function allowed(ctx) {
  return !ALLOWED || ctx.from?.id === ALLOWED;
}

function getHistory(id) {
  if (!histories.has(id)) {
    histories.set(id, [
      {
        role: 'system',
        content:
          'You are OpenIA Smart AI, a helpful, intelligent assistant. ' +
          'Answer in the language used by the user. ' +
          'Be accurate, clear and friendly. ' +
          'You can explain technology, programming, science and general topics.'
      }
    ]);
  }

  return histories.get(id);
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🧠 محادثة جديدة', 'new_chat')
    ],
    [
      Markup.button.callback('🖼️ توليد صورة', 'image_help'),
      Markup.button.callback('🎥 توليد فيديو', 'video_help')
    ],
    [
      Markup.button.callback('ℹ️ حول البوت', 'about')
    ]
  ]);
}

async function groqChat(messages, model = CHAT_MODEL) {
  const res = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      }),
      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data.error?.message || `Groq HTTP ${res.status}`
    );
  }

  const answer = data.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error('لم تصل إجابة من الذكاء الاصطناعي');
  }

  return answer.trim();
}

// =====================================
// START
// =====================================

bot.start(async ctx => {
  if (!allowed(ctx)) return;

  const id = ctx.from.id;
  histories.delete(id);

  await ctx.reply(
    '🚀 أهلاً بك في OpenIA Smart AI\n\n' +
    'مساعدك الذكي لتوليد المحتوى والإبداع.\n\n' +
    '🧠 أرسل رسالة للمحادثة الذكية.\n' +
    '🖼️ استخدم /img لوصف صورة تريد إنشاءها.\n' +
    '🎥 استخدم /clip لوصف فيديو تريد إنشاءه.\n' +
    '📷 أرسل صورة لتحليلها.\n' +
    '🧹 استخدم /new لبدء محادثة جديدة.',
    {
      ...Markup.removeKeyboard(),
      ...mainKeyboard()
    }
  );
});

// =====================================
// NEW CHAT
// =====================================

bot.command('new', async ctx => {
  if (!allowed(ctx)) return;

  histories.delete(ctx.from.id);

  await ctx.reply(
    '🧹 تم بدء محادثة جديدة.\n\nأرسل رسالتك الآن.',
    mainKeyboard()
  );
});

bot.action('new_chat', async ctx => {
  if (!allowed(ctx)) return;

  histories.delete(ctx.from.id);

  await ctx.answerCbQuery('بدأت محادثة جديدة');

  await ctx.reply(
    '🧹 محادثة جديدة!\nأرسل سؤالك الآن.',
    mainKeyboard()
  );
});

// =====================================
// IMAGE GENERATION
// =====================================

bot.command('img', async ctx => {
  if (!allowed(ctx)) return;

  const prompt = ctx.message.text
    .replace(/^\/img(@\w+)?/i, '')
    .trim();

  if (!prompt) {
    return ctx.reply(
      '🖼️ اكتب وصف الصورة بعد الأمر:\n\n' +
      '/img مدينة مستقبلية في الليل بإضاءة سينمائية'
    );
  }

  if (!imageEngine.enabled) {
    return ctx.reply(
      '❌ محرك الصور غير مربوط.\n' +
      'أضف مفاتيح Cloudflare إلى Railway.'
    );
  }

  const id = ctx.from.id;

  if (busyUsers.has(id)) {
    return ctx.reply('⏳ لديك طلب آخر قيد التنفيذ.');
  }

  busyUsers.add(id);

  const status = await ctx.reply(
    '🎨 جارٍ إنشاء صورتك بالذكاء الاصطناعي...'
  );

  try {
    const buffer = await imageEngine.generate(prompt);

    await ctx.replyWithPhoto(
      { source: buffer, filename: 'openia-image.png' },
      {
        caption: '🖼️ تم إنشاء الصورة بنجاح\n\n' +
          prompt.slice(0, 900)
      }
    );

    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

  } catch (e) {
    console.error('Image error:', e);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '❌ فشل إنشاء الصورة:\n' +
      String(e.message).slice(0, 500)
    ).catch(() => {});

  } finally {
    busyUsers.delete(id);
  }
});

// =====================================
// IMAGE ANALYSIS
// =====================================

bot.on('photo', async ctx => {
  if (!allowed(ctx)) return;

  const id = ctx.from.id;

  if (busyUsers.has(id)) {
    return ctx.reply('⏳ انتظر حتى ينتهي طلبك السابق.');
  }

  busyUsers.add(id);

  const status = await ctx.reply(
    '👁️ جارٍ تحليل الصورة...'
  );

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];

    if (photo.file_size && photo.file_size > 15 * 1024 * 1024) {
      throw new Error('حجم الصورة كبير جداً. أرسل صورة أصغر.');
    }

    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);

    const fileRes = await fetch(fileUrl.href, {
      signal: AbortSignal.timeout(30000)
    });

    if (!fileRes.ok) {
      throw new Error('تعذر تحميل الصورة من تيليجرام');
    }

    const contentType =
      fileRes.headers.get('content-type') || 'image/jpeg';

    if (!contentType.startsWith('image/')) {
      throw new Error('الملف المرسل ليس صورة صالحة');
    }

    const bytes = Buffer.from(await fileRes.arrayBuffer());

    if (bytes.length > 15 * 1024 * 1024) {
      throw new Error('حجم الصورة أكبر من المسموح');
    }

    const base64 = bytes.toString('base64');

    const history = getHistory(id);

    const question =
      ctx.message.caption ||
      'اشرح لي محتوى هذه الصورة بالتفصيل.';

    const messages = [
      {
        role: 'system',
        content:
          'You are an image analysis assistant. ' +
          'Describe visible image contents accurately. ' +
          'Answer in the user language. Never invent details.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`
            }
          }
        ]
      }
    ];

    const answer = await groqChat(messages, VISION_MODEL);

    history.push({
      role: 'user',
      content: '[أرسل المستخدم صورة للتحليل]: ' + question
    });

    history.push({
      role: 'assistant',
      content: answer
    });

    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await ctx.reply(
      '👁️ تحليل الصورة:\n\n' + answer,
      {
        ...mainKeyboard(),
        link_preview_options: { is_disabled: true }
      }
    );

  } catch (e) {
    console.error('Vision error:', e);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '❌ تعذر تحليل الصورة:\n' +
      String(e.message).slice(0, 500)
    ).catch(() => {});

  } finally {
    busyUsers.delete(id);
  }
});

// =====================================
// TEXT AI CHAT
// =====================================

bot.on('text', async ctx => {
  if (!allowed(ctx)) return;

  const text = ctx.message.text.trim();

  if (!text || text.startsWith('/')) return;

  const id = ctx.from.id;

  if (busyUsers.has(id)) {
    return ctx.reply('⏳ انتظر حتى تنتهي الإجابة السابقة.');
  }

  busyUsers.add(id);

  const status = await ctx.reply('🧠 أفكر في إجابتك...');

  try {
    const history = getHistory(id);

    history.push({
      role: 'user',
      content: text.slice(0, 8000)
    });

    const system = history[0];
    const conversation = history.slice(1);

    const messages = [
      system,
      ...conversation.slice(-MAX_HISTORY)
    ];

    const answer = await groqChat(messages);

    history.push({
      role: 'assistant',
      content: answer
    });

    // Keep history within a reasonable size
    if (history.length > MAX_HISTORY + 1) {
      history.splice(1, history.length - MAX_HISTORY - 1);
    }

    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    // Telegram message limit
    const chunks = answer.match(/[\s\S]{1,4000}/g) || [];

    for (const chunk of chunks) {
      await ctx.reply(chunk, mainKeyboard());
    }

  } catch (e) {
    console.error('Chat error:', e);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '❌ حدث خطأ أثناء المحادثة:\n' +
      String(e.message).slice(0, 500)
    ).catch(() => {});

  } finally {
    busyUsers.delete(id);
  }
});

// =====================================
// BUTTONS
// =====================================

bot.action('image_help', async ctx => {
  if (!allowed(ctx)) return;

  await ctx.answerCbQuery();

  await ctx.reply(
    '🖼️ لإنشاء صورة أرسل:\n\n' +
    '/img وصف الصورة\n\n' +
    'مثال:\n' +
    '/img أسد واقعي في غابة سينمائية'
  );
});

bot.action('video_help', async ctx => {
  if (!allowed(ctx)) return;

  await ctx.answerCbQuery();

  await ctx.reply(
    '🎥 لإنشاء فيديو أرسل:\n\n' +
    '/clip وصف الفيديو\n\n' +
    'مثال:\n' +
    '/clip سيارة رياضية تسير في مدينة مستقبلية'
  );
});

bot.action('about', async ctx => {
  if (!allowed(ctx)) return;

  await ctx.answerCbQuery();

  await ctx.reply(
    '🚀 OpenIA Smart AI\n\n' +
    'مساعد ذكاء اصطناعي للمحادثة وتوليد الصور والفيديو وتحليل الصور.\n\n' +
    'Developer: YASSINE MESAMAH'
  );
});

// =====================================
// VIDEO ENGINE
// =====================================

registerClip(bot);

// =====================================
// ERROR HANDLING
// =====================================

bot.catch((err, ctx) => {
  console.error(
    'Telegram error:',
    err.message,
    'Update:',
    ctx.updateType
  );
});

// =====================================
// RAILWAY HTTP SERVER
// =====================================

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    return res.end(JSON.stringify({
      status: 'online',
      bot: 'OpenIA Smart AI'
    }));
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// =====================================
// START BOT
// =====================================

bot.launch()
  .then(() => {
    console.log('OpenIA Smart AI is running!');
  })
  .catch(err => {
    console.error('Bot launch failed:', err);
    process.exit(1);
  });

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.close();
});
