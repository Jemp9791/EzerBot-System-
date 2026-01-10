const CatalogService = require('../modules/catalog/catalogServices');

module.exports = async (bot, msg) => {
  const chatId = msg.chat.id;

  try {
    const catalog = new CatalogService();
    const productos = await catalog.getAllProducts();

    if (!productos || productos.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No hay productos disponibles.');
    }

    // Obtener categorías únicas
    const categorias = [
      ...new Set(
        productos
          .map(p => p.CATEGORIA)
          .filter(c => c && c.trim() !== '')
      )
    ];

    if (categorias.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No se encontraron categorías.');
    }

    // Armar teclado
    const keyboard = categorias.map(cat => [cat]);

    await bot.sendMessage(chatId, '📦 Elegí una categoría:', {
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });

  } catch (err) {
    console.error('❌ Error en catalogHandler:', err.message);
    bot.sendMessage(chatId, '❌ Error cargando el catálogo.');
  }
};
