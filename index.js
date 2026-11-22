
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const http = require('http');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN غير موجود في متغيرات Railway');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const awaitingCcp = new Set();

function calculateCcpDetails(input) {
  const ccp = String(input).trim();

  if (!/^\d{1,10}$/.test(ccp)) return null;

  const clean = ccp.replace(/^0+/, '') || '0';
  const number = BigInt(clean);

  const keyValue = Number((number * 100n) % 97n);
  const key = String(keyValue === 0 ? 97 : 97 - keyValue)
    .padStart(2, '0');

  const padded = clean.padStart(10, '0');
  const ripBase = BigInt(`00799999${padded}00`);
  const ripKey = String(97n - (ripBase % 97n)).padStart(2, '0');

  return {
    ccp: clean,
    key,
    rip: `00799999${padded}${ripKey}`
  };
}

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔢 حاسبة مفتاح CCP و RIP', 'calc_ccp')],
  [
    Markup.button.callback('📄 الوثائق الإدارية', 'docs'),
    Markup.button.callback('📮 بريد الجزائر', 'post')
  ],
  [
    Markup.button.callback('💼 منحة البطالة ANEM', 'anem'),
    Markup.button.callback('🎓 خدمات الطلبة PROGRES', 'edu')
  ],
  [
    Markup.button.callback('🏢 سكنات عدل AADL', 'aadl'),
    Markup.button.callback('🚆 النقل والقطارات', 'transport')
  ],
  [Markup.button.callback('🚑 أرقام الطوارئ والنجدة', 'emergency')]
]);

const backMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔙 الرجوع للقائمة الرئيسية', 'home')]
]);

async function safeEdit(ctx, message, keyboard = backMenu) {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    if (!String(error.message).includes('message is not modified')) {
      console.error('Edit error:', error.message);
    }
  }
}

bot.start(async (ctx) => {
  awaitingCcp.delete(ctx.from.id);

  const name = String(ctx.from.first_name || 'صديقي')
    .replace(/[&<>"]/g, '');

  await ctx.reply(
    `مرحباً <b>${name}</b> في البوت الشامل لخدمات الجزائر 🇩🇿\n\nاختر الخدمة التي تحتاجها:`,
    {
      parse_mode: 'HTML',
      ...mainMenu
    }
  );
});

bot.action('home', async (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  await safeEdit(ctx, '🇩🇿 اختر الخدمة المطلوبة:', mainMenu);
});

bot.action('calc_ccp', async (ctx) => {
  awaitingCcp.add(ctx.from.id);

  await safeEdit(
    ctx,
    '🔢 <b>أرسل رقم حساب CCP بدون المفتاح:</b>\n\nمثال: <code>12345678</code>'
  );
});

const services = {
  docs:
    '📄 <b>الوثائق الإدارية:</b>\n\n' +
    '• شهادة الميلاد S12:\nhttps://etatcivil.interieur.gov.dz\n\n' +
    '• صحيفة السوابق العدلية:\nhttps://portail.mjustice.dz\n\n' +
    '• جواز السفر وبطاقة التعريف:\nhttps://passeport.interieur.gov.dz',

  post:
    '📮 <b>بريد الجزائر:</b>\n\n' +
    '• ECCP: https://eccp.poste.dz\n' +
    '• البطاقة الذهبية: https://edcarte.poste.dz\n' +
    '• مركز النداء: 1530',

  anem:
    '💼 <b>منحة البطالة ANEM:</b>\n\n' +
    '• منصة منحة البطالة: https://minha.anem.dz\n' +
    '• وسيط أونلاين: https://wassitonline.anem.dz\n' +
    '• الرقم الأخضر: 3005',

  edu:
    '🎓 <b>خدمات الطلبة:</b>\n\n' +
    '• منصة PROGRES: https://progres.mesrs.dz\n' +
    '• تطبيق WebEtu للطلبة\n' +
    '• متابعة الخدمات الجامعية عبر المنصات الرسمية.',

  aadl:
    '🏢 <b>سكنات عدل:</b>\n\n' +
    '• الموقع: https://www.aadl.com.dz\n' +
    '• الدفع الإلكتروني حسب الخدمات المتاحة عبر المنصة الرسمية.\n' +
    '• الرقم الأخضر: 1074',

  transport:
    '🚆 <b>النقل والقطارات:</b>\n\n' +
    '• SNTF: https://www.sntf.dz\n' +
    '• الخطوط الجوية الجزائرية: https://airalgerie.dz\n' +
    '• SOGRAL: https://sogral.dz',

  emergency:
    '🚑 <b>أرقام الطوارئ في الجزائر:</b>\n\n' +
    '• الحماية المدنية: 14 / 1021\n' +
    '• الشرطة: 1548 / 17\n' +
    '• الدرك الوطني: 1055\n' +
    '• سونلغاز: 3303\n' +
    '• المياه: 1594'
};

for (const [action, message] of Object.entries(services)) {
  bot.action(action, async (ctx) => {
    await safeEdit(ctx, message);
  });
}

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  if (!awaitingCcp.has(userId)) {
    return ctx.reply(
      '🇩🇿 اختر الخدمة التي تريدها من القائمة:',
      mainMenu
    );
  }

  const result = calculateCcpDetails(ctx.message.text);

  if (!result) {
    return ctx.reply(
      '❌ رقم CCP غير صالح. أرسل أرقاماً فقط، من 1 إلى 10 أرقام.'
    );
  }

  awaitingCcp.delete(userId);

  await ctx.reply(
    '✅ <b>نتيجة الحساب:</b>\n\n' +
    `• CCP: <code>${result.ccp}</code>\n` +
    `• المفتاح: <code>${result.key}</code>\n` +
    `• RIP: <code>${result.rip}</code>`,
    {
      parse_mode: 'HTML',
      ...backMenu
    }
  );
});

bot.catch((error, ctx) => {
  console.error(
    'Bot error:',
    error.message,
    'User:',
    ctx?.from?.id || 'unknown'
  );
});

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Dz Bot is Active! 🇩🇿');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on port ${PORT}`);
});

async function startBot() {
  try {
    console.log('Connecting to Telegram...');

    await bot.telegram.deleteWebhook({
      drop_pending_updates: true
    });

    await bot.launch();

    console.log('✅ Telegram bot started successfully!');
  } catch (error) {
    console.error('❌ Telegram startup error:', error.message);
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.close();
});
