// index.js - EzerBot System (Todo Queso)
// Bot de Telegram + backend Render conectado a Apps Script (Sheets)

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =======================
//   VARIABLES DE ENTORNO
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL; // URL del Apps Script (exec)
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !SHEETS_URL) {
  console.error('❌ Falta BOT_TOKEN o SHEETS_URL en variables de entorno');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =======================
//   ESTADO EN MEMORIA
// =======================

// Carritos por chatId
// carts[chatId] = { items: [...], total: 0, estado: 'normal'|'esperando_cantidad'|'esperando_entrega', itemPendiente: {...} }
const carts = {};

// Pequeño cache de config (para no llamar a Sheets en cada mensaje)
let cachedConfig = null;
let configTimestamp = 0;
const CONFIG_TTL_MS = 3 * 60 * 1000; // 3 minutos

// =======================
//   HELPERS GENERALES
// =======================

async function getConfig() {
  const now = Date.now();
  if (cachedConfig && now - configTimestamp < CONFIG_TTL_MS) {
    return cachedConfig;
  }
  const url = `${SHEETS_URL}?accion=config`;
  const res = await axios.get(url);
  cachedConfig = res.data || {};
  configTimestamp = now;
  return cachedConfig;
}

async function getCatalog() {
  const url = `${SHEETS_URL}?accion=catalogo`;
  const res = await axios.get(url);
  return res.data || { items: [], moneda: 'ARS' };
}

async function getClienteEstado(chatId) {
  const url = `${SHEETS_URL}?accion=estadoCliente&chatId=${encodeURIComponent(
    chatId
  )}`;
  const res = await axios.get(url);
  return res.data || {};
}

function getCart(chatId) {
  if (!carts[chatId]) {
    carts[chatId] = {
      items: [],
      total: 0,
      estado: 'normal',
      itemPendiente: null
    };
  }
  return carts[chatId];
}

function resetCart(chatId) {
  carts[chatId] = {
    items: [],
    total: 0,
    estado: 'normal',
    itemPendiente: null
  };
}

// =======================
//   HELPERS TELEGRAM
// =======================

async function sendMessage(chatId, text, extra = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...extra
    });
  } catch (err) {
    console.error('Error sendMessage:', err.response?.data || err.message);
  }
}

async function sendPhoto(chatId, photoUrl, caption, extra = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
      ...extra
    });
  } catch (err) {
    console.error('Error sendPhoto:', err.response?.data || err.message);
  }
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [
          { text: '🛒 Ver catálogo' },
          { text: '📋 Catálogo rápido' }
        ],
        [
          { text: '👜 Mi carrito' },
          { text: '🏆 Mi tarjeta de sellos' }
        ],
        [
          { text: '💬 Hablar con el vendedor' },
          { text: '🏬 Información del local' }
        ],
        [
          { text: '🎁 Compartir promos y bot' }
        ]
      ],
      resize_keyboard: true
    }
  };
}

// =======================
//   FLUJOS PRINCIPALES
// =======================

async function sendBienvenida(chatId, firstName) {
  const cfg = await getConfig();
  const nombreNegocio = cfg.NegocioNombre || 'Tu comercio favorito';
  const logoUrl =
    cfg.LogoURL || // si la agregás en Config
    'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg'; // fallback (podés cambiar)

  // 1) Logo
  await sendPhoto(
    chatId,
    logoUrl,
    `<b>${nombreNegocio}</b>\n\nBienvenid@ ${firstName || ''} 🧀`
  );

  // 2) Presentación persuasiva
  const texto =
    `<b>${nombreNegocio}</b>\n` +
    `🧀 Picadas, quesos, pan fresco y mucho más.\n\n` +
    `Con este bot podés:\n` +
    `• Ver el catálogo y elegir tus productos\n` +
    `• Armar tu carrito y confirmar el pedido\n` +
    `• Ver tu tarjeta de sellos y beneficios\n` +
    `• Hablar directo con el vendedor\n\n` +
    `Escribí el <b>CÓDIGO</b> de un producto o tocá un botón de abajo para empezar.`;

  await sendMessage(chatId, texto, mainMenuKeyboard());
}

