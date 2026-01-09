
const carritoPorUsuario = {};

function carritoHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Inicializar carrito si no existe
  if (!carritoPorUsuario[userId]) {
    carritoPorUsuario[userId] = [];
  }

  const carrito = carritoPorUsuario[userId];

  // Si el mensaje contiene texto tipo "agregar Producto X"
  const texto = msg.text.toLowerCase();
  const agregarMatch = texto.match(/agregar (.+)/);

  if (agregarMatch) {
    const producto = agregarMatch[1].trim();
    carrito.push(producto);

    bot.sendMessage(chatId, `🛒 Producto agregado: *${producto}*`, {
      parse_mode: 'Markdown'
    });
    return;
  }

  // Si el usuario quiere ver el carrito
  if (texto.includes('ver carrito') || texto === '/carrito') {
    if (carrito.length === 0) {
      bot.sendMessage(chatId, '🛒 Tu carrito está vacío.');
    } else {
      const lista = carrito.map((p, i) => `${i + 1}. ${p}`).join('\n');
      bot.sendMessage(chatId, `🛍️ Tu carrito:\n\n${lista}`);
    }
    return;
  }

  // Si el mensaje no coincide con nada
  bot.sendMessage(chatId, '🛒 Para agregar productos, escribí:\n\n_agregar Producto X_\n\nPara ver tu carrito, escribí:\n\n_ver carrito_');
}

module.exports = carritoHandler;
