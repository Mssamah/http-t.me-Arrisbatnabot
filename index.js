const http = require('http');
const https = require('https');

const token = (process.env.BOT_TOKEN || '').trim();
const adminId = Number((process.env.ADMIN_ID || '0').trim());
const paymentInfo = process.env.PAYMENT_INFO || 'BaridiMob RIP: 00799999000000000000';
const port = process.env.PORT || 3000;

if (!token) {
  console.error('❌ متغير BOT_TOKEN غير موجود!');
  process.exit(1);
}

const sessions = new Map();
const orders = new Map();
const userByAccount = new Map(); // ربط رقم حساب اللاعب بحسابه في تليجرام
let offset = 0;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is running!');
}).listen(port);

function tg(method, body = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
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
  const text = msg.text ? msg.text.trim() : '';

  // أمر خاص بالمشرف: شحن مباشر عبر رقم الحساب (ID)
  // مثال: /charge 123456789 2000
  if (userId === adminId && text.startsWith('/charge ')) {
    const parts = text.split(/\s+/);
    const accId = parts[1];
    const amount = parts[2];

    if (!accId || !amount) {
      return tg('sendMessage', {
        chat_id: chatId,
        text: '⚠️ الصيغة الصحيحة:\n`/charge رقم_الحساب المبلغ`\nمثال: `/charge 987654321 2000`',
        parse_mode: 'Markdown'
      });
    }

    const targetUser = userByAccount.get(accId);
    if (targetUser) {
      await tg('sendMessage', {
        chat_id: targetUser,
        text: `✅ تم شحن حسابك \`${accId}\` بمبلغ *${amount} دج* بنجاح!`,
        parse_mode: 'Markdown'
      });
      return tg('sendMessage', { chat_id: chatId, text: `✅ تم إشعار صاحب الحساب \`${accId}\` بالشحن.` });
    } else {
      return tg('sendMessage', { chat_id: chatId, text: `ℹ️ تم تسجيل العملية للحساب \`${accId}\` (المستخدم لم يربط حسابه بالبوت بعد).` });
    }
  }

  if (text === '/start') {
    sessions.delete(userId);
    let welcome = '👋 مرحباً بك في بوت الشحن والسحب السريع.\nاختر العملية المطلوبة:';
    if (userId === adminId) {
      welcome += '\n\n🛠 *أوامر المشرف:*\nلإرسال إشعار شحن مباشر لأي ID اكتب:\n`/charge 123456789 2000`';
    }
    return tg('sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '💳 شحن الحساب (إيداع)' }, { text: '💸 سحب الأرباح' }]
        ],
        resize_keyboard: true
      }
    });
  }

  if (text === '💳 شحن الحساب (إيداع)') {
    sessions.set(userId, { type: 'deposit', step: 'awaiting_id' });
    return tg('sendMessage', { chat_id: chatId, text: '🆔 أدخل رقم الحساب (ID) المراد شحنه:' });
  }

  if (text === '💸 سحب الأرباح') {
    sessions.set(userId, { type: 'withdraw', step: 'awaiting_id' });
    return tg('sendMessage', { chat_id: chatId, text: '🆔 أدخل رقم حسابك (ID) الذي سحبت منه:' });
  }

  const session = sessions.get(userId);
  if (!session) return;

  // --- مسار الإيداع ---
  if (session.type === 'deposit') {
    if (session.step === 'awaiting_id' && text) {
      session.accountId = text;
      userByAccount.set(text, userId); // حفظ ربط الـ ID بالمستخدم
      session.step = 'awaiting_amount';
      return tg('sendMessage', { chat_id: chatId, text: '💰 أدخل مبلغ الإيداع (بالدينار):' });
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
      const orderId = `DEP${Date.now()}`;
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      orders.set(orderId, { type: 'deposit', userId, accountId: session.accountId, amount: session.amount, status: 'pending' });

      const caption =
        `📥 *طلب إيداع جديد*\n` +
        `━━━━━━━━━━━━━━\n` +
        `🆔 رقم الحساب (اضغط للنسخ): \`${session.accountId}\`\n` +
        `💰 المبلغ: \`${session.amount}\`\n` +
        `🔖 رقم الطلب: \`${orderId}\``;

      if (adminId) {
        await tg('sendPhoto', {
          chat_id: adminId,
          photo: photoId,
          caption,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ تم الشحن', callback_data: `approve_${orderId}` },
              { text: '❌ رفض', callback_data: `reject_${orderId}` }
            ]]
          }
        });
      }
      sessions.delete(userId);
      return tg('sendMessage', { chat_id: chatId, text: '⏳ تم استلام الوصل. سيتم شحن حسابك وإشعارك خلال لحظات.' });
    }
  }

  // --- مسار السحب ---
  if (session.type === 'withdraw') {
    if (session.step === 'awaiting_id' && text) {
      session.accountId = text;
      userByAccount.set(text, userId);
      session.step = 'awaiting_code';
      return tg('sendMessage', { chat_id: chatId, text: '🔑 أدخل رمز السحب (Withdraw Code):' });
    }
    if (session.step === 'awaiting_code' && text) {
      session.withdrawCode = text;
      session.step = 'awaiting_rip';
      return tg('sendMessage', { chat_id: chatId, text: '🏦 أدخل رقم حسابك البريدي (RIP) أو رقم الهاتف لاستلام أموالك:' });
    }
    if (session.step === 'awaiting_rip' && text) {
      const orderId = `WTH${Date.now()}`;
      orders.set(orderId, { type: 'withdraw', userId, accountId: session.accountId, code: session.withdrawCode, rip: text, status: 'pending' });

      const report =
        `📤 *طلب سحب أرباح*\n` +
        `━━━━━━━━━━━━━━\n` +
        `🆔 رقم الحساب: \`${session.accountId}\`\n` +
        `🔑 رمز السحب: \`${session.withdrawCode}\`\n` +
        `🏦 حساب الاستلام: \`${text}\`\n` +
        `🔖 رقم الطلب: \`${orderId}\``;

      if (adminId) {
        await tg('sendMessage', {
          chat_id: adminId,
          text: report,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ تم التحويل', callback_data: `approve_${orderId}` },
              { text: '❌ رفض', callback_data: `reject_${orderId}` }
            ]]
          }
        });
      }
      sessions.delete(userId);
      return tg('sendMessage', { chat_id: chatId, text: '⏳ تم إرسال طلب السحب للمراجعة. سيصلك إشعار فور التحويل.' });
    }
  }
}

