// index.js — محادثة مع أحدث نماذج Claude من الطرفية
// التشغيل:
//   npm install @anthropic-ai/sdk
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   node index.js

const readline = require("readline");
const Anthropic = require("@anthropic-ai/sdk");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ضع مفتاحك في المتغير ANTHROPIC_API_KEY أولًا.");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// أحدث النماذج المتاحة للعامة
const MODELS = {
  fable: "claude-fable-5-2", // الأقوى (فئة Mythos مع حماية إضافية)
  opus: "claude-opus-5-5", // استدلال عميق
  sonnet: "claude-sonnet-5-5", // متوازن (نفس النموذج الذي تحادثه الآن)
  haiku: "claude-haiku-5-5", // الأسرع والأرخص
};

let currentModel = MODELS.sonnet;
let webSearch = false;
let history = [];

const SYSTEM_PROMPT =
  "أنت مساعد ذكي ومفيد. أجب بنفس لغة المستخدم وبوضوح وإيجاز.";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function help() {
  console.log(`
الأوامر:
  /model fable|opus|sonnet|haiku   تغيير النموذج
  /search                          تشغيل/إيقاف البحث في الويب
  /clear                           مسح المحادثة
  /help                            عرض الأوامر
  /exit                            خروج
`);
}

async function ask(text) {
  history.push({ role: "user", content: text });

  const params = {
    model: currentModel,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: history,
  };
  if (webSearch) {
    params.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  try {
    process.stdout.write("\nClaude: ");
    const stream = client.messages.stream(params);
    stream.on("text", (t) => process.stdout.write(t));
    const final = await stream.finalMessage();
    history.push({ role: "assistant", content: final.content });
    console.log("\n");
  } catch (err) {
    history.pop(); // تراجع عن آخر رسالة عند الفشل
    console.error("\n❌ خطأ:", err.message || err, "\n");
  }
}

function prompt() {
  rl.question(`[${currentModel}] أنت: `, async (line) => {
    const input = line.trim();
    if (!input) return prompt();

    if (input === "/exit") return rl.close();
    if (input === "/help") {
      help();
    } else if (input === "/clear") {
      history = [];
      console.log("✅ تم مسح المحادثة.\n");
    } else if (input === "/search") {
      webSearch = !webSearch;
      console.log(`🔎 البحث في الويب: ${webSearch ? "مفعّل" : "متوقف"}\n`);
    } else if (input.startsWith("/model")) {
      const key = input.split(/\s+/)[1];
      if (MODELS[key]) {
        currentModel = MODELS[key];
        console.log(`✅ النموذج الحالي: ${currentModel}\n`);
      } else {
        console.log("الخيارات: fable, opus, sonnet, haiku\n");
      }
    } else {
      await ask(input);
    }
    prompt();
  });
}

console.log("🤖 مرحبًا! اكتب /help لعرض الأوامر.");
prompt();
