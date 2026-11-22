# بوت شحن Telegram — إعداد Railway

## محتويات المشروع
- Telegram bot باستخدام grammY.
- Bun + Hono.
- SQLite لحفظ الطلبات.
- أوامر `/start`, `/buy`, `/status`, `/admin`, `/paid`.
- Dockerfile مناسب لـ Railway.
- Health endpoint: `/api/health`.

## نشر Railway
1. ارفع محتويات هذا المجلد إلى مستودع GitHub.
2. في Railway افتح الخدمة المقصودة واختر Settings / Source ثم اربط مستودع GitHub.
3. تأكد أن Railway يبني باستخدام Dockerfile الموجود في جذر المستودع.
4. في Variables أضف:
   - `BOT_TOKEN` = توكن Telegram من BotFather
   - `ADMIN_ID` = رقم حساب المدير في Telegram
   - `DATABASE_PATH` = `/data/data.sqlite`
   - `MOBICASH_MODE` = `mock` للاختبار فقط
5. في Volumes أنشئ Volume واربطه بمسار `/data`.
6. انشر الخدمة وانتظر نجاح Deployment.
7. افتح Logs وتأكد من ظهور `Telegram bot @... started`.
8. اترك نسخة واحدة فقط من خدمة long polling لهذا التوكن.

Railway يمرر `PORT` تلقائياً. التطبيق يستمع على `0.0.0.0` ويستخدم `PORT`.

## الاختبار
- افتح البوت في Telegram وأرسل `/start`.
- أنشئ طلباً تجريبياً:
  `/buy 0550000000 1000 REF12345678`
- راجع `/admin` بحساب المدير.
- لا تستخدم `/paid` إلا بعد التحقق الحقيقي من التحويل.

## تحذير مالي مهم
هذا المشروع لا يتصل حالياً بواجهة BaridiMob للتحقق من الدفع، ولا ينفذ شحناً حقيقياً عبر Mobi Cash.
`MOBICASH_MODE=mock` محاكاة فقط. لا تغيّره إلى `api` حتى يتم تنفيذ موصل مطابق لوثائق API الرسمية واختباره في بيئة تجريبية.
لا تجمع كلمة مرور BaridiMob أو OTP أو بيانات البطاقة. لا تعتمد على صورة إيصال وحدها كإثبات آلي للدفع.

## الاستكمال المطلوب
لإكمال التشغيل التلقائي الحقيقي، نحتاج وثائق مزود Mobi Cash الرسمية: base URL، المصادقة، endpoint إنشاء الشحن، endpoint الاستعلام عن الحالة، شكل النجاح والفشل، وآلية idempotency. ونحتاج أيضاً آلية دفع/تحقق رسمية معتمدة من BaridiMob أو مزود دفع متعاقد.
