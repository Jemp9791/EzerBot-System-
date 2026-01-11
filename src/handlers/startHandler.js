const configService = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    const texto = await configService.getValue('TextoBienvenida');

    if (!texto) {
      return ctx.reply('⚠️ TextoBienvenida no configurado en Sheets');
    }

    await ctx.reply(texto);
  } catch (error) {
    console.error('❌ Error en showWelcome:', error.message);
    await ctx.reply('❌ Error interno al mostrar bienvenida');
  }
}

module.exports = { showWelcome };
