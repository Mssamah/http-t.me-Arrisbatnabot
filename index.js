const dns = require('dns');
// حل مشكلة بطء وحظر اتصال Node.js بتيليجرام في الجزائر
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const http = require('http');

// ==========================================
// ضع التوكن الخاص بك هنا بين علامتي التنصيص
const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
// ==========================================

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ خطأ: لم تقم بوضع التوكن الخاص بالبوت في الكود!');
  process.exit(1);
}

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

// --- القائمة الرئيسية ---
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

// دالة مساعدة لتحديث الرسائل بأمان دون أخطاء
async function safeEdit(ctx, text, markup) {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...markup });
  } catch (err) {
    // تجاهل الخطأ إذا ضغط المستخدم على نفس الزر مرتين
  }
}

// --- الترحيب والأوامر ---
bot.start(async (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  const name = ctx.from.first_name || 'بك';
  await ctx.reply(
    `مرحباً <b>${name}</b> في <b>البوت الشامل لخدمات الجزائر</b> 🇩🇿\n\n` +
    `اختر الخدمة التي تحتاجها من الأزرار بالأسفل:`,
    { parse_mode: 'HTML', ...mainMenu }
  );
});

bot.action('home', async (ctx) => {
  awaitingCcp.delete(ctx.from.id);
  await safeEdit(ctx, 'اختر الخدمة المطلوبة من القائمة: 🇩🇿', mainMenu);
});

bot.action('calc_ccp', async (ctx) => {
  awaitingCcp.add(ctx.from.id);
  await safeEdit(
    ctx,
    '🔢 <b>أرسل الآن رقم حسابك البريدي (CCP) بدون المفتاح:</b>\n' +
    '<i>(مثال: 12345678)</i>',
    backMenu
  );
});

bot.action('docs', async (ctx) => {
  const text =
    '📄 <b>بوابات استخراج الوثائق عن بُعد:</b>\n\n' +
    '• <b>شهادة الميلاد (S12) وعقد الزواج:</b>\n<code>etatcivil.interieur.gov.dz</code>\n\n' +
    '• <b>صحيفة السوابق العدلية (رقم 3) والجنسية:</b>\n<code>portail.mjustice.dz</code>\n\n' +
    '• <b>متابعة جواز السفر وبطاقة التعريف:</b>\n<code>passeport.interieur.gov.dz</code>';
  await safeEdit(ctx, text, backMenu);
});

bot.action('post', async (ctx) => {
  const text =
    '📮 <b>خدمات بريد الجزائر و بريدي موب:</b>\n\n' +
    '• <b>الاطلاع على الرصيد (ECCP):</b> <code>eccp.poste.dz</code>\n' +
    '• <b>طلب البطاقة الذهبية:</b> <code>edcarte.poste.dz</code>\n' +
    '• <b>تغيير رقم الهاتف:</b> يتم عبر الموزع الآلي (GAB)\n' +
    '• <b>مركز النداء (الرقم الأخضر):</b> <code>1530</code>';
  await safeEdit(ctx, text, backMenu);
});

bot.action('anem', async (ctx) => {
  const text =
    '💼 <b>الوكالة الوطنية للتشغيل (ANEM):</b>\n\n' +
    '• <b>منصة منحة البطالة:</b> <code>minha.anem.dz</code>\n' +
    '• <b>تمديد طلب العمل (كل 6 أشهر):</b> <code>wassitonline.anem.dz</code>\n' +
    '• <b>الرقم الأخضر للوكالة:</b> <code>3005</code>';
  await safeEdit(ctx, text, backMenu);
});

bot.action('edu', async (ctx) => {
  const text =
    '🎓 <b>خدمات الطلبة والجامعات:</b>\n\n' +
    '• <b>منصة بروغرس (PROGRES):</b> <code>progres.mesrs.dz</code>\n' +
    '• <b>البوابة الإلكترونية للطالب:</b> تطبيق WebEtu على الهاتف\n' +
    '• <b>المنحة الجامعية والنقل:</b> يتم تجديدهما سنوياً عبر المنصة الرقمية للوزارة.';
  await safeEdit(ctx, text, backMenu);
});

