'use strict';

// ======================================================
// بوت تيليجرام: محادثة + تحليل صور + رسم + فيديو
// بدون أي مكتبات خارجية (Node 20 فقط) فلا يوجد خطأ "Cannot find module"
// ======================================================
//
// Railway Variables:
//   BOT_TOKEN             مطلوب  (من @BotFather)
//   GROQ_API_KEY          مطلوب  (من console.groq.com)
//   POLLINATIONS_API_KEY  اختياري (للفيديو فقط)
//   CLIP_MODEL            اختياري (الافتراضي wan-fast)
//   GROQ_MODEL            اختياري
//   GROQ_VISION_MODEL     اختياري
//   ALLOWED_USER_ID       اختياري (رقمك، أرسل /id لمعرفته)
//   DAILY_LIMIT           اختياري (الافتراضي 60)

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '')
  .trim()
  .replace(/^["']|["']$/g, '')
  .replace(/^Bearer\s+/i, '')
  .trim();
const CLIP_MODEL = (process.env.CLIP_MODEL || 'wan-fast').trim();
const ALLOWED = Number(process.env.ALLOWED_USER_ID) || null;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
const PORT = Number(process.env.PORT) || 3000;

const COOLDOWN_MS = 1500;
const MAX_HISTORY = 20;
const MAX_VIDEO_BYTES = 49 * 1024 * 1024;
const HORDE_URL = 'https://aihorde.net/api';
const HORDE_KEY = '0000000000';
const HORDE_AGENT = (process.env.HORDE_CLIENT_AGENT || 'TelegramAIBot:3.0').trim();

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const unique = arr => [...new Set(arr.filter(Boolean))];

let statusText = 'starting';
let running = true;

// ======================================================
// Telegram API (بدون مكتبات)
// ======================================================

async function tg(method, params = {}, timeoutMs = 40000) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await res.json().catch(() => ({}));

  if (!data.ok) {
    const err = new Error(data.description || `Telegram HTTP ${res.status}`);
    err.code = data.error_code || res.status;
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }

  return data.result;
}

async function tgUpload(method, fields, fileField, buffer, filename, mime) {
  const form = new FormData();

  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }

  form.append(fileField, new Blob([buffer], { type: mime }), filename);

  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180000)
  });

  const data = await res.json().catch(() => ({}));

  if (!data.ok) {
    const err = new Error(data.description || `Telegram HTTP ${res.status}`);
    err.code = data.error_code || res.status;
    throw err;
  }

  return data.result;
}

const send = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4096), ...extra });

const quiet = p => p.catch(() => {});

const typing = (chatId, action = 'typing') =>
  quiet(tg('sendChatAction', { chat_id: chatId, action }, 10000));

const startKeyboard = {
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

function clean(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^(\s*)\*\s+/gm, '$1• ')
    .replace(/^#{1,6}\s+/gm, '');
}

async function sendLong(chatId, text) {
  let rest = clean(text).trim();

  while (rest.length > 0) {
    let chunk = rest.slice(0, 4000);

    if (rest.length > 4000) {
      const cut = chunk.lastIndexOf('\n');
      if (cut > 2000) chunk = chunk.slice(0, cut);
    }

    await send(chatId, chunk);
    rest = rest.slice(chunk.length).trimStart();
  }
}

// ======================================================
// بيانات المستخدمين
// ======================================================

const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, { history: [], lastRequest: 0, day: '', count: 0, busy: false });
  }
  return users.get(id);
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Algiers' });
}

