// index.js (ESM) — Bot Todo Queso: catálogo + carrito + entrega/pago + sellos + mini servidor HTTP

import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

// === CONFIG BÁSICA ===

// Token: en Render usar env BOT_TOKEN
const token = process.env.BOT_TOKEN || 'PONE_ACA_TU_TOKEN_PARA_PROBAR_LOCAL';

// Chat del vendedor (vos)
const OWNER_CHAT_ID = 7454984023; // tu chat ID

// Link público del bot para compartir
const BOT_PUBLIC_LINK = 'https://t.me/EzerBot'; // cambialo por tu @real si hace falta

// Alias para transferencias
const ALIAS_TRANSFERENCIA = 'jennyocampos.mp';

// Logo del local (URL de imagen)
const LOGO_URL = 'https://i.ibb.co/kqhf4cP/todoqueso-logo.png'; // poné acá la URL real de tu logo

// Datos del negocio (aparecen en el saludo inicial)
const BUSINESS_INFO =
  '🧀 *Todo Queso Club*\n' +
  '📍 Carlos Pellegrini 526, Garín\n' +
  '🕒 Lunes a Sábado 08:30–14:00 / 16:30–21:00\n' +
  '📱 3484 230184\n' +
  '📸 Instagram: @todoqueso.club';

// === ESTRUCTURAS EN MEMORIA ===

// Catálogo de ejemplo (podés editar nombres, precios, imágenes, etc.)
const catalog = {
  PROMOS: [
    {
      id: 'promo_picada_2',
      name: 'Picada para 2',
      price: 35000,
      description: 'Selección de fiambres y quesos + pan fresco.',
      image:
        'https://i.ibb.co/6R2p99p/picada-para-2.jpg',
      unitType: 'unidad'
    }
  ],
  QUESOS: [
    {
      id: 'cremon',
      name: 'CREMON',
      price: 11500,
      description: 'Queso Cremón barra 1 kg.',
      image:
        'https://i.ibb.co/8Y6gk8m/cremon.jpg',
      unitType: 'gramos' // permite pensar en porciones
    },
    {
      id: 'muzza_barraza',
      name: 'MUZZA BARRAZA',
      price: 8500,
      description: 'Muzzarella Barraza por kg.',
      image:
        'https://i.ibb.co/FJfmgSq/muzza-barraza.jpg',
      unitType: 'gramos'
    }
  ],
  PANIFICADOS: [
    {
      id: 'pan_fresco',
      name: 'PAN FRESCO',
      price: 2200,
      description: 'Pan fresco del día (por unidad).',
      image:
        'https://i.ibb.co/6gqYTDY/pan-fresco.jpg',
      unitType: 'unidad'
    }
  ],
  LACTEOS: [],
  FIAMBRES: []
};

// Estado por usuario
const sessions = {}; // { [chatId]: Session }

let lastOrderId = 1;

// === TIPOS ===
// Session = {
// step: string | null,
// cart: CartItem[],
// stamps: number,
// currentCategory: string | null,
// currentIndex: number,
// delivery: { type: 'envio'|'retiro'|null, address: string|null, name: string|null, phone: string|null },
// pendingOrder: Order | null
// }
// CartItem = { id, name, price, qty }
// Order = { id, chatId, items, subtotal, delivery, paymentType }

// === INICIALIZAR BOT ===

const bot = new TelegramBot(token, { polling: true });

console.log('Bot Todo Queso iniciado…');

// === FUNCIONES DE SESIÓN ===

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      step: null,
      cart: [],
      stamps: 0,
      currentCategory: null,
      currentIndex: 0,
      delivery: { type: null, address: null, name: null, phone: null },
      pendingOrder: null
    };
  }
  return sessions[chatId];
}

// === MENÚ PRINCIPAL ===

function mainMenuKeyboard() {
  return {
    keyboard: [
      ['🛒 Catálogo', '🧾 Mi carrito'],
      ['🎫 Tarjeta de sellos'],
      ['📍 Horarios y dirección', '📣 Compartir el bot']
    ],
    resize_keyboard: true
  };
}

