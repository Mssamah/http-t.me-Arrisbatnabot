const { Telegraf, Markup } = require('telegraf');
const http = require('http');

// 1. ضع التوكن الخاص بك هنا
const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ خطأ: ضع التوكن الخاص بك في الكود أولاً!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- خوارزمية حساب مفتاح CCP و RIP ---
function calculateCcpDetails(ccpNumber) {
  const ccpClean = ccpNumber.trim().replace(/^0+/, '');
  if (!/^\d+$/.test(ccpClean) || ccpClean.length > 10) return null;

  const ccpInt = BigInt(ccpClean);
  let keyCcp = Number((ccpInt * 100n) % 97n);
  keyCcp = keyCcp !== 0 ? 97 - keyCcp : 97;
  const keyCcpStr = String(keyCcp).padStart(2, '0');

  const ccpPadded = ccpClean.padStart(10, '0');
  const ripBase = BigInt(`00799999${ccpPadded}00`);
  const keyRip = Number(97n - (ripBase % 97n));
  const keyRipStr = String(keyRip).padStart(2, '0');
  const fullRip = `00799999${ccpPadded}${keyRipStr}`;

  return { ccp: ccpClean, key: keyCcpStr, rip: fullRip };
}

// --- القائمة الرئيسية الشاملة ---
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔢 حاسبة مفتاح CCP و RIP', 'calc_ccp')],
  [
    Markup.button.callback('📄 الوثائق الإدارية', 'docs'),
    Markup.button.callback('📮 بريد الجزائر', 'post'),
  ],
  [
    Markup.button.callback('💼 منحة البطالة ANEM', 'anem'),
    Markup.button.callback('🎓 خدمات الطلبة PROGRES', 'edu'),
  ],
  [
    Markup.button.callback('🏢 سكنات عدل AADL', 'aadl'),
    Markup.button.callback('🚆 النقل والقطارات', 'transport'),
  ],
  [
    Markup.button.callback('🚑 أرقام الطوارئ والنجدة', 'emergency')
  ]
]);

const backMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔙 الرجوع للقائمة الرئيسية', 'home')]
]);

const awaitingCcp = new Set();

