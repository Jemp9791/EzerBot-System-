const CatalogService = require('../modules/catalog/catalogServices');

module.exports = async (bot, msg) => {
  const chatId = msg.chat.id;

  try {
    const service = new CatalogService();
    const productos = await service.getAllProducts();

    if (!productos.length) {
      return bot.sendMessage(chatId, '⚠️ No hay productos disponibles.');
    }

    const categorias = [
      ...new Set(productos.map(p => p.CATEGORIA).filter(Boolean))
    ];

    if (!categorias.length) {
      return bot.sendMessage(chatId, '⚠️ No hay categorías.');
    }

    const keyboard = categorias.map(cat => [cat]);

    bot.sendMessage(chatId, '📂 Elegí una categoría:', {
      reply_markup: {
        keyboard,
        resize_keyboard: true
      }
    });

  } catch (err) {
    console.error('❌ categoriesHandler:', err.message);
    bot.sendMessage(chatId, '❌ Error cargando categorías.');
  }
};
