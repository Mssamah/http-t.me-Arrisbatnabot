import dotenv from 'dotenv';
dotenv.config();

import { createBot } from './bot';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Error: BOT_TOKEN is missing in environment variables.');
  process.exit(1);
}

const bot = createBot(token);

bot.launch().then(() => {
  console.log('MobCash Telegram Bot is running...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
