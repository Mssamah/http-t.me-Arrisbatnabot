
'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');

// ==========================================
// RAILWAY VARIABLES
// ==========================================
// BOT_TOKEN             مطلوب
// GROQ_API_KEY          مطلوب
// POLLINATIONS_API_KEY  مطلوب لتوليد الفيديو
// GROQ_MODEL            اختياري
// GROQ_VISION_MODEL     اختياري
// CLIP_MODEL            اختياري
// ALLOWED_USER_ID       اختياري
// DAILY_LIMIT           اختياري

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();

const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '')
  .trim()
  .replace(/^Bearer\s+/i, '')
  .replace(/^["']|["']$/g, '');

const GROQ_MODEL = (
  process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
).trim();

const VISION_MODEL = (
  process.env.GROQ_VISION_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct'
).trim();

const CLIP_MODEL = (
  process.env.CLIP_MODEL || 'alibaba/wan-2.2-fast'
).trim();

const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
const PORT = Number(process.env.PORT) || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const GROQ_URL = 'https://api.groq.com/openai/v1';
const HORDE_URL = 'https://aihorde.net/api';
const POLL_URL = 'https://gen.pollinations.ai';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const users = new Map();

let running = true;
let statusText = 'starting';

const MAX_HISTORY = 20;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

// ==========================================
// ERROR HELPERS
// ==========================================

function errorText(data) {
  if (!data) return 'Unknown error';

  if (typeof data === 'string') return data;

  if (typeof data === 'object') {
    return (
      data.message ||
      data.error?.message ||
      (typeof data.error === 'string' ? data.error : '') ||
      data.detail ||
      data.description ||
      JSON.stringify(data)
    );
  }

  return String(data);
}

async function responseError(r) {
  const body = await r.text().catch(() => '');

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }

  return new Error(
    `HTTP ${r.status}: ${errorText(parsed).slice(0, 1000)}`
  );
}

// ==========================================
// TELEGRAM
// ==========================================

async function tg(method, params = {}, timeout = 40000) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeout)
  });

  const d = await r.json().catch(() => ({}));

  if (!d.ok) {
    const e = new Error(d.description || 'Telegram error');
    e.code = d.error_code || r.status;
    throw e;
  }

  return d.result;
}

async function uploadTelegram(
  method,
  fields,
  field,
  buffer,
  filename,
  mime
) {
  const form = new FormData();

  for (const [k, v] of Object.entries(fields)) {
    form.append(k, String(v));
  }

  form.append(field, new Blob([buffer], { type: mime }), filename);

  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180000)
  });

  const d = await r.json().catch(() => ({}));

  if (!d.ok) {
    throw new Error(d.description || 'Telegram upload error');
  }

  return d.result;
}

const send = (chatId, text, extra = {}) =>
  tg('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    ...extra
  });

const quiet = p => p.catch(() => {});

const action = (chatId, type = 'typing') =>
  quiet(tg('sendChatAction', {
    chat_id: chatId,
    action: type
  }, 10000));

const keyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🧹 محادثة جديدة', callback_data: 'new' }],
      [
        { text: '🎨 رسم صورة', callback_data: 'help_image' },
        { text: '🎥 إنشاء فيديو', callback_data: 'help_video' }
      ]
    ]
  }
};

// ==========================================
// USERS
// ==========================================

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      history: [],
      busy: false,
      last: 0,
      day: '',
      count: 0
    });
  }

  return users.get(id);
}

function today() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Africa/Algiers'
  });
}

async function begin(chatId, id) {
  const u = getUser(id);

  if (u.busy) {
    await quiet(send(chatId, '⏳ انتظر حتى ينتهي الطلب السابق.'));
    return null;
  }

  if (Date.now() - u.last < 1500) return null;

  if (u.day !== today()) {
    u.day = today();
    u.count = 0;
  }

  if (u.count >= DAILY_LIMIT) {
    await quiet(send(chatId, '🚫 وصلت إلى الحد اليومي.'));
    return null;
  }

  u.busy = true;
  u.last = Date.now();

  return u;
}