bot.action('aadl', async (ctx) => {
  const text =
    '🏢 <b>وكالة عدل (AADL) والسكن:</b>\n\n' +
    '• <b>الموقع الرسمي لوكالة عدل:</b> <code>aadl.com.dz</code>\n' +
    '• <b>دفع الشطر أو الفواتير:</b> متاح إلكترونياً عبر البطاقة الذهبية أو CIB.\n' +
    '• <b>الرقم الأخضر لوزارة السكن:</b> <code>1074</code>';
  await safeEdit(ctx, text, backMenu);
});

bot.action('transport', async (ctx) => {
  const text =
    '🚆 <b>مواقيت وحجوزات النقل:</b>\n\n' +
    '• <b>الشركة الوطنية للنقل بالسكك الحديدية (SNTF):</b> <code>sntf.dz</code>\n' +
    '• <b>الخطوط الجوية الجزائرية:</b> <code>airalgerie.dz</code>\n' +
    '• <b>حجز تذاكر الحافلات (محطة خروبة):</b> <code>sogral.dz</code>';
  await safeEdit(ctx, text, backMenu);
});

bot.action('emergency', async (ctx) => {
  const text =
    '🚑 <b>أرقام الطوارئ والنجدة في الجزائر (24/24):</b>\n\n' +
    '• <b>الحماية المدنية:</b> <code>14</code> أو <code>1021</code>\n' +
    '• <b>الأمن الوطني (الشرطة):</b> <code>1548</code> أو <code>17</code>\n' +
    '• <b>الدرك الوطني:</b> <code>1055</code>\n' +
    '• <b>سونلغاز (الكهرباء والغاز):</b> <code>3303</code>\n' +
    '• <b>المياه (سيال / ADE):</b> <code>1594</code>\n' +
    '• <b>حماية المستهلك:</b> <code>1020</code>';
  await safeEdit(ctx, text, backMenu);
});

// --- استقبال النصوص من المستخدم ---
bot.on('text', async (ctx) => {
  if (awaitingCcp.has(ctx.from.id)) {
    const result = calculateCcpDetails(ctx.message.text);
    if (result) {
      awaitingCcp.delete(ctx.from.id);
      const reply =
        `✅ <b>تم الحساب بنجاح (اضغط على الرقم لنسخه):</b>\n\n` +
        `• <b>رقم الحساب (CCP):</b> <code>${result.ccp}</code>\n` +
        `• <b>المفتاح (Clé):</b> <code>${result.key}</code>\n` +
        `• <b>رقم RIP (لبريدي موب):</b>\n<code>${result.rip}</code>`;
      await ctx.reply(reply, { parse_mode: 'HTML', ...backMenu });
    } else {
      await ctx.reply(
        '❌ الرقم الذي أدخلته غير صحيح.\nأرسل أرقاماً فقط بدون مسافات (مثال: <code>12345678</code>):',
        { parse_mode: 'HTML', ...backMenu }
      );
    }
  } else {
    await ctx.reply('مرحباً! اختر الخدمة التي تريدها من القائمة: 🇩🇿', mainMenu);
  }
});

// --- تجنب توقف البوت عند أي خطأ ---
bot.catch((err) => {
  console.error('⚠️ خطأ غير متوقع:', err.message);
});

// --- سيرفر ويب مدمج للاستضافات السحابية ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dz Bot is Active! 🇩🇿');
}).listen(PORT);

// --- بدء التشغيل ---
async function launchBot() {
  try {
    console.log('⏳ جاري الاتصال بتيليجرام...');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log('✅ البوت شغال 100%! اذهب إلى تيليجرام وأرسل له /start');
  } catch (err) {
    console.error('❌ فشل الاتصال بسبب:', err.message);
  }
}

launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
