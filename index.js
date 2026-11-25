'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================================
// Railway Variables
// ======================================================
// BOT_TOKEN             مطلوب
// GROQ_API_KEY          مطلوب
// POLLINATIONS_API_KEY  مطلوب للفيديو فقط
// CLIP_MODEL            اختياري (الافتراضي: wan-fast)
// GROQ_MODEL            اختياري
// GROQ_VISION_MODEL     اختياري
// ALLOWED_USER_ID       اختياري (رقمك في تيليجرام، أرسل /id لمعرفته)
// DAILY_LIMIT           اختياري (الافتراضي: 60)
// HORDE_CLIENT_AGENT    اختياري

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '').trim();
const CLIP_MODEL = (process.env.CLIP_MODEL || 'wan-fast').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
const PORT = Number(process.env.PORT) || 3000;

const COOLDOWN_MS = 1500;
const MAX_HISTORY = 20;
const GROQ_TOTAL_TIMEOUT_MS = 60000;
const MAX_VIDEO_BYTES = 49 * 1024 * 1024;

const HORDE_URL = 'https://aihorde.net/api';
const HORDE_KEY = '0000000000';
const HORDE_AGENT = (process.env.HORDE_CLIENT_AGENT || 'TelegramAIBot:2.0').trim();

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing');
  process.exit(1);
}

if (!GROQ_KEY) {
  console.error('GROQ_API_KEY is missing');
  process.exit(1);
}

// handlerTimeout كبير لأن توليد الفيديو قد يستغرق عدة دقائق
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 15 * 60 * 1000 });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unique = arr => [...new Set(arr.filter(Boolean))];

// تشغيل مهمة طويلة في الخلفية حتى لا يتجمد البوت أثناءها
function background(fn) {
  Promise.resolve()
    .then(fn)
    .catch(e => console.error('Background error:', e.message));
}

// ======================================================
// Access control
// ======================================================

bot.use((ctx, next) => {
  if (!ALLOWED) return next();

  const text = (ctx.message?.text || '').trim();

  // الأمر /id مسموح للجميع ليعرف المستخدم رقمه
  if (/^\/id(@\w+)?$/i.test(text)) return next();

  if (ctx.from?.id !== ALLOWED) {
    console.log('Blocked user id:', ctx.from?.id);
    return;
  }

  return next();
});

bot.command('id', ctx => ctx.reply(`🆔 رقمك في تيليجرام: ${ctx.from.id}`));

// ======================================================
// Models
// ======================================================

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

// ======================================================
// User data
// ======================================================

const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      history: [],
      lastRequest: 0,
      day: '',
      count: 0,
      busy: false
    });
  }

  return users.get(id);
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Algiers' });
}

// يتحقق من الازدحام والمهلة والحد اليومي ثم يحجز المستخدم
async function beginRequest(ctx) {
  const user = getUser(ctx.from.id);

  if (user.busy) {
    await ctx.reply('⏳ ما زلت أعالج طلبك السابق، انتظر قليلاً.').catch(() => {});
    return null;
  }

  if (Date.now() - user.lastRequest < COOLDOWN_MS) {
    return null;
  }

  if (user.day !== today()) {
    user.day = today();
    user.count = 0;
  }

  if (user.count >= DAILY_LIMIT) {
    await ctx.reply('🚫 وصلت إلى الحد اليومي للرسائل. عُد غداً.').catch(() => {});
    return null;
  }

  user.busy = true;
  user.lastRequest = Date.now();

  return user;
}

function pushHistory(user, userText, assistantText) {
  user.history.push({ role: 'user', content: userText });
  user.history.push({ role: 'assistant', content: assistantText || '...' });

  if (user.history.length > MAX_HISTORY) {
    user.history = user.history.slice(-MAX_HISTORY);
  }

  while (user.history.length && user.history[0].role !== 'user') {
    user.history.shift();
  }
}

// ======================================================
// Groq
// ======================================================

function systemPrompt() {
  const date = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Africa/Algiers',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return (
    'You are a helpful AI assistant inside a Telegram bot. ' +
    'Always answer in the same language as the user. ' +
    'Be accurate, friendly and reasonably concise. ' +
    'Never invent facts. ' +
    `Today is ${date}. ` +
    'When the user explicitly asks to generate an image, ' +
    'write one short sentence in their language, then add this exact marker: ' +
    '[[IMAGE: detailed English image description | square]] ' +
    'Use only square as the image format. ' +
    'Never use the image marker unless the user explicitly requests an image. ' +
    'When the user explicitly asks to generate a video or clip, ' +
    'write one short sentence in their language, then add this exact marker: ' +
    '[[VIDEO: detailed English video description with subject, motion, setting, lighting and camera movement, max 60 words]] ' +
    'Never use the video marker unless the user explicitly requests a video.'
  );
}

