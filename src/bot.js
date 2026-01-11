const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const { showWelcome } = require('./handlers/startHandler');

bot.start(async (ctx) => {
  console.log('/start recibido');
  await showWelcome(ctx);
});

bot.launch();
console.log('🤖 Bot lanzado');
