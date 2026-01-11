// src/handlers/startHandler.js

const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    const texto = await config.get('TextoBienvenida');

    if (!texto) {
      await ctx.reply('👋 ¡Bienvenido! Estamos listos para atenderte.');
      return;
    }

    await ctx.reply(texto, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('❌ Error en TextoBienvenida:', error);
    await ctx.reply('👋 ¡Bienvenido! (mensaje por defecto)');
  }
}

module.exports = {
  showWelcome,
};