// يتحقق من الازدحام والمهلة والحد اليومي ثم يحجز المستخدم
async function beginRequest(chatId, userId) {
  const user = getUser(userId);

  if (user.busy) {
    await quiet(send(chatId, '⏳ ما زلت أعالج طلبك السابق، انتظر قليلاً.'));
    return null;
  }

  if (Date.now() - user.lastRequest < COOLDOWN_MS) return null;

  if (user.day !== today()) {
    user.day = today();
    user.count = 0;
  }

  if (user.count >= DAILY_LIMIT) {
    await quiet(send(chatId, '🚫 وصلت إلى الحد اليومي للرسائل. عُد غداً.'));
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
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: withSystem
        ? [{ role: 'system', content: systemPrompt() }, ...messages]
        : messages,
      temperature: 0.7,
      max_tokens: 2048
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error?.message || `Groq error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('Groq returned an empty response');

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
// AI Horde (رسم)
// ======================================================

async function hordeJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: HORDE_KEY,
      'Client-Agent': HORDE_AGENT
    },
    signal: options.signal || AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      String(data.message || data.error || data.errors?.[0]?.message || `AI Horde error ${res.status}`)
    );
    err.status = res.status;
    throw err;
  }

  return data;
}

async function loadImageModels() {
  const data = await hordeJson(`${HORDE_URL}/v2/status/models?type=image&min_count=1`, {
    method: 'GET'
  });

  if (!Array.isArray(data)) return [];

  return data
    .map(m => (typeof m === 'string' ? m : m.name || m.model_name || ''))
    .filter(Boolean);
}

async function requestImage(prompt) {
  const submitted = await hordeJson(`${HORDE_URL}/v2/generate/async`, {
    method: 'POST',
    body: JSON.stringify({
      prompt: prompt.slice(0, 900),
      params: {
        width: 512,
        height: 512,
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
  if (!id) throw new Error(submitted.message || 'AI Horde did not return a request ID.');

  const started = Date.now();
  let finished = false;

  while (Date.now() - started < 6 * 60 * 1000) {
    await sleep(5000);

    const check = await hordeJson(
      `${HORDE_URL}/v2/generate/check/${encodeURIComponent(id)}`,
      { method: 'GET', signal: AbortSignal.timeout(20000) }
    );

    if (check.faulted) {
      throw new Error('AI Horde could not find a free worker. Try again later.');
    }

    if (check.done === true || Number(check.finished || 0) > 0) {
      finished = true;
      break;
    }
  }

  if (!finished) throw new Error('Image generation took too long. Try again later.');

  const result = await hordeJson(
    `${HORDE_URL}/v2/generate/status/${encodeURIComponent(id)}`,
    { method: 'GET' }
  );

  if (result.faulted) throw new Error('AI Horde generation failed.');

  const imageUrl = result.generations?.[0]?.img;

  if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
    throw new Error('No valid image was returned by AI Horde.');
  }

  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });

  if (!imgRes.ok) throw new Error(`Could not download image (${imgRes.status}).`);

  const type = imgRes.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('The returned file is not an image.');

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.length < 2000) throw new Error('The image file is incomplete.');

  return { buffer, type };
}

// ======================================================
// Pollinations (فيديو)
// ======================================================

async function requestVideo(prompt) {
  if (!POLL_KEY) throw new Error('POLLINATIONS_API_KEY غير موجود في Railway Variables');

  const seed = Math.floor(Math.random() * 1000000000);

  const baseUrl =
    'https://gen.pollinations.ai/video/' +
    encodeURIComponent(prompt.slice(0, 600)) +
    `?model=${encodeURIComponent(CLIP_MODEL)}&seed=${seed}`;

  let res = await fetch(baseUrl, {
    headers: { Authorization: `Bearer ${POLL_KEY}` },
    signal: AbortSignal.timeout(6 * 60 * 1000)
  });

  // محاولة ثانية: إرسال المفتاح كمعامل في الرابط (طريقة موثقة أيضاً)
  if (res.status === 401) {
    console.error('Pollinations 401 with header, retrying with key parameter');

    res = await fetch(`${baseUrl}&key=${encodeURIComponent(POLL_KEY)}`, {
      signal: AbortSignal.timeout(6 * 60 * 1000)
    });
  }

  const type = res.headers.get('content-type') || '';

  if (!res.ok || type.includes('json') || type.startsWith('text/')) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`${res.status} ${body}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length < 10000) throw new Error('الفيديو المُرجع صغير جداً.');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('حجم الفيديو أكبر من الحد المسموح للإرسال.');

  return buffer;
}

async function deliverVideo(chatId, prompt) {
  const status = await send(chatId, '🎬 بدأت إنشاء الفيديو.\nقد يستغرق ذلك عدة دقائق.');

  const timer = setInterval(() => typing(chatId, 'upload_video'), 4000);

  try {
    const video = await requestVideo(prompt);

    await tgUpload(
      'sendVideo',
      {
        chat_id: chatId,
        caption: '🎥 تم إنشاء الفيديو بنجاح.\n\n' + prompt.slice(0, 900),
        supports_streaming: 'true'
      },
      'video',
      video,
      'video.mp4',
      'video/mp4'
    );

    await quiet(tg('deleteMessage', { chat_id: chatId, message_id: status.message_id }));

    return `[تم إنشاء فيديو: ${prompt}]`;
  } catch (e) {
    console.error('Video generation failed:', e.message);

    await quiet(
      tg('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: '❌ فشل إنشاء الفيديو:\n' + String(e.message).slice(0, 500)
      })
    );

    return '[تعذر إنشاء الفيديو]';
  } finally {
    clearInterval(timer);
  }
}

