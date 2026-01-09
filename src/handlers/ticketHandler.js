const ConfigService = require('../modules/config/configService');
const ClientesService = require('../modules/clientes/clientesService');

const configService = new ConfigService();
const clientesService = new ClientesService();

module.exports = async function ticketHandler(bot, userId, pedido) {
  const config = await configService.getConfig();
  const vendedorChatId = config.VendedorChatId;

  const cliente = await clientesService.obtenerCliente(userId);

  const sellos = cliente?.Sellos || 0;
  const puntos = cliente?.Puntos || 0;

  // --- Ticket para el cliente ---
  let ticket = `🧾 *Ticket de compra*\n\n`;

  ticket += `👤 *${pedido.datosCliente.nombre}*\n`;
  ticket += `📞 ${pedido.datosCliente.telefono}\n\n`;

  ticket += `🛒 *Productos:*\n`;
  pedido.items.forEach(i => {
    ticket += `• ${i.PRODUCTO} x${i.CANTIDAD} = ${i.SUBTOTAL}\n`;
  });

  ticket += `\n💰 *Total:* ${pedido.total}\n`;
  ticket += `💳 *Pago:* ${pedido.metodoPago}\n\n`;

  ticket += `⭐ *Sellos acumulados:* ${sellos}\n`;
  ticket += `🎁 *Puntos por referido:* ${puntos}\n\n`;

  ticket += `¡Gracias por tu compra!`;

  await bot.sendMessage(userId, ticket, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [['Menú']],
      resize_keyboard: true
    }
  });

  // --- Copia para el vendedor ---
  let copia = `📦 *Pedido confirmado*\n\n`;
  copia += `Cliente: ${pedido.datosCliente.nombre}\n`;
  copia += `Teléfono: ${pedido.datosCliente.telefono}\n`;
  copia += `Total: ${pedido.total}\n`;
  copia += `Pago: ${pedido.metodoPago}\n\n`;
  copia += `Sellos: ${sellos}\n`;
  copia += `Puntos: ${puntos}\n`;

  await bot.sendMessage(vendedorChatId, copia, { parse_mode: 'Markdown' });
};