// --- الترحيب والأوامر ---
bot.start(async (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  await ctx.reply(
    `مرحباً بك خويا/أختي **${ctx.from.first_name}** في **البوت الشامل لخدمات الجزائر** 🇩🇿\n\n` +
    `اختر الخدمة التي تحتاجها من الأزرار بالأسفل:`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

bot.action('home', async (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  await ctx.editMessageText('اختر الخدمة المطلوبة من القائمة: 🇩🇿', mainMenu);
});

// --- قسم حاسبة CCP ---
bot.action('calc_ccp', async (ctx) => {
  awaitingCcp.add(ctx.from.id);
  await ctx.editMessageText(
    '🔢 **أرسل الآن رقم حسابك البريدي (CCP) بدون المفتاح:**\n' +
    '*(مثال: 12345678)*',
    { parse_mode: 'Markdown', ...backMenu }
  );
});

// --- قسم الوثائق الإدارية ---
bot.action('docs', async (ctx) => {
  const text =
    '📄 **بوابات استخراج الوثائق عن بُعد:**\n\n' +
    '• **شهادة الميلاد (S12) وعقد الزواج:**\n`etatcivil.interieur.gov.dz`\n\n' +
    '• **صحيفة السوابق العدلية (رقم 3) والجنسية:**\n`portail.mjustice.dz`\n\n' +
    '• **متابعة جواز السفر وبطاقة التعريف:**\n`passeport.interieur.gov.dz`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم بريد الجزائر ---
bot.action('post', async (ctx) => {
  const text =
    '📮 **خدمات بريد الجزائر و بريدي موب:**\n\n' +
    '• **الاطلاع على الرصيد (ECCP):** `eccp.poste.dz`\n' +
    '• **طلب البطاقة الذهبية:** `edcarte.poste.dz`\n' +
    '• **تغيير رقم الهاتف:** يتم عبر الموزع الآلي (GAB)\n' +
    '• **مركز النداء (الرقم الأخضر):** `1530`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم منحة البطالة ---
bot.action('anem', async (ctx) => {
  const text =
    '💼 **الوكالة الوطنية للتشغيل (ANEM):**\n\n' +
    '• **منصة منحة البطالة:** `minha.anem.dz`\n' +
    '• **تمديد طلب العمل (كل 6 أشهر):** `wassitonline.anem.dz`\n' +
    '• **الرقم الأخضر للوكالة:** `3005`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم التعليم العالي ---
bot.action('edu', async (ctx) => {
  const text =
    '🎓 **خدمات الطلبة والجامعات:**\n\n' +
    '• **منصة بروغرس (PROGRES):** `progres.mesrs.dz`\n' +
    '• **البوابة الإلكترونية للطالب:** تطبيق WebEtu على الهاتف\n' +
    '• **المنحة الجامعية والنقل:** يتم تجديدهما سنوياً عبر المنصة الرقمية للوزارة.';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم السكن ---
bot.action('aadl', async (ctx) => {
  const text =
    '🏢 **وكالة عدل (AADL) والسكن:**\n\n' +
    '• **الموقع الرسمي لوكالة عدل:** `aadl.com.dz`\n' +
    '• **دفع الشطر أو الفواتير:** متاح إلكترونياً عبر البطاقة الذهبية أو CIB.\n' +
    '• **الرقم الأخضر لوزارة السكن:** `1074`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم النقل ---
bot.action('transport', async (ctx) => {
  const text =
    '🚆 **مواقيت وحجوزات النقل:**\n\n' +
    '• **الشركة الوطنية للنقل بالسكك الحديدية (SNTF):** `sntf.dz`\n' +
    '• **الخطوط الجوية الجزائرية:** `airalgerie.dz`\n' +
    '• **حجز تذاكر الحافلات (محطة خروبة):** `sogral.dz`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- قسم الطوارئ ---
bot.action('emergency', async (ctx) => {
  const text =
    '🚑 **أرقام الطوارئ والنجدة في الجزائر (24/24):**\n\n' +
    '• **الحماية المدنية:** `14` أو `1021`\n' +
    '• **الأمن الوطني (الشرطة):** `1548` أو `17`\n' +
    '• **الدرك الوطني:** `1055`\n' +
    '• **سونلغاز (الكهرباء والغاز):** `3303`\n' +
    '• **المياه (سيال / ADE):** `1594`\n' +
    '• **حماية المستهلك:** `1020`';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

// --- استقبال النصوص من المستخدم ---
bot.on('text', async (ctx) => {
  if (awaitingCcp.has(ctx.from.id)) {
    const result = calculateCcpDetails(ctx.message.text);
    if (result) {
      awaitingCcp.delete(ctx.from.id);
      const reply =
        `✅ **تم الحساب بنجاح:**\n\n` +
        `• **رقم الحساب (CCP):** \`${result.ccp}\`\n` +
        `• **المفتاح (Clé):** \`${result.key}\`\n` +
        `• **رقم RIP (لبريدي موب):**\n\`${result.rip}\``;
      await ctx.reply(reply, { parse_mode: 'Markdown', ...backMenu });
    } else {
      await ctx.reply(
        '❌ الرقم الذي أدخلته غير صحيح.\nأرسل أرقاماً فقط بدون مسافات (مثال: `12345678`):',
        { parse_mode: 'Markdown', ...backMenu }
      );
    }
  } else {
    await ctx.reply('مرحباً! اختر الخدمة التي تريدها من القائمة: 🇩🇿', mainMenu);
  }
});

// --- تجنب توقف البوت عند حدوث أي خطأ مفاجئ ---
bot.catch((err) => {
  console.error('⚠️ خطأ غير متوقع:', err.message);
});

// --- سيرفر ويب مدمج للاستضافات السحابية ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is active! 🇩🇿');
}).listen(PORT);

// --- بدء التشغيل ---
async function launchBot() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log('✅ البوت شغال 100%! اذهب إلى تيليجرام وأرسل له أي رسالة.');
  } catch (err) {
    console.error('❌ توقف التشغيل بسبب:', err.message);
  }
}

launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
