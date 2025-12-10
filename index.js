// index.js
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- CACHES SENCILLAS PARA QUE RESPONDA MÁS RÁPIDO ---
let configCache = null;
let catalogCache = null;

async function loadConfig() {
  if (configCache) return configCache;
  const res = await axios.get(`${SHEETS_URL}?accion=config`);
  configCache = res.data || {};
  return configCache;
}

async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const res = await axios.get(`${SHEETS_URL}?accion=catalogo`);
  catalogCache = (res.data && res.data.items) || [];
  return catalogCache;
}

// --- SESIONES EN MEMORIA ---
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      mode: 'IDLE',
      cart: [],
      pendingProduct: null
    };
  }
  return sessions[chatId];
}

// --- UTILIDADES TELEGRAM ---
async function sendMessage(chatId, text, extra = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  }).catch(console.error);
}

async function sendPhoto(chatId, photoUrl, caption, extra = {}) {
  return axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...extra
  }).catch(console.error);
}

async function answerCallbackQuery(id, text) {
  if (!id) return;
  return axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: id,
    text,
    show_alert: false
  }).catch(console.error);
}

// --- MENÚ PRINCIPAL ---
async function sendMainMenu(chatId) {
  const keyboard = {
    keyboard: [
      [{ text: '🛒 Ver catálogo' }, { text: '🗂️ Catálogo rápido' }],
      [{ text: '🛍️ Mi carrito' }, { text: '🏆 Mis sellos y puntos' }],
      [{ text: '🏬 Información del local' }]
    ],
    resize_keyboard: true
  };
  await sendMessage(chatId, 'Elegí una opción del menú 👇', {
    reply_markup: keyboard
  });
}

async function sendWelcome(chatId) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || 'Tu negocio';
  const desc = cfg.Descripcion || '';
  await sendMessage(
    chatId,
    `🧀 Bienvenido/a a <b>${nombre}</b>\n\n${desc}\n\nUsá los botones de abajo para ver el catálogo, tu carrito o la info del local.`
  );
  await sendMainMenu(chatId);
}

// --- INFO DEL LOCAL ---
async function sendInfoLocal(chatId) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || 'Negocio';
  const direccion = cfg.Direccion || '—';
  const horarios = cfg.Horarios || '—';
  const telefono = cfg.TelefonoNegocio || '';
  const insta = cfg.Instagram || '';
  const logo = cfg.SelloURL || cfg.TarjetaURL || '';

  const texto =
    `🏬 <b>${nombre}</b>\n\n` +
    `📍 <b>Dirección:</b> ${direccion}\n` +
    `🕒 <b>Horarios:</b> ${horarios}\n` +
    (telefono ? `📞 <b>Teléfono:</b> ${telefono}\n` : '') +
    (insta ? `📸 <b>Instagram:</b> ${insta}\n` : '') +
    `\nGracias por ser parte de ${nombre} 🧀`;

  if (logo) {
    await sendPhoto(chatId, logo, texto);
  } else {
    await sendMessage(chatId, texto);
  }
}

// --- CATÁLOGO COMPLETO (CON FOTOS) ---
async function sendCatalogoCompleto(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const catalog = await loadCatalog();

  if (!catalog.length) {
    await sendMessage(chatId, 'Por ahora el catálogo no tiene productos cargados 🧀');
    return;
  }

  await sendMessage(
    chatId,
    'Te muestro algunos productos. Para comprar uno, escribí el <b>código</b> (por ej. TQ01).'
  );

  for (const item of catalog) {
    const codigo = item.codigo || item.CODIGO || '';
    const nombre = item.nombre || item.NOMBRE || '';
    const precio = item.precio || item.PRECIO || '';
    const descripcion = item.descripcion || item.DESCRIPCION || '';
    const imagen = item.imagenUrl || item.IMAGEN || '';

    let caption =
      `🛒 <b>${nombre}</b>\n` +
      `💰 <b>Precio:</b> ${precio} ${moneda}\n` +
      (codigo ? `🔢 <b>Código:</b> ${codigo}\n` : '') +
      (descripcion ? `\n${descripcion}` : '') +
      (codigo ? `\n\nPara comprar este producto escribí el código <b>${codigo}</b>.` : '');

    if (imagen) {
      await sendPhoto(chatId, imagen, caption);
    } else {
      await sendMessage(chatId, caption);
    }
  }
}

