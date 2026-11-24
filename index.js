
'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// RAILWAY VARIABLES
// ======================================

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const PORT = Number(process.env.PORT) || 3000;

const COOLDOWN_MS = 1500;
const MAX_HISTORY = 20;
const OVERALL_TIMEOUT_MS = 60000;

const HORDE_URL = 'https://aihorde.net/api';
const HORDE_KEY = '0000000000';

const HORDE_AGENT =
  (process.env.HORDE_CLIENT_AGENT || 'TelegramAIBot:2.0').trim();

const DEVELOPER = 'YASSINE MESAMAH';

if (!BOT_TOKEN || !GROQ_KEY) {
  console.error('Missing BOT_TOKEN or GROQ_API_KEY');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ======================================
// ACCESS CONTROL
// ======================================

if (ALLOWED) {
  bot.use((ctx, next) => {
    if (ctx.from?.id !== ALLOWED) return;
    return next();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const unique = arr => [...new Set(arr.filter(Boolean))];

// ======================================
// DEVELOPER IDENTITY
// ======================================

function developerIdentity(text) {
  if (!text || typeof text !== 'string') return false;

  const patterns = [
    /who\s+(created|developed|made|programmed|built)\s+you/i,
    /who\s+is\s+your\s+(developer|creator|programmer|owner)/i,
    /who\s+made\s+this\s+bot/i,
    /who\s+is\s+behind\s+you/i,
    /your\s+creator/i,
    /your\s+developer/i,

    /من\s+(طورك|صنعك|برمجك|أنشأك)/i,
    /من\s+هو\s+(مطورك|مبرمجك|صانعك)/i,
    /من\s+قام\s+بتطويرك/i,
    /من\s+صاحب\s+البوت/i,
    /من\s+أنشأ\s+هذا\s+البوت/i,
    /من\s+المطور/i
  ];

  return patterns.some(pattern => pattern.test(text));
}

// ======================================
// MODELS
// ======================================

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

// ======================================
// USER DATA
// ======================================

const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      history: [],
      lastRequest: 0,
      busy: false
    });
  }

  return users.get(id);
}

// ======================================
// GROQ AI
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
    'You are OpenIA Smart Bot, a helpful AI assistant. ' +
    'Your developer and creator is YASSINE MESAMAH. ' +
    'If anyone asks who created, developed, programmed or owns you, ' +
    'answer exactly: YASSINE MESAMAH. ' +
    'Always answer in the same language as the user. ' +
    'Be accurate, friendly and reasonably concise. ' +
    'Never invent facts. ' +
    `Today is ${date}. ` +
    'When the user explicitly asks to generate an image, ' +
    'write one short sentence in their language, then add this exact marker: ' +
    '[[IMAGE: detailed English image description | square]] ' +
    'Use only square as the image format. ' +
    'Never use the image marker unless the user explicitly requests an image.'
  );
}

async function loadModels() {
  const res = await fetch(
    'https://api.groq.com/openai/v1/models',
    {
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      data.error?.message || `Groq error ${res.status}`
    );
    err.status = res.status;
    throw err;
  }

  return (data.data || [])
    .map(model => model.id)
    .filter(id =>
      !/whisper|tts|guard|embed|safeguard|orpheus|playai/i.test(id)
    );
}

let availableModels = null;

async function callModel(model, messages) {
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
        messages: [
          { role: 'system', content: systemPrompt() },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 2048
      }),
      signal: AbortSignal.timeout(25000)
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      data.error?.message || `Groq error ${res.status}`
    );
    err.status = res.status;
    throw err;
  }

  const answer = data.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error('Groq returned an empty response');
  }

  return answer;
}

async function callGroq(messages, hasImage = false) {
  if (!availableModels) {
    try {
      availableModels = await loadModels();
      console.log('Groq models loaded:', availableModels.length);
    } catch (e) {
      console.error('Could not load Groq models:', e.message);

      if (e.status === 401 || e.status === 403) throw e;
    }
  }

  const base = hasImage ? VISION_MODELS : TEXT_MODELS;
  let order = base;

  if (availableModels) {
    const matching = base.filter(model =>
      availableModels.includes(model)
    );

    const extra = availableModels.filter(model =>
      hasImage
        ? /vision|scout|maverick|llama-4/i.test(model)
        : /llama|gpt-oss|qwen|kimi|gemma/i.test(model)
    );

    order = unique([...matching, ...extra]).slice(0, 5);

    if (!order.length) {
      const err = new Error('No compatible Groq model available');
      err.status = 404;
      throw err;
    }
  }

  let lastError;

  for (const model of order) {
    try {
      console.log('Using Groq model:', model);
      return await callModel(model, messages);
    } catch (e) {
      lastError = e;

      console.error(`Model ${model} failed:`, e.message);

      if (
        e.status === 404 ||
        e.status === 429 ||
        e.status >= 500 ||
        !e.status ||
        (e.status === 400 && /model|decommission/i.test(e.message))
      ) {
        continue;
      }

      throw e;
    }
  }

  throw lastError || new Error('All Groq models failed');
}

