const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    console.log('📥 /start recibido');

    const texto = await config.get('TextoBienvenida');

    if (!texto) {
      await ctx.reply('⚠️ TextoBienvenida no configurado en Sheets');
      return;
    }

    await ctx.reply(texto, {
      parse_mode: 'Markdown',
    });

  } catch (error) {
    console.error('❌ Error en startHandler:', error);
    await ctx.reply('❌ Error interno');
  }
}

module.exports = {
  showWelcome,
};