async function loadModels() {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    signal: AbortSignal.timeout(15000)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error?.message || `Groq error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return (data.data || [])
    .map(m => m.id)
    .filter(id => !/whisper|tts|guard|embed|safeguard|orpheus|playai/i.test(id));
}

let availableModels = null;

async function callModel(model, messages, withSystem = true) {
  const finalMessages = withSystem
    ? [{ role: 'system', content: systemPrompt() }, ...messages]
    : messages;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: finalMessages,
      temperature: 0.7,
      max_tokens: 2048
    }),
    signal: AbortSignal.timeout(25000)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error?.message || `Groq error ${res.status}`);
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
    const matching = base.filter(m => availableModels.includes(m));

    const extra = availableModels.filter(m =>
      hasImage
        ? /vision|scout|maverick|llama-4/i.test(m)
        : /llama|gpt-oss|qwen|kimi|gemma/i.test(m)
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

      const retryable =
        e.status === 404 ||
        e.status === 429 ||
        e.status >= 500 ||
        !e.status ||
        (e.status === 400 && /model|decommission/i.test(e.message));

      if (!retryable) throw e;
    }
  }

  throw lastError || new Error('All Groq models failed');
}

// تحويل فكرة المستخدم إلى وصف فيديو إنجليزي مفصل (للأمر /clip)
async function videoPromptFromIdea(idea) {
  try {
    const answer = await callModel(
      TEXT_MODELS[0],
      [
        {
          role: 'system',
          content:
            'Convert the idea into one detailed English text-to-video prompt. ' +
            'Maximum 60 words. Describe subject, visible motion, setting, ' +
            'lighting, camera movement and visual style. Output only the prompt.'
        },
        { role: 'user', content: idea }
      ],
      false
    );

    return answer.replace(/^["']|["']$/g, '').slice(0, 600);
  } catch (e) {
    console.error('Video prompt error:', e.message);
    return idea;
  }
}

// ======================================================
// AI Horde (images)
// ======================================================

const SIZES = {
  square: { w: 512, h: 512 },
  portrait: { w: 448, h: 576 },
  landscape: { w: 576, h: 448 }
};

async function hordeJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: HORDE_KEY,
      'Client-Agent': HORDE_AGENT,
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
    .map(m => (typeof m === 'string' ? m : m.name || m.model_name || ''))
    .filter(Boolean);
}

async function requestImage(prompt, aspect = 'square') {
  const size = SIZES[aspect] || SIZES.square;

  console.log('Starting AI Horde image request', size.w, 'x', size.h);

  const submitted = await hordeJson(`${HORDE_URL}/v2/generate/async`, {
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
    })
  });

  const id = submitted.id;

  if (!id) {
    throw new Error(submitted.message || 'AI Horde did not return a request ID.');
  }

  console.log('AI Horde request ID:', id);

  const started = Date.now();
  const maxWait = 6 * 60 * 1000;
  let finished = false;

  while (Date.now() - started < maxWait) {
    await sleep(5000);

    const check = await hordeJson(
      `${HORDE_URL}/v2/generate/check/${encodeURIComponent(id)}`,
      { method: 'GET', signal: AbortSignal.timeout(20000) }
    );

    if (check.faulted) {
      throw new Error('AI Horde could not find a suitable free worker. Try again later.');
    }

    if (check.done === true || Number(check.finished || 0) > 0) {
      finished = true;
      break;
    }

    console.log('AI Horde waiting:', check.wait_time ?? 'unknown', 'seconds');
  }

  if (!finished) {
    throw new Error('Image generation took too long. Please try again later.');
  }

  const result = await hordeJson(
    `${HORDE_URL}/v2/generate/status/${encodeURIComponent(id)}`,
    { method: 'GET' }
  );

  if (result.faulted) {
    throw new Error('AI Horde generation failed.');
  }

  const imageUrl = result.generations?.[0]?.img;

  if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
    throw new Error('No valid image was returned by AI Horde.');
  }

  const imageResponse = await fetch(imageUrl, {
    signal: AbortSignal.timeout(60000)
  });

  if (!imageResponse.ok) {
    throw new Error(`Could not download image (${imageResponse.status}).`);
  }

  const contentType = imageResponse.headers.get('content-type') || '';

  if (!contentType.startsWith('image/')) {
    throw new Error('The returned file is not an image.');
  }

  const buffer = Buffer.from(await imageResponse.arrayBuffer());

  if (buffer.length < 2000) {
    throw new Error('The image file is incomplete.');
  }

  return buffer;
}

// ======================================================
// Pollinations (video)
// ======================================================

async function requestVideo(prompt) {
  if (!POLL_KEY) {
    throw new Error('POLLINATIONS_API_KEY غير موجود في Railway Variables');
  }

  const seed = Math.floor(Math.random() * 1000000000);

  const url =
    'https://gen.pollinations.ai/video/' +
    encodeURIComponent(prompt.slice(0, 600)) +
    `?model=${encodeURIComponent(CLIP_MODEL)}` +
    `&seed=${seed}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${POLL_KEY}` },
    signal: AbortSignal.timeout(6 * 60 * 1000)
  });

  const type = res.headers.get('content-type') || '';

  if (!res.ok || type.includes('json') || type.startsWith('text/')) {
    const body = (await res.text().catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 300);

    throw new Error(`${res.status} ${body}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length < 10000) {
    throw new Error('الفيديو المُرجع صغير جداً.');
  }

  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error('حجم الفيديو أكبر من الحد المسموح لإرساله عبر البوت.');
  }

  return buffer;
}