async function handleVerCatalogoInstagram(chatId) {
  const { items, moneda } = await getCatalog();
  if (!items || !items.length) {
    await sendMessage(
      chatId,
      'Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀',
      mainMenuKeyboard()
    );
    return;
  }

  for (const p of items) {
    const nombre = p.nombre || 'Producto';
    const precio = p.precio || 0;
    const codigo = p.codigo || '';
    const desc = p.descripcion || '';
    const img = p.imagenUrl || '';

    const caption =
      `<b>${nombre}</b>\n` +
      (codigo ? `🧾 Código: <code>${codigo}</code>\n` : '') +
      `💰 Precio: <b>${precio} ${moneda || 'ARS'}</b>\n\n` +
      (desc ? `${desc}\n\n` : '') +
      `Si querés comprarlo, escribí el código <b>${codigo}</b> o tocá "📋 Catálogo rápido" para ver la lista completa.`;

    if (img) {
      await sendPhoto(chatId, img, caption, mainMenuKeyboard());
    } else {
      await sendMessage(chatId, caption, mainMenuKeyboard());
    }
  }

  await sendMessage(
    chatId,
    'Cuando quieras comprar algo, escribí el <b>CÓDIGO</b> del producto y te ayudo a sumarlo al carrito 🛒',
    mainMenuKeyboard()
  );
}

async function handleCatalogoRapido(chatId) {
  const { items, moneda } = await getCatalog();
  if (!items || !items.length) {
    await sendMessage(
      chatId,
      'Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀',
      mainMenuKeyboard()
    );
    return;
  }

  let texto = `<b>📋 Catálogo rápido</b>\n(Usá el <b>CÓDIGO</b> para comprar)\n\n`;

  for (const p of items) {
    const codigo = p.codigo || '—';
    const nombre = p.nombre || 'Producto';
    const unidad = p.unidad === 'kg' ? 'kg' : 'un';
    const precio = p.precio || 0;

    texto += `• <code>${codigo}</code> – ${nombre} (${unidad}) – ${precio} ${
      moneda || 'ARS'
    }\n`;
  }

  texto +=
    `\nEscribí el <b>CÓDIGO</b> del producto que quieras ver en detalle o agregar al carrito.`;

  await sendMessage(chatId, texto, mainMenuKeyboard());
}

async function handleInfoLocal(chatId) {
  const cfg = await getConfig();
  const nombre = cfg.NegocioNombre || 'Todo Queso';
  const dir = cfg.Direccion || '';
  const horarios = cfg.Horarios || '';
  const tel = cfg.TelefonoNegocio || '';
  const ig = cfg.Instagram || '';
  const logoUrl =
    cfg.LogoURL ||
    'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg';

  const texto =
    `🏬 <b>${nombre}</b>\n\n` +
    (dir ? `📍 <b>Dirección:</b> ${dir}\n` : '') +
    (horarios ? `⏰ <b>Horarios:</b> ${horarios}\n` : '') +
    (tel ? `📞 <b>Teléfono:</b> ${tel}\n` : '') +
    (ig ? `📸 <b>Instagram:</b> ${ig}\n` : '') +
    `\nGracias por ser parte de ${nombre} 🧀`;

  await sendPhoto(chatId, logoUrl, texto, mainMenuKeyboard());
}

async function handleHablarVendedor(chatId) {
  const cfg = await getConfig();
  const wspLink = cfg.WhatsAppLink || '';
  const tel = cfg.TelefonoNegocio || '';

  let texto =
    '💬 <b>Hablar con el vendedor</b>\n\n' +
    'Si necesitás ayuda con tu pedido, stock o promociones, podés escribirle directamente al vendedor.\n\n';

  if (wspLink) {
    texto += `👉 Tocá este enlace para abrir WhatsApp:\n${wspLink}\n\n`;
  } else if (tel) {
    texto += `📞 Podés escribir al WhatsApp: <b>${tel}</b>\n\n`;
  }

  texto += 'Mientras tanto, si querés, seguí armando tu carrito desde acá 🛒';

  await sendMessage(chatId, texto, mainMenuKeyboard());
}