// --- CATÁLOGO RÁPIDO (TABLA / LISTA) ---
async function sendCatalogoRapido(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const catalog = await loadCatalog();

  if (!catalog.length) {
    await sendMessage(chatId, 'Por ahora el catálogo no tiene productos cargados 🧀');
    return;
  }

  let texto = '<b>🗂️ Catálogo rápido</b>\n\n';
  for (const item of catalog) {
    const codigo = item.codigo || item.CODIGO || '';
    const nombre = item.nombre || item.NOMBRE || '';
    const precio = item.precio || item.PRECIO || '';
    texto += `• <b>${codigo}</b> – ${nombre} – ${precio} ${moneda}\n`;
  }

  texto += '\nPara comprar, escribí el código del producto (ej: <b>TQ01</b>).';

  await sendMessage(chatId, texto);
}

// --- ESTADO DE SELLOS / PUNTOS ---
async function sendEstadoCliente(chatId) {
  const res = await axios
    .get(`${SHEETS_URL}?accion=estadoCliente&chatId=${chatId}`)
    .catch(console.error);

  if (!res || !res.data) {
    await sendMessage(chatId, 'No pude obtener tu tarjeta en este momento. Probá de nuevo más tarde.');
    return;
  }

  const info = res.data;
  if (!info.tieneTarjeta) {
    await sendMessage(
      chatId,
      'No encontré tu tarjeta todavía. Hacé una compra en el local para empezar a sumar sellos 🧾✨'
    );
    return;
  }

  const msg =
    `🏆 <b>Mis sellos y puntos</b>\n\n` +
    `👤 Cliente: ${info.nombreCliente || ''}\n` +
    `🔘 Nivel actual: ${info.nivelActual || ''}\n` +
    `🔢 Sellos en este nivel: ${info.sellosActuales}/${info.sellosNivelActual}\n` +
    `📊 Sellos acumulados totales: ${info.sellosTotalesAcumulados}\n` +
    (info.beneficioDisponible
      ? `\n🎁 <b>Beneficio disponible:</b> ${info.descripcionBeneficio}\n` +
        (info.venceEl ? `⏰ Vence el: ${info.venceEl}\n` : '')
      : info.beneficioProximo
        ? `\n🎁 Próximo beneficio: ${info.beneficioProximo}`
        : '');

  await sendMessage(chatId, msg);
}

// --- CARRITO ---
function formatCart(session, moneda) {
  if (!session.cart.length) return 'Tu carrito está vacío 🧺';
  let texto = '🛍️ <b>Tu carrito</b>\n\n';
  session.cart.forEach((it, idx) => {
    texto += `${idx + 1}) ${it.nombre} – ${it.detalle} – ${it.subtotal} ${moneda}\n`;
  });
  texto += `\nTotal: <b>${session.cartTotal || 0} ${moneda}</b>`;
  return texto;
}

async function sendCart(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const session = getSession(chatId);

  const texto = formatCart(session, moneda);

  const keyboard = {
    keyboard: [
      [{ text: '✅ Confirmar pedido' }],
      [{ text: '🧹 Vaciar carrito' }],
      [{ text: '⬅️ Volver al menú' }]
    ],
    resize_keyboard: true
  };

  await sendMessage(chatId, texto, { reply_markup: keyboard });
}

function clearCart(session) {
  session.cart = [];
  session.cartTotal = 0;
}

// --- INICIO DE COMPRA POR CÓDIGO ---
async function startPurchaseByCode(chatId, codeRaw) {
  const code = String(codeRaw).trim().toUpperCase();
  const catalog = await loadCatalog();
  const item = catalog.find(
    (p) =>
      String(p.codigo || p.CODIGO || '').toUpperCase() === code ||
      String(p.codigobarras || p.CODIGOBARRAS || '') === code
  );

  if (!item) {
    await sendMessage(chatId, `No encontré ningún producto con código <b>${code}</b>. Revisá el catálogo rápido 🗂️`);
    return;
  }

  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';

  const nombre = item.nombre || item.NOMBRE || '';
  const precio = Number(item.precio || item.PRECIO || 0);
  const unidad = (item.unidad || item.UNIDAD || 'unidad').toLowerCase();
  const descripcion = item.descripcion || item.DESCRIPCION || '';
  const imagen = item.imagenUrl || item.IMAGEN || '';

  const session = getSession(chatId);
  session.pendingProduct = {
    codigo: code,
    nombre,
    precio,
    unidad
  };
  session.mode = 'WAITING_QUANTITY';

  const caption =
    `🛒 <b>${nombre}</b>\n` +
    `💰 <b>Precio:</b> ${precio} ${moneda} por ${unidad}\n` +
    (descripcion ? `\n${descripcion}\n` : '') +
    `\nAhora indicame la cantidad:\n` +
    (unidad === 'kg'
      ? '📏 Escribí los gramos que querés (ej: 250, 500, 1000).'
      : '🔢 Escribí cuántas unidades querés (ej: 1, 2, 3).');

  if (imagen) {
    await sendPhoto(chatId, imagen, caption);
  } else {
    await sendMessage(chatId, caption);
  }
}

