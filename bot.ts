import {
  Bot, InlineKeyboard, Context, Keyboard,
} from "grammy";
import { config } from "./lib/config";
import { Store } from "./lib/db";
import { rechargeMobiCash } from "./providers/mobicash";

const amountKeyboard = () => {
  const kb = new InlineKeyboard();
  config.amounts.forEach((amount, index) => {
    kb.text(`${amount.toLocaleString("en-US")} دج`, `amount:${amount}`);
    if (index % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ رجوع", "home");
  return kb;
};

function homeKeyboard() {
  return new InlineKeyboard()
    .text("🛒 طلب شحن", "buy").row()
    .text("📦 طلباتي", "orders")
    .text("💰 الأسعار", "prices").row()
    .text("📞 الدعم الفني", "support");
}

function isAdmin(ctx: Context) {
  return ctx.from?.id === config.adminId;
}

export function registerHandlers(bot: Bot, store: Store) {
  const waitingForAccount = new Set<number>();

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    store.saveUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await ctx.reply(
      `مرحباً ${ctx.from.first_name} 👋\nأهلاً بك في بوت Mob Cash.\nاختر الخدمة من القائمة:`,
      { reply_markup: homeKeyboard() },
    );
  });

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("غير مصرح لك.");
    await ctx.reply("لوحة المدير:\n/pending لعرض الطلبات\n/approve رقم_الطلب لتأكيد الدفع\n/reject رقم_الطلب لرفض الطلب");
  });

  bot.command("pending", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("غير مصرح لك.");
    const orders = store.getPendingOrders();
    if (!orders.length) return ctx.reply("لا توجد طلبات تنتظر تأكيد الدفع.");
    for (const o of orders) {
      await ctx.reply(
        `طلب #${o.id}\nالمبلغ: ${o.amount} دج\nالحساب: ${o.account_ref}\nالزبون: ${o.user_id}\nالحالة: ${o.status}`,
      );
    }
  });

  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("غير مصرح لك.");
    const id = Number(ctx.match);
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("استعمال الأمر: /approve رقم_الطلب");
    const order = store.getOrder(id);
    if (!order) return ctx.reply("الطلب غير موجود.");
    if (order.status !== "awaiting_payment") return ctx.reply(`لا يمكن اعتماد الطلب. حالته: ${order.status}`);
    store.setStatus(id, "awaiting_provider");
    await ctx.api.sendMessage(order.user_id, `تم تأكيد الدفع للطلب #${id} ✅\nجارٍ إرسال طلب الشحن.`);
    try {
      const result = await rechargeMobiCash(order.account_ref, order.amount);
      store.setStatus(id, "completed", result.reference || null);
      await ctx.api.sendMessage(order.user_id, `تم الشحن بنجاح ✅\nرقم الطلب: #${id}`);
      await ctx.reply(`تم إكمال الطلب #${id}.`);
    } catch (error) {
      store.setStatus(id, "failed");
      const message = error instanceof Error ? error.message : "Unknown provider error";
      await ctx.api.sendMessage(order.user_id, `تم تأكيد الدفع، لكن تعذر تنفيذ الشحن آلياً حالياً. رقم الطلب #${id}. يرجى التواصل مع الدعم.`);
      await ctx.reply(`تعذر تنفيذ الشحن للطلب #${id}: ${message}`);
    }
  });

  bot.command("reject", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("غير مصرح لك.");
    const id = Number(ctx.match);
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("استعمال الأمر: /reject رقم_الطلب");
    const order = store.getOrder(id);
    if (!order) return ctx.reply("الطلب غير موجود.");
    store.setStatus(id, "payment_rejected");
    await ctx.api.sendMessage(order.user_id, `تم رفض الدفع للطلب #${id}. تواصل مع الدعم إذا كان هذا خطأ.`);
    await ctx.reply(`تم رفض الطلب #${id}.`);
  });

  bot.callbackQuery("home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("القائمة الرئيسية:", { reply_markup: homeKeyboard() });
  });

  bot.callbackQuery("buy", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("اختر مبلغ الشحن:", { reply_markup: amountKeyboard() });
  });

  bot.callbackQuery(/^amount:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = Number(ctx.match[1]);
    if (!config.amounts.includes(amount)) return ctx.reply("هذا المبلغ غير متاح.");
    waitingForAccount.add(ctx.from.id);
    // Store the chosen amount in a per-user temporary map.
    selectedAmounts.set(ctx.from.id, amount);
    await ctx.reply(`اخترت ${amount} دج.\nأرسل الآن رقم الحساب أو المعرّف الذي تريد شحنه:`);
  });

  bot.callbackQuery("prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `أسعار/مبالغ الشحن المتاحة:\n${config.amounts.map((a) => `• ${a} دج`).join("\n")}`,
      { reply_markup: new InlineKeyboard().text("⬅️ رجوع", "home") },
    );
  });

  bot.callbackQuery("orders", async (ctx) => {
    await ctx.answerCallbackQuery();
    const orders = store.getUserOrders(ctx.from.id);
    if (!orders.length) return ctx.reply("ليس لديك طلبات حتى الآن.");
    await ctx.reply(orders.map((o) =>
      `#${o.id} — ${o.amount} دج — ${statusArabic(o.status)}`
    ).join("\n"));
  });

  bot.callbackQuery("support", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(config.supportUsername
      ? `للدعم الفني: @${config.supportUsername}`
      : "لم يتم إعداد حساب الدعم الفني بعد.");
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    if (!waitingForAccount.has(userId)) return;
    const accountRef = ctx.message.text.trim();
    if (accountRef.length < 3 || accountRef.length > 100) {
      return ctx.reply("المعرّف غير صحيح. أرسله مرة أخرى (من 3 إلى 100 حرف).");
    }
    const amount = selectedAmounts.get(userId);
    if (!amount) {
      waitingForAccount.delete(userId);
      return ctx.reply("انتهت الجلسة. ابدأ طلباً جديداً من /start.");
    }
    const orderId = store.createOrder(userId, ctx.from.username, amount, accountRef);
    waitingForAccount.delete(userId);
    selectedAmounts.delete(userId);

    const payment = config.baridimobRip
      ? `\nبيانات الدفع عبر BaridiMob:\nRIP: ${config.baridimobRip}\nالاسم: ${config.baridimobName || "غير محدد"}`
      : "\nسيتم إرسال تعليمات الدفع بعد إعداد بيانات الدفع من المدير.";
    await ctx.reply(
      `تم إنشاء طلبك بنجاح ✅\nرقم الطلب: #${orderId}\nالمبلغ: ${amount} دج\nالحساب: ${accountRef}${payment}\n\nحالة الطلب: ينتظر تأكيد الدفع.\nبعد الدفع، أرسل وصل الدفع إلى الدعم.`,
    );
    await ctx.api.sendMessage(
      config.adminId,
      `طلب شحن جديد #${orderId}\nالمبلغ: ${amount} دج\nالحساب: ${accountRef}\nالزبون: ${userId}\n\nتحقق من الدفع قبل استخدام /approve ${orderId}`,
    );
  });
}

const selectedAmounts = new Map<number, number>();

function statusArabic(status: string) {
  const labels: Record<string, string> = {
    awaiting_payment: "ينتظر الدفع",
    payment_rejected: "الدفع مرفوض",
    awaiting_provider: "قيد الشحن",
    completed: "مكتمل",
    failed: "تعذر الشحن",
  };
  return labels[status] || status;
}
