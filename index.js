const { Telegraf, Markup } = require('telegraf');

// 1. ضع التوكن الخاص بك مكان النص بالأسفل (اترك علامتي التنصيص)
const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';

const bot = new Telegraf(BOT_TOKEN);

// --- خوارزمية حساب مفتاح CCP و RIP الجزائري ---
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

// --- القوائم والأزرار ---
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔢 حاسبة مفتاح CCP و RIP', 'calc_ccp')],
  [
    Markup.button.callback('📄 الوثائق الإدارية', 'docs'),
    Markup.button.callback('💼 منحة البطالة ANEM', 'anem'),
  ],
  [
    Markup.button.callback('🚑 أرقام الطوارئ', 'emergency'),
    Markup.button.callback('📮 خدمات بريد الجزائر', 'post'),
  ]
]);

const backMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔙 الرجوع للقائمة الرئيسية', 'home')]
]);

const awaitingCcp = new Set();

// --- أوامر البوت ---
bot.start((ctx) => {
  awaitingCcp.delete(ctx.from.id);
  ctx.reply(
    'مرحباً بك في **بوت خدمات الجزائر** 🇩🇿\nاختر الخدمة التي تحتاجها من القائمة أدناه:',
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

bot.action('home', (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  ctx.editMessageText('اختر الخدمة المطلوبة: 🇩🇿', mainMenu);
});

bot.action('calc_ccp', (ctx) => {
  awaitingCcp.add(ctx.from.id);
  ctx.editMessageText(
    '🔢 **أرسل الآن رقم حسابك البريدي (CCP) بدون المفتاح:**\n*(مثال: 12345678)*',
    { parse_mode: 'Markdown', ...backMenu }
  );
});

bot.action('docs', (ctx) => {
  const text =
    '📄 **روابط استخراج الوثائق عن بُعد:**\n\n' +
    '• **شهادة الميلاد (S12):** `etatcivil.interieur.gov.dz`\n' +
    '• **صحيفة السوابق العدلية (رقم 3):** `portail.mjustice.dz`\n' +
    '• **جواز السفر وبطاقة التعريف:** `passeport.interieur.gov.dz`';
  ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

bot.action('anem', (ctx) => {
  const text =
    '💼 **خدمات التشغيل ومنحة البطالة:**\n\n' +
    '• **حجز موعد منحة البطالة:** `minha.anem.dz`\n' +
    '• **تمديد طلب العمل (الوسيط):** `wassitonline.anem.dz`';
  ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

bot.action('post', (ctx) => {
  const text =
    '📮 **بريد الجزائر:**\n\n' +
    '• **كشف الرصيد (ECCP):** `eccp.poste.dz`\n' +
    '• **طلب البطاقة الذهبية:** `edcarte.poste.dz`\n' +
    '• **الرقم الأخضر:** 1530';
  ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

bot.action('emergency', (ctx) => {
  const text =
    '🚑 **أرقام الطوارئ المجانية:**\n\n' +
    '• **الحماية المدنية:** 14 / 1021\n' +
    '• **الشرطة:** 1548 / 17\n' +
    '• **الدرك الوطني:** 1055\n' +
    '• **سونلغاز:** 3303\n' +
    '• **المياه:** 1594';
  ctx.editMessageText(text, { parse_mode: 'Markdown', ...backMenu });
});

bot.on('text', (ctx) => {
  if (awaitingCcp.has(ctx.from.id)) {
    const result = calculateCcpDetails(ctx.message.text);
    if (result) {
      awaitingCcp.delete(ctx.from.id);
      const reply =
        `✅ **نتيجة الحساب:**\n\n` +
        `• **رقم الحساب:** \`${result.ccp}\`\n` +
        `• **المفتاح (Clé):** \`${result.key}\`\n` +
        `• **رقم RIP (بريدي موب):**\n\`${result.rip}\``;
      ctx.reply(reply, { parse_mode: 'Markdown', ...backMenu });
    } else {
      ctx.reply('❌ رقم غير صحيح. أرسل أرقاماً فقط (بحد أقصى 10 أرقام):', backMenu);
    }
  }
});

// --- تشغيل البوت مع التقاط الأخطاء ---
bot.launch()
  .then(() => console.log('✅ البوت يعمل الآن بنجاح! اذهب إلى تيليجرام واضغط Start'))
  .catch((err) => console.error('❌ فشل التشغيل بسبب:', err.message));

// إيقاف آمن عند إغلاق البرنامج
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
