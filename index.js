// index.js – EzerBot TODO QUESO
// Versión sin Markdown, con menú completo, catálogo, carrito y sellos.

import express from 'express';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

// ========== CONFIG BÁSICA (podés dejar así por ahora) ==========

// Si en Render tenés env vars, las usa; si no, usa estos valores.
const BOT_TOKEN =
  process.env.TELEGRAM_TOKEN ||
  '8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA';

const BACKEND_URL =
  process.env.BACKEND_URL ||
  'https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec';

const LOGO_URL =
  process.env.LOGO_URL ||
  'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg';

const BOT_PUBLIC_LINK =
  process.env.BOT_PUBLIC_LINK || 'https://t.me/Ezer_IA_Bot';

const SELLER_WHATSAPP =
  process.env.SELLER_WHATSAPP || '1122538102'; // solo sin 54

const BUSINESS_NAME =
  process.env.BUSINESS_NAME || 'TODO QUESO CLUB';
const BUSINESS_ADDRESS =
  process.env.BUSINESS_ADDRESS || 'Garín, Escobar';
const BUSINESS_PHONE =
  process.env.BUSINESS_PHONE || '11 2253-8102';
const BUSINESS_HOURS =
  process.env.BUSINESS_HOURS ||
  'Lunes a sábados de 9 a 13 hs y de 17 a 20 hs';
const BUSINESS_DESCRIPTION =
  process.env.BUSINESS_DESCRIPTION ||
  'Fiambrería y quesería con productos frescos, panes caseros y picadas listas.';

// URL pública de Render
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://ezerbot-system.onrender.com';

const PORT = process.env.PORT || 10000;

// ========== EXPRESS + TELEGRAM ==========

const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Estado en memoria
const sessions = new Map(); // chatId -> { state, cart, pendingItem }
const catalogCache = new Map(); // chatId -> items del catálogo

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      state: 'IDLE',
      cart: [],
      pendingItem: null,
    });
  }
  return sessions.get(chatId);
}

