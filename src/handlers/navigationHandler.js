
const CatalogService = require('../modules/catalog/catalogService');
const catalog = new CatalogService();

async function navigationHandler(ctx) {
  const data = ctx.callbackQuery.data;
  const [action, categoria, indexStr] = data.split('_');
  let index = parseInt(indexStr);

  const productos = await catalog.getProductsByCategory(categoria);

  if (action === 'next') index++;
  if (action === 'prev') index--;

  if (index < 0) index = productos.length - 1;
  if (index >= productos.length) index = 0;

  const p = productos[index];

  await ctx.editMessageMedia(
    {
      type: 'photo',
      media: p.IMAGEN,
      caption: `*${p.NOMBRE}*\n$${p.PRECIO} ${p.UNIDAD}\n\n${p.DESCRIPCION}`,
      parse_mode: 'Markdown'
    },
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⬅️', callback_data: `prev_${categoria}_${index}` },
            { text: '➡️', callback_data: `next_${categoria}_${index}` }
          ],
          [
            { text: '❤️ Quiero este', callback_data: `want_${p.CODIGO}` }
          ],
          [
            { text: '🔗 Compartir', switch_inline_query: p.NOMBRE }
          ]
        ]
      }
    }
  );
}

module.exports = navigationHandler;
    
