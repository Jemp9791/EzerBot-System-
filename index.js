// index.js - EzerBot Todo Queso (catálogo + carrito + envío/retiro + pago)

// =========================
// CONFIGURACIÓN DEL NEGOCIO
// =========================

const TOKEN = process.env.BOT_TOKEN; // poné tu token en Render como variable de entorno

import TelegramBot from 'node-telegram-bot-api';

// Datos tomados de tu hoja Config (simplificados aquí)
const CONFIG = {
  negocioNombre: 'Todo Queso',
  logoURL: 'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg',
  descripcion:
    'Somos Todo Queso. Aquí encontrarás los mejores precios, las picadas más ricas y los mejores beneficios de ser parte de nuestro club.',
  direccion: 'Fructuoso Díaz 893, Garin',
  horarios: 'LUN a SAB 08:30-14:00 / 16:30-21:00',
  telefonoNegocio: '5493484230184',
  instagram: '@todoqueso.club',
  moneda: 'ARS',
  usaEnvioDomicilio: true,
  costoEnvioBase: 2000,
  textoEnvioDomicilio: 'Tu envío se realizará a partir de las 16:00 hs.',
  usaRetiroLocal: true,
  textoRetiroLocal:
    'Tu pedido será preparado y podés pasar a retirarlo hasta las 20:00 hs.',
  permitirPagoOnline: true,
  tipoPagoOnline: 'TRANSFERENCIA',
  aliasPago: 'jennyocampos.mp',
  mensajePostCompra: 'Agradecemos tu compra. Ya sumaste tus puntos.',
  chatIdVendedor: '7454984023',
  textoConfirmacionPedido:
    'Gracias. Tu compra fué confirmada y está en preparación. ✅',
  compartirBotActivo: true,
  textoCompartirBot:
    'Compartí este Ezerbot con tus amigos y ganá sellos extras. 🧀',
  botLink: 'https://t.me/Ezer_IA_Bot'
};

// Catálogo de ejemplo (reemplazá con tus productos reales si querés)
// unitType: 'kg' (precio por kilo, el cliente escribe gramos) o 'unit' (por unidad)
const CATALOG = [
  {
    id: 'PROMO1',
    name: 'DULCE DE BATATA',
    category: 'Promos',
    pricePerKg: 4000,
    unitType: 'kg',
    description: 'Dulce de batata clásico.',
    imageUrl:
      'https://i.postimg.cc/wvq6vM5w/dulce-batata.jpg'
  },
  {
    id: 'PROMO2',
    name: 'DULCE DE BATATA C/CHOCO',
    category: 'Promos',
    pricePerKg: 4000,
    unitType: 'kg',
    description: 'Dulce de batata con chocolate.',
    imageUrl:
      'https://i.postimg.cc/wvq6vM5w/dulce-batata-choco.jpg'
  },
  {
    id: 'PROMO3',
    name: 'DULCE DE MEMBRILLO',
    category: 'Promos',
    pricePerKg: 4000,
    unitType: 'kg',
    description: 'Dulce de membrillo de cajón.',
    imageUrl:
      'https://i.postimg.cc/wvq6vM5w/dulce-membrillo.jpg'
  },
  {
    id: 'PAN1',
    name: 'PAN FRESCO',
    category: 'Panificados',
    pricePerKg: 2200,
    unitType: 'kg',
    description: 'Pan surtido recién horneado.',
    imageUrl:
      'https://i.postimg.cc/3xH8wMbr/pan-fresco.jpg'
  },
  {
    id: 'JAMON1',
    name: 'JAMÓN COCIDO OFERTA',
    category: 'Fiambres',
    pricePerKg: 20000,
    unitType: 'kg',
    description: 'Jamón cocido oferta.',
    imageUrl:
      'https://i.postimg.cc/0yLh51bG/jamon-cocido.jpg'
  }
];

// ==============
// ESTADO EN MEMO
// ==============

const bot = new TelegramBot(TOKEN, { polling: true });

// Estado por chat
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      cart: [],
      step: null,
      temp: {},
      browse: {
        category: null,
        index: 0
      }
    });
  }
  return sessions.get(chatId);
}

// =============
// MENÚ PRINCIPAL
// =============

