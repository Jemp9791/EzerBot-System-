const { Telegraf } = require('telegraf');

const { showWelcome } = require('./handlers/startHandler');
const helpHandler = require('./handlers/helpHandler');
const navigationHandler = require('./handlers/navigationHandler');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ BOT_TOKEN no definido en variables de entorno');
  process.exit(1);
}

const bot = new Telegraf(token);

// ===== COMANDOS =====
bot.start(async (ctx) => {
  console.log('➡️ /start recibido');
  await showWelcome(ctx);
});

bot.command('help', async (ctx) => {
  console.log('➡️ /help recibido');
  await helpHandler(ctx);
});

// ===== CALLBACKS (CARRUSEL) =====
bot.on('callback_query', async (ctx) => {
  await navigationHandler(ctx);
});

// ===== ARRANQUE DEL BOT (CLAVE) =====
bot.launch({
  dropPendingUpdates: true
}).then(() => {
  console.log('🤖 Bot conectado a Telegram (updates limpios)');
});

// ===== CIERRE LIMPIO =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