// ======================================================
// الرد الرئيسي
// ======================================================

const IMAGE_MARKER = /\[\[\s*IMAGE\s*:\s*([\s\S]+?)\s*(?:\|\s*(?:square|portrait|landscape)\s*)?\]\]/i;
const VIDEO_MARKER = /\[\[\s*VIDEO\s*:\s*([\s\S]+?)\s*\]\]/i;

function parseReply(raw) {
  let text = raw;
  let imagePrompt = null;
  let videoPrompt = null;

  const video = text.match(VIDEO_MARKER);
  if (video) {
    videoPrompt = video[1].trim().slice(0, 600);
    text = text.replace(VIDEO_MARKER, '');
  }

  const image = text.match(IMAGE_MARKER);
  if (image) {
    imagePrompt = image[1].trim().slice(0, 900);
    text = text.replace(IMAGE_MARKER, '');
  }

  if (videoPrompt) imagePrompt = null;

  return { text: text.trim(), imagePrompt, videoPrompt };
}

async function respond(chatId, userId, userContent, historyText, hasImage = false) {
  const user = await beginRequest(chatId, userId);
  if (!user) return;

  const timer = setInterval(() => typing(chatId), 4000);
  typing(chatId);

  try {
    const raw = await callGroq([...user.history, { role: 'user', content: userContent }], hasImage);

    const { text, imagePrompt, videoPrompt } = parseReply(raw);

    let saved = text;

    if (text) await sendLong(chatId, text);

    if (videoPrompt) {
      const note = await deliverVideo(chatId, videoPrompt);
      saved = `${text ? text + '\n' : ''}${note}`;
    } else if (imagePrompt) {
      await send(
        chatId,
        '🎨 بدأت إنشاء صورتك باستخدام AI Horde المجاني.\nقد يستغرق الأمر عدة دقائق.'
      );

      typing(chatId, 'upload_photo');

      try {
        const img = await requestImage(imagePrompt);

        await tgUpload(
          'sendPhoto',
          { chat_id: chatId, caption: '🎨 تم إنشاء الصورة بنجاح.' },
          'photo',
          img.buffer,
          'image.webp',
          img.type
        );

        saved = `${text ? text + '\n' : ''}[تم إنشاء صورة: ${imagePrompt}]`;
      } catch (e) {
        console.error('Image generation failed:', e.message);

        const msg = /kudos|budget|heavy demand/i.test(e.message)
          ? 'الخدمة تطلب رصيد Kudos لهذا الطلب.'
          : String(e.message).slice(0, 500);

        await send(chatId, '❌ تعذر إنشاء الصورة حالياً.\n\n' + msg);

        saved = `${text ? text + '\n' : ''}[تعذر إنشاء الصورة]`;
      }
    }

    user.count += 1;
    pushHistory(user, historyText, saved);
  } catch (e) {
    console.error('Respond error:', e.message);

    let message = '❌ حدث خطأ. حاول مرة أخرى لاحقاً.';

    if (e.status === 401) message = '❌ مفتاح Groq غير صحيح.';
    else if (e.status === 403) message = '❌ الوصول إلى Groq مرفوض.';
    else if (e.status === 404) message = '❌ لا يوجد نموذج متاح لمفتاحك.';
    else if (e.status === 413) message = '❌ الطلب كبير جداً.';
    else if (e.status === 429) message = '⏱ تجاوزت الحد المؤقت. انتظر قليلاً.';

    await quiet(send(chatId, message + '\n\n' + String(e.message).slice(0, 250)));
  } finally {
    clearInterval(timer);
    user.busy = false;
  }
}

// ======================================================
// الأوامر
// ======================================================

const HELP_TEXT =
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
  '/id رقمك في تيليجرام';

