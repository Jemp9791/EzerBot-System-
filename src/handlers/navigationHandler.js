// src/handlers/navigationHandler.js

const catalog = require('../modules/catalog/catalogService');

async function navigationHandler(ctx) {
  if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;

  const data = ctx.callbackQuery.data;
  const [action, categoria, indexStr] = data.split('_');

  let index = parseInt(indexStr, 10);
  if (isNaN(index)) index = 0;

  const productos = await catalog.getProductsByCategory(categoria);

  if (!productos || productos.length === 0) {
    await ctx.answerCbQuery('No hay productos en esta categoría');
    return;
  }

  if (action === 'next') index++;
  if (action === 'prev') index--;

  if (index < 0) index = productos.length - 1;
  if (index >= productos.length) index = 0;

  const p = productos[index];

  await ctx.editMessageMedia(
    {
      type: 'photo',
      media: p.IMAGEN,
      caption:
        `*${p.NOMBRE}*\n` +
        `$${p.PRECIO} ${p.UNIDAD}\n\n` +
        `${p.DESCRIPCION || ''}`,
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
            { text: '🔗 Compartir', callback_data: `share_${p.CODIGO}` }
          ]
        ]
      }
    }
  );
}

module.exports = navigationHandler;