// ========== MENÚ PRINCIPAL ==========

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🛍 Catálogo' }, { text: '🛒 Mi carrito' }],
      [{ text: '🏆 Mis sellos' }, { text: '💬 Hablar con el vendedor' }],
      [{ text: '🏬 Información del local' }, { text: '📢 Compartir el bot' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ========== HELPERS ==========

async function fetchCatalog() {
  const url = `${BACKEND_URL}?accion=catalogo`;
  const res = await axios.get(url);
  const data = res.data || {};
  return data.items || [];
}

async function fetchEstadoCliente(chatId) {
  const url = `${BACKEND_URL}?accion=estadoCliente&chatId=${encodeURIComponent(
    String(chatId)
  )}`;
  const res = await axios.get(url);
  return res.data || {};
}

function formatMoney(n) {
  const num = Number(n) || 0;
  return `${num.toLocaleString('es-AR')} ARS`;
}

function buildWhatsappLink(texto) {
  const base = `https://wa.me/54${SELLER_WHATSAPP}`;
  const msg = encodeURIComponent(texto);
  return `${base}?text=${msg}`;
}

// ========== MENSAJES PRINCIPALES ==========

async function sendWelcome(chatId) {
  try {
    await bot.sendPhoto(chatId, LOGO_URL, {
      caption: `${BUSINESS_NAME}\n\n${BUSINESS_DESCRIPTION}`,
    });
  } catch (e) {
    console.error('Error enviando logo de bienvenida:', e.message);
  }

  await bot.sendMessage(
    chatId,
    '¡Hola! Soy el asistente de TODO QUESO 🧀\n\n' +
      'Desde acá podés:\n' +
      '• Ver el catálogo y armar tu pedido\n' +
      '• Consultar tus sellos y beneficios\n' +
      '• Hablar con un vendedor\n\n' +
      'Elegí una opción del menú de abajo para empezar 👇',
    { reply_markup: mainMenuKeyboard() }
  );
}

async function sendInfoLocal(chatId) {
  const texto =
    `${BUSINESS_NAME}\n\n` +
    `${BUSINESS_DESCRIPTION}\n\n` +
    `📍 Dirección: ${BUSINESS_ADDRESS}\n` +
    `🕒 Horarios: ${BUSINESS_HOURS}\n` +
    `📞 Contacto: ${BUSINESS_PHONE}\n\n` +
    'Gracias por elegir productos frescos y de calidad 💛';

  try {
    await bot.sendPhoto(chatId, LOGO_URL, { caption: texto });
  } catch (e) {
    console.error('Error enviando info del local con foto:', e.message);
    await bot.sendMessage(chatId, texto);
  }
}

async function sendCompartirBot(chatId) {
  const texto =
    'Compartí este mensaje para que tus contactos también ganen sellos 🧀👇\n\n' +
    `🧀 Sumate a ${BUSINESS_NAME}\n` +
    'Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n' +
    `👉 ${BOT_PUBLIC_LINK}`;

  await bot.sendMessage(chatId, texto);
}

async function sendHablarVendedor(chatId) {
  const link = buildWhatsappLink(
    'Hola, quiero hacer una consulta sobre productos o un pedido desde el bot.'
  );

  const texto =
    'Escribí tu consulta y un vendedor de TODO QUESO te responderá 💛\n\n' +
    'Si querés, también podés escribir directo por WhatsApp:\n' +
    link;

  await bot.sendMessage(chatId, texto);
}

// ========== SELLOS / TARJETA ==========

async function sendMisSellos(chatId) {
  try {
    const estado = await fetchEstadoCliente(chatId);

    if (!estado.tieneTarjeta) {
      await bot.sendMessage(
        chatId,
        'Todavía no tenés tu tarjeta de sellos.\n' +
          'Pedí en el local que te registren en TODO QUESO CLUB para empezar a sumar 🧀'
      );
      return;
    }

    const nombre = estado.nombreCliente || 'Cliente';
    const actuales = estado.sellosActuales || 0;
    const nivel = estado.nivelActual || '';
    const total = estado.sellosTotalesAcumulados || 0;
    const prox = estado.beneficioProximo || '';
    const disponible = estado.beneficioDisponible;
    const venceEl = estado.venceEl || '';
    const cod = estado.codigoCanje || '';
    const tarjetaUrl = estado.tarjetaImagenUrl || '';

    let texto =
      `Hola ${nombre} 🧀\n\n` +
      `Sellos en tu nivel actual: ${actuales}\n` +
      `Nivel: ${nivel}\n` +
      `Sellos totales acumulados: ${total}\n\n`;

    if (prox) {
      texto += `Próximo beneficio: ${prox}\n`;
    }

    if (disponible) {
      texto += '\n🎁 Tenés un beneficio disponible.\n';
      if (cod) {
        texto += `Código de canje: ${cod}\n`;
      }
      if (venceEl) {
        texto += `Vence el: ${venceEl}\n`;
      }
      texto +=
        '\nMostrá este mensaje en el local para usar tu beneficio 😊';
    } else {
      texto += '\nSeguí sumando sellos con tus compras para desbloquear beneficios 🎁';
    }

    if (tarjetaUrl) {
      try {
        await bot.sendPhoto(chatId, tarjetaUrl, { caption: texto });
        return;
      } catch (e) {
        console.error('Error enviando imagen de tarjeta:', e.message);
      }
    }

    await bot.sendMessage(chatId, texto);
  } catch (e) {
    console.error('Error en sendMisSellos:', e.message);
    await bot.sendMessage(
      chatId,
      'No pude consultar tus sellos en este momento. Probá de nuevo más tarde.'
    );
  }
}

// ========== CATÁLOGO Y CARRITO ==========

async function sendCatalogo(chatId) {
  let items;
  try {
    items = await fetchCatalog();
  } catch (e) {
    console.error('Error consultando catálogo:', e.message);
    await bot.sendMessage(
      chatId,
      'No pude cargar el catálogo en este momento. Probá de nuevo más tarde.'
    );
    return;
  }

  if (!items || !items.length) {
    await bot.sendMessage(
      chatId,
      'Por ahora el catálogo está vacío. Volvé a intentar en un rato.'
    );
    return;
  }

  // Guardamos catálogo para este chat
  catalogCache.set(chatId, items);

  await bot.sendMessage(
    chatId,
    'Te muestro los productos de TODO QUESO.\nEscribí el código del que quieras o tocá "Comprar" en cada foto para agregar al carrito 🛒'
  );

  // Enviar cada producto como foto + botón "Comprar"
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const nombre = item.nombre || item.NOMBRE || 'Producto';
    const precio = item.precio || item.PRECIO || 0;
    const codigo = item.codigo || item.CODIGO || String(i + 1);
    const unidadRaw = item.unidad || item.UNIDAD || '';
    const unidad =
      String(unidadRaw).toUpperCase() === 'KG' ? 'por kilo' : 'por unidad';
    const imagen = item.imagenUrl || item.IMAGEN || LOGO_URL;

    const caption =
      `${nombre}\n\n` +
      `Código: ${codigo}\n` +
      `Precio: ${formatMoney(precio)} ${unidad}`;

    const inline_keyboard = [
      [
        {
          text: '🛒 Comprar',
          callback_data: `CAT_ADD_${i}`,
        },
      ],
    ];

    try {
      await bot.sendPhoto(chatId, imagen, {
        caption,
        reply_markup: { inline_keyboard },
      });
    } catch (e) {
      console.error('Error enviando producto del catálogo:', e.message);
    }
  }
}

async function handleAddToCart(chatId, index) {
  const items = catalogCache.get(chatId);
  if (!items || !items[index]) {
    await bot.sendMessage(
      chatId,
      'No encontré ese producto. Volvé a abrir el catálogo, por favor.'
    );
    return;
  }

  const item = items[index];
  const nombre = item.nombre || item.NOMBRE || 'Producto';
  const unidadRaw = item.unidad || item.UNIDAD || '';
  const unidad =
    String(unidadRaw).toUpperCase() === 'KG' ? 'KG' : 'UNIDAD';

  const session = getSession(chatId);
  session.state = 'WAITING_QUANTITY';
  session.pendingItem = { index, unidad };

  let textoPregunta = `¿Cuánta cantidad querés de "${nombre}"?\n\n`;
  if (unidad === 'KG') {
    textoPregunta +=
      'Escribí los gramos (por ejemplo 200, 300, 500). Mínimo 100 g.';
  } else {
    textoPregunta += 'Escribí el número de unidades (1, 2, 3, etc.).';
  }

  await bot.sendMessage(chatId, textoPregunta);
}

async function handleCantidad(chatId, texto) {
  const session = getSession(chatId);
  if (!session.pendingItem) {
    session.state = 'IDLE';
    return;
  }

  const cantidadNum = parseInt(texto, 10);
  if (isNaN(cantidadNum) || cantidadNum <= 0) {
    await bot.sendMessage(
      chatId,
      'No entendí la cantidad. Escribí solo un número, por favor.'
    );
    return;
  }

  const { index, unidad } = session.pendingItem;
  const items = catalogCache.get(chatId) || [];
  const item = items[index];

  if (!item) {
    await bot.sendMessage(
      chatId,
      'No encontré el producto. Volvé a abrir el catálogo, por favor.'
    );
    session.state = 'IDLE';
    session.pendingItem = null;
    return;
  }

  const nombre = item.nombre || item.NOMBRE || 'Producto';
  const precio = Number(item.precio || item.PRECIO || 0);

  let descripcionCantidad;
  let subtotal = 0;

  if (unidad === 'KG') {
    const gramos = cantidadNum;
    if (gramos < 100) {
      await bot.sendMessage(
        chatId,
        'La cantidad mínima es 100 gramos. Probá con un número mayor.'
      );
      return;
    }
    const kilos = gramos / 1000;
    subtotal = Math.round(precio * kilos);
    descripcionCantidad = `${gramos} g`;
  } else {
    const unidades = cantidadNum;
    subtotal = Math.round(precio * unidades);
    descripcionCantidad = `${unidades} un.`;
  }

  const cartItem = {
    nombre,
    descripcionCantidad,
    subtotal,
  };

  session.cart.push(cartItem);
  session.state = 'IDLE';
  session.pendingItem = null;

  await bot.sendMessage(
    chatId,
    `Agregué ${descripcionCantidad} de "${nombre}" a tu carrito.\n` +
      `Subtotal: ${formatMoney(subtotal)}\n\n` +
      'Podés seguir eligiendo productos o ver tu carrito con el botón "Mi carrito".'
  );
}

async function sendCarrito(chatId) {
  const session = getSession(chatId);
  const cart = session.cart || [];

  if (!cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío por ahora 🛒\nUsá el botón "Catálogo" para agregar productos.'
    );
    return;
  }

  let texto = '🛍 Tu carrito\n\n';
  let total = 0;
  for (let i = 0; i < cart.length; i++) {
    const c = cart[i];
    total += c.subtotal || 0;
    texto += `${i + 1}) ${c.nombre} – ${c.descripcionCantidad} – ${formatMoney(
      c.subtotal
    )}\n`;
  }
  texto += `\nTotal: ${formatMoney(total)}`;

  const inline_keyboard = [
    [
      { text: '✅ Confirmar pedido', callback_data: 'CART_CONFIRM' },
    ],
    [{ text: '🗑 Vaciar carrito', callback_data: 'CART_CLEAR' }],
  ];

  await bot.sendMessage(chatId, texto, {
    reply_markup: { inline_keyboard },
  });
}