function saveHistory(u, question, answer) {
  u.history.push(
    { role: 'user', content: question },
    { role: 'assistant', content: answer || 'تم' }
  );

  if (u.history.length > MAX_HISTORY) {
    u.history = u.history.slice(-MAX_HISTORY);
  }
}

// ==========================================
// GROQ CHAT
// ==========================================

function systemPrompt() {
  return `
You are YASSINE AI, a helpful AI assistant inside Telegram.

Always answer in the user's language.
Be accurate, useful and concise.
Do not invent facts.

If the user explicitly asks for an image,
write a short response and then:
[[IMAGE: detailed English image prompt]]

If the user explicitly asks for a video,
write a short response and then:
[[VIDEO: detailed English video prompt]]

Never use these markers unless explicitly requested.
`;
}

async function groq(messages, model = GROQ_MODEL) {
  if (!GROQ_KEY) {
    throw new Error('GROQ_API_KEY غير موجود.');
  }

  const r = await fetch(`${GROQ_URL}/chat/completions`, {
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
      max_tokens: 1500
    }),
    signal: AbortSignal.timeout(45000)
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      `Groq HTTP ${r.status}: ${errorText(d).slice(0, 700)}`
    );
  }

  const answer = d.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error('Groq returned an empty response.');
  }

  return answer;
}

async function makeVideoPrompt(idea) {
  try {
    return await groq([
      {
        role: 'system',
        content:
          'Convert the idea into a detailed English video prompt. ' +
          'Maximum 60 words. Output only the prompt.'
      },
      { role: 'user', content: idea }
    ]);
  } catch (e) {
    console.error('Prompt error:', e.message);
    return idea;
  }
}

// ==========================================
// POLLINATIONS AUTHENTICATION
// ==========================================

async function checkPollinations() {
  if (!POLL_KEY) {
    throw new Error(
      'POLLINATIONS_API_KEY غير موجود في Railway.'
    );
  }

  if (!POLL_KEY.startsWith('sk_')) {
    throw new Error(
      'نوع المفتاح غير صحيح. استخدم Secret Key يبدأ بـ sk_.'
    );
  }

  const r = await fetch(`${POLL_URL}/account/key`, {
    headers: {
      Authorization: `Bearer ${POLL_KEY}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      `Pollinations HTTP ${r.status}: ${errorText(data)}`
    );
  }

  if (data.valid === false) {
    throw new Error('مفتاح Pollinations غير صالح.');
  }

  console.log('Pollinations key verified.');

  return data;
}

// ==========================================
// CHECK VIDEO MODEL
// ==========================================

async function checkVideoModel() {
  const r = await fetch(`${POLL_URL}/video/models`, {
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!r.ok) {
    throw await responseError(r);
  }

  const data = await r.json();

  const models = Array.isArray(data)
    ? data
    : Array.isArray(data.data)
      ? data.data
      : [];

  const found = models.some(m => {
    const id = typeof m === 'string'
      ? m
      : m.name || m.id || m.model;

    const aliases = Array.isArray(m.aliases)
      ? m.aliases
      : [];

    return id === CLIP_MODEL || aliases.includes(CLIP_MODEL);
  });

  if (!found) {
    throw new Error(
      `النموذج ${CLIP_MODEL} غير موجود في قائمة الفيديو الحالية.`
    );
  }

  return true;
}

// ==========================================
// VIDEO GENERATION
// ==========================================

async function requestVideo(prompt) {
  await checkPollinations();

  await checkVideoModel();

  const url =
    `${POLL_URL}/video/` +
    encodeURIComponent(prompt.slice(0, 600)) +
    '?model=' + encodeURIComponent(CLIP_MODEL);

  console.log('Starting video generation:', CLIP_MODEL);

  const r = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${POLL_KEY}`,
      Accept: 'video/mp4'
    },
    signal: AbortSignal.timeout(300000)
  });

  if (!r.ok) {
    throw await responseError(r);
  }

  const contentType = r.headers.get('content-type') || '';

  if (
    contentType.includes('json') ||
    contentType.startsWith('text/')
  ) {
    const body = await r.text();

    throw new Error(
      'Pollinations لم يرجع فيديو: ' + body.slice(0, 1000)
    );
  }

  const buffer = Buffer.from(await r.arrayBuffer());

  if (buffer.length < 10000) {
    throw new Error('الفيديو الناتج صغير أو غير مكتمل.');
  }

  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error('حجم الفيديو أكبر من حد Pollinations.');
  }

  return buffer;
}