// --- PROCESAR CANTIDAD ---
async function handleQuantity(chatId, text) {
  const num = parseInt(String(text).trim(), 10);
  if (isNaN(num) || num <= 0) {
    await sendMessage(chatId, 'Necesito un número válido. Probá otra vez 🙂');
    return;
  }

  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const session = getSession(chatId);
  const p = session.pendingProduct;

  if (!p) {
    session.mode = 'IDLE';
    await sendMainMenu(chatId);
    return;
  }

  let detalle = '';
  let subtotal = 0;

  if (p.unidad === 'kg') {
    // num = gramos
    const gramos = num;
    subtotal = Math.round((p.precio * gramos) / 1000);
    detalle = `${gramos} g`;
  } else {
    // unidades
    const unidades = num;
    subtotal = p.precio * unidades;
    detalle = `${unidades} un.`;
  }

  if (!session.cart) {
    session.cart = [];
    session.cartTotal = 0;
  }

  session.cart.push({
    codigo: p.codigo,
    nombre: p.nombre,
    detalle,
    subtotal
  });
  session.cartTotal = (session.cartTotal || 0) + subtotal;

  session.mode = 'IDLE';
  session.pendingProduct = null;

  await sendMessage(
    chatId,
    `🛒 Agregué <b>${detalle}</b> de <b>${p.nombre}</b>\nSubtotal: <b>${subtotal} ${moneda}</b>`
  );
  await sendMessage(chatId, 'Podés escribir otro código para seguir comprando o tocar 🛍️ Mi carrito.');
}

// --- CONFIRMAR PEDIDO Y ELEGIR ENTREGA ---
async function handleConfirmarPedido(chatId) {
  const cfg = await loadConfig();
  const session = getSession(chatId);

  if (!session.cart || !session.cart.length) {
    await sendMessage(chatId, 'Tu carrito está vacío 🧺. Primero agregá algún producto.');
    return;
  }

  session.mode = 'CHOOSING_DELIVERY';

  const opciones = [];
  if (String(cfg.UsaRetiroLocal || 'SI').toUpperCase() === 'SI') {
    opciones.push([{ text: '🏬 Retiro en local' }]);
  }
  if (String(cfg.UsaEnvioDomicilio || 'NO').toUpperCase() === 'SI') {
    opciones.push([{ text: '🚚 Envío a domicilio' }]);
  }
  opciones.push([{ text: '⬅️ Cancelar' }]);

  const keyboard = { keyboard: opciones, resize_keyboard: true };

  await sendMessage(chatId, '¿Cómo querés recibir tu pedido?', { reply_markup: keyboard });
}

