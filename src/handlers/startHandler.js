const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    const texto = await config.getValue('TextoBienvenida');

    if (!texto) {
      return ctx.reply('⚠️ TextoBienvenida no configurado en Sheets');
    }

    await ctx.reply(texto);
  } catch (error) {
    console.error('Error en showWelcome:', error);
    await ctx.reply('❌ Error interno al mostrar bienvenida');
  }
}

module.exports = {
  showWelcome
};
