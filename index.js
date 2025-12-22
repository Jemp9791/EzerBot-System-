// index.js — EzerBot Todo Queso
// Lee CONFIG y CATALOGO desde Google Sheets (Apps Script WebApp)
// Muestra menú, catálogo, carrito, ticket POS y flujo de entrega + pago.

import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

// ===================== CONFIG BÁSICA =====================

const token = process.env.BOT_TOKEN;
const CONFIG_URL = process.env.CONFIG_URL;
const CATALOG_URL = process.env.CATALOG_URL;

if (!token) {
  console.error('Falta BOT_TOKEN en variables de entorno');
  process.exit(1);
}

if (!CONFIG_URL) console.warn('⚠️ No se definió CONFIG_URL');
if (!CATALOG_URL) console.warn('⚠️ No se definió CATALOG_URL');

// Alias para transferencia (también podés leerlo desde CONFIG)
const ALIAS_TRANSFERENCIA = 'jennyocampos.mp';

// ===================== BOT TELEGRAM =====================

const bot = new TelegramBot(token, { polling: true });

// Cachés en memoria
let configCache = null;
let configCacheTime = 0;
let catalogCache = null;
let catalogCacheTime = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

// Estado por usuario
const userStates = {}; // flujo entrega + pago
const carts = {}; // carrito por chatId
const catalogPositions = {}; // posición actual en catálogo por chatId

// ===================== HELPERS HTTP =====================

async function loadConfig() {
  const now = Date.now();
  if (configCache && now - configCacheTime < CACHE_MS) return configCache;
  if (!CONFIG_URL) return null;

  const res = await fetch(CONFIG_URL);
  const json = await res.json();
  configCache = json;
  configCacheTime = now;
  return json;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogCacheTime < CACHE_MS) return catalogCache;
  if (!CATALOG_URL) return [];

  const res = await fetch(CATALOG_URL);
  const json = await res.json();
  catalogCache = json;
  catalogCacheTime = now;
  return json;
}

// ===================== CARRITO =====================

function getCart(chatId) {
  if (!carts[chatId]) {
    carts[chatId] = { items: [] }; // {id, nombre, precio, cantidad}
  }
  return carts[chatId];
}

function addToCart(chatId, product) {
  const cart = getCart(chatId);
  const existing = cart.items.find((i) => i.id === product.id);
  if (existing) {
    existing.cantidad += 1;
  } else {
    cart.items.push({
      id: product.id,
      nombre: product.nombre,
      precio: Number(product.precio) || 0,
      cantidad: 1,
    });
  }
}

function calcCartTotals(chatId) {
  const cart = getCart(chatId);
  let total = 0;
  for (const item of cart.items) {
    total += item.precio * item.cantidad;
  }
  return { total, items: cart.items };
}

function formatCartText(chatId) {
  const { total, items } = calcCartTotals(chatId);
  if (!items.length) return '🛒 Tu carrito está vacío. Agregá algo del catálogo.';

  let text = '🛒 *Tu carrito*\n\n';
  for (const item of items) {
    text += `• ${item.cantidad} × ${item.nombre} — $${item.precio * item.cantidad}\n`;
  }
  text += `\n*Total:* $${total}`;
  return text;
}

// ===================== MENÚ PRINCIPAL =====================