// ======================================
// AI HORDE IMAGE GENERATION
// ======================================

const SIZES = {
  square: { w: 512, h: 512 },
  portrait: { w: 448, h: 576 },
  landscape: { w: 576, h: 448 }
};

function hordeHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: HORDE_KEY,
    'Client-Agent': HORDE_AGENT
  };
}

async function hordeJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...hordeHeaders(),
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      data.message ||
      data.error ||
      data.errors?.[0]?.message ||
      `AI Horde error ${res.status}`;

    const err = new Error(String(message));
    err.status = res.status;
    throw err;
  }

  return data;
}

async function loadImageModels() {
  const data = await hordeJson(
    `${HORDE_URL}/v2/status/models?type=image&min_count=1`,
    { method: 'GET' }
  );

  if (!Array.isArray(data)) return [];

  return data
    .map(model =>
      typeof model === 'string'
        ? model
        : model.name || model.model_name || ''
    )
    .filter(Boolean);
}

async function requestImage(prompt, aspect = 'square') {
  const size = SIZES[aspect] || SIZES.square;

  console.log('Starting AI Horde image request');

  const submitted = await hordeJson(
    `${HORDE_URL}/v2/generate/async`,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt: prompt.slice(0, 900),
        params: {
          width: size.w,
          height: size.h,
          steps: 10,
          n: 1,
          cfg_scale: 6,
          sampler_name: 'k_euler',
          karras: true
        },
        nsfw: false,
        censor_nsfw: true,
        r2: true,
        shared: true,
        replacement_filter: true,
        slow_workers: true
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const id = submitted.id;

  if (!id) {
    throw new Error(
      submitted.message || 'AI Horde did not return a request ID.'
    );
  }

  console.log('AI Horde request ID:', id);

  const started = Date.now();
  const maxWait = 6 * 60 * 1000;
  let finished = false;

  while (Date.now() - started < maxWait) {
    await sleep(5000);

    const check = await hordeJson(
      `${HORDE_URL}/v2/generate/check/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(20000)
      }
    );

    if (check.faulted) {
      throw new Error(
        'AI Horde could not find a suitable free worker. Try again later.'
      );
    }

    if (
      check.done === true ||
      Number(check.finished || 0) > 0
    ) {
      finished = true;
      break;
    }

    console.log('AI Horde waiting:', check.wait_time ?? 'unknown');
  }

  if (!finished) {
    throw new Error(
      'Image generation took too long. Please try again later.'
    );
  }

  const result = await hordeJson(
    `${HORDE_URL}/v2/generate/status/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      signal: AbortSignal.timeout(30000)
    }
  );

  if (result.faulted) {
    throw new Error('AI Horde generation failed.');
  }

  const generation = result.generations?.[0];

  if (!generation?.img) {
    throw new Error('No image was returned by AI Horde.');
  }

  const imageUrl = generation.img;

  if (
    typeof imageUrl !== 'string' ||
    !/^https?:\/\//i.test(imageUrl)
  ) {
    throw new Error('Invalid image URL received.');
  }

  const imageResponse = await fetch(imageUrl, {
    signal: AbortSignal.timeout(60000)
  });

  if (!imageResponse.ok) {
    throw new Error(
      `Could not download image (${imageResponse.status}).`
    );
  }

  const contentType =
    imageResponse.headers.get('content-type') || '';

  if (!contentType.startsWith('image/')) {
    throw new Error('The returned file is not an image.');
  }

  const buffer = Buffer.from(
    await imageResponse.arrayBuffer()
  );

  if (buffer.length < 2000) {
    throw new Error('The image file is incomplete.');
  }

  return buffer;
}

// ======================================
// MESSAGE HELPERS
// ======================================

function clean(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^(\s*)\*\s+/gm, '$1• ')
    .replace(/^#{1,6}\s+/gm, '');
}

async function sendLong(ctx, text) {
  let rest = clean(text).trim();

  while (rest.length > 0) {
    let chunk = rest.slice(0, 4000);

    if (rest.length > 4000) {
      const cut = chunk.lastIndexOf('\n');

      if (cut > 2000) {
        chunk = chunk.slice(0, cut);
      }
    }

    await ctx.reply(chunk);
    rest = rest.slice(chunk.length).trimStart();
  }
}

const IMAGE_MARKER =
  /\[\[\s*IMAGE\s*:\s*([\s\S]+?)\s*(?:\|\s*(square|portrait|landscape)\s*)?\]\]/i;

function parseReply(raw) {
  const match = raw.match(IMAGE_MARKER);

  if (!match) {
    return {
      text: raw.trim(),
      prompt: null,
      aspect: 'square'
    };
  }

  return {
    text: raw.replace(IMAGE_MARKER, '').trim(),
    prompt: match[1].trim().slice(0, 900),
    aspect: (match[2] || 'square').toLowerCase()
  };
}

// ======================================
// MAIN RESPONSE
// ======================================

async function respond(
  ctx,
  userContent,
  historyText,
  hasImage = false
) {
  const user = getUser(ctx.from.id);

  if (user.busy) {
    return ctx.reply(
      '⏳ ما زلت أجيب على رسالتك السابقة، انتظر قليلاً.'
    );
  }

  if (Date.now() - user.lastRequest < COOLDOWN_MS) {
    return;
  }

  user.busy = true;
  user.lastRequest = Date.now();

  const typing = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  let timeout;

  try {
    const messages = [
      ...user.history,
      { role: 'user', content: userContent }
    ];

    const raw = await Promise.race([
      callGroq(messages, hasImage),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Groq request timed out')),
          OVERALL_TIMEOUT_MS
        );
      })
    ]);

    const { text, prompt, aspect } = parseReply(raw);
    let saved = text;

    if (text) {
      await sendLong(ctx, text);
    }

    if (prompt) {
      await ctx.reply(
        '🎨 بدأت إنشاء صورتك باستخدام AI Horde المجاني.\n' +
        'قد يستغرق الأمر عدة دقائق حسب توفر العمال.'
      );

      await ctx.sendChatAction('upload_photo').catch(() => {});

      try {
        const image = await requestImage(prompt, aspect);

        await ctx.replyWithPhoto(
          { source: image },
          {
            caption: '🎨 تم إنشاء الصورة بنجاح.'
          }
        );

        saved =
          `${text ? text + '\n' : ''}` +
          `[تم إنشاء صورة: ${prompt}]`;

      } catch (e) {
        console.error('Image generation failed:', e.message);

        let errorMessage =
          '❌ تعذر إنشاء الصورة حالياً.\n\n';

        if (/kudos|budget|heavy demand/i.test(e.message)) {
          errorMessage +=
            'الخدمة تطلب رصيد Kudos لهذا الطلب. ' +
            'تقليل الحجم لا يضمن تجاوز شرط الرصيد.';
        } else {
          errorMessage += String(e.message).slice(0, 500);
        }

        await ctx.reply(errorMessage);

        saved =
          `${text ? text + '\n' : ''}` +
          '[تعذر إنشاء الصورة]';
      }
    }

    user.history.push({
      role: 'user',
      content: historyText
    });

    user.history.push({
      role: 'assistant',
      content: saved || '...'
    });

    if (user.history.length > MAX_HISTORY) {
      user.history = user.history.slice(-MAX_HISTORY);
    }

    while (
      user.history.length &&
      user.history[0].role !== 'user'
    ) {
      user.history.shift();
    }

  } catch (e) {
    console.error('Respond error:', e.message);

    let message = '❌ حدث خطأ. حاول مرة أخرى لاحقاً.';

    if (e.status === 401) {
      message = '❌ مفتاح Groq غير صحيح.';
    } else if (e.status === 403) {
      message = '❌ الوصول إلى Groq مرفوض.';
    } else if (e.status === 404) {
      message = '❌ لا يوجد نموذج متاح لمفتاحك.';
    } else if (e.status === 413) {
      message = '❌ الطلب كبير جداً.';
    } else if (e.status === 429) {
      message = '⏱ تجاوزت الحد المؤقت لمزود الذكاء الاصطناعي. انتظر قليلاً.';
    }

    await ctx.reply(
      message + '\n\n' + String(e.message).slice(0, 250)
    );

  } finally {
    clearInterval(typing);
    clearTimeout(timeout);
    user.busy = false;
  }
}

