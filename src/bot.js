const { Telegraf } = require('telegraf');

const { showWelcome } = require('./handlers/startHandler');
const helpHandler = require('./handlers/helpHandler');
const navigationHandler = require('./handlers/navigationHandler');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(token);

// ===== LOG GLOBAL (CLAVE) =====
bot.use(async (ctx, next) => {
  console.log('📩 Update recibido:', ctx.updateType);
  return next();
});

// ===== COMANDOS =====
bot.start(async (ctx) => {
  console.log('➡️ /start recibido');
  await showWelcome(ctx);
});

bot.command('help', async (ctx) => {
  console.log('➡️ /help recibido');
  await helpHandler(ctx);
});

// ===== CALLBACKS =====
bot.on('callback_query', async (ctx) => {
  console.log('🔘 Callback recibido');
  await navigationHandler(ctx);
});

// ===== ARRANQUE FORZADO PARA RENDER =====
bot.launch({
  polling: {
    timeout: 30
  },
  dropPendingUpdates: true
}).then(() => {
  console.log('🤖 Bot de Telegram escuchando (polling activo)');
});

// ===== CIERRE LIMPIO =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
