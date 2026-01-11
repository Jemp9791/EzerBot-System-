const ConfigService = require('../modules/config/configService');
const config = new ConfigService();

async function showWelcome(ctx) {
  try {
    console.log('📥 showWelcome ejecutado');

    // 🔑 CLAVE EXACTA DE SHEETS
    const texto = await config.getValue('TextoBienvenida');

    if (!texto) {
      await ctx.reply('⚠️ Texto de bienvenida no configurado');
      return;
    }

    await ctx.reply(texto, {
      parse_mode: 'Markdown',
    });

  } catch (error) {
    console.error('❌ Error en showWelcome:', error);
    await ctx.reply('❌ Error al mostrar el mensaje de bienvenida');
  }
}

module.exports = {
  showWelcome,
};