async function sendWelcome(chatId) {
  try {
    await bot.sendPhoto(chatId, LOGO_URL, {
      caption:
        BUSINESS_INFO +
        '\n\nElegí una opción del menú para empezar 👇',
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard()
    });
  } catch (e) {
    // Si falla la foto, al menos mandamos el texto
    await bot.sendMessage(
      chatId,
      BUSINESS_INFO + '\n\nElegí una opción del menú 👇',
      {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard()
      }
    );
  }
}

// === CATÁLOGO / CARRUSEL ===

function categoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Promos', callback_data: 'cat_PROMOS' }],
      [{ text: 'Quesos', callback_data: 'cat_QUESOS' }],
      [{ text: 'Panificados', callback_data: 'cat_PANIFICADOS' }],
      [{ text: 'Lácteos', callback_data: 'cat_LACTEOS' }],
      [{ text: 'Fiambres', callback_data: 'cat_FIAMBRES' }],
      [{ text: '⬅ Menú', callback_data: 'back_menu' }]
    ]
  };
}

function formatPrice(n) {
  return '$' + n.toLocaleString('es-AR');
}

async function showCategories(chatId) {
  await bot.sendMessage(chatId, '🛍 Elegí una categoría:', {
    reply_markup: categoryKeyboard()
  });
}

async function sendProductCard(chatId, categoryKey, index) {
  const session = getSession(chatId);
  const products = catalog[categoryKey] || [];

  if (!products.length) {
    await bot.sendMessage(
      chatId,
      'Por ahora no hay productos cargados en esta categoría.',
      { reply_markup: categoryKeyboard() }
    );
    return;
  }

  if (index < 0) index = 0;
  if (index >= products.length) index = products.length - 1;

  session.currentCategory = categoryKey;
  session.currentIndex = index;

  const product = products[index];

  const caption =
    `*${product.name}*\n` +
    `💵 ${formatPrice(product.price)}\n` +
    (product.description ? `${product.description}\n` : '') +
    `\nUnidad: ${product.unitType === 'gramos' ? 'por kilo / gramos' : 'por unidad'}`;

  // Botones carrusel
  const rowNav = [];
  if (index > 0) {
    rowNav.push({
      text: '⬅ Anterior',
      callback_data: `prod_prev_${categoryKey}`
    });
  }
  if (index < products.length - 1) {
    rowNav.push({
      text: 'Siguiente ➡',
      callback_data: `prod_next_${categoryKey}`
    });
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ Agregar', callback_data: `add_${product.id}` },
        { text: '📤 Compartir', callback_data: `share_${product.id}` }
      ],
      ...(rowNav.length ? [rowNav] : []),
      [
        { text: '🧾 Ver carrito', callback_data: 'view_cart' },
        { text: '📂 Categorías', callback_data: 'back_categories' }
      ]
    ]
  };

  await bot.sendPhoto(chatId, product.image, {
    caption,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// === CARRITO ===

function getCartSummary(session) {
  if (!session.cart.length) return { text: 'Tu carrito está vacío.', subtotal: 0 };

  let text = '🧾 *Tu carrito*\n';
  let subtotal = 0;

  for (const item of session.cart) {
    const lineTotal = item.price * item.qty;
    subtotal += lineTotal;
    text += `• ${item.qty} × ${item.name} — ${formatPrice(lineTotal)}\n`;
  }

  text += `\nSubtotal: *${formatPrice(subtotal)}*`;

  return { text, subtotal };
}

async function showCart(chatId) {
  const session = getSession(chatId);
  const { text, subtotal } = getCartSummary(session);

  const keyboard =
    session.cart.length > 0
      ? {
          inline_keyboard: [
            [{ text: '🧹 Vaciar carrito', callback_data: 'empty_cart' }],
            [{ text: '✅ Finalizar compra', callback_data: 'checkout' }],
            [{ text: '⬅ Menú', callback_data: 'back_menu' }]
          ]
        }
      : {
          inline_keyboard: [
            [{ text: '🛒 Ver catálogo', callback_data: 'back_categories' }],
            [{ text: '⬅ Menú', callback_data: 'back_menu' }]
          ]
        };

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// === TARJETA DE SELLOS ===

async function showStamps(chatId) {
  const session = getSession(chatId);
  const totalSlots = 10;
  const filled = Math.min(session.stamps, totalSlots);
  const empty = totalSlots - filled;

  const bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);

  const text =
    '🎫 *Tarjeta de sellos*\n' +
    `${bar}\n\n` +
    `Sellos: ${filled} / ${totalSlots}\n` +
    'Premio al completar: Picada premium Todo Queso (configurable)\n\n' +
    'Tip: cada compra confirmada suma 1 sello automático.';

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// === HORARIOS & COMPARTIR ===

async function sendSchedule(chatId) {
  await bot.sendMessage(chatId, BUSINESS_INFO, { parse_mode: 'Markdown' });
}

async function sendShareMessage(chatId) {
  const text =
    '📣 *Compartí Todo Queso Club*\n\n' +
    'Reenviá este mensaje a tus contactos para que también puedan pedir por el bot:\n' +
    BOT_PUBLIC_LINK;

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// === CHECKOUT: ENTREGA & PAGO ===

async function startCheckout(chatId) {
  const session = getSession(chatId);
  const { subtotal } = getCartSummary(session);

  if (!session.cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío. Agregá algo del catálogo antes de finalizar la compra.',
      {
        reply_markup: categoryKeyboard()
      }
    );
    return;
  }

  session.delivery = { type: null, address: null, name: null, phone: null };
  session.step = 'choose_delivery';

  await bot.sendMessage(
    chatId,
    `Subtotal de tu pedido: *${formatPrice(subtotal)}*\n\nElegí cómo querés recibir tu pedido 👇`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚚 Envío a domicilio', callback_data: 'delivery_envio' }],
          [{ text: '🏪 Retiro en el local', callback_data: 'delivery_retiro' }],
          [{ text: '⬅ Cancelar', callback_data: 'back_menu' }]
        ]
      }
    }
  );
}

