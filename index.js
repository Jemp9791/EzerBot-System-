// EzerBot System - TODO QUESO
// Bot de Telegram con catálogo, carrito y contacto con el vendedor

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// =======================
//  CONFIGURACIÓN FIJA
// =======================

const BOT_TOKEN = '8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA';
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec';
const LOGO_URL = 'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg';

// Datos del negocio
const NEGOCIO = {
  nombre: 'TODO QUESO CLUB',
  direccion: 'Fructuoso Díaz 893, Garín',
  horarios: 'LUN a SAB 08:30-14:00 / 16:30-21:00',
  telefono: '3484230184',
  instagram: '@todoqueso.club',
  whatsappVendedor: '5491122538102', // 54 + 9 + área + número
  telegramVendedorAlias: '@Ezer_IA_Bot'
};

// Chat ID del vendedor (por ahora el tuyo)
const VENDEDOR_CHAT_ID = 7454984023;

// =======================
//   INICIALIZACIÓN
// =======================

const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);

// Memoria simple
let catalogCache = null;
let catalogCacheTime = 0;
const CACHE_MS = 2 * 60 * 1000; // 2 minutos

const carts = {};          // { chatId: [ ... ] }
const pendingQty = {};     // { chatId: producto }
const productsByCode = {}; // { codigo: producto }

// =======================
//   SERVIDOR EXPRESS
// =======================

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('EzerBot System activo');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('EzerBot escuchando en puerto ' + PORT);
});

// =======================
//   TECLADO PRINCIPAL
// =======================

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: '🛍 Catálogo' }, { text: '🛒 Mi carrito' }],
      [{ text: '🏆 Mis sellos' }, { text: '💬 Hablar con el vendedor' }],
      [{ text: '🏬 Información del local' }, { text: '📣 Compartir el bot' }]
    ],
    resize_keyboard: true
  };
}

// =======================
//   UTILIDADES CATÁLOGO
// =======================

async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache && (now - catalogCacheTime) < CACHE_MS) {
    return catalogCache;
  }

  const url = BACKEND_URL + '?accion=catalogo';
  const res = await axios.get(url);
  const data = res.data || {};
  const rawItems = Array.isArray(data.items) ? data.items : [];

  // NORMALIZAR: acepte formato viejo o nuevo de Apps Script
  const items = rawItems.map((it, idx) => {
    const codigo = (
      it.codigo ||
      it.CODIGO ||
      it.cod ||
      ''
    ).toString().trim() || ('P' + (idx + 1));

    const nombre = (
      it.nombre ||
      it.NOMBRE ||
      ''
    ).toString().trim() || ('Producto ' + (idx + 1));

    const precioRaw = (it.precio !== undefined ? it.precio : (it.PRECIO !== undefined ? it.PRECIO : 0));
    const precio = Number(precioRaw) || 0;

    const unidad = (
      it.unidad ||
      it.UNIDAD ||
      ''
    ).toString().trim(); // "kg" o "unidad"

    const descripcion = (
      it.descripcion ||
      it.DESCRIPCION ||
      ''
    ).toString().trim();

    const imagenUrl = (
      it.imagenUrl ||
      it.IMAGEN ||
      ''
    ).toString().trim() || LOGO_URL;

    const categoria = (
      it.categoria ||
      it.CATEGORIA ||
      ''
    ).toString().trim() || 'General';

    return {
      codigo,
      nombre,
      precio,
      unidad,
      descripcion,
      imagenUrl,
      categoria
    };
  });

  // reconstruir índice por código
  for (const it of items) {
    productsByCode[it.codigo] = it;
  }

  catalogCache = { items };
  catalogCacheTime = now;
  return catalogCache;
}

function iconoCategoria(catRaw) {
  const c = String(catRaw || '').toLowerCase();

  if (c.includes('queso')) return '🧀';
  if (c.includes('fiambre')) return '🥓';
  if (c.includes('pan')) return '🥖';
  if (c.includes('lácte') || c.includes('leche')) return '🥛';
  if (c.includes('bebida')) return '🥤';
  if (c.includes('promo') || c.includes('combo') || c.includes('picada')) return '🎁';

  return '📦';
}

// =======================
//     MENSAJES BASE
// =======================

async function sendBienvenida(chatId, nombre) {
  const caption =
    '🧀 Bienvenid@ a *' + NEGOCIO.nombre + '*\n\n' +
    'Soy tu asistente virtual. Desde acá podés:\n' +
    '• Ver el catálogo con fotos y precios\n' +
    '• Armar tu pedido y enviarlo al vendedor\n' +
    '• Sumar sellos y canjear beneficios\n\n' +
    'Elegí una opción del menú de abajo para empezar 👇';

  await bot.sendPhoto(chatId, LOGO_URL, {
    caption: caption,
    parse_mode: 'Markdown'
  });

  await bot.sendMessage(chatId, 'Elegí una opción del menú de abajo para empezar 👇', {
    reply_markup: mainKeyboard()
  });
}

