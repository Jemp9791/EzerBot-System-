
const CatalogService = require('../modules/catalog/catalogService');
const catalog = new CatalogService();

async function categoryCarouselHandler(ctx) {
  const categoria = ctx.callbackQuery.data.replace('categoria_', '');
  const productos = await catalog.getProductsByCategory(categoria);

  const p = productos[0]; // primer producto

  await ctx.replyWithPhoto(p.IMAGEN, {
    caption: `*${p.NOMBRE}*\n$${p.PRECIO} ${p.UNIDAD}\n\n${p.DESCRIPCION}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⬅️', callback_data: `prev_${categoria}_0` },
          { text: '➡️', callback_data: `next_${categoria}_0` }
        ],
        [
          { text: '❤️ Quiero este', callback_data: `want_${p.CODIGO}` }
        ],
        [
          { text: '🔗 Compartir', switch_inline_query: p.NOMBRE }
        ]
      ]
    }
  });
}

module.exports = categoryCarouselHandler;
           
