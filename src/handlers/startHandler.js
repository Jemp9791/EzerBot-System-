// src/handlers/startHandler.js

const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    const texto = await config.get('TextoBienvenida');

    if (!texto) {
      await ctx.reply('⚠️ TextoBienvenida no configurado en Sheets');
      return;
    }

    await ctx.reply(texto);
  } catch (error) {
    console.error('❌ Error en showWelcome:', error);
    await ctx.reply('❌ Error interno al mostrar bienvenida');
  }
}

module.exports = {
  showWelcome,
};
