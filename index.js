// index.js (ESM) — Bot entrega + pago + mini servidor HTTP para Render

import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

// Usa tu token desde variables de entorno en Render
const token = process.env.BOT_TOKEN || 'PONE_ACA_TU_TOKEN_SI PROBAS LOCAL';

// --- BOT TELEGRAM ---

const bot = new TelegramBot(token, { polling: true });

// Alias para transferencia (el mismo que tenés en Config)
const ALIAS_TRANSFERENCIA = 'jennyocampos.mp';

// Estado simple por usuario
const userStates = {};

// Inicia el flujo de entrega
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

  if (
    text === '/start' ||
    text === 'hola' ||
    text === 'buenas' ||
    text === 'buenos días' ||
    text === 'buenas tardes' ||
    text === 'buenas noches'
  ) {
    startFlow(chatId);
    return;
  }

  const state = userStates[chatId];
  if (!state) return;

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

// Botones inline
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId] || {};

  // Tipo de entrega
  if (data === 'envio_domicilio') {
    state.deliveryType = 'envio';
    state.step = 'ask_address';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📍 Decime tu dirección completa:');
    return;
  }

  if (data === 'retiro_local') {
    state.deliveryType = 'retiro';
    state.step = 'ask_name';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '🧾 Tu nombre:');
    return;
  }

  // Método de pago
  if (data === 'pago_efectivo' || data === 'pago_transferencia') {
    if (state.step !== 'choose_payment') {
      bot.answerCallbackQuery(query.id);
      return;
    }

    bot.answerCallbackQuery(query.id);

    state.paymentType = (data === 'pago_efectivo') ? 'Efectivo' : 'Transferencia';
    userStates[chatId] = state;

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
      resumen += '📌 Cuando hagas la transferencia, mandá el comprobante por acá así confirmamos el pedido.';
    } else {
      resumen += '💵 Pagás en efectivo al retirar o al recibir el pedido.';
    }

    bot.sendMessage(chatId, resumen, { parse_mode: 'Markdown' });
  }
});

console.log('Bot (entrega + pago) iniciado en modo ESM…');

// --- MINI SERVIDOR HTTP PARA RENDER ---

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('EzerBot está corriendo ✅');
});

server.listen(PORT, () => {
  console.log(`Servidor HTTP de salud escuchando en el puerto ${PORT}`);
});
