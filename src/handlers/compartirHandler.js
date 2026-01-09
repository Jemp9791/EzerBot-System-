
const ConfigService = require('../modules/config/configService');
const config = new ConfigService();

async function compartirHandler(ctx) {
  const userId = ctx.from.id;

  // Modo compartir catálogo
  const textoCatalogo = await config.getValue('TextoCompartirCatalogo');
  const gifCatalogo = await config.getValue('GifCompartirCatalogo');

  // Link con referral
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=ref_${userId}`;

  // Modo compartir bot/sistema
  const textoSistema = await config.getValue('TextoCompartirSistema');
  const gifSistema = await config.getValue('GifCompartirSistema');
  const email = await config.getValue('EmailSistema');

  await ctx.reply(
    '¿Qué querés compartir?',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📣 Compartir Catálogo', callback_data: 'share_catalogo' }],
          [{ text: '🤖 Compartir el Bot / Sistema', callback_data: 'share_sistema' }]
        ]
      }
    }
  );

  // Handlers internos
  ctx.telegram.on('callback_query', async (query) => {
    if (query.data === 'share_catalogo') {
      await ctx.replyWithAnimation(gifCatalogo, {
        caption: `${textoCatalogo}\n\n🔗 ${referralLink}`,
        parse_mode: 'Markdown'
      });
    }

    if (query.data === 'share_sistema') {
      await ctx.replyWithAnimation(gifSistema, {
        caption: `${textoSistema}\n\n📩 Contacto: ${email}`,
        parse_mode: 'Markdown'
      });
    }
  });
}

module.exports = compartirHandler;
Mostrar texto citado
                                             