async function cmdClip(chatId, userId, idea) {
  if (!idea) {
    return send(chatId, '🎥 أرسل وصف الفيديو بعد الأمر:\n\n/clip قطة تمشي في غابة جميلة');
  }

  if (!POLL_KEY) {
    return send(chatId, '❌ مفتاح POLLINATIONS_API_KEY غير موجود في Railway.');
  }

  const user = await beginRequest(chatId, userId);
  if (!user) return;

  try {
    const prompt = await videoPromptFromIdea(idea.slice(0, 500));
    const note = await deliverVideo(chatId, prompt);

    user.count += 1;
    pushHistory(user, `[طلب فيديو] ${idea}`, note);
  } catch (e) {
    console.error('Clip error:', e.message);
    await quiet(send(chatId, '❌ حدث خطأ:\n' + String(e.message).slice(0, 300)));
  } finally {
    user.busy = false;
  }
}

async function cmdTest(chatId) {
  const msg = await send(chatId, '🔎 جارٍ فحص الاتصال...');
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

  if (POLL_KEY) {
    lines.push(
      `🔑 مفتاح الفيديو: يبدأ بـ "${POLL_KEY.slice(0, 3)}" وطوله ${POLL_KEY.length} حرفاً (النموذج: ${CLIP_MODEL})`
    );

    if (/\s/.test(POLL_KEY) || POLL_KEY.length < 20) {
      lines.push('⚠️ القيمة تبدو ليست مفتاحاً صحيحاً (قصيرة أو فيها مسافات). أعد نسخ المفتاح من enter.pollinations.ai/keys');
    }
  } else {
    lines.push('❌ POLLINATIONS_API_KEY غير موجود');
  }

  lines.push('ℹ️ لم يتم إنشاء صورة أو فيديو أثناء الفحص.');

  await quiet(
    tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text: lines.join('\n')
    })
  );
}

async function handlePhoto(chatId, userId, message) {
  try {
    const MAX_BYTES = 2.5 * 1024 * 1024;
    const photos = message.photo;

    const best =
      [...photos].reverse().find(p => !p.file_size || p.file_size <= MAX_BYTES) || photos[0];

    const file = await tg('getFile', { file_id: best.file_id });

    const res = await fetch(`${TG_FILE}/${file.file_path}`, {
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) throw new Error('Image download failed');

    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length > MAX_BYTES) throw new Error('Image is too large');

    const caption = (message.caption || 'صف هذه الصورة وأجب عن أي سؤال عنها.').slice(0, 1000);

    await respond(
      chatId,
      userId,
      [
        { type: 'text', text: caption },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
        }
      ],
      `[أرسل المستخدم صورة] ${caption}`,
      true
    );
  } catch (e) {
    console.error('Photo error:', e.message);
    await quiet(send(chatId, '❌ تعذر قراءة الصورة. حاول بصورة أصغر.'));
  }
}

async function handleMessage(m) {
  if (!m || !m.from || !m.chat) return;

  const chatId = m.chat.id;
  const userId = m.from.id;
  const text = (m.text || '').trim();

  const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const cmd = match ? match[1].toLowerCase() : null;
  const arg = match && match[2] ? match[2].trim() : '';

  if (ALLOWED && userId !== ALLOWED && cmd !== 'id') {
    console.log('Blocked user id:', userId);
    return;
  }

  if (cmd) {
    switch (cmd) {
      case 'start':
        getUser(userId).history = [];
        return send(chatId, HELP_TEXT, startKeyboard);
      case 'new':
        getUser(userId).history = [];
        return send(chatId, '🧹 بدأت محادثة جديدة.');
      case 'id':
        return send(chatId, `🆔 رقمك في تيليجرام: ${userId}`);
      case 'clip':
        return cmdClip(chatId, userId, arg);
      case 'test':
        return cmdTest(chatId);
      case 'models':
        try {
          const list = await loadModels();
          availableModels = list;
          return send(chatId, list.length ? '📋 النماذج المتاحة:\n\n' + list.join('\n') : 'لا توجد نماذج متاحة.');
        } catch (e) {
          return send(chatId, '❌ ' + String(e.message).slice(0, 300));
        }
      case 'imgmodels':
        try {
          const list = await loadImageModels();
          return send(
            chatId,
            list.length ? '🖼 نماذج الرسم النشطة:\n\n' + list.slice(0, 40).join('\n') : 'لا توجد نماذج رسم نشطة حالياً.'
          );
        } catch (e) {
          return send(chatId, '❌ ' + String(e.message).slice(0, 300));
        }
      default:
        return send(chatId, 'أمر غير معروف. أرسل /start لعرض الأوامر.');
    }
  }

  if (m.photo && m.photo.length) return handlePhoto(chatId, userId, m);

  if (text) {
    if (text.length > 4000) {
      return send(chatId, '✂️ الرسالة طويلة جداً. اختصرها ثم أرسلها.');
    }
    return respond(chatId, userId, text, text, false);
  }
}

