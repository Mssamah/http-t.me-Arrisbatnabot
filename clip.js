
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let ffmpegBin = 'ffmpeg';

try {
  ffmpegBin = require('ffmpeg-static') || 'ffmpeg';
} catch {}

const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || '').trim();
const CLIP_MODEL = (process.env.CLIP_MODEL || 'wan-fast').trim();

async function englishPrompt(idea) {
  if (!GROQ_KEY) return idea;

  try {
    const res = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.6,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content:
                'Convert the idea into one detailed English text-to-video prompt. ' +
                'Maximum 60 words. Describe subject, visible motion, setting, ' +
                'lighting, camera movement and visual style. Output only the prompt.'
            },
            {
              role: 'user',
              content: idea
            }
          ]
        }),
        signal: AbortSignal.timeout(20000)
      }
    );

    const data = await res.json();
    const result = data.choices?.[0]?.message?.content?.trim();

    if (res.ok && result) {
      return result.replace(/^["']|["']$/g, '').slice(0, 600);
    }
  } catch (e) {
    console.error('Prompt error:', e.message);
  }

  return idea;
}

async function requestVideo(prompt) {
  if (!POLL_KEY) {
    throw new Error('POLLINATIONS_API_KEY غير موجود');
  }

  const seed = Math.floor(Math.random() * 1000000000);

  const url =
    'https://gen.pollinations.ai/video/' +
    encodeURIComponent(prompt) +
    `?model=${encodeURIComponent(CLIP_MODEL)}` +
    `&seed=${seed}` +
    `&key=${encodeURIComponent(POLL_KEY)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${POLL_KEY}`
    },
    signal: AbortSignal.timeout(360000)
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
    throw new Error('الفيديو المُرجع صغير جداً');
  }

  return buffer;
}

function toVertical(input, output) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegBin,
      [
        '-y',
        '-i', input,
        '-vf',
        'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        output
      ],
      { timeout: 180000 },
      err => err ? reject(err) : resolve()
    );
  });
}

module.exports = function registerClip(bot) {
  const busyUsers = new Set();

  bot.command('clip', async ctx => {
    const userId = ctx.from?.id;

    if (!userId) return;

    const idea = ctx.message.text
      .replace(/^\/clip(@\w+)?/i, '')
      .trim();

    if (!idea) {
      return ctx.reply(
        '🎥 أرسل وصف الفيديو بعد الأمر:\n\n' +
        '/clip قطة تمشي في غابة جميلة'
      );
    }

    if (!POLL_KEY) {
      return ctx.reply('❌ مفتاح Pollinations غير موجود في Railway.');
    }

    if (busyUsers.has(userId)) {
      return ctx.reply('⏳ لديك فيديو قيد الإنشاء، انتظر انتهاءه.');
    }

    busyUsers.add(userId);

    let dir;

    const status = await ctx.reply(
      '🎥 جارٍ إنشاء الفيديو...\nقد يستغرق ذلك عدة دقائق.'
    );

    try {
      const prompt = await englishPrompt(idea.slice(0, 500));

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        '🎬 جارٍ توليد الفيديو بواسطة الذكاء الاصطناعي...'
      ).catch(() => {});

      const raw = await requestVideo(prompt);

      dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'openia-clip-')
      );

      const rawPath = path.join(dir, 'raw.mp4');
      const outPath = path.join(dir, 'vertical.mp4');

      await fs.promises.writeFile(rawPath, raw);

      let sendPath = rawPath;

      try {
        await toVertical(rawPath, outPath);
        sendPath = outPath;
      } catch (e) {
        console.error('FFmpeg error:', e.message);
      }

      const stat = await fs.promises.stat(sendPath);

      if (stat.size > 49 * 1024 * 1024) {
        throw new Error('حجم الفيديو أكبر من الحد المسموح لإرساله عبر البوت.');
      }

      await ctx.replyWithVideo(
        { source: sendPath },
        {
          caption: '🎥 تم إنشاء الفيديو بنجاح\n\n' + prompt.slice(0, 900),
          supports_streaming: true
        }
      );

      await ctx.telegram.deleteMessage(
        ctx.chat.id,
        status.message_id
      ).catch(() => {});

    } catch (e) {
      console.error('Video error:', e);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        '❌ فشل إنشاء الفيديو:\n' + String(e.message).slice(0, 500)
      ).catch(() => {});

    } finally {
      busyUsers.delete(userId);

      if (dir) {
        await fs.promises.rm(
          dir,
          { recursive: true, force: true }
        ).catch(() => {});
      }
    }
  });
};
