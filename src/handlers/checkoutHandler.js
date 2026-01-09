const carritoPorUsuario = require('./carritoHandler').carritoPorUsuario;

function checkoutHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const carrito = carritoPorUsuario[userId] || [];

  if (carrito.length === 0) {
    bot.sendMessage(chatId, '🛒 No tenés productos en tu carrito.');
    return;
  }

  const resumen = carrito.map((p, i) => `${i + 1}. ${p}`).join('\n');

  bot.sendMessage(chatId, `✅ *Compra confirmada*\n\nTu pedido:\n${resumen}`, {
    parse_mode: 'Markdown'
  });

  // Vaciar carrito
  carritoPorUsuario[userId] = [];
}

module.exports = checkoutHandler;
