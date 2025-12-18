// index.js
const TelegramBot = require('node-telegram-bot-api');

// Usá el mismo BOT_TOKEN que ya tenías en Render
const token = process.env.BOT_TOKEN || 'PONE_ACA_TU_TOKEN_SI_PROBAS_LOCAL';

const bot = new TelegramBot(token, { polling: true });

// Alias para transferencia (el que ya tenés en Config)
const ALIAS_TRANSFERENCIA = 'jennyocampos.mp';

// Estado simple por usuario
const userStates = {};

// Helper para iniciar el flujo
function startFlow(chatId) {
  userStates[chatId] = {
    step: 'choose_delivery',
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    paymentType: null,
  };

  bot.sendMessage(
    chatId,
    'Elegí cómo querés recibir tu pedido 👇',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚚 Envío a domicilio', callback_data: 'envio_domicilio' }],
          [{ text: '🏪 Retiro por el local', callback_data: 'retiro_local' }]
        ]
      }
    }
  );
}

// /start y saludos básicos
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').toString().trim().toLowerCase();

  // Si es /start o un saludo simple, reiniciamos flujo
  if (text === '/start' || text === 'hola' || text === 'buenas' || text === 'buenos días' || text === 'buenas tardes' || text === 'buenas noches') {
    return startFlow(chatId);
  }

  // Si no hay estado, ignoramos (o podrías llamar a startFlow)
  const state = userStates[chatId];
  if (!state) return;

  // Lógica según el paso actual
  if (state.step === 'ask_address') {
    state.address = msg.text.trim();
    state.step = 'ask_name';

    bot.sendMessage(chatId, '🧾 Tu nombre:');
  } else if (state.step === 'ask_name') {
    state.name = msg.text.trim();
    state.step = 'ask_phone';

    bot.sendMessage(chatId, '📞 Tu teléfono:');
  } else if (state.step === 'ask_phone') {
    state.phone = msg.text.trim();
    state.step = 'choose_payment';

    // Preguntamos método de pago
    bot.sendMessage(
      chatId,
      'Perfecto. Ahora elegí el método de pago:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💵 Efectivo', callback_data: 'pago_efectivo' }],
            [{ text: '🏦 Transferencia', callback_data: 'pago_transferencia' }]
          ]
        }
      }
    );
  }
});

// Manejo de botones inline
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId] || {};

  // Elegir tipo de entrega
  if (data === 'envio_domicilio') {
    state.deliveryType = 'envio';
    state.step = 'ask_address';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📍 Decime tu dirección completa:');
  } else if (data === 'retiro_local') {
    state.deliveryType = 'retiro';
    state.step = 'ask_name';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '🧾 Tu nombre:');
  }

  // Elegir método de pago
  if (data === 'pago_efectivo' || data === 'pago_transferencia') {
    if (!state.step || state.step !== 'choose_payment') {
      // Si por alguna razón llegó acá sin estar en ese paso, ignoramos
      bot.answerCallbackQuery(query.id);
      return;
    }

    bot.answerCallbackQuery(query.id);

    if (data === 'pago_efectivo') {
      state.paymentType = 'Efectivo';
    } else {
      state.paymentType = 'Transferencia';
    }

    userStates[chatId] = state;

    // Armamos resumen final
    let deliveryText = '';
    if (state.deliveryType === 'envio') {
      deliveryText = 'Envío a domicilio 🚚';
    } else if (state.deliveryType === 'retiro') {
      deliveryText = 'Retiro por el local 🏪';
    } else {
      deliveryText = 'Sin especificar';
    }

    let resumen = '✅ Perfecto, acá va el resumen de tu pedido de entrega:\n\n';
    resumen += `Tipo de entrega: ${deliveryText}\n`;

    if (state.deliveryType === 'envio' && state.address) {
      resumen += `Dirección: ${state.address}\n`;
    }

    if (state.name) {
      resumen += `Nombre: ${state.name}\n`;
    }
    if (state.phone) {
      resumen += `Teléfono: ${state.phone}\n`;
    }

    resumen += `\nMétodo de pago: ${state.paymentType}\n`;

    if (state.paymentType === 'Transferencia') {
      resumen += `Alias para transferir: \`${ALIAS_TRANSFERENCIA}\`\n`;
      resumen += '📌 Una vez hecha la transferencia, enviá el comprobante por acá así confirmamos el pedido.';
    } else {
      resumen += '💵 Pagás en efectivo al retirar o al recibir el pedido.';
    }

    bot.sendMessage(chatId, resumen, { parse_mode: 'Markdown' });

    // Opcional: limpiar estado
    // delete userStates[chatId];
  }
});

console.log('Bot de prueba (entrega + pago) iniciado...');
