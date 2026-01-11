const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const { showWelcome } = require('./handlers/startHandler');

bot.start(async (ctx) => {
  console.log('➡️ /start recibido de', ctx.from.id);
  await showWelcome(ctx);
});

bot.launch().then(() => {
  console.log('🤖 Bot lanzado correctamente');
});

module.exports = bot;
