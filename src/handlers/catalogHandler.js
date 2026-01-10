const CatalogService = require('../modules/catalog/catalogService');

const catalog = new CatalogService();

async function catalogHandler(ctx) {
  try {
    const productos = await catalog.getAllProducts();

    if (!productos || productos.length === 0) {
      return ctx.reply('No hay productos disponibles.');
    }

    const categorias = [...new Set(productos.map(p => p.CATEGORIA))];

    return ctx.reply('Elegí una categoría:', {
      reply_markup: {
        inline_keyboard: categorias.map(c => [
          { text: c, callback_data: `categoria_${c}` }
        ])
      }
    });
  } catch (err) {
    console.error('❌ Error en catalogHandler:', err);
    return ctx.reply('Error cargando el catálogo.');
  }
}

module.exports = catalogHandler;