// ======================================
// TELEGRAM COMMANDS
// ======================================

const startKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(
      '🧹 محادثة جديدة',
      'new'
    )
  ]
]);

bot.start(async ctx => {
  // Remove old bottom Reply Keyboard
  await ctx.reply('👋', Markup.removeKeyboard());

  await ctx.reply(
    '🤖 أهلاً بك في OpenIA Smart Bot!\n\n' +
    '👨‍💻 المطور: YASSINE MESAMAH\n\n' +
    '• اسألني عن أي موضوع وبأي لغة.\n' +
    '• اطلب مني إنشاء أي صورة.\n' +
    '• أرسل صورة واسألني عنها.\n\n' +
    '/new محادثة جديدة\n' +
    '/test فحص الاتصال\n' +
    '/models نماذج المحادثة\n' +
    '/imgmodels نماذج الرسم',
    startKeyboard
  );
});

function resetChat(ctx) {
  getUser(ctx.from.id).history = [];
}

bot.command('new', async ctx => {
  resetChat(ctx);
  await ctx.reply('🧹 بدأت محادثة جديدة.');
});

bot.action('new', async ctx => {
  resetChat(ctx);
  await ctx.answerCbQuery('تم مسح المحادثة');
  await ctx.reply('🧹 بدأت محادثة جديدة.');
});

