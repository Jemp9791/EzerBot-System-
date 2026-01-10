const { Telegraf } = require('telegraf');

const startHandler = require('./handlers/startHandler');
const helpHandler = require('./handlers/helpHandler');
const catalogHandler = require('./handlers/catalogHandler');
const compartirHandler = require('./handlers/compartirHandler');

const bot = new Telegraf(process.env.BOT_TOKEN);

// START
bot.start(startHandler);

// BOTONES DEL TECLADO
bot.hears('🆘 Ayuda', helpHandler);
bot.hears('📦 Catálogo', catalogHandler);
bot.hears('🎟 Sellos', (ctx) => ctx.reply('🎟 Sistema de sellos en construcción'));
bot.hears('📤 Compartir', compartirHandler);

bot.launch().then(() => {
  console.log('🤖 EzerBot iniciado correctamente');
});