// يولّد الفيديو ويرسله، ويرجع نصاً يُحفظ في السجل
async function deliverVideo(ctx, prompt) {
  const status = await ctx.reply(
    '🎬 بدأت إنشاء الفيديو.\nقد يستغرق ذلك عدة دقائق.'
  );

  const action = setInterval(() => {
    ctx.sendChatAction('upload_video').catch(() => {});
  }, 4000);

  try {
    const video = await requestVideo(prompt);

    await ctx.replyWithVideo(
      { source: video, filename: 'video.mp4' },
      {
        caption: '🎥 تم إنشاء الفيديو بنجاح.\n\n' + prompt.slice(0, 900),
        supports_streaming: true
      }
    );

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    return `[تم إنشاء فيديو: ${prompt}]`;
  } catch (e) {
    console.error('Video generation failed:', e.message);

    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        '❌ فشل إنشاء الفيديو:\n' + String(e.message).slice(0, 500)
      )
      .catch(() => {});

    return '[تعذر إنشاء الفيديو]';
  } finally {
    clearInterval(action);
  }
}

// ======================================================
// Message helpers
// ======================================================

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
      if (cut > 2000) chunk = chunk.slice(0, cut);
    }

    await ctx.reply(chunk);
    rest = rest.slice(chunk.length).trimStart();
  }
}

const IMAGE_MARKER =
  /\[\[\s*IMAGE\s*:\s*([\s\S]+?)\s*(?:\|\s*(square|portrait|landscape)\s*)?\]\]/i;

const VIDEO_MARKER = /\[\[\s*VIDEO\s*:\s*([\s\S]+?)\s*\]\]/i;

function parseReply(raw) {
  let text = raw;
  let prompt = null;
  let aspect = 'square';
  let videoPrompt = null;

  const video = text.match(VIDEO_MARKER);

  if (video) {
    videoPrompt = video[1].trim().slice(0, 600);
    text = text.replace(VIDEO_MARKER, '');
  }

  const image = text.match(IMAGE_MARKER);

  if (image) {
    prompt = image[1].trim().slice(0, 900);
    aspect = (image[2] || 'square').toLowerCase();
    text = text.replace(IMAGE_MARKER, '');
  }

  // لا نولّد صورة وفيديو معاً، والفيديو له الأولوية
  if (videoPrompt) prompt = null;

  return { text: text.trim(), prompt, aspect, videoPrompt };
}

// ======================================================
// Main response
// ======================================================

