const http = require('http');
const https = require('https');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_ID = Number((process.env.ADMIN_ID || '0').trim());
const PORT = process.env.PORT || 3000;

if (!TOKEN || !ADMIN_ID) {
  console.error('❌ BOT_TOKEN or ADMIN_ID missing');
  process.exit(1);
}

// أسعار الصرف الافتراضية ومعلومات الدفع (قابلة للتعديل من داخل البوت)
let settings = {
  buyRate: 246,   // سعر البيع للزبون (1 USDT = 246 DA)
  sellRate: 240,  // سعر الشراء من الزبون (1 USDT = 240 DA)
  rip: process.env.PAYMENT_INFO || 'BaridiMob RIP: 00799999000000000000',
  wallet: 'TRC20 / Binance ID: 123456789'
};

const sessions = new Map();
const orders = new Map();
const stats = { totalBuyUsdt: 0, totalSellUsdt: 0 };
let offset = 0;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('P2P Exchange Bot Running');
}).listen(PORT);

function tg(method, body = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(payload);
    req.end();
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  // --- أوامر المشرف لتحديث الأسعار والمحافظ فوراً ---
  if (userId === adminIdCheck(userId)) {
    if (text.startsWith('/setbuy ')) {
      const val = Number(text.split(/\s+/));
      if (val > 0) {
        settings.buyRate = val;
        return tg('sendMessage', { chat_id: chatId, text: `✅ تم تحديث سعر البيع للزبون إلى: *${val} دج*`, parse_mode: 'Markdown' });
      }
    }
    if (text.startsWith('/setsell ')) {
      const val = Number(text.split(/\s+/));
      if (val > 0) {
        settings.sellRate = val;
        return tg('sendMessage', { chat_id: chatId, text: `✅ تم تحديث سعر الشراء من الزبون إلى: *${val} دج*`, parse_mode: 'Markdown' });
      }
    }
    if (text.startsWith('/setwallet ')) {
      const val = text.replace('/setwallet ', '').trim();
      if (val) {
        settings.wallet = val;
        return tg('sendMessage', { chat_id: chatId, text: `✅ تم تحديث عنوان محفظتك إلى:\n\`${val}\``, parse_mode: 'Markdown' });
      }
    }
    if (text === '/stats') {
      return tg('sendMessage', {
        chat_id: chatId,
        text: `📊 *إحصائيات التبادل:*\n🟢 مبيعات USDT: ${stats.totalBuyUsdt}\n🔵 مشتريات USDT: ${stats.totalSellUsdt}`,
        parse_mode: 'Markdown'
      });
    }
  }

  // --- القائمة الرئيسية ---
  if (text === '/start') {
    sessions.delete(userId);
    let welcome =
      `💱 *مرحباً بك في مكتب الصرف الإلكتروني*\n\n` +
      `📈 *أسعار الصرف اليوم:*\n` +
      `• شراء USDT: *1$ = ${settings.buyRate} دج*\n` +
      `• بيع USDT: *1$ = ${settings.sellRate} دج*\n\n` +
      `اختر العملية المطلوبة من القائمة بالأسفل:`;

    if (userId === ADMIN_ID) {
      welcome += `\n\n🛠 *أوامر المشرف السريعة:*\n` +
        `\`/setbuy 246\` — تعديل سعر البيع\n` +
        `\`/setsell 240\` — تعديل سعر الشراء\n` +
        `\`/setwallet عنوان_محفظتك\` — تعديل المحفظة\n` +
        `\`/stats\` — عرض الإحصائيات`;
    }

    return tg('sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '🟢 شراء USDT (دفع دينار)' }, { text: '🔵 بيع USDT (استلام دينار)' }],
          [{ text: '💱 أسعار الصرف الحالية' }]
        ],
        resize_keyboard: true
      }
    });
  }

  if (text === '💱 أسعار الصرف الحالية') {
    return tg('sendMessage', {
      chat_id: chatId,
      text: `📈 *أسعار الصرف المحدثة:*\n🟢 شراء USDT: *${settings.buyRate} دج*\n🔵 بيع USDT: *${settings.sellRate} دج*`,
      parse_mode: 'Markdown'
    });
  }

  // --- 1. مسار شراء USDT (الزبون يدفع بالدينار) ---
  if (text === '🟢 شراء USDT (دفع دينار)') {
    sessions.set(userId, { type: 'buy', step: 'awaiting_amount' });
    return tg('sendMessage', {
      chat_id: chatId,
      text: `🟢 *شراء USDT* (السعر: ${settings.buyRate} دج)\n\nأدخل الكمية التي تريد شراءها بـ USDT (مثال: 20):`,
      parse_mode: 'Markdown'
    });
  }

  // --- 2. مسار بيع USDT (الزبون يبيع رصيده ويستلم دينار) ---
  if (text === '🔵 بيع USDT (استلام دينار)') {
    sessions.set(userId, { type: 'sell', step: 'awaiting_amount' });
    return tg('sendMessage', {
      chat_id: chatId,
      text: `🔵 *بيع USDT* (السعر: ${settings.sellRate} دج)\n\nأدخل الكمية التي تريد بيعها بـ USDT (مثال: 50):`,
      parse_mode: 'Markdown'
    });
  }

  const session = sessions.get(userId);
  if (!session) return;

  // خطوات الشراء
  if (session.type === 'buy') {
    if (session.step === 'awaiting_amount' && text) {
      const usdt = parseFloat(text);
      if (isNaN(usdt) || usdt <= 0) {
        return tg('sendMessage', { chat_id: chatId, text: '⚠️ يرجى إدخال رقم صحيح للكمية (مثال: 25).' });
      }
      session.usdt = usdt;
      session.dzd = Math.round(usdt * settings.buyRate);
      session.step = 'awaiting_wallet';
      return tg('sendMessage', {
        chat_id: chatId,
        text: `🧮 المبلغ المطلوب دفعه: *${session.dzd} دج*\n\nأرسل الآن *عنوان محفظتك (TRC20 أو Binance ID)* لاستلام الرصيد:`,
        parse_mode: 'Markdown'
      });
    }

    if (session.step === 'awaiting_wallet' && text) {
      session.targetWallet = text;
      session.step = 'awaiting_receipt';
      return tg('sendMessage', {
        chat_id: chatId,
        text: `📌 *معلومات الدفع:*\n${settings.rip}\n\nقم بتحويل مبلغ *${session.dzd} دج* ثم أرسل *صورة وصل الدفع* هنا:`,
        parse_mode: 'Markdown'
      });
    }

    if (msg.photo && session.step === 'awaiting_receipt') {
      const orderId = `BUY${Date.now()}`;
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      orders.set(orderId, {
        type: 'buy', userId, usdt: session.usdt, dzd: session.dzd, target: session.targetWallet, status: 'pending'
      });

      const caption =
        `🟢 *طلب شراء USDT جديد*\n` +
        `━━━━━━━━━━━━━━\n` +
        `💵 الكمية: \`${session.usdt} USDT\`\n` +
        `💰 المبلغ المدفوع: \`${session.dzd} دج\`\n` +
        `👛 محفظة الزبون (اضغط للنسخ):\n\`${session.targetWallet}\`\n` +
        `🔖 رقم الطلب: \`${orderId}\``;

      await tg('sendPhoto', {
        chat_id: ADMIN_ID,
        photo: photoId,
        caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ تم إرسال USDT', callback_data: `ok_${orderId}` },
            { text: '❌ رفض', callback_data: `no_${orderId}` }
          ]]
        }
      });

      sessions.delete(userId);
      return tg('sendMessage', { chat_id: chatId, text: '⏳ تم استلام الوصل. سيتم إرسال الرصيد إلى محفظتك خلال دقائق.' });
    }
  }

  // خطوات البيع
  if (session.type === 'sell') {
    if (session.step === 'awaiting_amount' && text) {
      const usdt = parseFloat(text);
      if (isNaN(usdt) || usdt <= 0) {
        return tg('sendMessage', { chat_id: chatId, text: '⚠️ يرجى إدخال رقم صحيح للكمية.' });
      }
      session.usdt = usdt;
      session.dzd = Math.round(usdt * settings.sellRate);
      session.step = 'awaiting_rip';
      return tg('sendMessage', {
        chat_id: chatId,
        text: `🧮 المبلغ الذي ستستلمه: *${session.dzd} دج*\n\nأرسل الآن *رقم حسابك البريدي (RIP)* لاستلام أموالك:`,
        parse_mode: 'Markdown'
      });
    }

    if (session.step === 'awaiting_rip' && text) {
      session.targetRip = text;
      session.step = 'awaiting_receipt';
      return tg('sendMessage', {
        chat_id: chatId,
        text: `📌 *عنوان محفظتنا للاستلام:*\n\`${settings.wallet}\`\n\nقم بتحويل *${session.usdt} USDT* إلى العنوان أعلاه ثم أرسل *صورة إثبات التحويل* هنا:`,
        parse_mode: 'Markdown'
      });
    }

    if (msg.photo && session.step === 'awaiting_receipt') {
      const orderId = `SELL${Date.now()}`;
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      orders.set(orderId, {
        type: 'sell', userId, usdt: session.usdt, dzd: session.dzd, target: session.targetRip, status: 'pending'
      });

      const caption =
        `🔵 *طلب بيع USDT جديد*\n` +
        `━━━━━━━━━━━━━━\n` +
        `💵 الكمية المستلمة: \`${session.usdt} USDT\`\n` +
        `💰 المبلغ المطلوب دفعه: \`${session.dzd} دج\`\n` +
        `🏦 حساب الزبون (RIP):\n\`${session.targetRip}\`\n` +
        `🔖 رقم الطلب: \`${orderId}\``;

      await tg('sendPhoto', {
        chat_id: ADMIN_ID,
        photo: photoId,
        caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ تم تحويل الدينار', callback_data: `ok_${orderId}` },
            { text: '❌ رفض', callback_data: `no_${orderId}` }
          ]]
        }
      });

      sessions.delete(userId);
      return tg('sendMessage', { chat_id: chatId, text: '⏳ تم استلام طلب البيع. سيتم تحويل المبلغ لحسابك فور تأكيد الشبكة.' });
    }
  }
}

function adminIdCheck(id) {
  return id === ADMIN_ID ? ADMIN_ID : -1;
}

async function handleCallback(cb) {
  if (cb.from.id !== ADMIN_ID) {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ غير مصرح لك.', show_alert: true });
  }

  const [action, orderId] = cb.data.split('_');
  const order = orders.get(orderId);

  if (!order || order.status !== 'pending') {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ الطلب غير متاح أو تمت معالجته.', show_alert: true });
  }

  if (action === 'ok') {
    order.status = 'approved';