// === TICKET ===

function buildTicket(order) {
  const { items, subtotal, delivery, paymentType, id, chatId } = order;
  let text = '🧾 *Ticket de compra - Todo Queso*\n';
  text += '--------------------------------\n';
  text += `ID Pedido: #${id}\n`;
  text += `ChatID: ${chatId}\n\n`;
  text += '*Detalle:*\n';

  for (const it of items) {
    const line = it.price * it.qty;
    text += `• ${it.qty} × ${it.name} — ${formatPrice(line)}\n`;
  }

  text += `\nSubtotal: *${formatPrice(subtotal)}*\n`;
  text += `Envío: *${formatPrice(0)}* (configurable)\n`;
  text += `TOTAL: *${formatPrice(subtotal)}*\n\n`;

  text += `📦 Entrega: ${
    delivery.type === 'envio' ? 'Envío a domicilio 🚚' : 'Retiro en el local 🏪'
  }\n`;
  if (delivery.type === 'envio' && delivery.address) {
    text += `📍 Dirección: ${delivery.address}\n`;
  }
  if (delivery.name) text += `👤 Cliente: ${delivery.name}\n`;
  if (delivery.phone) text += `📞 Tel: ${delivery.phone}\n`;

  text += `\n💳 Pago: *${paymentType}*\n`;

  if (paymentType === 'Transferencia') {
    text += `Alias: \`${ALIAS_TRANSFERENCIA}\`\n`;
  }

  text += '\nGracias por tu compra 🧀';

  return text;
}