async function deliverVideo(chatId, prompt) {
  const msg = await send(
    chatId,
    '🎬 جارٍ إنشاء الفيديو، يرجى الانتظار...'
  );

  const timer = setInterval(
    () => action(chatId, 'upload_video'),
    4000
  );

  try {
    const video = await requestVideo(prompt);

    await uploadTelegram(
      'sendVideo',
      {
        chat_id: chatId,
        caption: '🎥 تم إنشاء الفيديو بنجاح.',
        supports_streaming: 'true'
      },
      'video',
      video,
      'video.mp4',
      'video/mp4'
    );

    await quiet(
      tg('deleteMessage', {
        chat_id: chatId,
        message_id: msg.message_id
      })
    );

    return '[تم إنشاء الفيديو]';

  } catch (e) {
    console.error('Video error:', e.message);

    await quiet(
      tg('editMessageText', {
        chat_id: chatId,
        message_id: msg.message_id,
        text:
          '❌ فشل إنشاء الفيديو:\n' +
          String(e.message).slice(0, 1000)
      })
    );

    return '[فشل إنشاء الفيديو]';

  } finally {
    clearInterval(timer);
  }
}

// ==========================================
// AI HORDE IMAGE GENERATION
// ==========================================

async function horde(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: '0000000000',
      'Client-Agent': 'YASSINE-AI:1.0',
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(30000)
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      `AI Horde HTTP ${r.status}: ${errorText(d)}`
    );
  }

  return d;
}

async function requestImage(prompt) {
  const submitted = await horde(
    `${HORDE_URL}/v2/generate/async`,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt: prompt.slice(0, 900),
        params: {
          width: 512,
          height: 512,
          steps: 10,
          n: 1,
          cfg_scale: 6,
          sampler_name: 'k_euler'
        },
        nsfw: false,
        censor_nsfw: true,
        r2: true
      })
    }
  );

  if (!submitted.id) {
    throw new Error('AI Horde لم يرجع رقم الطلب.');
  }

  const started = Date.now();
  let done = false;

  while (Date.now() - started < 360000) {
    await sleep(5000);

    const check = await horde(
      `${HORDE_URL}/v2/generate/check/${submitted.id}`,
      { method: 'GET' }
    );

    if (check.faulted) {
      throw new Error(
        'تعذر العثور على خادم مجاني للرسم.'
      );
    }

    if (check.done) {
      done = true;
      break;
    }
  }

  if (!done) {
    throw new Error('انتهت مهلة انتظار إنشاء الصورة.');
  }

  const result = await horde(
    `${HORDE_URL}/v2/generate/status/${submitted.id}`,
    { method: 'GET' }
  );

  const imageUrl = result.generations?.[0]?.img;

  if (!imageUrl) {
    throw new Error('لم يتم إنشاء الصورة.');
  }

  const r = await fetch(imageUrl, {
    signal: AbortSignal.timeout(60000)
  });

  if (!r.ok) {
    throw new Error('فشل تحميل الصورة.');
  }

  const type = r.headers.get('content-type') || '';

  if (!type.startsWith('image/')) {
    throw new Error('الملف الناتج ليس صورة.');
  }

  const buffer = Buffer.from(await r.arrayBuffer());

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('الصورة كبيرة جداً.');
  }

  return { buffer, type };
}

// ==========================================
// PARSE AI RESPONSE
// ==========================================

