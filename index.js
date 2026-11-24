
'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const crypto = require('crypto');
const http = require('http');
const { Telegraf, Markup } = require('telegraf');

// ======================================
// إعدادات البوت من Railway Variables
// ======================================

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_KEY = (process.env.BINANCE_API_KEY || '').trim();
const API_SECRET = (process.env.BINANCE_API_SECRET || '').trim();

const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN || !API_KEY || !API_SECRET) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ======================================
// الاتصال بمنصة Binance
// ======================================

async function binanceRequest(endpoint, parameters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(parameters)) {
    params.set(key, String(value));
  }

  params.set('timestamp', String(Date.now()));
  params.set('recvWindow', '10000');

  const query = params.toString();

  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(query)
    .digest('hex');

  const url =
    'https://api.binance.com' +
    endpoint +
    '?' +
    query +
    '&signature=' +
    signature;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': API_KEY
    },
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.msg || `Binance API error: ${response.status}`
    );
  }

  return data;
}

// ======================================
// جلب معلومات المحفظة
// ======================================

async function getWallet() {
  const account = await binanceRequest('/api/v3/account');

  const balances = account.balances
    .map(item => ({
      asset: item.asset,
      free: Number(item.free),
      locked: Number(item.locked),
      total: Number(item.free) + Number(item.locked)
    }))
    .filter(item => item.total > 0);

  return balances;
}

// ======================================
// سعر Bitcoin الحقيقي
// ======================================

async function getBitcoinPrice() {
  const response = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    {
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw new Error('Unable to get BTC price');
  }

  const data = await response.json();

  return Number(data.price);
}

// ======================================
// تنسيق الأرقام
// ======================================

function formatNumber(value, decimals = 8) {
  return Number(value).toFixed(decimals)
    .replace(/\.?0+$/, '');
}

function formatUSD(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ======================================
// القائمة الرئيسية
// ======================================

const mainMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('₿ رصيد Bitcoin', 'btc')
  ],
  [
    Markup.button.callback('💰 جميع الأصول', 'assets')
  ],
  [
    Markup.button.callback('🔄 تحديث المحفظة', 'refresh')
  ]
]);

const backMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('🔙 القائمة الرئيسية', 'home')
  ],
  [
    Markup.button.callback('🔄 تحديث', 'refresh')
  ]
]);

// ======================================
// عرض المحفظة
// ======================================

async function dashboard() {
  const [balances, price] = await Promise.all([
    getWallet(),
    getBitcoinPrice()
  ]);

  const btc = balances.find(item => item.asset === 'BTC');

  const btcBalance = btc ? btc.total : 0;
  const btcUSD = btcBalance * price;

  return {
    balances,
    price,
    btcBalance,
    btcUSD
  };
}

function dashboardText(data) {
  return (
    '₿ <b>BITCOIN WALLET</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '🟠 <b>رصيد Bitcoin:</b>\n' +
    `<code>${formatNumber(data.btcBalance)} BTC</code>\n\n` +
    '💵 <b>القيمة بالدولار:</b>\n' +
    `<code>$${formatUSD(data.btcUSD)}</code>\n\n` +
    '📈 <b>سعر Bitcoin:</b>\n' +
    `<code>$${formatUSD(data.price)}</code>\n\n` +
    '━━━━━━━━━━━━━━━━━━\n' +
    '🔐 الاتصال: Binance API\n' +
    '📡 نوع البيانات: رصيد Spot الحقيقي'
  );
}

// ======================================
// عرض الأصول
// ======================================

function assetsText(balances) {
  let text =
    '💰 <b>أصول محفظة Binance Spot</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n\n';

  if (balances.length === 0) {
    return text + 'لا توجد أرصدة متاحة.';
  }

  for (const item of balances.slice(0, 30)) {
    text +=
      `🪙 <b>${item.asset}</b>\n` +
      `المتاح: <code>${formatNumber(item.free)}</code>\n` +
      `المحجوز: <code>${formatNumber(item.locked)}</code>\n` +
      `الإجمالي: <code>${formatNumber(item.total)}</code>\n\n`;
  }

  if (balances.length > 30) {
    text += `\nعرض أول 30 من أصل ${balances.length} عملة.`;
  }

  return text;
}