const mainKeyboard = {
  keyboard: [
    ['🛍️ Catálogo'],
    ['🛒 Ver carrito', '✅ Finalizar compra'],
    ['📍 Horarios y dirección', '📢 Compartir bot']
  ],
  resize_keyboard: true
};

function sendWelcome(chatId) {
  const caption =
    `👋 Hola!\nSoy el bot de <b>${CONFIG.negocioNombre}</b>.\n\n` +
    `${CONFIG.descripcion}\n\n` +
    '✅ Podés ver el catálogo por categorías, armar tu carrito y finalizar tu pedido.\n\n' +
    '👇 Elegí una opción del menú para empezar:';

  bot
    .sendPhoto(chatId, CONFIG.logoURL, {
      caption,
      parse_mode: 'HTML',
      reply_markup: mainKeyboard
    })
    .catch(console.error);
}

// ============
// UTILIDADES
// ============

function formatMoney(amount) {
  return `$${amount.toLocaleString('es-AR')}`;
}

function getCategories() {
  const set = new Set();
  CATALOG.forEach((p) => set.add(p.category));
  // Orden similar a tu hoja
  const order = ['Promos', 'Quesos', 'Panificados', 'Lácteos', 'Fiambres'];
  const ordered = order.filter((c) => set.has(c));
  // por si hay otras
  CATALOG.forEach((p) => {
    if (!ordered.includes(p.category)) ordered.push(p.category);
  });
  return ordered;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===================================
// CATÁLOGO POR CATEGORÍA (HOJEAR)
// ===================================

function sendCategories(chatId) {
  const categories = getCategories();
  const inlineKeyboard = categories.map((c) => [
    { text: c, callback_data: `CAT:${c}` }
  ]);
  inlineKeyboard.push([
    { text: '🛒 Ver carrito', callback_data: 'VIEW_CART' },
    { text: '🏠 Menú', callback_data: 'MENU' }
  ]);

  bot
    .sendMessage(chatId, '🛍️ Elegí una categoría:', {
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

function showProduct(chatId, category, index) {
  const session = getSession(chatId);
  const products = CATALOG.filter((p) => p.category === category);
  if (products.length === 0) {
    bot.sendMessage(chatId, 'No hay productos en esta categoría.');
    return;
  }

  if (index < 0) index = products.length - 1;
  if (index >= products.length) index = 0;

  session.browse.category = category;
  session.browse.index = index;

  const p = products[index];
  const priceLine =
    p.unitType === 'kg'
      ? `${formatMoney(p.pricePerKg)} / kg`
      : `${formatMoney(p.pricePerKg)} c/u`;

  const caption =
    `<b>${p.name}</b>\n` +
    `💰 ${priceLine}\n` +
    `📝 ${p.description || ''}`;

  const pageText = `${index + 1}/${products.length}`;

  const inlineKeyboard = [
    [
      {
        text: '🟢 Quiero éste',
        callback_data: `BUY:${p.id}`
      },
      {
        text: '📣 Compartir',
        callback_data: `SHARE_PROD:${p.id}`
      }
    ],
    [
      { text: '⬅️ Anterior', callback_data: 'NAV:PREV' },
      { text: pageText, callback_data: 'PAGE_INFO' },
      { text: '➡️ Siguiente', callback_data: 'NAV:NEXT' }
    ],
    [
      { text: '🛒 Ver carrito', callback_data: 'VIEW_CART' },
      { text: '🏠 Menú', callback_data: 'MENU' }
    ]
  ];

  bot
    .sendPhoto(chatId, p.imageUrl, {
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

function findProductById(id) {
  return CATALOG.find((p) => p.id === id);
}

// =========================
// CARRITO Y CANTIDADES
// =========================

function describeCart(cart) {
  if (!cart.length) return 'Tu carrito está vacío.';
  let text = '🛒 <b>Tu carrito</b>\n';
  let subtotal = 0;
  for (const item of cart) {
    subtotal += item.subtotal;
    text += `• ${item.displayQty} × ${item.name} — ${formatMoney(
      item.subtotal
    )}\n`;
  }
  text += `\nSubtotal: <b>${formatMoney(subtotal)}</b>`;
  return text;
}

function addToCart(chatId, product, quantity, quantityLabel) {
  const session = getSession(chatId);
  let subtotal = 0;
  let displayQty = '';

  if (product.unitType === 'kg') {
    // quantity en gramos
    const kg = quantity / 1000;
    subtotal = Math.round(product.pricePerKg * kg);
    displayQty = `${quantityLabel}g`;
  } else {
    subtotal = product.pricePerKg * quantity;
    displayQty = `${quantity} u.`;
  }

  session.cart.push({
    id: product.id,
    name: product.name,
    unitType: product.unitType,
    quantity,
    displayQty,
    pricePerUnit: product.pricePerKg,
    subtotal
  });

  const totalItems = session.cart.length;
  const subtotalCarrito = session.cart.reduce(
    (sum, it) => sum + it.subtotal,
    0
  );

  const msg =
    `Listo, lo sumé a tu carrito.\n\n` +
    `Ahora tenés ${totalItems} producto(s) y un subtotal de ${formatMoney(
      subtotalCarrito
    )}.\n\n` +
    '👉 Si querés seguir mirando, tocá <b>🛍️ Catálogo</b>.\n' +
    '👉 Si ya está, tocá <b>✅ Finalizar compra</b> y cerramos el pedido.';

  bot
    .sendMessage(chatId, msg, {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard
    })
    .catch(console.error);
}

// ====================
// CHECKOUT / ENTREGA
// ====================

function startCheckout(chatId) {
  const session = getSession(chatId);
  if (!session.cart.length) {
    bot.sendMessage(
      chatId,
      'Tu carrito está vacío. ¿Querés que te muestre el catálogo?',
      {
        reply_markup: mainKeyboard
      }
    );
    return;
  }

  session.order = {
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    time: null,
    paymentMethod: null,
    ticketId: null
  };
  session.step = 'ASK_DELIVERY_TYPE';

  const inlineKeyboard = [];

  if (CONFIG.usaEnvioDomicilio) {
    inlineKeyboard.push([
      {
        text: '🚚 Envío a domicilio',
        callback_data: 'DELIVERY:DOMICILIO'
      }
    ]);
  }
  if (CONFIG.usaRetiroLocal) {
    inlineKeyboard.push([
      { text: '🏪 Retiro por el local', callback_data: 'DELIVERY:LOCAL' }
    ]);
  }
  inlineKeyboard.push([
    { text: '❌ Cancelar', callback_data: 'CANCEL_ORDER' }
  ]);

  bot
    .sendMessage(
      chatId,
      'Perfecto, cerremos tu pedido 🙌\n\nPrimero decime cómo querés recibirlo:',
      { reply_markup: { inline_keyboard: inlineKeyboard } }
    )
    .catch(console.error);
}

function sendPaymentMethodQuestion(chatId) {
  const session = getSession(chatId);
  session.step = 'ASK_PAYMENT';

  const inlineKeyboard = [
    [{ text: '💵 Efectivo', callback_data: 'PAY:EFECTIVO' }],
    [{ text: '🏦 Transferencia', callback_data: 'PAY:TRANSFERENCIA' }]
  ];

  bot
    .sendMessage(chatId, 'Elegí método de pago:', {
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

function buildTicketText(chatId) {
  const session = getSession(chatId);
  const cart = session.cart;
  const order = session.order;

  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const random = Math.floor(1000 + Math.random() * 9000);

  const ticketId = `TQ-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${random}`;
  order.ticketId = ticketId;

  let subtotal = 0;
  cart.forEach((it) => (subtotal += it.subtotal));

  const envioCost =
    order.deliveryType === 'DOMICILIO' ? CONFIG.costoEnvioBase : 0;
  const total = subtotal + envioCost;

  let lines = '';
  cart.forEach((it) => {
    lines += ` ${it.displayQty}  ${it.name}    ${formatMoney(
      it.subtotal
    )}\n`;
  });

  const entregaTexto =
    order.deliveryType === 'DOMICILIO' ? 'ENVÍO' : 'RETIRO';

  const body =
    'TICKET POS\n\n' +
    'TODO QUESO\n' +
    '--------------------------------\n' +
    `Ticket: ${ticketId}\n` +
    `Fecha: ${dd}/${mm}/${yyyy}, ${hh}:${mi}:${ss}\n` +
    '--------------------------------\n' +
    `Cliente: ${order.name}\n` +
    `Tel: ${order.phone}\n` +
    `Entrega: ${entregaTexto}\n` +
    (order.deliveryType === 'DOMICILIO'
      ? `Dirección: ${order.address}\n`
      : '') +
    `Horario: ${order.time || '-'}\n` +
    '--------------------------------\n' +
    lines +
    '--------------------------------\n' +
    `SUBTOTAL: ${formatMoney(subtotal)}\n` +
    (order.deliveryType === 'DOMICILIO'
      ? `Envío: ${formatMoney(envioCost)}\n`
      : 'Retiro en el local: $0\n') +
    `TOTAL: ${formatMoney(total)}\n` +
    '--------------------------------\n' +
    `Pago: ${order.paymentMethod}\n` +
    `ChatID: ${chatId}\n`;

  return `<pre>${escapeHtml(body)}</pre>`;
}

function sendTicket(chatId) {
  const session = getSession(chatId);
  const order = session.order;

  const ticketHtml = buildTicketText(chatId);

  const inlineKeyboard = [
    [{ text: '✅ Confirmar pedido', callback_data: 'CONFIRM_ORDER' }],
    [{ text: '❌ Cancelar', callback_data: 'CANCEL_ORDER' }]
  ];

  bot
    .sendMessage(chatId, ticketHtml, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

// ============
// COMPARTIR BOT
// ============

function sendShareBot(chatId) {
  const text =
    `${CONFIG.textoCompartirBot}\n\n` +
    `Link directo del bot:\n${CONFIG.botLink}`;

  const encodedText = encodeURIComponent(
    `Mirá este bot de ${CONFIG.negocioNombre}: ${CONFIG.botLink}`
  );

  const whatsappUrl = `https://wa.me/?text=${encodedText}`;
  const mailUrl = `mailto:?subject=${encodeURIComponent(
    'Bot Todo Queso'
  )}&body=${encodedText}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(
    CONFIG.botLink
  )}&text=${encodedText}`;

  const inlineKeyboard = [
    [
      {
        text: '📱 Compartir por WhatsApp',
        url: whatsappUrl
      }
    ],
    [
      {
        text: '✉️ Compartir por email',
        url: mailUrl
      }
    ],
    [
      {
        text: '📣 Compartir por Telegram',
        url: telegramUrl
      }
    ]
  ];

  bot
    .sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

function sendShareProduct(chatId, productId) {
  const p = findProductById(productId);
  if (!p) return;

  const priceLine =
    p.unitType === 'kg'
      ? `${formatMoney(p.pricePerKg)} / kg`
      : `${formatMoney(p.pricePerKg)} c/u`;

  const text =
    `Te comparto este producto de ${CONFIG.negocioNombre}:\n\n` +
    `${p.name}\n` +
    `${priceLine}\n` +
    `${p.description || ''}\n\n` +
    `Pedilo por el bot: ${CONFIG.botLink}`;

  const encodedText = encodeURIComponent(text);
  const whatsappUrl = `https://wa.me/?text=${encodedText}`;
  const mailUrl = `mailto:?subject=${encodeURIComponent(
    p.name
  )}&body=${encodedText}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(
    CONFIG.botLink
  )}&text=${encodedText}`;

  const inlineKeyboard = [
    [
      { text: '📱 WhatsApp', url: whatsappUrl },
      { text: '✉️ Email', url: mailUrl },
      { text: '📣 Telegram', url: telegramUrl }
    ]
  ];

  bot
    .sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
    .catch(console.error);
}

// ==================
// HORARIOS & DIRECCIÓN
// ==================

function sendHorariosDireccion(chatId) {
  const text =
    `<b>${CONFIG.negocioNombre}</b>\n` +
    `🕒 ${CONFIG.horarios}\n` +
    `📍 ${CONFIG.direccion}\n` +
    (CONFIG.instagram ? `📸 ${CONFIG.instagram}\n` : '') +
    `📞 +${CONFIG.telefonoNegocio}`;

  bot
    .sendMessage(chatId, text, { parse_mode: 'HTML' })
    .catch(console.error);
}

// ========================
// MANEJO DE MENSAJES TEXTO
// ========================

bot.onText(/\/start|^hola$|^Hola$/i, (msg) => {
  const chatId = msg.chat.id;
  getSession(chatId); // asegura sesión
  sendWelcome(chatId);
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const session = getSession(chatId);

  // Ignoramos los mensajes que vienen como respuesta a inline keyboards (ya se manejan en callback_query)
  if (msg.via_bot || msg.chat.type === 'channel') return;

  // Si estamos en un paso de flujo, lo priorizamos
  if (session.step === 'ASK_ADDRESS') {
    session.order.address = text;
    session.step = 'ASK_NAME';
    bot
      .sendMessage(chatId, '🧾 Tu nombre:')
      .catch(console.error);
    return;
  }

  if (session.step === 'ASK_NAME') {
    session.order.name = text;
    session.step = 'ASK_PHONE';
    bot
      .sendMessage(chatId, '📞 Tu teléfono:')
      .catch(console.error);
    return;
  }

  if (session.step === 'ASK_PHONE') {
    session.order.phone = text;
    session.step = 'ASK_TIME';
    bot
      .sendMessage(
        chatId,
        '⏰ ¿En qué horario te conviene recibir el pedido o pasar a retirarlo?'
      )
      .catch(console.error);
    return;
  }

  if (session.step === 'ASK_TIME') {
    session.order.time = text;
    // Ahora pasamos a elegir método de pago
    sendPaymentMethodQuestion(chatId);
    return;
  }

  if (session.step === 'ASK_WEIGHT') {
    const p = session.temp.product;
    if (!p) {
      session.step = null;
      return;
    }
    // El cliente escribe gramos (ej: 250, 500, 1000)
    const num = parseInt(text.replace(/\D/g, ''), 10);
    if (!num || num <= 0) {
      bot
        .sendMessage(
          chatId,
          'No entendí los gramos 🤔. Escribí solo el número, por ejemplo 250 o 500.'
        )
        .catch(console.error);
      return;
    }
    addToCart(chatId, p, num, num);
    session.step = null;
    session.temp = {};
    return;
  }

  if (session.step === 'ASK_UNITS') {
    const p = session.temp.product;
    if (!p) {
      session.step = null;
      return;
    }
    const num = parseInt(text.replace(/\D/g, ''), 10);
    if (!num || num <= 0) {
      bot
        .sendMessage(
          chatId,
          'No entendí la cantidad 🤔. Escribí solo el número de unidades.'
        )
        .catch(console.error);
      return;
    }
    addToCart(chatId, p, num, num);
    session.step = null;
    session.temp = {};
    return;
  }

  // Si no estamos en un flujo especial, vemos el texto como comando de menú
  if (text === '🛍️ Catálogo') {
    sendCategories(chatId);
    return;
  }

  if (text === '📍 Horarios y dirección') {
    sendHorariosDireccion(chatId);
    return;
  }

  if (text === '📢 Compartir bot') {
    sendShareBot(chatId);
    return;
  }

  if (text === '🛒 Ver carrito') {
    const cartText = describeCart(session.cart);
    bot
      .sendMessage(chatId, cartText, {
        parse_mode: 'HTML',
        reply_markup: mainKeyboard
      })
      .catch(console.error);
    return;
  }

  if (text === '✅ Finalizar compra') {
    startCheckout(chatId);
    return;
  }

  if (/^menú$/i.test(text)) {
    sendWelcome(chatId);
    return;
  }
});

// ===========================
// MANEJO DE CALLBACK QUERIES
// ===========================

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const session = getSession(chatId);

  if (data === 'MENU') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    sendWelcome(chatId);
    return;
  }

  if (data === 'VIEW_CART') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    const cartText = describeCart(session.cart);
    bot
      .sendMessage(chatId, cartText, {
        parse_mode: 'HTML',
        reply_markup: mainKeyboard
      })
      .catch(console.error);
    return;
  }

  if (data.startsWith('CAT:')) {
    const category = data.substring(4);
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    showProduct(chatId, category, 0);
    return;
  }

  if (data === 'NAV:PREV') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    const { category, index } = session.browse;
    if (!category) return;
    showProduct(chatId, category, index - 1);
    return;
  }

  if (data === 'NAV:NEXT') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    const { category, index } = session.browse;
    if (!category) return;
    showProduct(chatId, category, index + 1);
    return;
  }

  if (data.startsWith('BUY:')) {
    const productId = data.substring(4);
    const p = findProductById(productId);
    if (!p) return;

    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);

    session.temp.product = p;
    if (p.unitType === 'kg') {
      session.step = 'ASK_WEIGHT';
      bot
        .sendMessage(
          chatId,
          `¿Cuántos gramos querés de ${p.name}? Escribí solo el número, por ejemplo 250 o 500.`
        )
        .catch(console.error);
    } else {
      session.step = 'ASK_UNITS';
      bot
        .sendMessage(
          chatId,
          `¿Cuántas unidades querés de ${p.name}? Escribí solo el número.`
        )
        .catch(console.error);
    }
    return;
  }

  if (data.startsWith('SHARE_PROD:')) {
    const productId = data.substring('SHARE_PROD:'.length);
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    sendShareProduct(chatId, productId);
    return;
  }

  if (data === 'CHECKOUT') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);
    startCheckout(chatId);
    return;
  }

  if (data.startsWith('DELIVERY:')) {
    const type = data.split(':')[1];
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);

    session.order.deliveryType = type;

    if (type === 'DOMICILIO') {
      session.step = 'ASK_ADDRESS';
      bot
        .sendMessage(chatId, '📍 Decime tu dirección completa:')
        .catch(console.error);
    } else {
      // Retiro local: salteamos dirección y vamos directo a nombre
      session.step = 'ASK_NAME';
      bot
        .sendMessage(chatId, '🧾 Tu nombre para el pedido:')
        .catch(console.error);
    }
    return;
  }

  if (data.startsWith('PAY:')) {
    const method = data.split(':')[1];
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);

    session.order.paymentMethod =
      method === 'EFECTIVO' ? 'Efectivo' : 'Transferencia';

    if (method === 'TRANSFERENCIA') {
      const textoAlias =
        `🏦 Alias para transferir:\n<code>${CONFIG.aliasPago}</code>\n\n` +
        'Una vez hecha la transferencia, guardá este ticket para mostrarlo en el local.';

      bot
        .sendMessage(chatId, textoAlias, { parse_mode: 'HTML' })
        .catch(console.error);
    }

    // En ambos casos mostramos el ticket POS
    session.step = 'CONFIRM_ORDER';
    sendTicket(chatId);
    return;
  }

  if (data === 'CONFIRM_ORDER') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);

    // Mensaje al cliente
    bot
      .sendMessage(chatId, CONFIG.textoConfirmacionPedido, {
        reply_markup: mainKeyboard
      })
      .catch(console.error);

    // Aviso al vendedor (si hay chatId configurado)
    if (CONFIG.chatIdVendedor) {
      const session = getSession(chatId);
      const order = session.order;
      const cartText = describeCart(session.cart);

      const aviso =
        `📥 Nuevo pedido de ${CONFIG.negocioNombre}\n\n` +
        `Cliente: ${order.name}\n` +
        `Tel: ${order.phone}\n` +
        `Entrega: ${
          order.deliveryType === 'DOMICILIO' ? 'Envío a domicilio' : 'Retiro'
        }\n` +
        (order.deliveryType === 'DOMICILIO'
          ? `Dirección: ${order.address}\n`
          : '') +
        (order.time ? `Horario: ${order.time}\n` : '') +
        `Método de pago: ${order.paymentMethod}\n` +
        `Ticket: ${order.ticketId}\n\n` +
        cartText.replace(/<[^>]*>/g, '');

      bot
        .sendMessage(CONFIG.chatIdVendedor, aviso)
        .catch(console.error);
    }

    // Mensaje post compra
    bot
      .sendMessage(chatId, CONFIG.mensajePostCompra, {
        reply_markup: mainKeyboard
      })
      .catch(console.error);

    // Reseteamos carrito
    session.cart = [];
    session.order = null;
    session.step = null;
    session.temp = {};
    return;
  }

  if (data === 'CANCEL_ORDER') {
    bot
      .answerCallbackQuery(query.id)
      .catch(console.error);

    session.step = null;
    session.order = null;
    session.temp = {};

    bot
      .sendMessage(
        chatId,
        'El pedido fue cancelado. Podés seguir mirando el catálogo cuando quieras.',
        { reply_markup: mainKeyboard }
      )
      .catch(console.error);
    return;
  }

  // Por si acaso
  bot
    .answerCallbackQuery(query.id)
    .catch(console.error);
});

// =====================
// LOG DE INICIO
// =====================

console.log('EzerBot Todo Queso iniciado con éxito');