async function mostrarInfoLocal(chatId) {
  const texto =
    '🏬 *' + NEGOCIO.nombre + '*\n\n' +
    '📍 *Dirección:* ' + NEGOCIO.direccion + '\n' +
    '🕒 *Horarios:* ' + NEGOCIO.horarios + '\n' +
    '📞 *Teléfono:* ' + NEGOCIO.telefono + '\n' +
    '📷 *Instagram:* ' + NEGOCIO.instagram + '\n\n' +
    'Gracias por ser parte de ' + NEGOCIO.nombre + ' 🧀';

  await bot.sendPhoto(chatId, LOGO_URL, {
    caption: texto,
    parse_mode: 'Markdown'
  });
}

async function mostrarHablarVendedor(chatId) {
  const texto =
    '💬 Si necesitás algo especial, querés armar una picada distinta o tenés dudas sobre un producto, podés hablar directo con el vendedor.';

  const waLink =
    'https://wa.me/' +
    NEGOCIO.whatsappVendedor +
    '?text=' +
    encodeURIComponent('Hola, vengo del bot de ' + NEGOCIO.nombre + ' 🧀');

  const inline = {
    inline_keyboard: [
      [{ text: '📲 Escribir por WhatsApp', url: waLink }],
      [{ text: '💬 Escribir por Telegram', url: 'https://t.me/' + NEGOCIO.telegramVendedorAlias.replace('@', '') }]
    ]
  };

  await bot.sendMessage(chatId, texto, { reply_markup: inline });
}

async function mostrarCompartirBot(chatId) {
  const texto =
    'Compartí este texto con tus contactos para que también usen el bot y sumen sellos:\n\n' +
    '🧀 *Sumate a ' + NEGOCIO.nombre + '*\n' +
    'Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n' +
    '👉 https://t.me/Ezer_IA_Bot';

  await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
}

async function mostrarMisSellos(chatId, nombre) {
  const texto =
    '🏆 *Mis sellos*\n\n' +
    'Muy pronto vas a ver acá tu tarjeta de sellos digital con los sellos que vas acumulando.\n\n' +
    'Por ahora, cada compra que hagas en *' + NEGOCIO.nombre + '* suma para tus próximos beneficios.';

  await bot.sendPhoto(chatId, LOGO_URL, {
    caption: texto,
    parse_mode: 'Markdown'
  });
}

// =======================
//   CATÁLOGO Y COMPRA
// =======================

async function mostrarCategorias(chatId) {
  try {
    const catData = await fetchCatalog();
    const items = catData.items;

    if (!items.length) {
      await bot.sendMessage(chatId, 'Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀');
      return;
    }

    const set = new Set();
    for (const it of items) {
      set.add(it.categoria || 'General');
    }
    const categorias = Array.from(set);

    if (categorias.length === 1) {
      await mostrarProductosPorCategoria(chatId, categorias[0]);
      return;
    }

    const inline = {
      inline_keyboard: categorias.map(cat => [{
        text: iconoCategoria(cat) + ' ' + cat,
        callback_data: 'cat:' + cat
      }])
    };

    await bot.sendMessage(chatId, 'Elegí una categoría:', {
      reply_markup: inline
    });
  } catch (err) {
    console.error('Error al mostrar categorías:', err);
    await bot.sendMessage(chatId, 'Hubo un problema al cargar el catálogo. Probá de nuevo en unos segundos 🙏');
  }
}

async function mostrarProductosPorCategoria(chatId, categoria) {
  try {
    const catData = await fetchCatalog();
    const items = catData.items.filter(
      it => (it.categoria || 'General') === categoria
    );

    if (!items.length) {
      await bot.sendMessage(chatId, 'No encontré productos en esta categoría todavía.');
      return;
    }

    for (const it of items) {
      const precio = it.precio || 0;
      const unidad = (it.unidad || '').toLowerCase();
      let textoUnidad = '';

      if (unidad === 'kg') {
        textoUnidad = 'Precio por kilo. Te vamos a pedir los gramos que querés.';
      } else if (unidad === 'unidad') {
        textoUnidad = 'Precio por unidad.';
      } else {
        textoUnidad = '';
      }

      const caption =
        '🛍 *' + it.nombre + '*\n' +
        '🔖 Código: `' + (it.codigo || '-') + '` \n' +
        '💰 Precio: ' + precio + ' ARS\n' +
        (textoUnidad ? '📦 ' + textoUnidad + '\n\n' : '\n') +
        (it.descripcion || '');

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🛍 Comprar', callback_data: 'buy:' + it.codigo },
            { text: '📤 Compartir promo', callback_data: 'sharepromo:' + it.codigo }
          ]
        ]
      };

      const img = it.imagenUrl || LOGO_URL;

      await bot.sendPhoto(chatId, img, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }

    await bot.sendMessage(
      chatId,
      'Si querés seguir mirando productos, volvé a tocar *Catálogo*. Cuando ya tengas elegidos, mirá *Mi carrito* para confirmar tu pedido 🧺',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error al mostrar productos:', err);
    await bot.sendMessage(chatId, 'Hubo un problema al cargar el catálogo. Probá de nuevo en unos segundos 🙏');
  }
}

