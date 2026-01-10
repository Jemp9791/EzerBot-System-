const CatalogService = require('../modules/catalog/catalogServices');

module.exports = async (bot, msg) => {
  const chatId = msg.chat.id;

  try {
    const service = new CatalogService();
    const productos = await service.getAllProducts();

    if (!productos.length) {
      return bot.sendMessage(chatId, '⚠️ El catálogo está vacío.');
    }

    // Obtener categorías únicas
    const categorias = [
      ...new Set(productos.map(p => p.CATEGORIA).filter(Boolean))
    ];

    if (!categorias.length) {
      return bot.sendMessage(chatId, '⚠️ No hay categorías disponibles.');
    }

    const teclado = categorias.map(cat => [cat]);

    bot.sendMessage(chatId, '📂 *Elegí una categoría:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: teclado,
        resize_keyboard: true
      }
    });

  } catch (err) {
    console.error('❌ catalogHandler error:', err.message);
    bot.sendMessage(chatId, '❌ Error al cargar el catálogo.');
  }
};