bot.command('models', async ctx => {
  try {
    const list = await loadModels();
    availableModels = list;

    await ctx.reply(
      list.length
        ? '📋 النماذج المتاحة:\n\n' + list.join('\n')
        : 'لا توجد نماذج متاحة.'
    );

  } catch (e) {
    await ctx.reply(
      '❌ ' + String(e.message).slice(0, 300)
    );
  }
});

bot.command('imgmodels', async ctx => {
  try {
    const list = await loadImageModels();

    await ctx.reply(
      list.length
        ? '🖼 نماذج الرسم النشطة:\n\n' +
          list.slice(0, 40).join('\n')
        : 'لا توجد نماذج رسم نشطة حالياً.'
    );

  } catch (e) {
    await ctx.reply(
      '❌ ' + String(e.message).slice(0, 300)
    );
  }
});

// ======================================
// CONNECTION TEST
// ======================================

bot.command('test', async ctx => {
  const msg = await ctx.reply(
    '🔎 جارٍ فحص الاتصال...\n\n' +
    'Groq: جاري الفحص\n' +
    'AI Horde: جاري الفحص'
  );

  const lines = ['🔎 نتيجة فحص البوت'];

  try {
    const started = Date.now();

    const answer = await callGroq([
      {
        role: 'user',
        content: 'Reply with only OK'
      }
    ]);

    lines.push(
      `✅ Groq يعمل (${((Date.now() - started) / 1000).toFixed(1)} ثانية)`
    );

    lines.push(`الرد: ${answer.slice(0, 30)}`);

  } catch (e) {
    lines.push(
      `❌ Groq: ${String(e.message).slice(0, 200)}`
    );
  }

  try {
    const models = await loadImageModels();

    lines.push(
      `✅ AI Horde متصل (${models.length} نموذج نشط)`
    );

    lines.push('ℹ️ لم يتم إنشاء صورة أثناء الاختبار.');

  } catch (e) {
    lines.push(
      `❌ AI Horde: ${String(e.message).slice(0, 200)}`
    );
  }

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      lines.join('\n')
    );
  } catch (e) {
    console.error('Test update failed:', e.message);
  }
});

// ======================================
// IMAGE ANALYSIS
// ======================================

bot.on('photo', async ctx => {
  try {
    const photos = ctx.message.photo;
    const MAX_BYTES = 2.5 * 1024 * 1024;

    const best =
      [...photos]
        .reverse()
        .find(p => !p.file_size || p.file_size <= MAX_BYTES) ||
      photos[0];

    const link = await ctx.telegram.getFileLink(best.file_id);

    const res = await fetch(link.href, {
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      throw new Error('Image download failed');
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length > MAX_BYTES) {
      throw new Error('Image is too large');
    }

    const data = buffer.toString('base64');

    const caption = (
      ctx.message.caption ||
      'صف هذه الصورة وأجب عن أي سؤال عنها.'
    ).slice(0, 1000);

    await respond(
      ctx,
      [
        { type: 'text', text: caption },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${data}`
          }
        }
      ],
      `[أرسل المستخدم صورة] ${caption}`,
      true
    );

  } catch (e) {
    console.error('Photo error:', e.message);
    await ctx.reply('❌ تعذر قراءة الصورة. حاول بصورة أصغر.');
  }
});

// ======================================
// TEXT MESSAGES
// ======================================

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();

  if (!text || text.startsWith('/')) return;

  if (text.length > 4000) {
    return ctx.reply(
      '✂️ الرسالة طويلة جداً. اختصرها ثم أرسلها.'
    );
  }

  // Answer developer questions directly
  if (developerIdentity(text)) {
    return ctx.reply(DEVELOPER);
  }

  await respond(ctx, text, text, false);
});

// ======================================
// ERROR HANDLING
// ======================================

bot.catch(e => {
  console.error('Telegram bot error:', e.message);
});

// ======================================
// RAILWAY SERVER
// ======================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('OpenIA Smart Bot is Running!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// ======================================
// START BOT
// ======================================

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();

    console.log('OpenIA Smart Bot started.');
    console.log('Developer: YASSINE MESAMAH');
    console.log('Text provider: Groq');
    console.log('Image provider: AI Horde');
    console.log('Daily bot message limit: DISABLED');
    console.log('Bottom Reply Keyboard: REMOVED ON START');

  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.close();
});