function getCart(chatId) {
  if (!carts[chatId]) {
    carts[chatId] = [];
  }
  return carts[chatId];
}

async function mostrarCarrito(chatId) {
  const cart = getCart(chatId);

  if (!cart.length) {
    await bot.sendMessage(chatId, 'Tu carrito está vacío por ahora. Entrá a *Catálogo* para agregar productos 🛍', {
      parse_mode: 'Markdown'
    });
    return;
  }

  let texto = '🧺 *Tu carrito*\n\n';
  let total = 0;

  cart.forEach((item, idx) => {
    total += item.subtotal;
    texto +=
      (idx + 1) +
      ') ' +
      item.nombre +
      ' – ' +
      item.subtotal +
      ' ARS\n';
  });

  texto += '\nTotal: *' + total + ' ARS*';

  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ Confirmar pedido', callback_data: 'confirmar_pedido' }],
      [{ text: '🗑 Vaciar carrito', callback_data: 'vaciar_carrito' }]
    ]
  };

  await bot.sendMessage(chatId, texto, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

async function pedirCantidad(chatId, producto) {
  const unidad = (producto.unidad || '').toLowerCase();

  pendingQty[chatId] = producto;

  if (unidad === 'kg') {
    await bot.sendMessage(
      chatId,
      '¿Cuántos *gramos* de ' + producto.nombre + ' querés? (ejemplo: 250, 500, 750...)',
      { parse_mode: 'Markdown' }
    );
  } else {
    await bot.sendMessage(
      chatId,
      '¿Cuántas *unidades* de ' + producto.nombre + ' querés? (ejemplo: 1, 2, 3...)',
      { parse_mode: 'Markdown' }
    );
  }
}

async function procesarCantidad(chatId, texto) {
  const producto = pendingQty[chatId];
  if (!producto) return;

  const numero = parseInt(texto, 10);
  if (isNaN(numero) || numero <= 0) {
    await bot.sendMessage(chatId, 'Decime un número válido, por favor 🙂');
    return;
  }

  const unidad = (producto.unidad || '').toLowerCase();
  let subtotal = 0;

  if (unidad === 'kg') {
    if (numero < 100) {
      await bot.sendMessage(chatId, 'Para productos al corte, el mínimo es 100 gramos.');
      return;
    }
    subtotal = Math.round((producto.precio || 0) * (numero / 1000));
  } else {
    subtotal = (producto.precio || 0) * numero;
  }

  const cart = getCart(chatId);
  cart.push({
    codigo: producto.codigo,
    nombre: producto.nombre,
    cantidad: numero,
    unidad: unidad === 'kg' ? 'g' : 'u',
    subtotal: subtotal
  });

  delete pendingQty[chatId];

  let msg = '';
  if (unidad === 'kg') {
    msg =
      '🛒 Agregué *' +
      numero +
      ' g* de *' +
      producto.nombre +
      '*\n' +
      'Subtotal: *' +
      subtotal +
      ' ARS*';
  } else {
    msg =
      '🛒 Agregué *' +
      numero +
      ' un.* de *' +
      producto.nombre +
      '*\n' +
      'Subtotal: *' +
      subtotal +
      ' ARS*';
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  await mostrarCarrito(chatId);
}

async function confirmarPedido(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    await bot.sendMessage(chatId, 'Tu carrito está vacío. Agregá algo desde *Catálogo* primero 🧀', {
      parse_mode: 'Markdown'
    });
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🏬 Retiro en local', callback_data: 'tipo_entrega:local' }],
      [{ text: '🚚 Envío a domicilio', callback_data: 'tipo_entrega:envio' }]
    ]
  };

  await bot.sendMessage(chatId, '¿Cómo querés recibir tu pedido?', {
    reply_markup: keyboard
  });
}