async function handleConfirmPedido(chatId) {
  const session = getSession(chatId);
  const cart = session.cart || [];

  if (!cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío por ahora. Agregá productos desde el catálogo.'
    );
    return;
  }

  const inline_keyboard = [
    [
      {
        text: '🏬 Retiro en local',
        callback_data: 'DELIVERY_LOCAL',
      },
    ],
    [
      {
        text: '🚚 Envío a domicilio',
        callback_data: 'DELIVERY_ENVIO',
      },
    ],
  ];

  await bot.sendMessage(
    chatId,
    '¿Cómo querés recibir tu pedido?',
    { reply_markup: { inline_keyboard } }
  );
}

async function handleEntrega(chatId, tipo) {
  const session = getSession(chatId);
  const cart = session.cart || [];

  if (!cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío por ahora. Agregá productos desde el catálogo.'
    );
    return;
  }

  let total = 0;
  let detalle = '';
  for (let i = 0; i < cart.length; i++) {
    const c = cart[i];
    total += c.subtotal || 0;
    detalle += `${i + 1}) ${c.nombre} – ${c.descripcionCantidad} – ${formatMoney(
      c.subtotal
    )}\n`;
  }

  const tipoTexto =
    tipo === 'LOCAL' ? 'Retiro en local' : 'Envío a domicilio';

  const textoPedido =
    '🎉 Pedido registrado\n\n' +
    `Tipo: ${tipoTexto}\n\n` +
    `${detalle}\n` +
    `Total: ${formatMoney(total)}\n\n` +
    'Un vendedor confirmará tu pedido y el pago antes de prepararlo.\n';

  const textoClienteWA =
    'Hola, acabo de hacer un pedido desde el bot TODO QUESO.\n\n' +
    `Tipo: ${tipoTexto}\n\n` +
    `${detalle}\n` +
    `Total: ${formatMoney(total)}\n\n` +
    'Quisiera confirmar el pago y la preparación del pedido.';

  const linkWA = buildWhatsappLink(textoClienteWA);

  await bot.sendMessage(
    chatId,
    textoPedido +
      '\nPara acelerar la confirmación, podés avisar por WhatsApp con este enlace:\n' +
      linkWA
  );

  // limpiamos carrito
  session.cart = [];
}

