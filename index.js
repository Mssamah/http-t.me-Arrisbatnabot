
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================= CONFIGURATION =================

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = process.env.DATA_DIR || './data';
const DATA_FILE = path.join(DATA_DIR, 'database.json');

if (!TOKEN || !Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error('BOT_TOKEN or ADMIN_ID is missing or invalid.');
  process.exit(1);
}

// ================= DATABASE =================

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultDatabase() {
  return {
    settings: {
      buyRate: Number(process.env.BUY_RATE || 246),
      sellRate: Number(process.env.SELL_RATE || 240),
      paymentInfo: process.env.PAYMENT_INFO || 'ضع معلومات الدفع هنا',
      wallet: process.env.WALLET_INFO || 'ضع عنوان محفظتك هنا'
    },
    sessions: {},
    orders: {},
    stats: {
      soldToCustomers: 0,
      boughtFromCustomers: 0
    }
  };
}

function loadDatabase() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const defaults = defaultDatabase();

      return {
        ...defaults,
        ...data,
        settings: { ...defaults.settings, ...data.settings },
        sessions: data.sessions || {},
        orders: data.orders || {},
        stats: { ...defaults.stats, ...data.stats }
      };
    }
  } catch (error) {
    console.error('Database load error:', error.message);
  }

  return defaultDatabase();
}

let db = loadDatabase();

