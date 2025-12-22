// index.js — EzerBot Todo Queso: catálogo + carrito + sellos + checkout + Render

import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

// =====================
// CONFIG BÁSICA
// =====================

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Falta BOT_TOKEN en variables de entorno');
  process.exit(1);
}

const CONFIG_URL = process.env.CONFIG_URL;
const CATALOG_URL = process.env.CATALOG_URL;

// Alias de transferencia (también lo podés leer desde Config si lo agregás allí)
const ALIAS_TRANSFERENCIA = 'jennyocampos.mp';

// =====================
// ESTADO EN MEMORIA
// =====================

let CONFIG = null; // Datos del local
let CATALOG = []; // Productos
let CATEGORIES = []; // Categorías únicas

const userStates = {}; // checkout (entrega+pago)
const userCart = {}; // carrito por chatId
const userCatalogState = {}; // navegación de catálogo por usuario
const userStamps = {}; // sellos por usuario (de momento en memoria)

// =====================
// CARGA DE SHEETS (Config + Catálogo)
// =====================

async function loadConfig() {
  if (!CONFIG_URL) return;
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) throw new Error('Respuesta no OK en CONFIG_URL');
    const data = await res.json();
    CONFIG = data;
    console.log('Config cargada desde Sheets');
  } catch (err) {
    console.error('Error al cargar CONFIG desde Sheets:', err.message);
  }
}

async function loadCatalog() {
  if (!CATALOG_URL) return;
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error('Respuesta no OK en CATALOG_URL');
    const data = await res.json();

    // Filtramos sólo productos activos si tienen flag "activo"
    CATALOG = (Array.isArray(data) ? data : []).filter(
      (p) => p.activo === undefined || p.activo === true
    );

    const cats = new Set();
    CATALOG.forEach((p) => {
      if (p.categoria) cats.add(p.categoria);
    });
    CATEGORIES = Array.from(cats);
    console.log(`Catálogo cargado: ${CATALOG.length} productos / ${CATEGORIES.length} categorías`);
  } catch (err) {
    console.error('Error al cargar CATALOG desde Sheets:', err.message);
  }
}

// Cargamos al inicio y refrescamos cada 10 minutos
await loadConfig();
await loadCatalog();
setInterval(() => {
  loadConfig();
  loadCatalog();
}, 10 * 60 * 1000);

// =====================
// UTILIDADES
// =====================

function getCart(chatId) {
  if (!userCart[chatId]) userCart[chatId] = [];
  return userCart[chatId];
}

function addToCart(chatId, productId) {
  const cart = getCart(chatId);
  const product = CATALOG.find((p) => p.id === productId);
  if (!product) return;

  const item = cart.find((i) => i.id === productId);
  if (item) {
    item.cantidad += 1;
  } else {
    cart.push({
      id: product.id,
      nombre: product.nombre,
      precio: Number(product.precio) || 0,
      cantidad: 1,
    });
  }
}

function cartSummaryText(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) return '🛒 Tu carrito está vacío. Agregá algo del catálogo 🙂';

  let total = 0;
  let text = '🛒 *Tu carrito*\n\n';
  cart.forEach((item) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    text += `• ${item.cantidad} × ${item.nombre} — $${subtotal.toLocaleString('es-AR')}\n`;
  });
  text += `\n*Subtotal:* $${total.toLocaleString('es-AR')}`;
  return text;
}

function getStamps(chatId) {
  if (!userStamps[chatId]) userStamps[chatId] = 0;
  return userStamps[chatId];
}

function addStamp(chatId) {
  userStamps[chatId] = getStamps(chatId) + 1;
}

function stampsCardText(chatId) {
  const max = 10;
  const current = Math.min(getStamps(chatId), max);
  const filled = '🟩'.repeat(current);
  const empty = '⬜'.repeat(max - current);

  const premio =
    (CONFIG && CONFIG.premioSellos) ||
    'Picada premium Todo Queso (configurable)';

  return (
    '🎟 *Tarjeta de sellos*\n' +
    `${filled}${empty}\n\n` +
    `Sellos: ${current} / ${max}\n` +
    `Premio al completar: ${premio}\n\n` +
    'Tip: cada compra confirmada suma 1 sello automático.'
  );
}

// =====================
// BOT TELEGRAM
// =====================

const bot = new TelegramBot(token, { polling: true });

// -------- SALUDO INICIAL + MENÚ ----------