function parseReply(raw) {
  let text = raw;
  let image = null;
  let video = null;

  const vm = text.match(
    /\[\[\s*VIDEO\s*:\s*([\s\S]+?)\s*\]\]/i
  );

  if (vm) {
    video = vm[1].trim();
    text = text.replace(vm[0], '');
  }

  const im = text.match(
    /\[\[\s*IMAGE\s*:\s*([\s\S]+?)\s*\]\]/i
  );

  if (im) {
    image = im[1].trim();
    text = text.replace(im[0], '');
  }

  if (video) image = null;

  return {
    text: text.trim(),
    image,
    video
  };
}

async function sendLong(chatId, text) {
  text = text.trim();

  while (text.length) {
    const part = text.slice(0, 4000);
    await send(chatId, part);
    text = text.slice(part.length).trim();
  }
}

// ==========================================
// MAIN CHAT
// ==========================================

async function respond(chatId, userId, question) {
  const u = await begin(chatId, userId);
  if (!u) return;

  const timer = setInterval(
    () => action(chatId),
    4000
  );

  try {
    const messages = [
      ...u.history,
      { role: 'user', content: question }
    ];

    const raw = await groq(messages);
    const result = parseReply(raw);

    let saved = result.text;

    if (result.text) {
      await sendLong(chatId, result.text);
    }

    if (result.video) {
      saved += '\n' +
        await deliverVideo(chatId, result.video);
    }

    else if (result.image) {
      await send(chatId, '🎨 جارٍ إنشاء الصورة...');

      try {
        const img = await requestImage(result.image);

        await uploadTelegram(
          'sendPhoto',
          {
            chat_id: chatId,
            caption: '🎨 تم إنشاء الصورة.'
          },
          'photo',
          img.buffer,
          'image.png',
          img.type
        );

        saved += '\n[تم إنشاء الصورة]';

      } catch (e) {
        console.error('Image error:', e.message);

        await send(
          chatId,
          '❌ فشل إنشاء الصورة:\n' + e.message
        );

        saved += '\n[فشل إنشاء الصورة]';
      }
    }

    u.count++;
    saveHistory(u, question, saved);

  } catch (e) {
    console.error('Chat error:', e.message);

    await send(
      chatId,
      '❌ حدث خطأ:\n' + e.message.slice(0, 800)
    );

  } finally {
    clearInterval(timer);
    u.busy = false;
  }
}

// ==========================================
// VIDEO COMMAND
// ==========================================

async function cmdClip(chatId, userId, idea) {
  if (!idea) {
    return send(
      chatId,
      'اكتب:\n/clip قطة تمشي في غابة سينمائية'
    );
  }

  const u = await begin(chatId, userId);
  if (!u) return;

  try {
    const prompt = await makeVideoPrompt(idea);

    const result = await deliverVideo(chatId, prompt);

    u.count++;
    saveHistory(u, idea, result);

  } catch (e) {
    console.error('Clip command:', e.message);

    await send(
      chatId,
      '❌ خطأ الفيديو:\n' + e.message
    );

  } finally {
    u.busy = false;
  }
}

// ==========================================
// TEST COMMAND
// ==========================================

async function cmdTest(chatId) {
  const msg = await send(
    chatId,
    '🔎 جارٍ فحص الخدمات...'
  );

  const lines = [
    '🔎 نتيجة فحص YASSINE AI'
  ];

  // GROQ
  try {
    await groq([
      { role: 'user', content: 'Reply only OK' }
    ]);

    lines.push('✅ Groq: يعمل');
    lines.push('النموذج: ' + GROQ_MODEL);

  } catch (e) {
    lines.push(
      '❌ Groq: ' + e.message.slice(0, 250)
    );
  }

  // AI HORDE
  try {
    const r = await horde(
      `${HORDE_URL}/v2/status/models?type=image&min_count=1`,
      { method: 'GET' }
    );

    lines.push(
      `✅ AI Horde: متصل (${Array.isArray(r) ? r.length : 0} نموذج)`
    );

  } catch (e) {
    lines.push(
      '❌ AI Horde: ' + e.message.slice(0, 250)
    );
  }

  // POLLINATIONS KEY
  try {
    const data = await checkPollinations();

    lines.push('✅ Pollinations: المفتاح مقبول');

    if (data.type) {
      lines.push('نوع المفتاح: ' + data.type);
    }

    if (data.permissions) {
      lines.push(
        'الصلاحيات: ' +
        JSON.stringify(data.permissions).slice(0, 500)
      );
    }

  } catch (e) {
    lines.push(
      '❌ Pollinations: ' + e.message.slice(0, 500)
    );
  }

  // VIDEO MODEL
  try {
    await checkVideoModel();

    lines.push(
      '✅ نموذج الفيديو موجود: ' + CLIP_MODEL
    );

  } catch (e) {
    lines.push(
      '❌ نموذج الفيديو: ' + e.message.slice(0, 400)
    );
  }

  lines.push('');
  lines.push('لم يتم إنشاء فيديو أثناء الفحص.');

  await quiet(
    tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text: lines.join('\n')
    })
  );
}