async function sendMainMenu(chatId) {
  const config = await loadConfig() || {};
  const nombre = config.nombreComercio || 'Todo Queso Club';
  const direccion = config.direccion || 'Dirección no configurada';
  const horario = config.horario || 'Horarios no configurados';
  const telefono = config.telefono || 'Teléfono no configurado';
  const instagram = config.instagram || '@todoqueso.club';

  const saludo = `
🧀 *${nombre}*
📍 ${direccion}
🕒 ${horario}
📞 ${telefono}
📸 Instagram: ${instagram}

Elegí una opción del menú para empezar 👇`.trim();

  await bot.sendMessage(chatId, saludo, {
    parse_mode: 'Markdown',
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

// ===================== CATÁLOGO =====================

async function showCatalog(chatId) {
  const catalog = await loadCatalog();
  if (!catalog || !catalog.length) {
    await bot.sendMessage(
      chatId,
      'Por ahora no hay productos cargados en el catálogo. Revisá la hoja de Sheets o intentá de nuevo en unos minutos.'
    );
    return;
  }

  catalogPositions[chatId] = 0;
  await sendCatalogItem(chatId);
}

async function sendCatalogItem(chatId) {
  const catalog = await loadCatalog();
  if (!catalog || !catalog.length) return;

  let index = catalogPositions[chatId] ?? 0;
  if (index < 0) index = 0;
  if (index >= catalog.length) index = catalog.length - 1;
  catalogPositions[chatId] = index;

  const prod = catalog[index];

  const nombre = prod.nombre || 'Producto';
  const precio = Number(prod.precio) || 0;
  const descripcion = prod.descripcion || '';
  const imageUrl = prod.imagenUrl || prod.imagen || null;

  const caption =
    `*${nombre}*\n` +
    `💰 $${precio}\n` +
    (descripcion ? `_${descripcion}_\n` : '') +
    `\nProducto ${index + 1} de ${catalog.length}`;

  const inline_keyboard = [
    [
      { text: '➕ Agregar al carrito', callback_data: `add_${prod.id}` },
      { text: '📤 Compartir', callback_data: `share_${prod.id}` },
    ],
    [
      { text: '⬅️ Anterior', callback_data: 'cat_prev' },
      { text: '➡️ Siguiente', callback_data: 'cat_next' },
    ],
    [{ text: '🏠 Volver al menú', callback_data: 'back_menu' }],
  ];

  if (imageUrl) {
    await bot.sendPhoto(chatId, imageUrl, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }
}

// ===================== TARJETA DE SELLOS =====================

async function showStampCard(chatId) {
  const config = await loadConfig() || {};
  const meta = Number(config.sellosMeta) || 10;
  const premio = config.premioSellos || 'Picada premium Todo Queso (configurable)';

  // Por ahora mostramos tarjeta "0 / meta" estática
  const bloques = '🟩' + '⬜'.repeat(Math.max(meta - 1, 0));

  const txt = `
🎟 *Tarjeta de sellos*

${bloques}

Sellos: 0 / ${meta}
Premio al completar: ${premio}

Tip: cada compra confirmada suma 1 sello automático (configurable).
`.trim();

  await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
}

// ===================== COMPARTIR EL BOT =====================

async function shareBot(chatId) {
  const config = await loadConfig() || {};
  const nombre = config.nombreComercio || 'Todo Queso Club';
  const botLink = config.linkBot || 'https://t.me/EzerBot';

  const textoShare = encodeURIComponent(
    `Pedí en ${nombre} por acá: ${botLink}`
  );

  const waUrl = `https://wa.me/?text=${textoShare}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${textoShare}`;
  const mailUrl = `mailto:?subject=${encodeURIComponent(
    nombre
  )}&body=${textoShare}`;

  const msg = `📣 *Compartí ${nombre}*\n\nReenviá este mensaje o usá los botones para compartir el bot con tus contactos.`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'WhatsApp', url: waUrl },
          { text: 'Telegram', url: tgUrl },
          { text: 'Email', url: mailUrl },
        ],
      ],
    },
  });
}

// ===================== FLUJO ENTREGA + PAGO =====================

function startCheckoutFlow(chatId) {
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
        [{ text: '🚚 Envío a domicilio', callback_data: 'envio_domicilio' }],
        [{ text: '🏪 Retiro por el local', callback_data: 'retiro_local' }],
      ],
    },
  });
}

