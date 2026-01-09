
const CatalogService = require('../modules/catalog/catalogService');
const catalog = new CatalogService();

async function categoriesHandler(ctx) {
  const productos = await catalog.getAllProducts();

  const categorias = [...new Set(productos.map(p => p.CATEGORIA))];

  await ctx.reply('Elegí una categoría:', {
    reply_markup: {
      inline_keyboard: categorias.map(c => [
        { text: c, callback_data: `categoria_${c}` }
      ])
    }
  });
}

module.exports = categoriesHandler;