async function finalizarPedido(chatId, tipoEntrega) {
  const cart = getCart(chatId);
  if (!cart.length) return;

  let total = 0;
  let detalle = '';

  cart.forEach((item, idx) => {
    total += item.subtotal;
    detalle +=
      (idx + 1) +
      ') ' +
      item.nombre +
      ' – ' +
      item.subtotal +
      ' ARS\n';
  });

  const tipoTexto = tipoEntrega === 'envio' ? 'Envío a domicilio' : 'Retiro en local';

  const resumenCliente =
    '🎉 *Pedido confirmado*\n\n' +
    'Tipo: *' +
    tipoTexto +
    '*\n' +
    'Total estimado: *' +
    total +
    ' ARS*\n\n' +
    'El vendedor va a revisar tu pedido y te va a escribir para confirmar el total final, forma de pago y horario de entrega.\n\n' +
    'Detalle:\n' +
    detalle;

  await bot.sendMessage(chatId, resumenCliente, { parse_mode: 'Markdown' });

  const resumenVendedor =
    '🧾 *Nuevo pedido desde el bot*\n\n' +
    'Cliente chatId: `' +
    chatId +
    '`\n' +
    'Tipo de entrega: *' +
    tipoTexto +
    '*\n' +
    'Total estimado: *' +
    total +
    ' ARS*\n\n' +
    'Detalle:\n' +
    detalle;

  await bot.sendMessage(VENDEDOR_CHAT_ID, resumenVendedor, {
    parse_mode: 'Markdown'
  });

  carts[chatId] = [];
}

// =======================
//   COMPARTIR PROMO
// =======================

async function compartirPromo(chatId, codigo) {
  const producto = productsByCode[codigo];
  if (!producto) {
    await bot.sendMessage(chatId, 'No encontré esa promo. Probá de nuevo desde el catálogo.');
    return;
  }

  const texto =
    '📣 *Promo de ' +
    NEGOCIO.nombre +
    '*\n\n' +
    '🛍 ' +
    producto.nombre +
    '\n' +
    '💰 ' +
    (producto.precio || 0) +
    ' ARS\n\n' +
    'Podés hacer tu pedido directo desde el bot:\n' +
    '👉 https://t.me/Ezer_IA_Bot';

  await bot.sendMessage(chatId, 'Copiá y compartí este mensaje con quien quieras:\n\n' + texto, {
    parse_mode: 'Markdown'
  });
}

// =======================
//   MANEJO DE MENSAJES
// =======================

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (pendingQty[chatId]) {
    await procesarCantidad(chatId, text);
    return;
  }

  const lower = text.toLowerCase();

  if (
    text === '/start' ||
    text === '/menu' ||
    lower === 'hola' ||
    lower === 'buenas' ||
    lower.includes('menu')
  ) {
    await sendBienvenida(chatId, msg.from.first_name);
    return;
  }

  if (text === '🛍 Catálogo') {
    await mostrarCategorias(chatId);
    return;
  }

  if (text === '🛒 Mi carrito') {
    await mostrarCarrito(chatId);
    return;
  }

  if (text === '🏆 Mis sellos') {
    await mostrarMisSellos(chatId, msg.from.first_name);
    return;
  }

  if (text === '💬 Hablar con el vendedor') {
    await mostrarHablarVendedor(chatId);
    return;
  }

  if (text === '🏬 Información del local') {
    await mostrarInfoLocal(chatId);
    return;
  }

  if (text === '📣 Compartir el bot') {
    await mostrarCompartirBot(chatId);
    return;
  }

  await sendBienvenida(chatId, msg.from.first_name);
});

// =======================
//   MANEJO DE CALLBACKS
// =======================

bot.on('callback_query', async query => {
  try {
    const data = query.data || '';
    const chatId = query.message.chat.id;

    if (data.startsWith('cat:')) {
      const cat = data.split(':')[1];
      await mostrarProductosPorCategoria(chatId, cat);
    } else if (data.startsWith('buy:')) {
      const code = data.split(':')[1];
      const producto = productsByCode[code];
      if (!producto) {
        await bot.sendMessage(chatId, 'No encontré ese producto. Volvé a entrar al catálogo.');
      } else {
        await pedirCantidad(chatId, producto);
      }
    } else if (data.startsWith('sharepromo:')) {
      const code = data.split(':')[1];
      await compartirPromo(chatId, code);
    } else if (data === 'confirmar_pedido') {
      await confirmarPedido(chatId);
    } else if (data === 'vaciar_carrito') {
      carts[chatId] = [];
      await bot.sendMessage(chatId, 'Vacié tu carrito. Podés volver a agregar productos desde el catálogo 🧺');
    } else if (data.startsWith('tipo_entrega:')) {
      const tipo = data.split(':')[1];
      await finalizarPedido(chatId, tipo);
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Error en callback_query:', err);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Ocurrió un error, probá de nuevo.' });
    } catch (e) {}
  }
});
