console.log('🤖 bot.js cargado');

const { Telegraf } = require('telegraf');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start(async (ctx) => {
  console.log('➡️ /start recibido');
  await ctx.reply('Bot activo ✅');
});

(async () => {
  try {
    console.log('🚀 Lanzando bot (polling)...');
    await bot.launch({
      dropPendingUpdates: true,
    });
    console.log('🤖 Bot de Telegram escuchando (polling activo)');
  } catch (err) {
    console.error('❌ Error al lanzar bot:', err);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