async function handleCompartirPromos(chatId) {
  const cfg = await getConfig();
  const nombre = cfg.NegocioNombre || 'Todo Queso Club';
  const botUser =
    cfg.BotUsername || 'tu_bot_aqui'; // si querés lo agregás en Config
  const bonusSellos = cfg.BonusSellosShare || 0;

  let texto =
    `🎁 <b>Compartir promos y el bot</b>\n\n` +
    `Si te gusta ${nombre}, ayudanos compartiendo este bot con tus amigos.\n\n` +
    `Podés reenviar este mensaje o pasarles este enlace:\n` +
    `👉 https://t.me/${botUser}\n\n`;

  if (bonusSellos > 0) {
    texto += `Cada amigo que compre gracias a vos puede darte sellos extra 🧀 (configurable para cada comercio).\n\n`;
  }

  texto += 'Gracias por ayudarnos a hacer crecer el club 🧡';

  await sendMessage(chatId, texto, mainMenuKeyboard());
}

async function handleTarjetaSellos(chatId) {
  const cfg = await getConfig();
  const estado = await getClienteEstado(chatId);

  if (!estado || estado.tieneTarjeta === false) {
    const txt =
      '🔔 <b>No encontré tu tarjeta de sellos todavía.</b>\n\n' +
      'Pedí en el local que te registren con tu nombre y teléfono para empezar a sumar sellos con cada compra 🧀';
    await sendMessage(chatId, txt, mainMenuKeyboard());
    return;
  }

  const nombre = estado.nombreCliente || 'Cliente';
  const sellosAct = estado.sellosActuales || 0;
  const sellosNivel = estado.sellosNivelActual || 10;
  const nivel = estado.nivelActual || 'Nivel 1';
  const beneficio = estado.beneficioProximo || '';
  const benefDisp = estado.beneficioDisponible;
  const vence = estado.venceEl || '';
  const tarjetaUrl =
    estado.tarjetaImagenUrl || cfg.TarjetaURL || '';

  let txt =
    `🏆 <b>Tarjeta de sellos de ${nombre}</b>\n\n` +
    `• Nivel actual: <b>${nivel}</b>\n` +
    `• Sellos en este nivel: <b>${sellosAct}/${sellosNivel}</b>\n`;

  if (beneficio) {
    txt += `• Próximo beneficio: ${beneficio}\n`;
  }

  if (benefDisp) {
    txt += `\n🎁 <b>Tenés un beneficio listo para canjear.</b>\n`;
    if (vence) {
      txt += `⏰ Vence el: <b>${vence}</b>\n`;
    }
    txt +=
      '\nMostrá este mensaje en el local para canjearlo o consultá al vendedor en WhatsApp.';
  } else {
    txt +=
      '\nSeguí sumando sellos con cada compra y pronto vas a desbloquear un beneficio 🎁';
  }

  if (tarjetaUrl) {
    await sendPhoto(chatId, tarjetaUrl, txt, mainMenuKeyboard());
  } else {
    await sendMessage(chatId, txt, mainMenuKeyboard());
  }
}

async function mostrarCarrito(chatId) {
  const cart = getCart(chatId);
  if (!cart.items.length) {
    await sendMessage(
      chatId,
      '👜 Tu carrito está vacío.\n\nUsá <b>🛒 Ver catálogo</b> o escribí el código de un producto para empezar a cargar tu pedido.',
      mainMenuKeyboard()
    );
    return;
  }

  let texto = '🛍 <b>Tu carrito</b>\n\n';
  cart.items.forEach((item, idx) => {
    texto += `${idx + 1}) ${item.nombre} – ${item.subtotal} ARS\n`;
  });
  texto += `\nTotal: <b>${cart.total} ARS</b>`;

  await sendMessage(chatId, texto, {
    reply_markup: {
      keyboard: [
        [{ text: '✅ Confirmar pedido' }, { text: '🗑 Vaciar carrito' }],
        [
          { text: '🛒 Ver catálogo' },
          { text: '📋 Catálogo rápido' }
        ],
        [
          { text: '👜 Mi carrito' },
          { text: '🏆 Mi tarjeta de sellos' }
        ],
        [
          { text: '💬 Hablar con el vendedor' },
          { text: '🏬 Información del local' }
        ],
        [{ text: '🎁 Compartir promos y bot' }]
      ],
      resize_keyboard: true
    }
  });
}

