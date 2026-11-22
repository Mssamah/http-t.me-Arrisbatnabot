const http = require('http');

// 1. الإعدادات الأساسية من متغيرات Railway
const token = process.env.BOT_TOKEN;
const adminId = Number(process.env.ADMIN_ID || 0);
const paymentInfo = process.env.PAYMENT_INFO || 'BaridiMob RIP: 00799999000000000000';
const port = process.env.PORT || 3000;

if (!token) {
  console.error('❌ خطأ: متغير BOT_TOKEN غير موجود في إعدادات Variables.');
  process.exit(1);
}

const API_URL = `https://telegram.org{token}`;
const sessions = new Map();
const orders = new Map();
let offset = 0;

// 2. تشغيل خادم ويب بسيط لإبقاء البوت نشطاً على Railway
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is running smoothly!');
}).listen(port, () => console.log(`Server listening on port ${port}`));

// دالة مساعدة للتواصل المباشر مع تليجرام
async function tg(method, body = {}) {
  try {
    const res = await fetch(`${API_URL}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API Error (${method}):`, err.message);
    return { ok: false };
  }
}

// 3. معالجة الرسائل الواردة
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim() : '';

  // أمر البداية
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

  // زر طلب الشحن
  if (text === '💳 شحن الحساب') {
    sessions.set(userId, { step: 'awaiting_id' });
    return tg('sendMessage', {
      chat_id: chatId,
      text: '🆔 أدخل رقم الحساب (ID) المراد شحنه:'
    });
  }

  const session = sessions.get(userId);
  if (!session) return;

  // استقبال رقم الحساب
  if (session.step === 'awaiting_id' && text) {
    session.accountId = text;
    session.step = 'awaiting_amount';
    return tg('sendMessage', {
      chat_id: chatId,
      text: '💰 أدخل المبلغ المراد شحنه (بالدينار):'
    });
  }

  // استقبال المبلغ
  if (session.step === 'awaiting_amount' && text) {
    session.amount = text;
    session.step = 'awaiting_receipt';
    return tg('sendMessage', {
      chat_id: chatId,
      text: `📌 *معلومات الدفع:*\n${paymentInfo}\n\nقم بتحويل مبلغ *${text}* ثم أرسل *صورة وصل الدفع* هنا الآن:`,
      parse_mode: 'Markdown'
    });
  }

  // استقبال صورة الوصل
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

// 4. معالجة أزرار الموافقة والرفض للمشرف
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
  const action = parts[0];
  const orderId = parts[1];
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

// 5. حلقة الاستقبال المستمر (Long Polling)
async function startBot() {
  await tg('deleteWebhook', { drop_pending_updates: true });
  console.log('✅ البوت يعمل بنجاح الآن (ملف واحد بدون مكتبات خارجية)!');

  while (true) {
    const data = await tg('getUpdates', { offset, timeout: 30 });
    if (data.ok && data.result) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    }
  }
}

startBot();