async function respond(ctx, userContent, historyText, hasImage = false) {
  const user = await beginRequest(ctx);

  if (!user) return;

  const typing = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  let timer;

  try {
    const messages = [...user.history, { role: 'user', content: userContent }];

    const raw = await Promise.race([
      callGroq(messages, hasImage),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Groq request timed out')),
          GROQ_TOTAL_TIMEOUT_MS
        );
      })
    ]);

    clearTimeout(timer);

    const { text, prompt, aspect, videoPrompt } = parseReply(raw);

    let saved = text;

    if (text) {
      await sendLong(ctx, text);
    }

    if (videoPrompt) {
      const note = await deliverVideo(ctx, videoPrompt);
      saved = `${text ? text + '\n' : ''}${note}`;
    } else if (prompt) {
      await ctx.reply(
        '🎨 بدأت إنشاء صورتك باستخدام AI Horde المجاني.\n' +
          'قد يستغرق الأمر عدة دقائق حسب توفر العمال.'
      );

      await ctx.sendChatAction('upload_photo').catch(() => {});

      try {
        const image = await requestImage(prompt, aspect);

        await ctx.replyWithPhoto(
          { source: image },
          { caption: '🎨 تم إنشاء الصورة بنجاح.' }
        );

        saved = `${text ? text + '\n' : ''}[تم إنشاء صورة: ${prompt}]`;
      } catch (e) {
        console.error('Image generation failed:', e.message);

        let errorMessage = '❌ تعذر إنشاء الصورة حالياً.\n\n';

        if (/kudos|budget|heavy demand/i.test(e.message)) {
          errorMessage +=
            'الخدمة تطلب رصيد Kudos لهذا الطلب. ' +
            'تقليل الحجم لا يضمن تجاوز شرط الرصيد.';
        } else {
          errorMessage += String(e.message).slice(0, 500);
        }

        await ctx.reply(errorMessage);

        saved = `${text ? text + '\n' : ''}[تعذر إنشاء الصورة]`;
      }
    }

    user.count += 1;
    pushHistory(user, historyText, saved);
  } catch (e) {
    clearTimeout(timer);
    console.error('Respond error:', e.message);

    let message = '❌ حدث خطأ. حاول مرة أخرى لاحقاً.';

    if (e.status === 401) message = '❌ مفتاح Groq غير صحيح.';
    else if (e.status === 403) message = '❌ الوصول إلى Groq مرفوض.';
    else if (e.status === 404) message = '❌ لا يوجد نموذج متاح لمفتاحك.';
    else if (e.status === 413) message = '❌ الطلب كبير جداً.';
    else if (e.status === 429) message = '⏱ تجاوزت الحد المؤقت. انتظر قليلاً.';

    await ctx
      .reply(message + '\n\n' + String(e.message).slice(0, 250))
      .catch(() => {});
  } finally {
    clearInterval(typing);
    user.busy = false;
  }
}

// ======================================================
// Commands
// ======================================================

const startKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🧹 محادثة جديدة', 'new')],
  [
    Markup.button.callback('🎨 رسم صورة', 'help_image'),
    Markup.button.callback('🎥 إنشاء فيديو', 'help_video')
  ]
]);

bot.start(ctx =>
  ctx.reply(
    '🤖 أهلاً بك! أنا مساعدك الذكي.\n\n' +
      '• اسألني عن أي موضوع وبأي لغة.\n' +
      '• اطلب مني رسم أي صورة.\n' +
      '• اطلب مني إنشاء فيديو، أو استخدم /clip.\n' +
      '• أرسل صورة واسألني عنها.\n\n' +
      '/new محادثة جديدة\n' +
      '/clip وصف الفيديو\n' +
      '/test فحص الاتصال\n' +
      '/models نماذج المحادثة\n' +
      '/imgmodels نماذج الرسم\n' +
      '/id رقمك في تيليجرام',
    startKeyboard
  )
);

function resetChat(ctx) {
  getUser(ctx.from.id).history = [];
}

bot.command('new', async ctx => {
  resetChat(ctx);
  await ctx.reply('🧹 بدأت محادثة جديدة.');
});

bot.action('new', async ctx => {
  resetChat(ctx);
  await ctx.answerCbQuery('تم مسح المحادثة').catch(() => {});
  await ctx.reply('🧹 بدأت محادثة جديدة.');
});

bot.action('help_image', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '🎨 لرسم صورة اكتب مثلاً:\n\n' +
      'ارسم لي أسداً واقعياً في غابة سينمائية'
  );
});

bot.action('help_video', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '🎥 لإنشاء فيديو أرسل:\n\n' +
      '/clip وصف الفيديو\n\n' +
      'مثال:\n' +
      '/clip سيارة رياضية تسير في مدينة مستقبلية\n\n' +
      'أو اكتب طلبك بشكل عادي: "أنشئ لي فيديو لقطة تمشي في غابة".'
  );
});

bot.command('clip', ctx => {
  const idea = ctx.message.text.replace(/^\/clip(@\w+)?/i, '').trim();

  if (!idea) {
    return ctx.reply(
      '🎥 أرسل وصف الفيديو بعد الأمر:\n\n' +
        '/clip قطة تمشي في غابة جميلة'
    );
  }

  if (!POLL_KEY) {
    return ctx.reply('❌ مفتاح POLLINATIONS_API_KEY غير موجود في Railway.');
  }

  background(async () => {
    const user = await beginRequest(ctx);

    if (!user) return;

    try {
      const prompt = await videoPromptFromIdea(idea.slice(0, 500));
      const note = await deliverVideo(ctx, prompt);

      user.count += 1;
      pushHistory(user, `[طلب فيديو] ${idea}`, note);
    } catch (e) {
      console.error('Clip error:', e.message);
      await ctx
        .reply('❌ حدث خطأ:\n' + String(e.message).slice(0, 300))
        .catch(() => {});
    } finally {
      user.busy = false;
    }
  });
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
    await ctx.reply('❌ ' + String(e.message).slice(0, 300));
  }
});