// ==========================================
// PHOTO ANALYSIS
// ==========================================

async function handlePhoto(chatId, userId, message) {
  try {
    const photos = message.photo;
    const photo = photos[photos.length - 1];

    if (photo.file_size > MAX_IMAGE_BYTES) {
      return send(chatId, 'الصورة كبيرة جداً.');
    }

    const file = await tg('getFile', {
      file_id: photo.file_id
    });

    const r = await fetch(
      `${TG_FILE}/${file.file_path}`,
      { signal: AbortSignal.timeout(60000) }
    );

    if (!r.ok) {
      throw new Error('فشل تحميل الصورة.');
    }

    const buffer = Buffer.from(await r.arrayBuffer());

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('الصورة أكبر من الحد المسموح.');
    }

    const caption = message.caption || 'صف هذه الصورة.';

    const u = await begin(chatId, userId);
    if (!u) return;

    try {
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: caption },
          {
            type: 'image_url',
            image_url: {
              url:
                `data:image/jpeg;base64,${buffer.toString('base64')}`
            }
          }
        ]
      }];

      const answer = await fetch(
        `${GROQ_URL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_KEY}`
          },
          body: JSON.stringify({
            model: VISION_MODEL,
            messages: [
              { role: 'system', content: systemPrompt() },
              ...messages
            ],
            max_tokens: 1200
          }),
          signal: AbortSignal.timeout(60000)
        }
      );

      const data = await answer.json().catch(() => ({}));

      if (!answer.ok) {
        throw new Error(
          `Groq Vision HTTP ${answer.status}: ${errorText(data)}`
        );
      }

      const reply =
        data.choices?.[0]?.message?.content || '';

      if (!reply) {
        throw new Error('لم يصل رد تحليل الصورة.');
      }

      await sendLong(chatId, reply);

      u.count++;
      saveHistory(u, '[صورة] ' + caption, reply);

    } finally {
      u.busy = false;
    }

  } catch (e) {
    console.error('Photo error:', e.message);

    await send(
      chatId,
      '❌ تعذر تحليل الصورة:\n' + e.message.slice(0, 800)
    );
  }
}

// ==========================================
// HELP AND COMMANDS
// ==========================================

const HELP =
  '🤖 أهلاً بك في YASSINE AI\n\n' +
  '• محادثة ذكية بالعربية وجميع اللغات.\n' +
  '• تحليل الصور.\n' +
  '• إنشاء الصور.\n' +
  '• إنشاء الفيديو.\n\n' +
  '/new محادثة جديدة\n' +
  '/clip وصف الفيديو\n' +
  '/test فحص الخدمات\n' +
  '/models عرض النماذج\n' +
  '/id رقم حسابك';

