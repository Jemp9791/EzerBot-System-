const CatalogService = require('../../modules/catalog/catalogServices');

const catalogService = new CatalogService();

module.exports = async function catalogHandler(bot, msg) {
  const chatId = msg.chat.id;

  try {
    const productos = await catalogService.getAllProducts();

    if (!productos || productos.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No hay productos disponibles.');
    }

    const categorias = [
      ...new Set(
        productos
          .map(p => p.CATEGORIA)
          .filter(Boolean)
      )
    ];

    if (categorias.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No se encontraron categorías.');
    }

    const keyboard = categorias.map(c => ([{
      text: c,
      callback_data: `categoria_${c}`
    }]));

    await bot.sendMessage(chatId, '🛒 Elegí una categoría:', {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });

  } catch (error) {
    console.error('❌ Error en catalogHandler:', error.message);
    bot.sendMessage(chatId, '❌ Error cargando el catálogo.');
  }
};