async function iniciarCheckout(chatId) {
  const cart = getCart(chatId);
  if (!cart.items.length) {
    await sendMessage(
      chatId,
      'Tu carrito está vacío. Agregá al menos un producto antes de confirmar el pedido 🧀',
      mainMenuKeyboard()
    );
    return;
  }

  cart.estado = 'esperando_entrega';

  await sendMessage(
    chatId,
    '📦 ¿Cómo querés recibir tu pedido?',
    {
      reply_markup: {
        keyboard: [
          [{ text: '🏪 Retiro en local' }, { text: '🚚 Envío a domicilio' }],
          [{ text: '👜 Mi carrito' }],
          [{ text: 'Cancelar pedido' }]
        ],
        resize_keyboard: true
      }
    }
  );
}

async function finalizarPedido(chatId, tipoEntrega) {
  const cfg = await getConfig();
  const cart = getCart(chatId);

  const total = cart.total;
  const nombreNegocio = cfg.NegocioNombre || 'Todo Queso';
  const alias = cfg.AliasPago || cfg.AliasPago.toLowerCase || '';
  const moneda = cfg.Moneda || 'ARS';
  const wspLink = cfg.WhatsAppLink || '';
  const msgPost = cfg.MensajePostCompra || '';

  let texto =
    '🎉 <b>Pedido confirmado (pendiente de pago)</b>\n\n' +
    `Tipo: <b>${tipoEntrega}</b>\n` +
    `Total: <b>${total} ${moneda}</b>\n\n` +
    `💛 Para que podamos preparar tu pedido, necesitamos que realices el pago por transferencia.\n\n`;

  if (alias) {
    texto += `🔐 <b>Alias de pago:</b> <code>${alias}</code>\n\n`;
  }

  texto +=
    '📸 Después de pagar, enviá <b>la captura o comprobante</b> en este mismo chat.\n' +
    'En cuanto el vendedor lo valide, tu pedido entra a preparación.\n\n';

  if (wspLink) {
    texto += `Si preferís hablar directo con el vendedor, usá este enlace de WhatsApp:\n${wspLink}\n\n`;
  }

  if (msgPost) {
    texto += `${msgPost}\n\n`;
  }

  texto += `Gracias por elegir <b>${nombreNegocio}</b> 🧀`;

  await sendMessage(chatId, texto, mainMenuKeyboard());

  // dejamos el carrito, pero estado vuelve a normal
  cart.estado = 'normal';
}

// =======================
//   MANEJO DE CODIGO PRODUCTO
// =======================

async function handleCodigoProducto(chatId, codigoIngresado) {
  const { items, moneda } = await getCatalog();
  const codigoBuscado = codigoIngresado.trim().toUpperCase();

  const producto = items.find(
    (p) => (p.codigo || '').toUpperCase() === codigoBuscado
  );

  if (!producto) {
    await sendMessage(
      chatId,
      `😕 No encontré el producto con código <b>${codigoBuscado}</b>.\nProbá revisar el <b>📋 Catálogo rápido</b> y volver a escribir el código.`,
      mainMenuKeyboard()
    );
    return;
  }

  const img = producto.imagenUrl || '';
  const nombre = producto.nombre || 'Producto';
  const precio = producto.precio || 0;
  const unidad = producto.unidad || 'unidad';
  const desc = producto.descripcion || '';

  let caption =
    `🧾 <b>${nombre}</b>\n` +
    `Código: <code>${codigoBuscado}</code>\n` +
    `Precio: <b>${precio} ${moneda || 'ARS'}</b>\n` +
    `Unidad de venta: <b>${unidad === 'kg' ? 'por kilo (gramos)' : 'por unidad'}</b>\n\n` +
    (desc ? `${desc}\n\n` : '') +
    `¿Querés agregarlo al carrito?`;

  const cart = getCart(chatId);
  cart.itemPendiente = {
    codigo: codigoBuscado,
    nombre,
    precio,
    unidad
  };
  cart.estado = 'confirmar_agregado';

  const extraKeyboard = {
    reply_markup: {
      keyboard: [
        [{ text: '✅ Sí, agregar al carrito' }, { text: '❌ No, otro producto' }],
        [{ text: '📋 Catálogo rápido' }, { text: '🛒 Ver catálogo' }],
        [{ text: '👜 Mi carrito' }]
      ],
      resize_keyboard: true
    }
  };

  if (img) {
    await sendPhoto(chatId, img, caption, extraKeyboard);
  } else {
    await sendMessage(chatId, caption, extraKeyboard);
  }
}