async function handleCallback(q) {
  const userId = q.from?.id;
  const chatId = q.message?.chat?.id;

  await quiet(tg('answerCallbackQuery', { callback_query_id: q.id }, 10000));

  if (!chatId || !userId) return;
  if (ALLOWED && userId !== ALLOWED) return;

  if (q.data === 'new') {
    getUser(userId).history = [];
    return send(chatId, '🧹 بدأت محادثة جديدة.');
  }

  if (q.data === 'help_image') {
    return send(chatId, '🎨 لرسم صورة اكتب مثلاً:\n\nارسم لي أسداً واقعياً في غابة سينمائية');
  }

  if (q.data === 'help_video') {
    return send(
      chatId,
      '🎥 لإنشاء فيديو أرسل:\n\n/clip وصف الفيديو\n\nمثال:\n/clip سيارة رياضية تسير في مدينة مستقبلية\n\nأو اكتب طلبك بشكل عادي: "أنشئ لي فيديو لقطة تمشي في غابة".'
    );
  }
}

// ======================================================
// الاستقبال (Long Polling)
// كل رسالة تُعالَج بالتوازي، فلا يتجمد البوت أبداً
// ======================================================

let offset = 0;

async function poll() {
  while (running) {
    try {
      const updates = await tg(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        45000
      );

      for (const u of updates) {
        offset = u.update_id + 1;

        const job = u.callback_query ? handleCallback(u.callback_query) : handleMessage(u.message);

        job.catch(e => console.error('Handler error:', e.message));
      }
    } catch (e) {
      console.error('Polling error:', e.message);

      if (e.code === 401) {
        statusText = 'BOT_TOKEN غير صحيح';
        console.error('❌ BOT_TOKEN غير صحيح. صحّحه في Variables ثم أعد النشر.');
        return;
      }

      if (e.code === 409) {
        console.error('⚠️ نسخة أخرى من البوت تعمل بنفس التوكن. أوقفها.');
        await sleep(10000);
      } else {
        await sleep(e.code === 429 ? (e.retryAfter || 5) * 1000 : 3000);
      }
    }
  }
}

// ======================================================
// خادم Railway
// ======================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`AI Telegram Bot: ${statusText}`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// ======================================================
// التشغيل
// ======================================================

function idle(message) {
  statusText = message;
  console.error('❌ ' + message);
  setInterval(() => console.error('❌ ' + message), 60000);
}

async function main() {
  const missing = [];
  if (!BOT_TOKEN) missing.push('BOT_TOKEN');
  if (!GROQ_KEY) missing.push('GROQ_API_KEY');

  if (missing.length) {
    return idle(`متغيرات ناقصة في Railway Variables: ${missing.join(', ')}`);
  }

  let me;

  try {
    me = await tg('getMe', {}, 15000);
  } catch (e) {
    return idle(
      e.code === 401
        ? 'BOT_TOKEN غير صحيح. انسخه من @BotFather (يبدأ بأرقام ثم نقطتان).'
        : `تعذر الاتصال بتيليجرام: ${e.message}`
    );
  }

  console.log(`Bot token OK: @${me.username}`);

  await quiet(tg('deleteWebhook', { drop_pending_updates: true }));

  await quiet(
    tg('setMyCommands', {
      commands: [
        { command: 'start', description: 'بدء البوت' },
        { command: 'new', description: 'محادثة جديدة' },
        { command: 'clip', description: 'إنشاء فيديو' },
        { command: 'test', description: 'فحص الاتصال' },
        { command: 'id', description: 'رقمك في تيليجرام' }
      ]
    })
  );

  statusText = `online @${me.username}`;

  console.log('Telegram AI Bot started.');
  console.log(`Allowed user: ${ALLOWED || 'everyone'}`);
  console.log(`Video: ${POLL_KEY ? 'enabled (' + CLIP_MODEL + ')' : 'disabled (no key)'}`);

  poll();
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});

main().catch(e => idle(`فشل التشغيل: ${e.message}`));

function shutdown() {
  running = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
