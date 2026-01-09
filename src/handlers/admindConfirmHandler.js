
const CarritoService = require('../modules/carrito/carritoService');
const ClientesService = require('../modules/clientes/clientesService');
const ConfigService = require('../modules/config/configService');
const ComprasService = require('../modules/compras/comprasService');
const ticketHandler = require('./ticketHandler');

const carritoService = new CarritoService();
const clientesService = new ClientesService();
const configService = new ConfigService();
const comprasService = new ComprasService();

module.exports = async function adminConfirmHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Estado global de pedidos en espera de confirmación
  if (!global.pedidosPendientes) global.pedidosPendientes = {};

  // --- Cuando el checkout termina, se llama a esta función ---
  // Esta función la vas a llamar desde checkoutHandler:
  // adminConfirmHandler.enviarPedidoAlVendedor(...)
  // Por eso la exportamos abajo también.

  // --- Confirmación del vendedor ---
  if (text === 'Confirmar pedido') {
    const pedido = global.pedidosPendientes[userId];
    if (!pedido) {
      return bot.sendMessage(chatId, 'No hay pedidos pendientes.');
    }

    // Registrar compra
    await comprasService.registrarCompra(
      pedido.userId,
      pedido.items,
      pedido.total,
      pedido.metodoPago,
      pedido.datosCliente
    );

    // Vaciar carrito
    await carritoService.vaciarCarrito(pedido.userId);

    // Avisar al cliente
    await bot.sendMessage(
      pedido.userId,
      '¡Tu pedido fue confirmado! Estamos preparando todo.',
      { reply_markup: { keyboard: [['Menú']], resize_keyboard: true } }
    );

    // Enviar ticket
    await ticketHandler(bot, pedido.userId, pedido);

    delete global.pedidosPendientes[userId];

    return bot.sendMessage(chatId, 'Pedido confirmado y registrado.');
  }

  // --- Rechazo del vendedor ---
  if (text === 'Rechazar pedido') {
    const pedido = global.pedidosPendientes[userId];
    if (!pedido) {
      return bot.sendMessage(chatId, 'No hay pedidos pendientes.');
    }

    // Vaciar carrito
    await carritoService.vaciarCarrito(pedido.userId);

    // Avisar al cliente
    await bot.sendMessage(
      pedido.userId,
      'Tu pedido fue rechazado. Podés volver a intentarlo cuando quieras.',
      { reply_markup: { keyboard: [['Menú']], resize_keyboard: true } }
    );

    delete global.pedidosPendientes[userId];

    return bot.sendMessage(chatId, 'Pedido rechazado y carrito vaciado.');
  }
};

// ============================================================
// FUNCIÓN PARA ENVIAR EL PEDIDO AL VENDEDOR
// Se llama desde checkoutHandler cuando el cliente termina.
// ============================================================

module.exports.enviarPedidoAlVendedor = async function (bot, userId, datosCliente) {
  const config = await configService.getConfig();
  const vendedorChatId = config.VendedorChatId;

  const items = await carritoService.obtenerCarrito(userId);
  const total = await carritoService.calcularTotal(userId);

  let resumen = `🧾 *Nuevo pedido*\n\n`;
  resumen += `👤 *Cliente:* ${datosCliente.nombre}\n`;
  resumen += `📞 *Teléfono:* ${datosCliente.telefono}\n`;
  resumen += `🚚 *Entrega:* ${datosCliente.entrega}\n`;

  if (datosCliente.entrega === 'Retiro en local') {
    resumen += `⏰ *Horario:* ${datosCliente.horario}\n`;
  } else {
    resumen += `📍 *Dirección:* ${datosCliente.direccion}\n`;
  }

  if (datosCliente.nota) resumen += `📝 *Nota:* ${datosCliente.nota}\n`;

  resumen += `💳 *Pago:* ${datosCliente.pago}\n`;
  resumen += `💰 *Total:* ${total}\n\n`;

  resumen += `🛒 *Productos:*\n`;
  items.forEach(i => {
    resumen += `• ${i.PRODUCTO} x${i.CANTIDAD} = ${i.SUBTOTAL}\n`;
  });

  // Guardamos el pedido en memoria para cuando el vendedor confirme
  global.pedidosPendientes[userId] = {
    userId,
    items,
    total,
    metodoPago: datosCliente.pago,
    datosCliente
  };

  // Enviar al vendedor
  await bot.sendMessage(vendedorChatId, resumen, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['Confirmar pedido'],
        ['Rechazar pedido']
      ],
      resize_keyboard: true
    }
  });
};