async function handleMessage(m) {
  if (!m?.from || !m?.chat) return;

  const chatId = m.chat.id;
  const userId = m.from.id;
  const text = (m.text || '').trim();

  const match = text.match(
    /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/
  );

  const cmd = match?.[1]?.toLowerCase();
  const arg = match?.[2]?.trim() || '';

  if (ALLOWED && userId !== ALLOWED && cmd !== 'id') {
    return;
  }

  if (cmd) {
    switch (cmd) {
      case 'start':
        getUser(userId).history = [];
        return send(chatId, HELP, keyboard);

      case 'new':
        getUser(userId).history = [];
        return send(chatId, '🧹 بدأت محادثة جديدة.');

      case 'id':
        return send(chatId, `رقمك: ${userId}`);

      case 'clip':
        return cmdClip(chatId, userId, arg);

      case 'test':
        return cmdTest(chatId);

      case 'models':
        return send(
          chatId,
          '🤖 نموذج المحادثة: ' + GROQ_MODEL +
          '\n👁️ نموذج الصور: ' + VISION_MODEL +
          '\n🎥 نموذج الفيديو: ' + CLIP_MODEL
        );

      default:
        return send(
          chatId,
          'أمر غير معروف. أرسل /start'
        );
    }
  }

  if (m.photo?.length) {
    return handlePhoto(chatId, userId, m);
  }

  if (text) {
    if (text.length > 4000) {
      return send(chatId, 'الرسالة طويلة جداً.');
    }

    return respond(chatId, userId, text);
  }
}

// ==========================================
// BUTTONS
// ==========================================

async function handleCallback(q) {
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;

  await quiet(
    tg('answerCallbackQuery', {
      callback_query_id: q.id
    })
  );

  if (!chatId || !userId) return;

  if (ALLOWED && userId !== ALLOWED) return;

  if (q.data === 'new') {
    getUser(userId).history = [];
    return send(chatId, '🧹 محادثة جديدة.');
  }

  if (q.data === 'help_image') {
    return send(
      chatId,
      'اكتب: ارسم لي أسداً في غابة.'
    );
  }

  if (q.data === 'help_video') {
    return send(
      chatId,
      'اكتب:\n/clip سيارة رياضية في مدينة مستقبلية'
    );
  }
}

// ==========================================
// TELEGRAM POLLING
// ==========================================

let offset = 0;

async function poll() {
  while (running) {
    try {
      const updates = await tg(
        'getUpdates',
        {
          offset,
          timeout: 30,
          allowed_updates: [
            'message',
            'callback_query'
          ]
        },
        45000
      );

      for (const u of updates) {
        offset = u.update_id + 1;

        const job = u.callback_query
          ? handleCallback(u.callback_query)
          : handleMessage(u.message);

        Promise.resolve(job).catch(e =>
          console.error('Handler:', e.message)
        );
      }

    } catch (e) {
      console.error('Polling:', e.message);

      if (e.code === 401) {
        statusText = 'BOT_TOKEN غير صحيح';
        return;
      }

      await sleep(e.code === 429 ? 5000 : 3000);
    }
  }
}

// ==========================================
// RAILWAY HTTP SERVER
// ==========================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('YASSINE AI: ' + statusText);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT);
});

// ==========================================
// START
// ==========================================

async function main() {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN غير موجود');
  }

  if (!GROQ_KEY) {
    throw new Error('GROQ_API_KEY غير موجود');
  }

  const me = await tg('getMe');

  console.log('Bot connected:', me.username);

  await quiet(
    tg('deleteWebhook', {
      drop_pending_updates: true
    })
  );

  await quiet(
    tg('setMyCommands', {
      commands: [
        { command: 'start', description: 'بدء البوت' },
        { command: 'new', description: 'محادثة جديدة' },
        { command: 'clip', description: 'إنشاء فيديو' },
        { command: 'test', description: 'فحص الخدمات' },
        { command: 'models', description: 'عرض النماذج' },
        { command: 'id', description: 'رقم المستخدم' }
      ]
    })
  );

  statusText = 'online @' + me.username;

  console.log('YASSINE AI started.');
  console.log('Groq model:', GROQ_MODEL);
  console.log('Vision model:', VISION_MODEL);
  console.log('Video key configured:', Boolean(POLL_KEY));
  console.log('Video model:', CLIP_MODEL);

  poll();
}

main().catch(e => {
  statusText = 'startup error';
  console.error('Startup error:', e.message);
});

process.on('unhandledRejection', e => {
  console.error('Unhandled rejection:', e);
});

function shutdown() {
  running = false;

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 3000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
