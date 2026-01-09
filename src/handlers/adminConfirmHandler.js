
function adminConfirmHandler(bot, msg) {
  const chatId = msg.chat.id;
  const texto = msg.text.toLowerCase();

  if (texto.includes('confirmar pedido')) {
    bot.sendMessage(chatId, '✅ Pedido confirmado. El cliente será notificado.');
    return;
  }

  if (texto.includes('rechazar pedido')) {
    bot.sendMessage(chatId, '❌ Pedido rechazado. El cliente será notificado.');
    return;
  }

  // Si no coincide con comandos de vendedor, no responde
}

module.exports = adminConfirmHandler;