async function handleConfirmarAgregar(chatId, respuesta) {
  const cart = getCart(chatId);
  const itemPend = cart.itemPendiente;

  if (!itemPend) {
    cart.estado = 'normal';
    await sendMessage(
      chatId,
      'No tengo ningún producto pendiente de agregar. Escribí un código de producto o usá el catálogo para elegir 🧀',
      mainMenuKeyboard()
    );
    return;
  }

  const respLower = respuesta.toLowerCase();

  if (respLower.includes('no')) {
    cart.itemPendiente = null;
    cart.estado = 'normal';
    await sendMessage(
      chatId,
      'Perfecto, no agregué este producto. Podés elegir otro del catálogo o escribir otro código 🙂',
      mainMenuKeyboard()
    );
    return;
  }

  // Sí, quiere agregar → pedir cantidad (unidades o gramos)
  if (itemPend.unidad === 'kg') {
    cart.estado = 'esperando_cantidad';
    await sendMessage(
      chatId,
      `¿Cuántos <b>gramos</b> de ${itemPend.nombre} querés? (mínimo 100 g)\nEjemplo: 250, 500, 1000...`,
      mainMenuKeyboard()
    );
  } else {
    cart.estado = 'esperando_cantidad';
    await sendMessage(
      chatId,
      `¿Cuántas <b>unidades</b> de ${itemPend.nombre} querés?\nEjemplo: 1, 2, 3...`,
      mainMenuKeyboard()
    );
  }
}

async function handleCantidad(chatId, texto) {
  const cart = getCart(chatId);
  const itemPend = cart.itemPendiente;
  if (!itemPend) {
    cart.estado = 'normal';
    await sendMessage(
      chatId,
      'No tengo ningún producto pendiente de cantidad. Escribí un código de producto o usá el catálogo 🧀',
      mainMenuKeyboard()
    );
    return;
  }

  const cantidadNum = Number(texto.replace(',', '.'));
  if (!cantidadNum || cantidadNum <= 0) {
    await sendMessage(
      chatId,
      'Necesito un número válido. Probá de nuevo 🙂',
      mainMenuKeyboard()
    );
    return;
  }

  let detalleCantidad = '';
  let subtotal = 0;

  if (itemPend.unidad === 'kg') {
    if (cantidadNum < 100) {
      await sendMessage(
        chatId,
        'Para productos por peso el mínimo es 100 g. Probá con 100, 250, 500, 1000...',
        mainMenuKeyboard()
      );
      return;
    }
    const precioPorKg = itemPend.precio; // precio base por kilo
    const kilos = cantidadNum / 1000;
    subtotal = Math.round(precioPorKg * kilos);
    detalleCantidad = `${cantidadNum} g`;
  } else {
    subtotal = itemPend.precio * cantidadNum;
    detalleCantidad = `${cantidadNum} un.`;
  }

  const itemCarrito = {
    codigo: itemPend.codigo,
    nombre: itemPend.nombre,
    cantidadTexto: detalleCantidad,
    subtotal
  };

  cart.items.push(itemCarrito);
  cart.total += subtotal;
  cart.estado = 'normal';
  cart.itemPendiente = null;

  await sendMessage(
    chatId,
    `🧺 Agregué <b>${detalleCantidad}</b> de <b>${itemCarrito.nombre}</b>.\nSubtotal: <b>${subtotal} ARS</b>\n\nPodés seguir agregando productos o ver tu carrito con "👜 Mi carrito".`,
    mainMenuKeyboard()
  );
}

// =======================
//   MANEJO DEL WEBHOOK
// =======================

