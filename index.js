const http = require('http');
const https = require('https');

// 1. الإعدادات الأساسية مع تنظيف المسافات الزائدة
const token = (process.env.BOT_TOKEN || '').trim();
const adminId = Number((process.env.ADMIN_ID || '0').trim());
const paymentInfo = process.env.PAYMENT_INFO || 'BaridiMob RIP: 00799999000000000000';
const port = process.env.PORT || 3000;

if (!token) {
  console.error('❌ خطأ: متغير BOT_TOKEN غير موجود!');
  process.exit(1);
}

const sessions = new Map();
const orders = new Map();
let offset = 0;

// 2. خادم ويب لإبقاء البوت نشطاً على Railway
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is running!');
}).listen(port, () => console.log(`Server listening on port ${port}`));

// 3. دالة الاتصال الموثوقة عبر HTTPS المدمج
function tg(method, body = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error(`Telegram API Error (${method}):`, parsed.description);
          }
          resolve(parsed);
        } catch (e) {
          resolve({ ok: false });
        }
      });
    });

    req.on('error', (err) => {
      console.error(`HTTPS Request Error (${method}):`, err.message);
      resolve({ ok: false });
    });

    req.write(payload);
    req.end();
  });
}

// 4. معالجة الرسائل الواردة
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim() : '';

  if (text === '/start') {
    sessions.delete(userId);
    return tg('sendMessage', {
      chat_id: chatId,
      text: '👋 مرحباً بك في بوت الشحن.\nاضغط على الزر بالأسفل للبدء:',
      reply_markup: {
        keyboard: [[{ text: '💳 شحن الحساب' }]],
        resize_keyboard: true
      }
    });
  }

  if (text === '💳 شحن الحساب') {
    sessions.set(userId, { step: 'awaiting_id' });
    return tg('sendMessage', {
      chat_id: chatId,
      text: '🆔 أدخل رقم الحساب (ID) المراد شحنه:'
    });
  }

  const session = sessions.get(userId);
  if (!session) return;

  if (session.step === 'awaiting_id' && text) {
    session.accountId = text;
    session.step = 'awaiting_amount';
    return tg('sendMessage', {
      chat_id: chatId,
      text: '💰 أدخل المبلغ المراد شحنه (بالدينار):'
    });
  }

  if (session.step === 'awaiting_amount' && text) {
    session.amount = text;
    session.step = 'awaiting_receipt';
    return tg('sendMessage', {
      chat_id: chatId,
      text: `📌 *معلومات الدفع:*\n${paymentInfo}\n\nقم بتحويل مبلغ *${text}* ثم أرسل *صورة وصل الدفع* هنا الآن:`,
      parse_mode: 'Markdown'
    });
  }

  if (msg.photo && session.step === 'awaiting_receipt') {
    const orderId = `ORD${Date.now()}`;
    const photoId = msg.photo[msg.photo.length - 1].file_id;

    orders.set(orderId, {
      userId,
      accountId: session.accountId,
      amount: session.amount,
      status: 'pending'
    });

    const caption =
      `📥 *طلب شحن جديد*\n\n` +
      `🔖 رقم الطلب: \`${orderId}\`\n` +
      `👤 المستخدم: \`${userId}\`\n` +
      `🆔 رقم الحساب: \`${session.accountId}\`\n` +
      `💰 المبلغ: \`${session.amount}\``;

    if (adminId) {
      await tg('sendPhoto', {
        chat_id: adminId,
        photo: photoId,
        caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ تأكيد الشحن', callback_data: `approve_${orderId}` },
            { text: '❌ رفض الطلب', callback_data: `reject_${orderId}` }
          ]]
        }
      });
    }

    sessions.delete(userId);
    return tg('sendMessage', {
      chat_id: chatId,
      text: '⏳ تم استلام الوصل وإرسال طلبك للمراجعة. سيتم إشعارك فور الشحن.'
    });
  }
}

// 5. معالجة أزرار المشرف
async function handleCallback(cb) {
  const fromId = cb.from.id;
  if (fromId !== adminId) {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⛔ غير مصرح لك بهذا الإجراء.',
      show_alert: true
    });
  }

  const parts = cb.data.split('_');
  const action = parts;
  const orderId = parts;
  const order = orders.get(orderId);

  if (!order || order.status !== 'pending') {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⚠️ الطلب غير موجود أو تمت معالجته مسبقاً.',
      show_alert: true
    });
  }

  if (action === 'approve') {
    order.status = 'approved';
    await tg('sendMessage', {
      chat_id: order.userId,
      text: `✅ تم تأكيد شحن حسابك \`${order.accountId}\` بمبلغ *${order.amount}* بنجاح!`,
      parse_mode: 'Markdown'
    });
    await tg('editMessageCaption', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      caption: `✅ *تم تأكيد الطلب* (\`${orderId}\`)\n🆔 الحساب: \`${order.accountId}\` | 💰 المبلغ: \`${order.amount}\``,
      parse_mode: 'Markdown'
    });
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ تم التأكيد.' });
  } else if (action === 'reject') {
    order.status = 'rejected';
    await tg('sendMessage', {
      chat_id: order.userId,
      text: `❌ عذراً، تم رفض طلب الشحن رقم \`${orderId}\`. يرجى التأكد من صحة الوصل والمحاولة مجدداً.`,
      parse_mode: 'Markdown'
    });
    await tg('editMessageCaption', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      caption: `❌ *تم رفض الطلب* (\`${orderId}\`)\n🆔 الحساب: \`${order.accountId}\` | 💰 المبلغ: \`${order.amount}\``,
      parse_mode: 'Markdown'
    });
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ تم الرفض.' });
  }
}

// 6. بدء الاستقبال المستمر
async function startBot() {
  const check = await tg('getMe');
  if (!check.ok) {
    console.error('❌ فشل الاتصال بتليجرام. تأكد من صحة BOT_TOKEN في Variables.');
    return;
  }
  console.log(`✅ تم الاتصال بنجاح بالبوت: @${check.result.username}`);
  await tg('deleteWebhook', { drop_pending_updates: true });

  while (true) {
    const data = await tg('getUpdates', { offset, timeout: 30 });
    if (data.ok && data.result) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

startBot();
