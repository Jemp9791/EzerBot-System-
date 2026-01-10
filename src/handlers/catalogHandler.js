const CatalogService = require('../modules/catalog/catalogServices');

module.exports = async (bot, msg) => {
  const chatId = msg.chat.id;

  try {
    const service = new CatalogService();
    const productos = await service.getAllProducts();

    if (!productos.length) {
      return bot.sendMessage(chatId, '⚠️ No hay productos disponibles.');
    }

    let texto = '📦 *Catálogo disponible:*\n\n';

    productos.forEach(p => {
      texto += `• ${p.NOMBRE || 'Producto'} - $${p.PRECIO || '0'}\n`;
    });

    bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('❌ Error en catalogHandler:', error.message);
    bot.sendMessage(chatId, '❌ Error al cargar el catálogo.');
  }
}; 
