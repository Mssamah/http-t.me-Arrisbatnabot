
const http = require('http');
const https = require('https');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const PORT = process.env.PORT || 3000;

const MOBCASH = {
  API_URL: process.env.MOBCASH_API_URL || '',
  AGENT_ID: process.env.MOBCASH_AGENT_ID || '',
  API_KEY: process.env.MOBCASH_API_KEY || '',
  API_SECRET: process.env.MOBCASH_API_SECRET || ''
};

if (!TOKEN || !ADMIN_ID) {
  console.error('BOT_TOKEN or ADMIN_ID missing');
  process.exit(1);
}

const pending = new Map();
const history = [];
let offset = 0;

http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('MobCash Bot Running');
}).listen(PORT);

function tg(method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let result = '';
      res.on('data', c => result += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(result);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function send(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    ...extra
  });
}

// =================================
// MOB CASH OFFICIAL API PLACEHOLDERS
// =================================

async function findPlayer(id) {
  throw new Error('MobCash API غير مربوط');
}

async function deposit(id, amount) {
  throw new Error('MobCash API غير مربوط');
}

async function withdraw(id, amount) {
  throw new Error('MobCash API غير مربوط');
}

async function getBalance() {
  throw new Error('MobCash API غير مربوط');
}

// =================================
// ADMIN COMMANDS
// =================================

async function handleMessage(msg) {
  if (!msg.from || msg.from.id !== ADMIN_ID) return;

  const chat = msg.chat.id;
  const text = (msg.text || '').trim();
  const p = text.split(/\s+/);

  if (text === '/start') {
    return send(chat,
`👋 MobCash Manager

الأوامر:

/user ID
البحث عن لاعب

/deposit ID AMOUNT
إيداع

/withdraw ID AMOUNT
سحب

/balance
رصيد الوكيل

/history
سجل العمليات

/cancel
إلغاء`);
  }

  if (text === '/cancel') {
    pending.clear();
    return send(chat, 'تم إلغاء الطلبات المعلقة.');
  }

  if (text === '/balance') {
    try {
      const balance = await getBalance();
      return send(chat, '💰 رصيد الوكيل:\n' + JSON.stringify(balance));
    } catch (e) {
      return send(chat, '⚠️ ' + e.message);
    }
  }

  if (text === '/history') {
    if (!history.length) {
      return send(chat, 'لا توجد عمليات مسجلة.');
    }

    return send(chat, history.slice(-20).map(x =>
      `${x.type} | ${x.id} | ${x.amount} دج | ${x.status}`
    ).join('\n'));
  }

  if (p[0] === '/user') {
    if (!/^\d+$/.test(p[1] || '')) {
      return send(chat, 'مثال:\n/user 123456789');
    }

    try {
      const player = await findPlayer(p[1]);
      return send(chat,
        `👤 اللاعب\nالاسم: ${player.name}\nID: ${p[1]}`
      );
    } catch (e) {
      return send(chat, '⚠️ ' + e.message);
    }
  }

  if (p[0] === '/deposit' || p[0] === '/withdraw') {
    const id = p[1];
    const amount = Number(p[2]);

    if (!/^\d+$/.test(id || '') ||
        !Number.isSafeInteger(amount) || amount <= 0) {
      return send(chat,
        'الصيغة:\n/deposit ID AMOUNT\n/withdraw ID AMOUNT'
      );
    }

    try {
      const player = await findPlayer(id);
      const key = `${Date.now()}_${Math.random()}`;

      pending.set(key, {
        id,
        amount,
        name: player.name,
        type: p[0] === '/deposit' ? 'deposit' : 'withdraw',
        chat
      });

      return send(chat,
        `تأكيد العملية\n\nاللاعب: ${player.name}\nID: ${id}\nالمبلغ: ${amount} دج\nالنوع: ${p[0]}\n\nهل تؤكد؟`,
        {
          reply_markup: {
            inline_keyboard: [[
              {text:'✅ تأكيد', callback_data:'yes_' + key},
              {text:'❌ إلغاء', callback_data:'no_' + key}
            ]]
          }
        }
      );
    } catch (e) {
      return send(chat, '⚠️ ' + e.message);
    }
  }
}

// =================================
// CALLBACKS
// =================================

async function handleCallback(cb) {
  if (!cb.from || cb.from.id !== ADMIN_ID) {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'غير مصرح',
      show_alert: true
    });
  }

  const [action, key] = cb.data.split('_');
  const order = pending.get(key);

  if (!order) {
    return tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'الطلب غير موجود',
      show_alert: true
    });
  }

  if (action === 'no') {
    pending.delete(key);
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'تم الإلغاء'
    });
    return send(order.chat, '❌ تم إلغاء العملية.');
  }

  if (action !== 'yes') return;

  pending.delete(key);

  await tg('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: 'جار التحقق'
  });

  try {
    const result = order.type === 'deposit'
      ? await deposit(order.id, order.amount)
      : await withdraw(order.id, order.amount);

    if (!result || result.status !== 'success') {
      throw new Error('لم يؤكد MobCash نجاح العملية');
    }

    history.push({
      type: order.type,
      id: order.id,
      amount: order.amount,
      status: 'success'
    });

    return send(order.chat,
      `✅ تم تأكيد العملية\nاللاعب: ${order.name}\nID: ${order.id}\nالمبلغ: ${order.amount} دج`
    );
  } catch (e) {
    history.push({
      type: order.type,
      id: order.id,
      amount: order.amount,
      status: 'not_confirmed'
    });

    return send(order.chat,
      '❌ لم يتم تأكيد العملية من MobCash.\n' + e.message
    );
  }
}

// =================================
// BOT START
// =================================

async function startBot() {
  const me = await tg('getMe');
  console.log('Bot started: @' + me.username);

  await tg('deleteWebhook', {
    drop_pending_updates: true
  });

  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 30
      });

      for (const u of updates) {
        offset = u.update_id + 1;

        if (u.message) {
          await handleMessage(u.message);
        }

        if (u.callback_query) {
          await handleCallback(u.callback_query);
        }
      }
    } catch (e) {
      console.error(e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

startBot().catch(console.error);