async function sendWelcome(chatId) {
  if (!CONFIG) await loadConfig();

  const nombre =
    (CONFIG && CONFIG.nombreComercio) || 'Todo Queso Club';
  const direccion =
    (CONFIG && CONFIG.direccion) || 'Dirección no configurada';
  const telefono =
    (CONFIG && CONFIG.telefono) || 'Teléfono no configurado';
  const instagram =
    (CONFIG && CONFIG.instagram) || '@todoqueso.club';
  const horarios =
    (CONFIG && CONFIG.horariosTexto) ||
    'Lunes a Sábado 08:30–14:00 / 16:30–21:00';
  const logoUrl = CONFIG && CONFIG.logoUrl;

  const infoTexto =
    `🧀 *${nombre}*\n` +
    `📍 ${direccion}\n` +
    `⏰ ${horarios}\n` +
    `📞 ${telefono}\n` +
    `📸 Instagram: ${instagram}\n\n` +
    'Elegí una opción del menú para empezar 👇';

  if (logoUrl) {
    try {
      await bot.sendPhoto(chatId, logoUrl, {
        caption: infoTexto,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      console.error('Error enviando logo, mando sólo texto:', e.message);
      await bot.sendMessage(chatId, infoTexto, {
        parse_mode: 'Markdown',
      });
    }
  } else {
    await bot.sendMessage(chatId, infoTexto, {
      parse_mode: 'Markdown',
    });
  }

  await sendMainMenu(chatId);
}

async function sendMainMenu(chatId) {
  await bot.sendMessage(chatId, '📋 Menú principal:', {
    reply_markup: {
      keyboard: [
        ['🛍 Catálogo', '🛒 Mi carrito'],
        ['✅ Finalizar compra'],
        ['🎟 Tarjeta de sellos', '📣 Compartir el bot'],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// -------- CATÁLOGO ----------

async function sendCategoryList(chatId) {
  if (!CATALOG.length) await loadCatalog();

  if (!CATALOG.length) {
    await bot.sendMessage(
      chatId,
      'Por ahora no hay productos cargados en el catálogo. Revisá la hoja de Sheets o intentá de nuevo en unos minutos.'
    );
    return;
  }

  const rows = CATEGORIES.map((cat) => [
    { text: cat, callback_data: `cat_${cat}` },
  ]);

  await bot.sendMessage(
    chatId,
    '🛍 *Catálogo* — elegí una categoría:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

function showProduct(chatId, category, index) {
  const products = CATALOG.filter((p) => p.categoria === category);
  if (!products.length) {
    bot.sendMessage(
      chatId,
      'No encontré productos en esta categoría. Revisá el catálogo en Sheets.'
    );
    return;
  }

  if (index < 0) index = products.length - 1;
  if (index >= products.length) index = 0;

  userCatalogState[chatId] = {
    category,
    index,
  };

  const product = products[index];
  const caption =
    `*${product.nombre || 'Producto'}*\n` +
    (product.precio
      ? `💲 $${Number(product.precio).toLocaleString('es-AR')}\n`
      : '') +
    (product.descripcion ? `${product.descripcion}\n` : '') +
    `\n${index + 1}/${products.length}`;

  const inline_keyboard = [
    [
      {
        text: '➕ Agregar',
        callback_data: `add_${product.id}`,
      },
      {
        text: '📤 Compartir',
        callback_data: `shareprod_${product.id}`,
      },
    ],
    [
      {
        text: '⬅️ Anterior',
        callback_data: 'nav_prev',
      },
      {
        text: '➡️ Siguiente',
        callback_data: 'nav_next',
      },
    ],
    [
      {
        text: '🛍 Ver categorías',
        callback_data: 'back_categories',
      },
      {
        text: '🛒 Ver carrito',
        callback_data: 'view_cart',
      },
    ],
  ];

  if (product.imagenUrl) {
    bot
      .sendPhoto(chatId, product.imagenUrl, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      })
      .catch((e) => {
        console.error('Error enviando foto de producto:', e.message);
        bot.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard },
        });
      });
  } else {
    bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }
}

// -------- CARRITO ----------

async function sendCart(chatId) {
  const text = cartSummaryText(chatId);
  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🧹 Vaciar carrito', callback_data: 'empty_cart' },
          { text: '🛍 Seguir comprando', callback_data: 'back_categories' },
        ],
        [
          {
            text: '✅ Finalizar compra',
            callback_data: 'go_checkout',
          },
        ],
      ],
    },
  });
}

// -------- CHECKOUT (ENTREGA + PAGO) ----------