function handleCheckoutText(chatId, text) {
  const state = userStates[chatId];
  if (!state) return;

  if (state.step === 'ask_address') {
    state.address = text.trim();
    state.step = 'ask_name';
    bot.sendMessage(chatId, '🧾 Tu nombre:');
  } else if (state.step === 'ask_name') {
    state.name = text.trim();
    state.step = 'ask_phone';
    bot.sendMessage(chatId, '📞 Tu teléfono:');
  } else if (state.step === 'ask_phone') {
    state.phone = text.trim();
    state.step = 'choose_payment';

    bot.sendMessage(chatId, 'Perfecto. Ahora elegí el método de pago:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💵 Efectivo', callback_data: 'pago_efectivo' }],
          [{ text: '🏦 Transferencia', callback_data: 'pago_transferencia' }],
        ],
      },
    });
  }
}

function buildTicketText(config, state, chatId) {
  const { total, items } = calcCartTotals(chatId);
  const nombreComercio = config.nombreComercio || 'Todo Queso Club';

  let detalle = '';
  for (const item of items) {
    const sub = item.precio * item.cantidad;
    detalle += `• ${item.cantidad} × ${item.nombre} — $${sub}\n`;
  }

  let deliveryText = '';
  if (state.deliveryType === 'envio') {
    deliveryText = 'Envío a domicilio';
  } else if (state.deliveryType === 'retiro') {
    deliveryText = 'Retiro en el local';
  } else {
    deliveryText = 'Sin especificar';
  }

  let txt = `🧾 *Ticket de compra*\n*${nombreComercio}*\n`;
  txt += '──────────────────────\n';
  if (state.name) txt += `👤 Cliente: ${state.name}\n`;
  if (state.phone) txt += `📞 Tel: ${state.phone}\n`;
  txt += `🆔 ChatID: ${chatId}\n`;
  txt += '──────────────────────\n';
  txt += '*Detalle:*\n';
  txt += detalle || 'Sin ítems en el carrito\n';
  txt += '\n';
  txt += `Subtotal: $${total}\n`;
  txt += `Envío: $0 (no configurado)\n`;
  txt += `*TOTAL:* $${total}\n\n`;
  txt += `🚚 Entrega: ${deliveryText}\n`;
  txt += `💳 Pago: ${state.paymentType}\n`;

  if (state.paymentType === 'Transferencia') {
    txt += `\nAlias para transferir: \`${ALIAS_TRANSFERENCIA}\`\n`;
    txt += '📌 Cuando hagas la transferencia, mandá el comprobante por acá así confirmamos el pedido.';
  } else {
    txt += '\nPagás en efectivo al retirar o al recibir el pedido.';
  }

  return txt;
}

// ===================== HANDLERS TELEGRAM =====================

// Mensajes de texto
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const lower = text.toLowerCase();

  // Flujo base /start y saludos
  if (
    lower === '/start' ||
    lower === 'hola' ||
    lower === 'buenas' ||
    lower === 'buenos días' ||
    lower === 'buenas tardes' ||
    lower === 'buenas noches' ||
    lower === 'menú' ||
    lower === 'menu'
  ) {
    await sendMainMenu(chatId);
    return;
  }

  // Si estoy en medio del flujo de entrega/pago, primero proceso eso
  const state = userStates[chatId];
  if (state && ['ask_address', 'ask_name', 'ask_phone'].includes(state.step)) {
    handleCheckoutText(chatId, text);
    return;
  }

  // Menú principal
  if (lower.includes('catálogo') || text.startsWith('🛍')) {
    await showCatalog(chatId);
    return;
  }

  if (lower.includes('carrito') || text.startsWith('🛒')) {
    await bot.sendMessage(chatId, formatCartText(chatId), { parse_mode: 'Markdown' });
    return;
  }

  if (lower.includes('finalizar') || text.startsWith('✅')) {
    const cart = getCart(chatId);
    if (!cart.items.length) {
      await bot.sendMessage(
        chatId,
        'Tu carrito está vacío. Agregá al menos un producto del catálogo antes de finalizar la compra.'
      );
      return;
    }
    startCheckoutFlow(chatId);
    return;
  }

  if (lower.includes('tarjeta') || text.startsWith('🎟')) {
    await showStampCard(chatId);
    return;
  }

  if (lower.includes('compartir el bot') || text.startsWith('📣')) {
    await shareBot(chatId);
    return;
  }
});

