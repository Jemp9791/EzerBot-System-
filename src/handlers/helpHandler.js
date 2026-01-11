// src/handlers/helpHandler.js

const config = require('../modules/config/configService');

async function helpHandler(ctx) {
  const gif = await config.getValue('GifAyudaID');
  const texto = await config.getValue('TextoBienvenida');
  const whatsapp = await config.getValue('WhatsAppLink');
  const email = await config.getValue('EmailSistema');

  await ctx.replyWithAnimation(gif, {
    caption: texto,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        whatsapp ? [{ text: '📞 WhatsApp', url: whatsapp }] : [],
        email ? [{ text: '📩 Email', url: `mailto:${email}` }] : []
      ].filter(row => row.length)
    }
  });
}

module.exports = helpHandler;