function saveDatabase() {
  const tempFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

// ================= TELEGRAM API =================

function tg(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 45000
    }, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);

      res.on('end', () => {
        try {
          const result = JSON.parse(data);

          if (!result.ok) {
            return reject(new Error(result.description || 'Telegram API error'));
          }

          resolve(result.result);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);

    req.on('timeout', () => {
      req.destroy(new Error('Telegram request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    ...extra
  });
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

function newOrderId(type) {
  const prefix = type === 'buy' ? 'B' : 'S';
  return prefix + Date.now() + crypto.randomBytes(3).toString('hex');
}

function validAmount(text) {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;

  const amount = Number(text);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return null;
  }

  return amount;
}

function formatNumber(number) {
  return Number(number).toLocaleString('en-US', {
    maximumFractionDigits: 2
  });
}

// ================= MAIN MENU =================

async function startMenu(chatId, userId) {
  delete db.sessions[userId];
  saveDatabase();

  let welcome =
    '💱 مرحباً بك في مكتب الصرف الإلكتروني\n\n' +
    '📈 أسعار الصرف الحالية:\n\n' +
    `🟢 شراء USDT: 1 USDT = ${db.settings.buyRate} دج\n` +
    `🔵 بيع USDT: 1 USDT = ${db.settings.sellRate} دج\n\n` +
    'اختر العملية المطلوبة:';

  if (isAdmin(userId)) {
    welcome +=
      '\n\n🛠 أوامر المشرف:\n' +
      '/setbuy 246 - سعر شراء الزبون\n' +
      '/setsell 240 - سعر بيع الزبون\n' +
      '/setpayment معلومات الدفع\n' +
      '/setwallet عنوان المحفظة\n' +
      '/stats - الإحصائيات\n' +
      '/orders - الطلبات المعلقة';
  }

  await sendMessage(chatId, welcome, {
    reply_markup: {
      keyboard: [
        [
          { text: '🟢 شراء USDT (دفع دينار)' },
          { text: '🔵 بيع USDT (استلام دينار)' }
        ],
        [
          { text: '💱 أسعار الصرف الحالية' }
        ],
        [
          { text: '❌ إلغاء العملية' }
        ]
      ],
      resize_keyboard: true
    }
  });
}

// ================= ADMIN COMMANDS =================

async function handleAdminCommand(msg, text) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) return false;

  if (text.startsWith('/setbuy ')) {
    const value = Number(text.slice(8).trim());

    if (!Number.isFinite(value) || value <= 0) {
      await sendMessage(chatId, '⚠️ أدخل سعراً صحيحاً.');
      return true;
    }

    db.settings.buyRate = value;
    saveDatabase();

    await sendMessage(chatId, `✅ تم تحديث سعر شراء USDT للزبون إلى ${value} دج.`);
    return true;
  }

  if (text.startsWith('/setsell ')) {
    const value = Number(text.slice(9).trim());

    if (!Number.isFinite(value) || value <= 0) {
      await sendMessage(chatId, '⚠️ أدخل سعراً صحيحاً.');
      return true;
    }

    db.settings.sellRate = value;
    saveDatabase();

    await sendMessage(chatId, `✅ تم تحديث سعر بيع USDT للزبون إلى ${value} دج.`);
    return true;
  }

  if (text.startsWith('/setpayment ')) {
    const value = text.slice(12).trim();

    if (!value) {
      await sendMessage(chatId, '⚠️ أدخل معلومات الدفع.');
      return true;
    }

    db.settings.paymentInfo = value;
    saveDatabase();

    await sendMessage(chatId, '✅ تم تحديث معلومات الدفع.');
    return true;
  }

  if (text.startsWith('/setwallet ')) {
    const value = text.slice(11).trim();

    if (!value) {
      await sendMessage(chatId, '⚠️ أدخل عنوان المحفظة.');
      return true;
    }

    db.settings.wallet = value;
    saveDatabase();

    await sendMessage(chatId, '✅ تم تحديث عنوان المحفظة.');
    return true;
  }

  if (text === '/stats') {
    await sendMessage(chatId,
      '📊 إحصائيات التبادل\n\n' +
      `🟢 USDT المباعة للعملاء: ${formatNumber(db.stats.soldToCustomers)}\n` +
      `🔵 USDT المشتراة من العملاء: ${formatNumber(db.stats.boughtFromCustomers)}`
    );
    return true;
  }

  if (text === '/orders') {
    const pending = Object.values(db.orders)
      .filter(order => order.status === 'pending');

    if (!pending.length) {
      await sendMessage(chatId, 'لا توجد طلبات معلقة حالياً.');
      return true;
    }

    const list = pending.slice(0, 30).map(order =>
      `${order.id}\n${order.type === 'buy' ? 'شراء USDT' : 'بيع USDT'}\n` +
      `${order.usdt} USDT - ${order.dzd} دج`
    ).join('\n\n');

    await sendMessage(chatId, '📋 الطلبات المعلقة:\n\n' + list);
    return true;
  }

  return false;
}

// ================= BUY / SELL ORDER =================

async function handleMessage(msg) {
  if (!msg.from || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  if (text === '/start') {
    return startMenu(chatId, userId);
  }

  if (text === '/cancel' || text === '❌ إلغاء العملية') {
    delete db.sessions[userId];
    saveDatabase();

    return sendMessage(chatId, '✅ تم إلغاء العملية.', {
      reply_markup: {
        keyboard: [
          [{ text: '🟢 شراء USDT (دفع دينار)' }, { text: '🔵 بيع USDT (استلام دينار)' }],
          [{ text: '💱 أسعار الصرف الحالية' }]
        ],
        resize_keyboard: true
      }
    });
  }

  if (await handleAdminCommand(msg, text)) return;

  if (text === '💱 أسعار الصرف الحالية') {
    return sendMessage(chatId,
      '📈 أسعار الصرف:\n\n' +
      `🟢 شراء USDT: ${db.settings.buyRate} دج\n` +
      `🔵 بيع USDT: ${db.settings.sellRate} دج`
    );
  }

  if (text === '🟢 شراء USDT (دفع دينار)') {
    db.sessions[userId] = {
      type: 'buy',
      step: 'amount'
    };

    saveDatabase();

    return sendMessage(chatId,
      `🟢 شراء USDT\nالسعر: ${db.settings.buyRate} دج\n\n` +
      'أدخل كمية USDT التي تريد شراءها:\nمثال: 20'
    );
  }

  if (text === '🔵 بيع USDT (استلام دينار)') {
    db.sessions[userId] = {
      type: 'sell',
      step: 'amount'
    };

    saveDatabase();

    return sendMessage(chatId,
      `🔵 بيع USDT\nالسعر: ${db.settings.sellRate} دج\n\n` +
      'أدخل كمية USDT التي تريد بيعها:\nمثال: 50'
    );
  }

  const session = db.sessions[userId];
  if (!session) return;

  // ===== RECEIVE PAYMENT RECEIPT =====

  if (session.step === 'receipt') {
    if (!msg.photo || !msg.photo.length) {
      return sendMessage(chatId, '⚠️ أرسل صورة إثبات التحويل، أو اكتب /cancel للإلغاء.');
    }

    const orderId = newOrderId(session.type);
    const photoId = msg.photo[msg.photo.length - 1].file_id;

    const order = {
      id: orderId,
      type: session.type,
      userId,
      usdt: session.usdt,
      dzd: session.dzd,
      target: session.target,
      photoId,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    db.orders[orderId] = order;
    delete db.sessions[userId];
    saveDatabase();

    const title = session.type === 'buy'
      ? '🟢 طلب شراء USDT جديد'
      : '🔵 طلب بيع USDT جديد';

    const details =
      `${title}\n\n` +
      `👤 المستخدم: ${userId}\n` +
      `💵 الكمية: ${session.usdt} USDT\n` +
      `💰 المبلغ: ${session.dzd} دج\n` +
      `${session.type === 'buy' ? '👛 محفظة الزبون:' : '🏦 RIP الزبون:'}\n` +
      `${session.target}\n\n` +
      `🔖 رقم الطلب: ${orderId}`;

    try {
      await tg('sendPhoto', {
        chat_id: ADMIN_ID,
        photo: photoId,
        caption: details,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ قبول الطلب', callback_data: `ok_${orderId}` },
            { text: '❌ رفض الطلب', callback_data: `no_${orderId}` }
          ]]
        }
      });

      return sendMessage(chatId,
        `⏳ تم استلام طلبك بنجاح.\nرقم الطلب: ${orderId}\nسيتم مراجعته من طرف المشرف.`
      );
    } catch (error) {
      console.error('Admin notification error:', error.message);

      try {
        await sendMessage(ADMIN_ID, details);
      } catch (e) {
        console.error('Admin fallback error:', e.message);
      }

      return sendMessage(chatId,
        '⚠️ تم حفظ طلبك، لكن حدث خطأ في إرسال الإشعار للمشرف. يرجى التواصل معه.'
      );
    }
  }

  // ===== AMOUNT =====

  if (session.step === 'amount') {
    const amount = validAmount(text);

    if (amount === null) {
      return sendMessage(chatId, '⚠️ أدخل كمية صحيحة أكبر من صفر، مثال: 25');
    }

    session.usdt = amount;

    const rate = session.type === 'buy'
      ? db.settings.buyRate
      : db.settings.sellRate;

    session.dzd = Math.round(amount * rate);

    session.step = session.type === 'buy' ? 'wallet' : 'rip';

    saveDatabase();

    if (session.type === 'buy') {
      return sendMessage(chatId,
        `🧮 المبلغ المطلوب دفعه: ${formatNumber(session.dzd)} دج\n\n` +
        'أرسل عنوان محفظتك TRC20 أو Binance ID لاستلام USDT:'
      );
    }

    return sendMessage(chatId,
      `🧮 المبلغ الذي ستستلمه: ${formatNumber(session.dzd)} دج\n\n` +
      'أرسل رقم حسابك البريدي RIP لاستلام الدينار:'
    );
  }

  // ===== WALLET FOR BUY =====

  if (session.step === 'wallet') {
    if (!text || text.length > 200) {
      return sendMessage(chatId, '⚠️ أرسل عنوان محفظة صحيحاً.');
    }

    session.target = text;
    session.step = 'receipt';
    saveDatabase();

    return sendMessage(chatId,
      '📌 معلومات الدفع:\n\n' +
      `${db.settings.paymentInfo}\n\n` +
      `💰 المبلغ المطلوب: ${formatNumber(session.dzd)} دج\n\n` +
      'بعد الدفع أرسل صورة وصل الدفع هنا.'
    );
  }

  // ===== RIP FOR SELL =====

  if (session.step === 'rip') {
    if (!text || text.length > 200) {
      return sendMessage(chatId, '⚠️ أرسل رقم RIP صحيحاً.');
    }

    session.target = text;
    session.step = 'receipt';
    saveDatabase();

    return sendMessage(chatId,
      '📌 عنوان محفظتنا:\n\n' +
      `${db.settings.wallet}\n\n` +
      `💵 الكمية المطلوب إرسالها: ${session.usdt} USDT\n\n` +
      'بعد التحويل أرسل صورة إثبات التحويل هنا.'
    );
  }
}