// Botones inline
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId] || {};
  const catalog = await loadCatalog();

  // Navegación catálogo
  if (data === 'cat_prev' || data === 'cat_next') {
    if (!catalog || !catalog.length) {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    let index = catalogPositions[chatId] ?? 0;
    if (data === 'cat_prev') index -= 1;
    if (data === 'cat_next') index += 1;
    if (index < 0) index = catalog.length - 1;
    if (index >= catalog.length) index = 0;
    catalogPositions[chatId] = index;

    await bot.answerCallbackQuery(query.id);
    await sendCatalogItem(chatId);
    return;
  }

  // Volver al menú
  if (data === 'back_menu') {
    await bot.answerCallbackQuery(query.id);
    await sendMainMenu(chatId);
    return;
  }

  // Agregar producto al carrito
  if (data.startsWith('add_')) {
    const prodId = data.substring(4);
    const prod = (catalog || []).find((p) => String(p.id) === String(prodId));
    if (!prod) {
      await bot.answerCallbackQuery(query.id, { text: 'Producto no encontrado', show_alert: true });
      return;
    }
    addToCart(chatId, prod);
    await bot.answerCallbackQuery(query.id, { text: 'Agregado al carrito ✅', show_alert: false });
    return;
  }

  // Compartir producto (mensaje con links)
  if (data.startsWith('share_')) {
    const prodId = data.substring(6);
    const prod = (catalog || []).find((p) => String(p.id) === String(prodId));
    if (!prod) {
      await bot.answerCallbackQuery(query.id, { text: 'Producto no encontrado', show_alert: true });
      return;
    }

    const config = await loadConfig() || {};
    const nombreComercio = config.nombreComercio || 'Todo Queso Club';
    const botLink = config.linkBot || 'https://t.me/EzerBot';

    const texto = encodeURIComponent(
      `Mirá este producto de ${nombreComercio}: ${prod.nombre} - $${prod.precio}. Podés pedir por acá: ${botLink}`
    );

    const waUrl = `https://wa.me/?text=${texto}`;
    const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${texto}`;
    const mailUrl = `mailto:?subject=${encodeURIComponent(
      `${nombreComercio} - ${prod.nombre}`
    )}&body=${texto}`;

    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      chatId,
      `📤 Compartir *${prod.nombre}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'WhatsApp', url: waUrl },
              { text: 'Telegram', url: tgUrl },
              { text: 'Email', url: mailUrl },
            ],
          ],
        },
      }
    );
    return;
  }

  // Tipo de entrega
  if (data === 'envio_domicilio') {
    state.deliveryType = 'envio';
    state.step = 'ask_address';
    userStates[chatId] = state;

    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '📍 Decime tu dirección completa (calle + número + referencia):');
    return;
  }

  if (data === 'retiro_local') {
    state.deliveryType = 'retiro';
    state.step = 'ask_name';
    userStates[chatId] = state;

    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '🧾 Tu nombre:');
    return;
  }

  // Método de pago
  if (data === 'pago_efectivo' || data === 'pago_transferencia') {
    if (state.step !== 'choose_payment') {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    state.paymentType = data === 'pago_efectivo' ? 'Efectivo' : 'Transferencia';
    userStates[chatId] = state;

    await bot.answerCallbackQuery(query.id);

    const config = await loadConfig() || {};
    const ticket = buildTicketText(config, state, chatId);

    await bot.sendMessage(chatId, ticket, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, 'Gracias. Tu compra fue registrada. ✅');

    // Opcional: vaciar carrito luego de confirmar
    carts[chatId] = { items: [] };
    return;
  }
});

// ===================== MINI SERVIDOR HTTP (Render) =====================

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('EzerBot está corriendo ✅');
});

server.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en puerto ${PORT}`);
  console.log('Bot EzerBot iniciado…');
});
