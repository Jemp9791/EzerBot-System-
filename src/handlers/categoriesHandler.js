const CatalogService = require('../modules/catalog/catalogService');

const catalog = new CatalogService();

async function categoriesHandler(ctx) {
  try {
    const productos = await catalog.getAllProducts();

    if (!productos || productos.length === 0) {
      return ctx.reply('❌ No hay productos disponibles en este momento.');
    }

    const categorias = [
      ...new Set(
        productos
          .map(p => p.CATEGORIA)
          .filter(c => c && String(c).trim() !== '')
      )
    ];

    if (categorias.length === 0) {
      return ctx.reply('❌ No se encontraron categorías.');
    }

    await ctx.reply('📦 Elegí una categoría:', {
      reply_markup: {
        inline_keyboard: categorias.map(c => [
          {
            text: c,
            callback_data: `categoria_${c}`
          }
        ])
      }
    });

  } catch (err) {
    console.error('❌ Error en categoriesHandler:', err);
    await ctx.reply('⚠️ Ocurrió un error al cargar las categorías.');
  }
}

module.exports = categoriesHandler; 
