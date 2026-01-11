console.log('🤖 bot.js cargado');

const { Telegraf } = require('telegraf');

// 👉 Handlers
const { showWelcome } = require('./handlers/startHandler');
const helpHandler = require('./handlers/helpHandler');
const navigationHandler = require('./handlers/navigationHandler');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(token);

// ===== LOG GLOBAL (para debug limpio) =====
bot.use(async (ctx, next) => {
  console.log('📩 Update recibido:', ctx.updateType);
  return next();
});

// ===== /START =====
bot.start(async (ctx) => {
  console.log('➡️ /start recibido');
  await showWelcome(ctx);
});

// ===== /HELP =====
bot.command('help', async (ctx) => {
  console.log('➡️ /help recibido');
  await helpHandler(ctx);
});

// ===== CALLBACKS (CARRUSEL / BOTONES) =====
bot.on('callback_query', async (ctx) => {
  console.log('🔘 Callback recibido');
  await navigationHandler(ctx);
});

// ===== LANZAR BOT (RENDER SAFE) =====
(async () => {
  try {
    console.log('🚀 Lanzando bot (polling)...');
    await bot.launch({
      dropPendingUpdates: true,
    });
    console.log('🤖 Bot de Telegram escuchando (polling activo)');
  } catch (err) {
    console.error('❌ Error al lanzar el bot:', err);
  }
})();

// ===== CIERRE LIMPIO =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
