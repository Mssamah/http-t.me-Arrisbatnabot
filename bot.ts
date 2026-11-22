import { Telegraf, Markup } from 'telegraf';
import { store } from './lib/store';
import { ManualProvider } from './providers/manualProvider';

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);
  const adminId = Number(process.env.ADMIN_ID || 0);
  const paymentInfo = process.env.PAYMENT_INFO || 'يرجى التواصل مع الإدارة للحصول على معلومات الدفع.';
  const provider = new ManualProvider();

  bot.start((ctx) => {
    store.clearSession(ctx.from.id);
    return ctx.reply(
      'مرحباً بك في نظام الشحن.\nاختر العملية المطلوبة من القائمة:',
      Markup.keyboard([['💳 شحن الحساب']]).resize()
    );
  });

  bot.hears('💳 شحن الحساب', (ctx) => {
    const session = store.getSession(ctx.from.id);
    session.step = 'awaiting_account_id';
    return ctx.reply('أدخل رقم الحساب (ID) المراد شحنه:');
  });

  bot.on('text', (ctx) => {
    const userId = ctx.from.id;
    const session = store.getSession(userId);
    const text = ctx.message.text.trim();

    if (session.step === 'awaiting_account_id') {
      session.accountId = text;
      session.step = 'awaiting_amount';
      return ctx.reply('أدخل المبلغ المراد شحنه:');
    }

    if (session.step === 'awaiting_amount') {
      session.amount = text;
      session.step = 'awaiting_receipt';
      return ctx.reply(
        `${paymentInfo}\n\nقم بتحويل مبلغ *${text}* ثم أرسل *صورة وصل الدفع* هنا:`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    const session = store.getSession(userId);

    if (session.step !== 'awaiting_receipt' || !session.accountId || !session.amount) {
      return ctx.reply('يرجى الضغط على "💳 شحن الحساب" لبدء طلب جديد أولاً.');
    }

    const orderId = `ORD${Date.now()}`;
    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    store.saveOrder({
      id: orderId,
      userId,
      accountId: session.accountId,
      amount: session.amount,
      status: 'pending',
      createdAt: new Date()
    });

    const caption =
      `📥 *طلب شحن جديد*\n\n` +
      `🔖 رقم الطلب: \`${orderId}\`\n` +
      `👤 المستخدم: \`${userId}\`\n` +
      `🆔 رقم الحساب: \`${session.accountId}\`\n` +
      `💰 المبلغ: \`${session.amount}\``;

    if (adminId) {
      await ctx.telegram.sendPhoto(adminId, photo.file_id, {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ تأكيد الشحن', `approve_${orderId}`),
            Markup.button.callback('❌ رفض الطلب', `reject_${orderId}`)
          ]
        ])
      });
    }

    store.clearSession(userId);
    return ctx.reply('⏳ تم استلام الوصل وإرسال طلبك للمراجعة. سيتم إشعارك فور التنفيذ.');
  });

  bot.action(/^(approve|reject)_(.+)$/, async (ctx) => {
    if (ctx.from?.id !== adminId) {
      return ctx.answerCbQuery('غير مصرح لك بهذا الإجراء.', { show_alert: true });
    }

    const action = ctx.match[1];
    const orderId = ctx.match[2];
    const order = store.getOrder(orderId);

    if (!order) {
      return ctx.answerCbQuery('الطلب غير موجود أو انتهت صلاحيته.', { show_alert: true });
    }

    if (order.status !== 'pending') {
      return ctx.answerCbQuery('تمت معالجة هذا الطلب مسبقاً.', { show_alert: true });
    }

    if (action === 'approve') {
      const result = await provider.processTopUp({
        orderId: order.id,
        accountId: order.accountId,
        amount: order.amount,
        userId: order.userId
      });

      store.updateOrderStatus(orderId, 'approved');
      await ctx.telegram.sendMessage(order.userId, `✅ ${result.message}`);
      await ctx.editMessageCaption(
        `✅ *تم تأكيد الطلب* (\`${orderId}\`)\n🆔 الحساب: \`${order.accountId}\` | 💰 المبلغ: \`${order.amount}\``,
        { parse_mode: 'Markdown' }
      );
      return ctx.answerCbQuery('تم تأكيد الشحن وإشعار المستخدم.');
    } else {
      store.updateOrderStatus(orderId, 'rejected');
      await ctx.telegram.sendMessage(
        order.userId,
        `❌ عذراً، تم رفض طلب الشحن رقم \`${orderId}\`. يرجى التأكد من صحة الوصل والمحاولة مجدداً.`,
        { parse_mode: 'Markdown' }
      );
      await ctx.editMessageCaption(
        `❌ *تم رفض الطلب* (\`${orderId}\`)\n🆔 الحساب: \`${order.accountId}\` | 💰 المبلغ: \`${order.amount}\``,
        { parse_mode: 'Markdown' }
      );
      return ctx.answerCbQuery('تم رفض الطلب.');
    }
  });

  return bot;
}