// === HANDLERS DE MENSAJES ===

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = (msg.text || '').trim();
  const text = textRaw.toLowerCase();
  const session = getSession(chatId);

  // Saludos / /start → bienvenida
  if (
    text === '/start' ||
    text === 'hola' ||
    text === 'buenas' ||
    text.startsWith('buenos') ||
    text.startsWith('buenas ')
  ) {
    await sendWelcome(chatId);
    session.step = null;
    return;
  }

  // Menú principal por texto
  if (textRaw === '🛒 Catálogo') {
    await showCategories(chatId);
    return;
  }
  if (textRaw === '🧾 Mi carrito') {
    await showCart(chatId);
    return;
  }
  if (textRaw === '🎫 Tarjeta de sellos') {
    await showStamps(chatId);
    return;
  }
  if (textRaw === '📍 Horarios y dirección') {
    await sendSchedule(chatId);
    return;
  }
  if (textRaw === '📣 Compartir el bot') {
    await sendShareMessage(chatId);
    return;
  }

  // Flujo de checkout: address, name, phone
  if (session.step === 'ask_address') {
    session.delivery.address = textRaw;
    session.step = 'ask_name';
    await bot.sendMessage(chatId, '🧾 Decime tu nombre para el pedido:');
    return;
  }

  if (session.step === 'ask_name') {
    session.delivery.name = textRaw;
    session.step = 'ask_phone';
    await bot.sendMessage(chatId, '📞 Pasame tu teléfono (para coordinar si hace falta):');
    return;
  }

  if (session.step === 'ask_phone') {
    session.delivery.phone = textRaw;
    session.step = 'choose_payment';

    await bot.sendMessage(chatId, 'Elegí método de pago:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💵 Efectivo', callback_data: 'pay_cash' }],
          [{ text: '🏦 Transferencia', callback_data: 'pay_transfer' }],
          [{ text: '⬅ Cancelar', callback_data: 'back_menu' }]
        ]
      }
    });
    return;
  }

  // Otros mensajes fuera de flujo: ignorar o responder suave
});