// ======================================
// التعامل مع عرض الرسائل
// ======================================

async function show(ctx, message, keyboard, edit = false) {
  try {
    if (edit) {
      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        ...keyboard
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'HTML',
        ...keyboard
      });
    }
  } catch (error) {
    if (String(error.message).includes('message is not modified')) {
      return;
    }

    if (edit) {
      try {
        await ctx.reply(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
      } catch (e) {
        console.error('Telegram message error:', e.message);
      }
    } else {
      console.error('Telegram message error:', error.message);
    }
  }
}

// ======================================
// أمر البداية
// ======================================

bot.start(async (ctx) => {
  await show(
    ctx,
    '₿ <b>مرحباً بك في Bitcoin Wallet Bot</b>\n\n' +
    'هذا البوت متصل بمحفظة Binance الخاصة بك.\n\n' +
    'يمكنك متابعة رصيد Bitcoin والعملات المتوفرة في حسابك.\n\n' +
    'اختر الخدمة المطلوبة:',
    mainMenu
  );
});

// ======================================
// القائمة الرئيسية
// ======================================

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();

  await show(
    ctx,
    '₿ <b>القائمة الرئيسية</b>\n\nاختر الخدمة:',
    mainMenu,
    true
  );
});

// ======================================
// رصيد Bitcoin
// ======================================

bot.action('btc', async (ctx) => {
  await ctx.answerCbQuery('جاري جلب الرصيد...');

  try {
    const data = await dashboard();

    await show(
      ctx,
      dashboardText(data),
      backMenu,
      true
    );
  } catch (error) {
    console.error('BTC error:', error.message);

    await show(
      ctx,
      '❌ تعذر الاتصال بمحفظة Binance.\n' +
      'تأكد من إعدادات API وصلاحيات القراءة.',
      backMenu,
      true
    );
  }
});

// ======================================
// جميع الأصول
// ======================================

bot.action('assets', async (ctx) => {
  await ctx.answerCbQuery('جاري تحميل الأصول...');

  try {
    const balances = await getWallet();

    await show(
      ctx,
      assetsText(balances),
      backMenu,
      true
    );
  } catch (error) {
    console.error('Assets error:', error.message);

    await show(
      ctx,
      '❌ لم نتمكن من جلب بيانات المحفظة.',
      backMenu,
      true
    );
  }
});

// ======================================
// تحديث المحفظة
// ======================================

bot.action('refresh', async (ctx) => {
  await ctx.answerCbQuery('جاري تحديث البيانات...');

  try {
    const data = await dashboard();

    await show(
      ctx,
      dashboardText(data),
      backMenu,
      true
    );
  } catch (error) {
    console.error('Refresh error:', error.message);

    await show(
      ctx,
      '❌ فشل التحديث. حاول مرة أخرى.',
      backMenu,
      true
    );
  }
});

// ======================================
// التعامل مع الرسائل النصية
// ======================================

bot.on('text', async (ctx) => {
  await show(
    ctx,
    '₿ اختر الخدمة من القائمة:',
    mainMenu
  );
});

// ======================================
// معالجة الأخطاء
// ======================================

bot.catch((error) => {
  console.error('Telegram bot error:', error.message);
});

// ======================================
// سيرفر Railway
// ======================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('Bitcoin Wallet Bot is Running!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// ======================================
// تشغيل البوت
// ======================================

async function startBot() {
  try {
    console.log('Connecting to Telegram...');

    await bot.telegram.deleteWebhook();

    await bot.launch();

    console.log('Bitcoin Wallet Bot started successfully!');
  } catch (error) {
    console.error('Bot startup failed:', error.message);
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