// ========== MANEJO DE MENSAJES ==========

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = msg.text || '';
  const text = textRaw.trim();

  const session = getSession(chatId);

  // Si estamos esperando cantidad, procesamos eso
  if (session.state === 'WAITING_QUANTITY') {
    await handleCantidad(chatId, text);
    return;
  }

  const lower = text.toLowerCase();

  if (text === '/start') {
    await sendWelcome(chatId);
    return;
  }

  if (lower === '🛍 catálogo'.toLowerCase() || lower === 'catalogo') {
    await sendCatalogo(chatId);
    return;
  }

  if (lower === '🛒 mi carrito'.toLowerCase() || lower === 'mi carrito') {
    await sendCarrito(chatId);
    return;
  }

  if (lower === '🏆 mis sellos'.toLowerCase() || lower === 'mis sellos') {
    await sendMisSellos(chatId);
    return;
  }

  if (
    lower === '💬 hablar con el vendedor'.toLowerCase() ||
    lower.includes('vendedor')
  ) {
    await sendHablarVendedor(chatId);
    return;
  }

  if (
    lower === '🏬 información del local'.toLowerCase() ||
    lower.includes('información del local') ||
    lower.includes('info del local')
  ) {
    await sendInfoLocal(chatId);
    return;
  }

  if (
    lower === '📢 compartir el bot'.toLowerCase() ||
    lower.includes('compartir')
  ) {
    await sendCompartirBot(chatId);
    return;
  }

  // Cualquier otra cosa: responder bienvenida + menú
  await sendWelcome(chatId);
});

// ========== CALLBACKS (BOTONES INLINE) ==========

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  try {
    if (data.startsWith('CAT_ADD_')) {
      const indexStr = data.replace('CAT_ADD_', '');
      const index = parseInt(indexStr, 10);
      await handleAddToCart(chatId, index);
    } else if (data === 'CART_CONFIRM') {
      await handleConfirmPedido(chatId);
    } else if (data === 'CART_CLEAR') {
      const session = getSession(chatId);
      session.cart = [];
      await bot.sendMessage(
        chatId,
        'Vacíe tu carrito. Podés volver a agregar productos desde el catálogo.'
      );
    } else if (data === 'DELIVERY_LOCAL') {
      await handleEntrega(chatId, 'LOCAL');
    } else if (data === 'DELIVERY_ENVIO') {
      await handleEntrega(chatId, 'ENVIO');
    }
  } catch (e) {
    console.error('Error en callback_query:', e.message);
  }

  // Siempre respondemos al callback para sacar el "relojito"
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    // ignoramos errores acá
  }
});

// ========== WEBHOOK EXPRESS ==========

app.get('/', (req, res) => {
  res.send('EzerBot TODO QUESO está funcionando.');
});

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log('EzerBot escuchando en puerto', PORT);
  try {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
    console.log('Webhook configurado en', `${WEBHOOK_URL}/webhook`);
  } catch (e) {
    console.error('Error configurando webhook:', e.message);
  }
});