async function handleCallback(cb) {
  if (cb.from.id !== adminId) {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ غير مصرح لك.', show_alert: true });
  }

  const parts = cb.data.split('_');
  const action = parts[0];
  const orderId = parts[1];
  const order = orders.get(orderId);

  if (!order || order.status !== 'pending') {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ الطلب غير متاح أو تمت معالجته.', show_alert: true });
  }

  const isDeposit = order.type === 'deposit';

  if (action === 'approve') {
    order.status = 'approved';
    const userMsg = isDeposit
      ? `✅ تم شحن حسابك \`${order.accountId}\` بمبلغ *${order.amount}* بنجاح!`
      : `✅ تم صرف السحب رقم \`${orderId}\` وتحويل المبلغ إلى حسابك بنجاح!`;

    await tg('sendMessage', { chat_id: order.userId, text: userMsg, parse_mode: 'Markdown' });

    const editMethod = isDeposit ? 'editMessageCaption' : 'editMessageText';
    const editPayload = {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'Markdown'
    };
    if (isDeposit) {
      editPayload.caption = `✅ *تم الشحن* (\`${orderId}\`)\n🆔 \`${order.accountId}\` | 💰 \`${order.amount}\``;
    } else {
      editPayload.text = `✅ *تم التحويل* (\`${orderId}\`)\n🆔 \`${order.accountId}\` | 🏦 \`${order.rip}\``;
    }
    await tg(editMethod, editPayload);
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ تم التأكيد.' });
  } else if (action === 'reject') {
    order.status = 'rejected';
    await tg('sendMessage', {
      chat_id: order.userId,
      text: `❌ عذراً، تم رفض طلبك رقم \`${orderId}\`. يرجى التأكد من البيانات والمحاولة مجدداً.`,
      parse_mode: 'Markdown'
    });
    const editMethod = isDeposit ? 'editMessageCaption' : 'editMessageText';
    const editPayload = {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'Markdown'
    };
    if (isDeposit) {
      editPayload.caption = `❌ *تم الرفض* (\`${orderId}\`)`;
    } else {
      editPayload.text = `❌ *تم الرفض* (\`${orderId}\`)`;
    }
    await tg(editMethod, editPayload);
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ تم الرفض.' });
  }
}

async function startBot() {
  const check = await tg('getMe');
  if (!check.ok) return;
  console.log(`✅ البوت يعمل بنجاح: @${check.result.username}`);
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
