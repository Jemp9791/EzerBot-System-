const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    const texto = await config.getValue('TextoBienvenida');

    if (!texto) {
      await ctx.reply('⚠️ TextoBienvenida no configurado en Sheets');
      return;
    }

    await ctx.reply(texto);
  } catch (err) {
    console.error('Error en showWelcome:', err);
    await ctx.reply('❌ Error interno al mostrar bienvenida');
  }
}

module.exports = { showWelcome };
