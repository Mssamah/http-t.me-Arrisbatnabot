import { Bot, webhookCallback } from "grammy";
import { Hono } from "hono";
import { config } from "./lib/config";
import { initDb } from "./lib/db";
import { registerHandlers } from "./bot";

const db = initDb(config.databasePath);
const bot = new Bot(config.botToken);
registerHandlers(bot, db);

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

const app = new Hono();
app.get("/", (c) => c.text("Mob Cash Telegram bot is running."));
app.get("/api/health", (c) =>
  c.json({ ok: true, service: "mob-cash-telegram-bot", timestamp: new Date().toISOString() })
);

app.post("/telegram/webhook", webhookCallback(bot, "hono"));

const port = Number(Bun.env.PORT || 3000);
Bun.serve({ fetch: app.fetch, port });

await bot.start({
  onStart: (info) => console.log(`Bot @${info.username} started`),
});