bot.command('imgmodels', async ctx => {
  try {
    const list = await loadImageModels();

    await ctx.reply(
      list.length
        ? '🖼 نماذج الرسم النشطة:\n\n' + list.slice(0, 40).join('\n')
        : 'لا توجد نماذج رسم نشطة حالياً.'
    );
  } catch (e) {
    await ctx.reply('❌ ' + String(e.message).slice(0, 300));
  }
});

// فحص الاتصال (لا يولّد صورة ولا فيديو)
bot.command('test', ctx => {
  background(async () => {
    const msg = await ctx.reply('🔎 جارٍ فحص الاتصال...');

    const lines = ['🔎 نتيجة فحص البوت'];

    try {
      const started = Date.now();
      const answer = await callGroq([{ role: 'user', content: 'Reply with only OK' }]);

      lines.push(`✅ Groq يعمل (${((Date.now() - started) / 1000).toFixed(1)} ثانية)`);
      lines.push(`الرد: ${answer.slice(0, 30)}`);
    } catch (e) {
      lines.push(`❌ Groq: ${String(e.message).slice(0, 200)}`);
    }

    try {
      const models = await loadImageModels();
      lines.push(`✅ AI Horde متصل (${models.length} نموذج نشط)`);
    } catch (e) {
      lines.push(`❌ AI Horde: ${String(e.message).slice(0, 200)}`);
    }

    lines.push(
      POLL_KEY
        ? `✅ مفتاح الفيديو موجود (النموذج: ${CLIP_MODEL})`
        : '❌ POLLINATIONS_API_KEY غير موجود'
    );

    lines.push('ℹ️ لم يتم إنشاء صورة أو فيديو أثناء الفحص.');

    await ctx.telegram
      .editMessageText(ctx.chat.id, msg.message_id, undefined, lines.join('\n'))
      .catch(() => {});
  });
});

// ======================================================
// Photos
// ======================================================

bot.on('photo', ctx => {
  background(async () => {
    try {
      const photos = ctx.message.photo;
      const MAX_BYTES = 2.5 * 1024 * 1024;

      const best =
        [...photos].reverse().find(p => !p.file_size || p.file_size <= MAX_BYTES) ||
        photos[0];

      const link = await ctx.telegram.getFileLink(best.file_id);

      const res = await fetch(link.href, { signal: AbortSignal.timeout(30000) });

      if (!res.ok) throw new Error('Image download failed');

      const buffer = Buffer.from(await res.arrayBuffer());

      if (buffer.length > MAX_BYTES) throw new Error('Image is too large');

      const data = buffer.toString('base64');

      const caption = (
        ctx.message.caption || 'صف هذه الصورة وأجب عن أي سؤال عنها.'
      ).slice(0, 1000);

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
      await ctx.reply('❌ تعذر قراءة الصورة. حاول بصورة أصغر.').catch(() => {});
    }
  });
});

// ======================================================
// Text
// ======================================================

bot.on('text', ctx => {
  const text = ctx.message.text.trim();

  if (!text || text.startsWith('/')) return;

  if (text.length > 4000) {
    return ctx.reply('✂️ الرسالة طويلة جداً. اختصرها ثم أرسلها.');
  }

  background(() => respond(ctx, text, text, false));
});

// ======================================================
// Errors
// ======================================================

bot.catch(e => {
  console.error('Telegram bot error:', e.message);
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
});

// ======================================================
// HTTP server (Railway)
// ======================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('AI Telegram Bot is Running!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// ======================================================
// Start
// ======================================================

async function start() {
  try {
    const me = await bot.telegram.getMe();
    console.log(`Bot token OK: @${me.username}`);

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // launch لا يعود إلا عند إيقاف البوت، لذلك لا نستخدم await هنا
    bot.launch({ dropPendingUpdates: true }).catch(e => {
      console.error('Launch failed:', e.message);
      process.exit(1);
    });

    console.log('Telegram AI Bot started.');
    console.log(`Allowed user: ${ALLOWED || 'everyone'}`);
    console.log(`Video: ${POLL_KEY ? 'enabled (' + CLIP_MODEL + ')' : 'disabled (no key)'}`);
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
}

start();

function shutdown(signal) {
  try {
    bot.stop(signal);
  } catch {}

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