// === HANDLERS DE CALLBACKS ===

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  // Navegación básica
  if (data === 'back_menu') {
    await bot.answerCallbackQuery(query.id);
    await sendWelcome(chatId);
    return;
  }

  if (data === 'back_categories') {
    await bot.answerCallbackQuery(query.id);
    await showCategories(chatId);
    return;
  }

  if (data === 'view_cart') {
    await bot.answerCallbackQuery(query.id);
    await showCart(chatId);
    return;
  }

  if (data === 'empty_cart') {
    await bot.answerCallbackQuery(query.id, { text: 'Carrito vaciado.' });
    session.cart = [];
    await showCart(chatId);
    return;
  }

  if (data === 'checkout') {
    await bot.answerCallbackQuery(query.id);
    await startCheckout(chatId);
    return;
  }

  // Categorías
  if (data.startsWith('cat_')) {
    await bot.answerCallbackQuery(query.id);
    const categoryKey = data.replace('cat_', '');
    await sendProductCard(chatId, categoryKey, 0);
    return;
  }

  // Carrusel next/prev
  if (data.startsWith('prod_prev_') || data.startsWith('prod_next_')) {
    await bot.answerCallbackQuery(query.id);
    const isPrev = data.startsWith('prod_prev_');
    const categoryKey = data.replace('prod_prev_', '').replace('prod_next_', '');
    const current = session.currentCategory === categoryKey ? session.currentIndex : 0;
    const newIndex = isPrev ? current - 1 : current + 1;
    await sendProductCard(chatId, categoryKey, newIndex);
    return;
  }

  // Agregar al carrito
  if (data.startsWith('add_')) {
    await bot.answerCallbackQuery(query.id, { text: 'Producto agregado al carrito.' });
    const productId = data.replace('add_', '');

    let foundProduct = null;
    for (const key of Object.keys(catalog)) {
      const p = catalog[key].find((x) => x.id === productId);
      if (p) {
        foundProduct = p;
        break;
      }
    }
    if (!foundProduct) return;

    const existing = session.cart.find((it) => it.id === productId);
    if (existing) existing.qty += 1;
    else session.cart.push({ id: productId, name: foundProduct.name, price: foundProduct.price, qty: 1 });

    await bot.sendMessage(chatId, `✅ Agregado: *${foundProduct.name}*\n¿Qué querés hacer ahora?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛍 Seguir viendo', callback_data: `back_categories` }],
          [{ text: '🧾 Ver carrito', callback_data: 'view_cart' }]
        ]
      }
    });
    return;
  }

  // Compartir producto (texto listo para reenviar)
  if (data.startsWith('share_')) {
    await bot.answerCallbackQuery(query.id);
    const productId = data.replace('share_', '');

    let foundProduct = null;
    for (const key of Object.keys(catalog)) {
      const p = catalog[key].find((x) => x.id === productId);
      if (p) {
        foundProduct = p;
        break;
      }
    }
    if (!foundProduct) return;

    const shareText =
      `📣 *Mirá este producto de Todo Queso Club*\n\n` +
      `*${foundProduct.name}*\n` +
      `💵 ${formatPrice(foundProduct.price)}\n` +
      (foundProduct.description ? `${foundProduct.description}\n\n` : '\n') +
      `Pedilo por el bot: ${BOT_PUBLIC_LINK}`;

    await bot.sendMessage(chatId, shareText, { parse_mode: 'Markdown' });
    return;
  }

  // Entrega
  if (data === 'delivery_envio' || data === 'delivery_retiro') {
    await bot.answerCallbackQuery(query.id);
    session.delivery.type = data === 'delivery_envio' ? 'envio' : 'retiro';

    if (data === 'delivery_envio') {
      session.step = 'ask_address';
      await bot.sendMessage(
        chatId,
        '📍 Pasame tu dirección completa (calle + número + entre calles / referencia):'
      );
    } else {
      session.step = 'ask_name';
      await bot.sendMessage(chatId, '🧾 Decime tu nombre para el pedido:');
    }
    return;
  }

  // Pago
  if (data === 'pay_cash' || data === 'pay_transfer') {
    await bot.answerCallbackQuery(query.id);

    const paymentType = data === 'pay_cash' ? 'Efectivo' : 'Transferencia';

    const { subtotal } = getCartSummary(session);

    const order = {
      id: lastOrderId++,
      chatId,
      items: [...session.cart],
      subtotal,
      delivery: { ...session.delivery },
      paymentType
    };

    session.pendingOrder = order;
    session.step = null;
    session.cart = []; // vaciamos carrito al generar pedido

    // Ticket para cliente
    const ticketText = buildTicket(order);
    await bot.sendMessage(chatId, ticketText, { parse_mode: 'Markdown' });

    if (paymentType === 'Transferencia') {
      await bot.sendMessage(
        chatId,
        `🏦 Recordá enviar el comprobante de transferencia por acá cuando lo tengas.\nAlias: \`${ALIAS_TRANSFERENCIA}\``,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId, '💵 Pagás en efectivo al recibir o retirar tu pedido.');
    }

    // Ticket para vendedor
    const sellerText = '📢 *Nuevo pedido recibido*\n\n' + buildTicket(order);
    await bot.sendMessage(OWNER_CHAT_ID, sellerText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Pago recibido', callback_data: `confirm_pay_${order.id}` }]
        ]
      }
    });

    // Sumar sello
    session.stamps = (session.stamps || 0) + 1;

    return;
  }

  // Confirmación de pago por parte del vendedor
  if (data.startsWith('confirm_pay_') && chatId === OWNER_CHAT_ID) {
    await bot.answerCallbackQuery(query.id, { text: 'Pago confirmado.' });
    const orderId = parseInt(data.replace('confirm_pay_', ''), 10);

    // Buscar a qué usuario pertenece ese pedido
    let targetChat = null;
    for (const [cid, sess] of Object.entries(sessions)) {
      if (sess.pendingOrder && sess.pendingOrder.id === orderId) {
        targetChat = Number(cid);
        break;
      }
    }

    if (targetChat) {
      await bot.sendMessage(
        targetChat,
        '✅ Tu pago fue confirmado. Estamos preparando tu pedido. ¡Gracias por elegir Todo Queso!'
      );
    }

    return;
  }
});

// === MINI SERVIDOR HTTP PARA RENDER ===

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('EzerBot / Todo Queso está corriendo ✅');
});

server.listen(PORT, () => {
  console.log(`Servidor HTTP de salud escuchando en el puerto ${PORT}`);
});