// ================= CALLBACKS =================

async function handleCallback(cb) {
  if (!cb.from || !cb.data) return;

  if (!isAdmin(cb.from.id)) {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⛔ غير مصرح لك.',
      show_alert: true
    });
  }

  const parts = cb.data.split('_');
  const action = parts[0];
  const orderId = parts.slice(1).join('_');

  const order = db.orders[orderId];

  if (!order || order.status !== 'pending') {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⚠️ الطلب غير موجود أو تمت معالجته.',
      show_alert: true
    });
  }

  if (action !== 'ok' && action !== 'no') return;

  if (action === 'ok') {
    order.status = 'approved';
    order.processedAt = new Date().toISOString();

    if (order.type === 'buy') {
      db.stats.soldToCustomers += order.usdt;
    } else {
      db.stats.boughtFromCustomers += order.usdt;
    }
  } else {
    order.status = 'rejected';
    order.processedAt = new Date().toISOString();
  }

  saveDatabase();

  await tg('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: action === 'ok' ? '✅ تم قبول الطلب.' : '❌ تم رفض الطلب.'
  });

  try {
    await tg('editMessageReplyMarkup', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  } catch (error) {
    console.error('Keyboard update:', error.message);
  }

  const result = action === 'ok'
    ? '✅ تم قبول طلبك من طرف المشرف.'
    : '❌ تم رفض طلبك. يرجى التواصل مع المشرف.';

  try {
    await sendMessage(order.userId,
      `${result}\n\nرقم الطلب: ${order.id}`
    );
  } catch (error) {
    console.error('Customer notification:', error.message);
  }

  return sendMessage(ADMIN_ID,
    `${action === 'ok' ? '✅ تم قبول' : '❌ تم رفض'} الطلب ${order.id}.`
  );
}

// ================= UPDATE PROCESSING =================

async function processUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

// ================= HTTP SERVER =================

http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('USDT Exchange Bot is Running');
  }

  res.writeHead(404);
  res.end('Not Found');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// ================= POLLING =================

let offset = 0;
let stopping = false;

async function polling() {
  while (!stopping) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query']
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          await processUpdate(update);
        } catch (error) {
          console.error('Update error:', error.message);
        }
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  try {
    await tg('deleteWebhook', {
      drop_pending_updates: false
    });

    console.log('Telegram webhook cleared.');
    console.log('USDT Exchange Bot started successfully.');

    await polling();
  } catch (error) {
    console.error('Startup error:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  stopping = true;
  saveDatabase();
});

process.on('SIGINT', () => {
  stopping = true;
  saveDatabase();
});

main();
