import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes

# ضع التوكن الخاص بك هنا
TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE"

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)

# --- دالة خوارزمية حساب مفتاح CCP و RIP الجزائري ---
def calculate_ccp_details(ccp_number: str):
    ccp_clean = ccp_number.strip().lstrip('0')
    if not ccp_clean.isdigit() or len(ccp_clean) > 10:
        return None
    
    # حساب المفتاح (Clé CCP)
    ccp_int = int(ccp_clean)
    key_ccp = (ccp_int * 100) % 97
    key_ccp = 97 - key_ccp if key_ccp != 0 else 97
    key_ccp_str = f"{key_ccp:02d}"
    
    # حساب مفتاح RIP (الخاص ببريدي موب)
    ccp_padded = ccp_clean.zfill(10)
    rip_base = int(f"00799999{ccp_padded}00")
    key_rip = 97 - (rip_base % 97)
    key_rip_str = f"{key_rip:02d}"
    full_rip = f"00799999{ccp_padded}{key_rip_str}"
    
    return ccp_clean, key_ccp_str, full_rip

# --- القوائم ---
def main_menu():
    keyboard = [
        [InlineKeyboardButton("🔢 حاسبة مفتاح CCP و RIP", callback_data="calc_ccp")],
        [
            InlineKeyboardButton("📄 الوثائق الإدارية", callback_data="docs"),
            InlineKeyboardButton("💼 منحة البطالة ANEM", callback_data="anem"),
        ],
        [
            InlineKeyboardButton("🚑 أرقام الطوارئ", callback_data="emergency"),
            InlineKeyboardButton("📮 خدمات بريد الجزائر", callback_data="post"),
        ]
    ]
    return InlineKeyboardMarkup(keyboard)

def back_menu():
    return InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="home")]])

# --- الأوامر والتفاعلات ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["awaiting_ccp"] = False
    await update.message.reply_text(
        "مرحباً بك في **بوت خدمات الجزائر** 🇩🇿\nاختر ما تحتاجه من القائمة:",
        reply_markup=main_menu(),
        parse_mode="Markdown"
    )

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "home":
        context.user_data["awaiting_ccp"] = False
        await query.edit_message_text("اختر الخدمة المطلوبة: 🇩🇿", reply_markup=main_menu())

    elif data == "calc_ccp":
        context.user_data["awaiting_ccp"] = True
        await query.edit_message_text(
            "🔢 **أرسل الآن رقم حسابك البريدي (CCP) بدون المفتاح:**\n*(مثال: 12345678)*",
            reply_markup=back_menu(),
            parse_mode="Markdown"
        )

    elif data == "docs":
        text = (
            "📄 **روابط استخراج الوثائق عن بُعد:**\n\n"
            "• **شهادة الميلاد (S12):** `etatcivil.interieur.gov.dz`\n"
            "• **صحيفة السوابق العدلية (رقم 3):** `portail.mjustice.dz`\n"
            "• **جواز السفر وبطاقة التعريف:** `passeport.interieur.gov.dz`"
        )
        await query.edit_message_text(text, reply_markup=back_menu(), parse_mode="Markdown")

    elif data == "anem":
        text = (
            "💼 **خدمات التشغيل ومنحة البطالة:**\n\n"
            "• **حجز موعد منحة البطالة:** `minha.anem.dz`\n"
            "• **تمديد طلب العمل (الوسيط):** `wassitonline.anem.dz`"
        )
        await query.edit_message_text(text, reply_markup=back_menu(), parse_mode="Markdown")

    elif data == "post":
        text = (
            "📮 **بريد الجزائر:**\n\n"
            "• **كشف الرصيد (ECCP):** `eccp.poste.dz`\n"
            "• **طلب البطاقة الذهبية:** `edcarte.poste.dz`\n"
            "• **الرقم الأخضر:** 1530"
        )
        await query.edit_message_text(text, reply_markup=back_menu(), parse_mode="Markdown")

    elif data == "emergency":
        text = (
            "🚑 **أرقام الطوارئ المجانية:**\n\n"
            "• **الحماية المدنية:** 14 / 1021\n"
            "• **الشرطة:** 1548 / 17\n"
            "• **الدرك الوطني:** 1055\n"
            "• **سونلغاز:** 3303\n"
            "• **المياه:** 1594"
        )
        await query.edit_message_text(text, reply_markup=back_menu(), parse_mode="Markdown")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if context.user_data.get("awaiting_ccp"):
        result = calculate_ccp_details(update.message.text)
        if result:
            ccp, key, rip = result
            context.user_data["awaiting_ccp"] = False
            reply = (
                f"✅ **نتيجة الحساب:**\n\n"
                f"• **رقم الحساب:** `{ccp}`\n"
                f"• **المفتاح (Clé):** `{key}`\n"
                f"• **رقم RIP (بريدي موب):**\n`{rip}`"
            )
            await update.message.reply_text(reply, reply_markup=back_menu(), parse_mode="Markdown")
        else:
            await update.message.reply_text("❌ رقم غير صحيح. أرسل أرقاماً فقط (بحد أقصى 10 أرقام):", reply_markup=back_menu())

def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    print("البوت قيد التشغيل...")
    app.run_polling()

if __name__ == "__main__":
    main()
