
const ConfigService = require('../modules/config/configService');
const config = new ConfigService();

async function startHandler(ctx) {
  const t1 = await config.getValue('TextoInicio');
  const t2 = await config.getValue('TextoInicio2');
  const t3 = await config.getValue('TextoInicio3');
  const gif = await config.getValue('CardURL');

  await ctx.replyWithAnimation(gif, {
    caption: `${t1}\n\n${t2}\n\n${t3}`,
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['🧀 Catálogo', '🎟️ Sellos'],
        ['ℹ️ Ayuda', '📣 Compartir']
      ],
      resize_keyboard: true
    }
  });
}

module.exports = startHandler;