function startCheckout(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    bot.sendMessage(
      chatId,
      'Tu carrito está vacío. Primero agregá algún producto del catálogo 🙂'
    );
    return;
  }

  userStates[chatId] = {
    step: 'choose_delivery',
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    paymentType: null,
  };

  bot.sendMessage(chatId, 'Elegí cómo querés recibir tu pedido 👇', {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🚚 Envío a domicilio',
            callback_data: 'envio_domicilio',
          },
        ],
        [
          {
            text: '🏪 Retiro en el local',
            callback_data: 'retiro_local',
          },
        ],
      ],
    },
  });
}

// =====================
// HANDLERS DE MENSAJES
// =====================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Saludo / start
  const lower = text.toLowerCase();
  if (
    lower === '/start' ||
    lower === 'menú' ||
    lower === 'menu' ||
    lower === 'hola' ||
    lower === 'buenas' ||
    lower === 'buenos días' ||
    lower === 'buenas tardes' ||
    lower === 'buenas noches'
  ) {
    await sendWelcome(chatId);
    return;
  }

  // Menú principal
  if (text === '🛍 Catálogo') {
    await sendCategoryList(chatId);
    return;
  }

  if (text === '🛒 Mi carrito') {
    await sendCart(chatId);
    return;
  }

  if (text === '✅ Finalizar compra') {
    startCheckout(chatId);
    return;
  }

  if (text === '🎟 Tarjeta de sellos') {
    const card = stampsCardText(chatId);
    await bot.sendMessage(chatId, card, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '📣 Compartir el bot') {
    const shareText =
      '📣 *Compartí Todo Queso Club*\n\n' +
      'Reenviá este mensaje o usá uno de los botones para compartir el bot con tus contactos:';

    const botLink = 'https://t.me/EzerBot';

    const waText = encodeURIComponent(
      'Te paso el bot de Todo Queso Club para hacer pedidos por Telegram: ' + botLink
    );
    const tgText = encodeURIComponent(
      'Bot de Todo Queso Club para hacer pedidos: ' + botLink
    );
    const mailSubject = encodeURIComponent('Bot Todo Queso Club');
    const mailBody = encodeURIComponent(
      'Te comparto el bot de Todo Queso Club para hacer pedidos:\n' + botLink
    );

    await bot.sendMessage(chatId, shareText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📲 WhatsApp',
              url: `https://wa.me/?text=${waText}`,
            },
          ],
          [
            {
              text: '📨 Telegram',
              url: `https://t.me/share/url?url=${botLink}&text=${tgText}`,
            },
          ],
          [
            {
              text: '📧 Email',
              url: `mailto:?subject=${mailSubject}&body=${mailBody}`,
            },
          ],
        ],
      },
    });
    return;
  }

  // Flujo de checkout: address / name / phone
  const state = userStates[chatId];
  if (!state) return;

  if (state.step === 'ask_address') {
    state.address = text;
    state.step = 'ask_name';
    bot.sendMessage(chatId, '🧾 Tu nombre para el pedido:');
    return;
  }

  if (state.step === 'ask_name') {
    state.name = text;
    state.step = 'ask_phone';
    bot.sendMessage(chatId, '📞 Tu teléfono:');
    return;
  }

  if (state.step === 'ask_phone') {
    state.phone = text;
    state.step = 'choose_payment';

    bot.sendMessage(chatId, 'Elegí el método de pago:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💵 Efectivo', callback_data: 'pago_efectivo' }],
          [{ text: '🏦 Transferencia', callback_data: 'pago_transferencia' }],
        ],
      },
    });
    return;
  }
});

