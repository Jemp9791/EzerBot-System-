const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  try {
    console.log('📥 showWelcome ejecutado');

    const texto = await config.getValue('TextoBienvenida');

    if (!texto) {
      await ctx.reply('⚠️ TextoBienvenida no configurado');
      return;
    }

    await ctx.reply(texto, {
      parse_mode: 'Markdown',
    });

  } catch (error) {
    console.error('❌ Error en showWelcome:', error);
    await ctx.reply('❌ Error interno');
  }
}

module.exports = {
  showWelcome,
};
