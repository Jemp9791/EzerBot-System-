

const ConfigService = require('../modules/config/configService');
const config = new ConfigService();

async function helpHandler(ctx) {
  const gif = await config.getValue('SellosURL'); 
  const texto = await config.getValue('TextoBienvenida');

  await ctx.replyWithAnimation(gif, {
    caption: texto,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📞 WhatsApp', url: await config.getValue('WhatsAppLink') }],
        [{ text: '📩 Email', url: `mailto:${await config.getValue('EmailSistema')}` }]
      ]
    }
  });
}

module.exports = helpHandler;
