const { Telegraf } = require('telegraf');
const { showWelcome } = require('./handlers/startHandler');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  console.log('➡️ /start recibido');
  await showWelcome(ctx);
});

bot.launch();
console.log('🤖 Bot lanzado');

module.exports = bot;