app.post('/webhooks/telegram', async (req, res) => {
  res.sendStatus(200); // respondemos rápido a Telegram

  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const firstName = msg.chat.first_name || '';
      const text = (msg.text || '').trim();

      // manejo de estados
      const cart = getCart(chatId);
      const estado = cart.estado;

      // Cualquier primer mensaje / hola / texto → bienvenida
      const lower = text.toLowerCase();

      const esSaludo =
        lower === '/start' ||
        lower === 'start' ||
        lower === 'hola' ||
        lower === 'buenas' ||
        lower === 'menu' ||
        lower === 'menú' ||
        lower === 'quiero comprar';

      if (esSaludo) {
        await sendBienvenida(chatId, firstName);
        return;
      }

      // si está esperando cantidad
      if (estado === 'esperando_cantidad') {
        await handleCantidad(chatId, text);
        return;
      }

      // si está esperando confirmación de agregado
      if (estado === 'confirmar_agregado') {
        await handleConfirmarAgregar(chatId, text);
        return;
      }

      // si está en checkout (tipo de entrega)
      if (estado === 'esperando_entrega') {
        if (lower.includes('retiro')) {
          await finalizarPedido(chatId, 'Retiro en local');
          return;
        } else if (lower.includes('envío') || lower.includes('envio')) {
          await finalizarPedido(chatId, 'Envío a domicilio');
          return;
        } else if (lower.includes('cancelar')) {
          cart.estado = 'normal';
          await sendMessage(
            chatId,
            'Cancelé el proceso de confirmación. Tu carrito sigue guardado 🧺',
            mainMenuKeyboard()
          );
          return;
        } else {
          await sendMessage(
            chatId,
            'Elegí una opción: <b>Retiro en local</b> o <b>Envío a domicilio</b>.',
            mainMenuKeyboard()
          );
          return;
        }
      }

      // ---- MENÚ PRINCIPAL POR TEXTO / BOTONES ----

      if (lower.startsWith('🛒 ver catálogo') || lower === 'ver catálogo') {
        await handleVerCatalogoInstagram(chatId);
        return;
      }

      if (
        lower.startsWith('📋 catálogo rápido') ||
        lower === 'catalogo rapido' ||
        lower === 'catálogo rápido'
      ) {
        await handleCatalogoRapido(chatId);
        return;
      }

      if (lower.startsWith('👜 mi carrito') || lower === 'mi carrito') {
        await mostrarCarrito(chatId);
        return;
      }

      if (
        lower.startsWith('🏆 mi tarjeta de sellos') ||
        lower.includes('mis sellos') ||
        lower.includes('mi tarjeta')
      ) {
        await handleTarjetaSellos(chatId);
        return;
      }

      if (
        lower.startsWith('💬 hablar con el vendedor') ||
        lower.includes('hablar con el vendedor')
      ) {
        await handleHablarVendedor(chatId);
        return;
      }

      if (
        lower.startsWith('🏬 información del local') ||
        lower.includes('información del local')
      ) {
        await handleInfoLocal(chatId);
        return;
      }

      if (
        lower.startsWith('🎁 compartir promos') ||
        lower.includes('compartir promos') ||
        lower.includes('compartir bot')
      ) {
        await handleCompartirPromos(chatId);
        return;
      }

      if (lower.includes('vaciar carrito')) {
        resetCart(chatId);
        await sendMessage(
          chatId,
          'Vacié tu carrito. Podés empezar de nuevo desde el catálogo 🧀',
          mainMenuKeyboard()
        );
        return;
      }

      if (lower.includes('confirmar pedido')) {
        await iniciarCheckout(chatId);
        return;
      }

      // Si el texto parece un código de producto (ej. TQ01, tq02, etc)
      if (/^[a-zA-Z]{2,5}\d{1,4}$/.test(text.replace(/\s+/g, ''))) {
        await handleCodigoProducto(chatId, text.replace(/\s+/g, '').toUpperCase());
        return;
      }

      // Si no matchea nada → mostrar bienvenida + menú
      await sendBienvenida(chatId, firstName);
    }
  } catch (err) {
    console.error('Error manejando update:', err.response?.data || err.message);
  }
});

app.get('/', (req, res) => {
  res.send('EzerBot backend activo ✅');
});

app.listen(PORT, () => {
  console.log(`EzerBot escuchando en puerto ${PORT}`);
});