// =====================
// HANDLERS DE CALLBACKS
// =====================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId] || {};

  // --- Catálogo: elegir categoría ---
  if (data.startsWith('cat_')) {
    const category = data.substring(4);
    showProduct(chatId, category, 0);
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'back_categories') {
    await sendCategoryList(chatId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'nav_prev' || data === 'nav_next') {
    const st = userCatalogState[chatId];
    if (!st || !st.category) {
      bot.answerCallbackQuery(query.id);
      return;
    }
    const delta = data === 'nav_prev' ? -1 : 1;
    showProduct(chatId, st.category, (st.index || 0) + delta);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // --- Agregar producto al carrito ---
  if (data.startsWith('add_')) {
    const productId = data.substring(4);
    addToCart(chatId, productId);
    bot.answerCallbackQuery(query.id, { text: 'Producto agregado al carrito ✅' });
    return;
  }

  if (data === 'view_cart') {
    await sendCart(chatId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'empty_cart') {
    userCart[chatId] = [];
    bot.answerCallbackQuery(query.id, { text: 'Carrito vaciado' });
    await sendCart(chatId);
    return;
  }

  if (data === 'go_checkout') {
    bot.answerCallbackQuery(query.id);
    startCheckout(chatId);
    return;
  }

  // --- Compartir producto ---
  if (data.startsWith('shareprod_')) {
    const productId = data.substring('shareprod_'.length);
    const p = CATALOG.find((x) => x.id === productId);
    if (!p) {
      bot.answerCallbackQuery(query.id);
      return;
    }

    const botLink = 'https://t.me/EzerBot';
    const baseText = `Mirá este producto de Todo Queso Club: ${p.nombre} - $${Number(
      p.precio
    ).toLocaleString('es-AR')}.\nLo podés pedir desde el bot: ${botLink}`;

    const waText = encodeURIComponent(baseText);
    const tgText = encodeURIComponent(baseText);

    await bot.sendMessage(
      chatId,
      `📤 Compartir *${p.nombre}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📲 WhatsApp',
                url: `https://wa.me/?text=${waText}`,
              },
            ],
            [
              {
                text: '📨 Telegram',
                url: `https://t.me/share/url?url=${botLink}&text=${tgText}`,
              },
            ],
          ],
        },
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // --- Checkout: tipo de entrega ---
  if (data === 'envio_domicilio') {
    state.deliveryType = 'envio';
    state.step = 'ask_address';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '📍 Pasame tu dirección completa (calle + número + entre calles / referencia):');
    return;
  }

  if (data === 'retiro_local') {
    state.deliveryType = 'retiro';
    state.step = 'ask_name';
    userStates[chatId] = state;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '🧾 Tu nombre para el pedido:');
    return;
  }

  // --- Checkout: método de pago ---
  if (data === 'pago_efectivo' || data === 'pago_transferencia') {
    if (state.step !== 'choose_payment') {
      bot.answerCallbackQuery(query.id);
      return;
    }

    state.paymentType =
      data === 'pago_efectivo' ? 'Efectivo' : 'Transferencia';
    userStates[chatId] = state;
    bot.answerCallbackQuery(query.id);

    const cart = getCart(chatId);
    let total = 0;
    cart.forEach((i) => (total += i.precio * i.cantidad));

    let deliveryText = '';
    if (state.deliveryType === 'envio') {
      deliveryText = 'Envío a domicilio 🚚';
    } else if (state.deliveryType === 'retiro') {
      deliveryText = 'Retiro en el local 🏪';
    } else {
      deliveryText = 'Sin especificar';
    }

    let ticket =
      '🧾 *Ticket de compra*\n' +
      'Todo Queso Club\n' +
      '────────────────────\n' +
      `👤 Cliente: ${state.name || 'Sin nombre'}\n` +
      `📞 Tel: ${state.phone || 'Sin teléfono'}\n` +
      `💬 ChatID: ${chatId}\n\n` +
      '*Detalle:*\n';

    cart.forEach((item) => {
      const subtotal = item.precio * item.cantidad;
      ticket += `• ${item.cantidad} × ${item.nombre} — $${subtotal.toLocaleString(
        'es-AR'
      )}\n`;
    });

    ticket +=
      `\n*Subtotal:* $${total.toLocaleString('es-AR')}\n` +
      `*Envío:* $0 (no configurado)\n` +
      `*TOTAL:* $${total.toLocaleString('es-AR')}\n\n` +
      `🚚 *Entrega:* ${deliveryText}\n`;

    if (state.deliveryType === 'envio' && state.address) {
      ticket += `📍 Dirección: ${state.address}\n`;
    }

    ticket += `💳 *Pago:* ${state.paymentType}\n\n`;

    if (state.paymentType === 'Transferencia') {
      ticket +=
        `Alias para transferir: \`${ALIAS_TRANSFERENCIA}\`\n` +
        '📌 Enviá el comprobante por acá para confirmar el pedido.';
    } else {
      ticket += '💵 Pagás en efectivo al retirar o al recibir el pedido.';
    }

    await bot.sendMessage(chatId, ticket, { parse_mode: 'Markdown' });

    // Sumar sello por compra confirmada (simple por ahora)
    addStamp(chatId);

    await bot.sendMessage(
      chatId,
      'Gracias. Tu compra fue registrada ✅\n\nCuando el vendedor confirme el pago, comenzamos a preparar tu pedido.'
    );

    // Vaciar carrito
    userCart[chatId] = [];
    return;
  }
});

console.log('EzerBot Todo Queso iniciado…');

// =====================
// MINI SERVIDOR HTTP PARA RENDER
// =====================

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('EzerBot está corriendo ✅');
});

server.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en puerto ${PORT}`);
});
