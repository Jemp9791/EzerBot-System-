// src/bot.js

require('dotenv').config();
const { Telegraf } = require('telegraf');

// Handlers
const { showWelcome } = require('./handlers/startHandler');

// ================================
// Validaciones básicas
// ================================
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN no definido en variables de entorno');
  process.exit(1);
}

// ================================
// Inicialización del bot
// ================================
const bot = new Telegraf(process.env.BOT_TOKEN);

// ================================
// Comando /start
// ================================
bot.start(async (ctx) => {
  try {
    console.log('➡️ /start recibido de', ctx.from?.username || ctx.from?.id);
    await showWelcome(ctx);
  } catch (error) {
    console.error('❌ Error en /start:', error);
    await ctx.reply('❌ Error interno al iniciar el bot');
  }
});

// ================================
// Manejo de errores global
// ================================
bot.catch((err, ctx) => {
  console.error('❌ Error no manejado:', err);
  if (ctx?.reply) {
    ctx.reply('❌ Ocurrió un error inesperado');
  }
});

// ================================
// Lanzar bot (POLLING)
// IMPORTANTE: NO usar webhook
// ================================
bot.launch()
  .then(() => {
    console.log('🤖 Bot lanzado correctamente (polling)');
  })
  .catch((err) => {
    console.error('❌ Error al lanzar el bot:', err);
  });

// ================================
// Cierre limpio (Render / Linux)
// ================================
process.once('SIGINT', () => {
  console.log('🛑 SIGINT recibido, cerrando bot');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido, cerrando bot');
  bot.stop('SIGTERM');
});

module.exports = bot;