async function finalizarPedido(chatId, tipo) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const session = getSession(chatId);

  const totalProductos = session.cartTotal || 0;
  let costoEnvio = 0;
  let textoExtra = '';

  if (tipo === 'ENVIO') {
    costoEnvio = Number(cfg.CostoEnvioBase || 0);
    textoExtra = cfg.TextoEnvioDomicilio || '';
  } else {
    textoExtra = cfg.TextoRetiroLocal || '';
  }

  const totalFinal = totalProductos + costoEnvio;

  // Registrar compra para sellos
  axios
    .get(`${SHEETS_URL}?accion=registrarCompra&chatId=${chatId}&monto=${totalFinal}`)
    .catch(console.error);

  // Aviso al vendedor
  if (cfg.ChatIdVendedor) {
    const detalle = formatCart(session, moneda);
    const msgV =
      `📥 Nuevo pedido desde el bot\n\n` +
      `${detalle}\n\n` +
      `Tipo: ${tipo === 'ENVIO' ? 'Envío a domicilio' : 'Retiro en local'}\n` +
      (costoEnvio ? `Costo de envío: ${costoEnvio} ${moneda}\n` : '') +
      `Total final: ${totalFinal} ${moneda}`;
    sendMessage(cfg.ChatIdVendedor, msgV).catch(console.error);
  }

  const alias = cfg.AliasPago || '';

  let texto =
    '🎉 <b>Pedido confirmado</b>\n\n' +
    `Tipo: ${tipo === 'ENVIO' ? 'Envío a domicilio' : 'Retiro en local'}\n` +
    `Total productos: ${totalProductos} ${moneda}\n`;

  if (costoEnvio) {
    texto += `Costo de envío: ${costoEnvio} ${moneda}\n`;
  }

  texto += `Total a pagar: <b>${totalFinal} ${moneda}</b>\n`;

  if (alias) {
    texto += `\n💳 Alias para pagar: <b>${alias}</b>\n`;
  }
  if (textoExtra) {
    texto += `\n${textoExtra}`;
  }

  await sendMessage(chatId, texto);

  clearCart(session);
  session.mode = 'IDLE';
  await sendMainMenu(chatId);
}

// --- MANEJO DE MENSAJES ---
async function handleTextMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const session = getSession(chatId);

  // Prioridad: estados especiales
  if (session.mode === 'WAITING_QUANTITY') {
    await handleQuantity(chatId, text);
    return;
  }

  if (session.mode === 'CHOOSING_DELIVERY') {
    if (text.includes('Retiro')) {
      await finalizarPedido(chatId, 'RETIRO');
    } else if (text.includes('Envío') || text.includes('Envio')) {
      await finalizarPedido(chatId, 'ENVIO');
    } else {
      session.mode = 'IDLE';
      await sendMainMenu(chatId);
    }
    return;
  }

  // Comandos / botones
  if (text === '/start') {
    await sendWelcome(chatId);
    return;
  }

  if (text === '🛒 Ver catálogo') {
    await sendCatalogoCompleto(chatId);
    return;
  }

  if (text === '🗂️ Catálogo rápido') {
    await sendCatalogoRapido(chatId);
    return;
  }

  if (text === '🛍️ Mi carrito') {
    await sendCart(chatId);
    return;
  }

  if (text === '🏆 Mis sellos y puntos') {
    await sendEstadoCliente(chatId);
    return;
  }

  if (text === '🏬 Información del local') {
    await sendInfoLocal(chatId);
    return;
  }

  if (text === '✅ Confirmar pedido') {
    await handleConfirmarPedido(chatId);
    return;
  }

  if (text === '🧹 Vaciar carrito') {
    clearCart(session);
    await sendMessage(chatId, 'Vacié tu carrito 🧺');
    await sendMainMenu(chatId);
    return;
  }

  if (text === '⬅️ Volver al menú' || text === '⬅️ Cancelar') {
    session.mode = 'IDLE';
    await sendMainMenu(chatId);
    return;
  }

  // Si el texto parece un código de producto (letras + números, sin espacios)
  if (/^[A-Za-z0-9]+$/.test(text)) {
    await startPurchaseByCode(chatId, text);
    return;
  }

  // Cualquier otra cosa: lo mando al menú
  await sendMessage(
    chatId,
    'No entendí ese mensaje 🤔. Podés usar los botones de abajo o escribir el código de un producto (por ej. TQ01).'
  );
  await sendMainMenu(chatId);
}

// --- MANEJO DE CALLBACKS (lo dejamos preparado por si luego queremos botones inline) ---
async function handleCallbackQuery(cb) {
  const id = cb.id;
  const data = cb.data || '';
  const chatId = cb.message.chat.id;

  if (data.startsWith('add_')) {
    const code = data.substring(4);
    await startPurchaseByCode(chatId, code);
    await answerCallbackQuery(id, 'Producto seleccionado');
    return;
  }

  await answerCallbackQuery(id, '');
}

// --- ROUTES EXPRESS ---
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'EzerBot backend activo' });
});

app.post('/webhook', async (req, res) => {
  const update = req.body;

  try {
    if (update.message && update.message.text) {
      await handleTextMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error('Error manejando update:', err);
  }

  res.sendStatus(200);
});

// --- ARRANQUE LOCAL (Render usa el mismo PORT) ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('EzerBot escuchando en puerto', PORT);
});
