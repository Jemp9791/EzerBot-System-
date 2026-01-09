
const CarritoService = require('../modules/carrito/carritoService');
const ClientesService = require('../modules/clientes/clientesService');
const ConfigService = require('../modules/config/configService');

const carritoService = new CarritoService();
const clientesService = new ClientesService();
const configService = new ConfigService();

module.exports = async function checkoutHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const text = msg.text;

  // Estado temporal del checkout
  if (!global.checkout) global.checkout = {};
  if (!global.checkout[userId]) global.checkout[userId] = {};

  const state = global.checkout[userId];

  // --- INICIO DEL CHECKOUT ---
  if (text === 'Finalizar compra') {
    const tiene = await carritoService.tieneProductos(userId);
    if (!tiene) {
      return bot.sendMessage(chatId, 'Tu carrito está vacío.', menuButtons());
    }

    state.step = 'entrega';

    return bot.sendMessage(
      chatId,
      '¿Cómo querés recibir tu pedido?',
      entregaButtons()
    );
  }

  // --- PASO 1: FORMA DE ENTREGA ---
  if (state.step === 'entrega') {
    if (text === 'Retiro en local' || text === 'Envío programado' || text === 'Envío express') {
      state.entrega = text;
      state.step = 'nombre';

      return bot.sendMessage(
        chatId,
        'Decime tu nombre:',
        cancelButtons()
      );
    }

    return bot.sendMessage(chatId, 'Elegí una opción válida.', entregaButtons());
  }

  // --- PASO 2: NOMBRE ---
  if (state.step === 'nombre') {
    state.nombre = text;
    state.step = 'telefono';

    return bot.sendMessage(
      chatId,
      'Perfecto. Ahora tu teléfono:',
      cancelButtons()
    );
  }

  // --- PASO 3: TELÉFONO ---
  if (state.step === 'telefono') {
    state.telefono = text;

    if (state.entrega === 'Retiro en local') {
      state.step = 'horario';
      return bot.sendMessage(chatId, '¿A qué hora aproximada pasás a retirar?', cancelButtons());
    }

    state.step = 'direccion';
    return bot.sendMessage(chatId, 'Decime tu dirección completa:', cancelButtons());
  }

  // --- PASO 4A: HORARIO ---
  if (state.step === 'horario') {
    state.horario = text;
    state.step = 'nota';

    return bot.sendMessage(chatId, '¿Querés agregar una nota al pedido?', notaButtons());
  }

  // --- PASO 4B: DIRECCIÓN ---
  if (state.step === 'direccion') {
    state.direccion = text;
    state.step = 'nota';

    return bot.sendMessage(chatId, '¿Querés agregar una nota al pedido?', notaButtons());
  }

  // --- PASO 5: NOTA ---
  if (state.step === 'nota') {
    if (text !== 'Sin nota') state.nota = text;
    else state.nota = '';

    state.step = 'pago';

    return bot.sendMessage(chatId, '¿Cómo querés pagar?', pagoButtons());
  }

  // --- PASO 6: MÉTODO DE PAGO ---
  if (state.step === 'pago') {
    if (text === 'Efectivo') {
      state.pago = 'Efectivo';
      state.step = 'confirmar';

      return finalizarPedido(bot, chatId, userId, state);
    }

    if (text === 'Transferencia') {
      state.pago = 'Transferencia';
      state.step = 'comprobante';

      const config = await configService.getConfig();
      const total = await carritoService.calcularTotal(userId);

      return bot.sendMessage(
        chatId,
        `Transferí *${total}* a:\n\n*Alias:* ${config.Alias}\n\nTu carrito queda reservado por 1 hora.\nCuando tengas el comprobante, enviámelo acá.`,
        cancelButtons()
      );
    }

    return bot.sendMessage(chatId, 'Elegí un método válido.', pagoButtons());
  }

  // --- PASO 7: COMPROBANTE ---
  if (state.step === 'comprobante') {
    if (!msg.photo && !msg.document) {
      return bot.sendMessage(chatId, 'Enviame una foto o archivo del comprobante.', cancelButtons());
    }

    state.comprobante = msg.photo || msg.document;
    state.step = 'confirmar';

    return finalizarPedido(bot, chatId, userId, state);
  }
};

      keyboard: [['Menú']],
      resize_keyboard: true
    },
    parse_mode: 'Markdown'
  });

  // Acá se envía al vendedor
  // (lo armamos cuando hagamos adminConfirmHandler)

  return true;
                           }


async function finalizarPedido(bot, chatId, userId, state) {
  const total = await carritoService.calcularTotal(userId);

  let resumen = `🧾 *Resumen del pedido*\n\n`;
  resumen += `👤 *Nombre:* ${state.nombre}\n`;
  resumen += `📞 *Teléfono:* ${state.telefono}\n`;
  resumen += `🚚 *Entrega:* ${state.entrega}\n`;

  if (state.entrega === 'Retiro en local') {
    resumen += `⏰ *Horario:* ${state.horario}\n`;
  } else {
    resumen += `📍 *Dirección:* ${state.direccion}\n`;
  }

  if (state.nota) resumen += `📝 *Nota:* ${state.nota}\n`;

  resumen += `💳 *Pago:* ${state.pago}\n`;
  resumen += `💰 *Total:* ${total}\n\n`;
  resumen += `Esperá un momento mientras verificamos tu pedido.`;

  await bot.sendMessage(chatId, resumen, {
    reply_markup: {
      keyboard: [['Menú']],
      resize_keyboard: true
    },
    parse_mode: 'Markdown'
  });

  // Acá se envía al vendedor
  // (lo armamos cuando hagamos adminConfirmHandler)

  return true;
}
    
    
