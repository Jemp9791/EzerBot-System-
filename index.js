// index.js
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- CACHES ---
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

// --- SESIONES ---
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      mode: 'IDLE',
      cart: [],
      cartTotal: 0,
      pendingProduct: null,
      pendingOrder: null
    };
  }
  return sessions[chatId];
}

// --- TELEGRAM UTILS ---
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

// --- MENÚ ---
async function sendMainMenu(chatId) {
  const keyboard = {
    keyboard: [
      [{ text: '🛒 Ver catálogo' }, { text: '🗂️ Catálogo rápido' }],
      [{ text: '🛍️ Mi carrito' }, { text: '🏆 Mis sellos y puntos' }],
      [{ text: '🏬 Información del local' }]
    ],
    resize_keyboard: true
  };
  await sendMessage(chatId, 'Elegí una opción 👇', { reply_markup: keyboard });
}

async function sendWelcome(chatId) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || 'Tu negocio';
  const desc = cfg.Descripcion || '';
  await sendMessage(chatId,
    `🧀 Bienvenido/a a <b>${nombre}</b>\n\n${desc}\n\nElegí lo que necesitás desde el menú 👇`
  );
  await sendMainMenu(chatId);
}

// --- INFO LOCAL ---
async function sendInfoLocal(chatId) {
  const cfg = await loadConfig();
  const logo = cfg.SelloURL || cfg.TarjetaURL || '';
  const txt =
    `🏬 <b>${cfg.NegocioNombre}</b>\n\n` +
    `📍 ${cfg.Direccion}\n` +
    `🕒 ${cfg.Horarios}\n` +
    (cfg.TelefonoNegocio ? `📞 ${cfg.TelefonoNegocio}\n` : '') +
    (cfg.Instagram ? `📸 ${cfg.Instagram}\n` : '') +
    `\nGracias por elegirnos 🧀`;

  if (logo) await sendPhoto(chatId, logo, txt);
  else await sendMessage(chatId, txt);
}

// --- CATÁLOGO COMPLETO ---
async function sendCatalogoCompleto(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const catalog = await loadCatalog();

  if (!catalog.length) {
    await sendMessage(chatId, 'No hay productos cargados 🧀');
    return;
  }

  await sendMessage(chatId,
    'Acá tenés algunos productos 🤩\nSi querés comprar uno, escribí su <b>código</b> (ej: TQ01).'
  );

  for (const item of catalog) {
    const codigo = item.codigo || item.CODIGO || '';
    const nombre = item.nombre || item.NOMBRE || '';
    const precio = item.precio || item.PRECIO || '';
    const descripcion = item.descripcion || item.DESCRIPCION || '';
    const imagen = item.imagenUrl || item.IMAGEN || '';

    const caption =
      `🛒 <b>${nombre}</b>\n` +
      `💰 <b>${precio} ${moneda}</b>\n` +
      (codigo ? `🔢 Código: <b>${codigo}</b>\n` : '') +
      (descripcion ? `\n${descripcion}` : '') +
      (codigo ? `\n\nPara comprarlo, escribí <b>${codigo}</b>.` : '');

    if (imagen) await sendPhoto(chatId, imagen, caption);
    else await sendMessage(chatId, caption);
  }
}

// --- CATÁLOGO RÁPIDO ---
async function sendCatalogoRapido(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const catalog = await loadCatalog();

  if (!catalog.length) {
    await sendMessage(chatId, 'No hay productos cargados 🧀');
    return;
  }

  let txt = '<b>🗂️ Catálogo rápido</b>\n\n';
  catalog.forEach(item => {
    txt += `• <b>${item.codigo}</b> – ${item.nombre} – ${item.precio} ${moneda}\n`;
  });

  txt += `\nEscribí el código del producto (ej: <b>TQ01</b>) para comprarlo.`;

  await sendMessage(chatId, txt);
}

// --- ESTADO DE CLIENTE ---
async function sendEstadoCliente(chatId) {
  const res = await axios.get(`${SHEETS_URL}?accion=estadoCliente&chatId=${chatId}`);
  const info = res.data;

  if (!info.tieneTarjeta) {
    await sendMessage(chatId,
      'Todavía no encontré tu tarjeta.\nCuando hagas tu primera compra, empezás a sumar sellos 🧾✨'
    );
    return;
  }

  let msg =
    `🏆 <b>Mis sellos y puntos</b>\n\n` +
    `👤 ${info.nombreCliente}\n` +
    `🔘 Nivel: ${info.nivelActual}\n` +
    `🔢 Progreso: ${info.sellosActuales}/${info.sellosNivelActual}\n` +
    `📊 Acumulados: ${info.sellosTotalesAcumulados}\n`;

  if (info.beneficioDisponible) {
    msg += `\n🎁 <b>Beneficio disponible:</b> ${info.descripcionBeneficio}\n`;
    if (info.venceEl) msg += `⏰ Vence el: ${info.venceEl}`;
  } else if (info.beneficioProximo) {
    msg += `\n🎁 Próximo beneficio: ${info.beneficioProximo}`;
  }

  await sendMessage(chatId, msg);
}

// --- CARRITO ---
function formatCart(session, moneda) {
  if (!session.cart.length) return 'Tu carrito está vacío 🧺';
  let txt = '🛍️ <b>Tu carrito</b>\n\n';
  session.cart.forEach((it, i) => {
    txt += `${i + 1}) ${it.nombre} – ${it.detalle} – ${it.subtotal} ${moneda}\n`;
  });
  txt += `\nTotal: <b>${session.cartTotal} ${moneda}</b>`;
  return txt;
}

async function sendCart(chatId) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const session = getSession(chatId);

  const keyboard = {
    keyboard: [
      [{ text: '✅ Confirmar pedido' }],
      [{ text: '🧹 Vaciar carrito' }],
      [{ text: '⬅️ Volver al menú' }]
    ],
    resize_keyboard: true
  };

  await sendMessage(chatId, formatCart(session, moneda), { reply_markup: keyboard });
}

function clearCart(s) {
  s.cart = [];
  s.cartTotal = 0;
  s.pendingOrder = null;
}

// --- PROCESO DE COMPRA ---
async function startPurchaseByCode(chatId, codeRaw) {
  const code = codeRaw.trim().toUpperCase();
  const catalog = await loadCatalog();

  const item = catalog.find(p => p.codigo.toUpperCase() === code);
  if (!item) {
    await sendMessage(chatId,
      `No encontré un producto con el código <b>${code}</b>.\nProbá mirar el 🗂️ Catálogo rápido.`
    );
    return;
  }

  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const session = getSession(chatId);

  session.pendingProduct = {
    codigo: code,
    nombre: item.nombre,
    precio: Number(item.precio),
    unidad: (item.unidad || 'unidad').toLowerCase()
  };

  session.mode = 'WAITING_QUANTITY';

  const caption =
    `🛒 <b>${item.nombre}</b>\n` +
    `💰 ${item.precio} ${moneda} por ${session.pendingProduct.unidad}\n\n` +
    (item.descripcion || '') +
    `\n\nIndicame la cantidad:\n` +
    (session.pendingProduct.unidad === 'kg'
      ? '📏 Escribí gramos (ej: 250, 500, 1000)'
      : '🔢 Escribí unidades (ej: 1, 2, 3)');

  if (item.imagenUrl) await sendPhoto(chatId, item.imagenUrl, caption);
  else await sendMessage(chatId, caption);
}

async function handleQuantity(chatId, text) {
  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || num <= 0) {
    await sendMessage(chatId, 'Necesito un número válido 🙂');
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

  let subtotal = 0;
  let detalle = '';

  if (p.unidad === 'kg') {
    subtotal = Math.round((p.precio * num) / 1000);
    detalle = `${num} g`;
  } else {
    subtotal = p.precio * num;
    detalle = `${num} un.`;
  }

  session.cart.push({
    codigo: p.codigo,
    nombre: p.nombre,
    detalle,
    subtotal
  });

  session.cartTotal += subtotal;

  session.pendingProduct = null;
  session.mode = 'IDLE';

  await sendMessage(chatId,
    `🛒 Agregué <b>${detalle}</b> de <b>${p.nombre}</b>\nSubtotal: <b>${subtotal} ${moneda}</b>`
  );

  await sendMessage(chatId,
    'Podés seguir agregando productos escribiendo otro código.\nCuando estés listo, abrí tu 🛍️ <b>carrito</b>.'
  );
}

// --- CONFIRMAR PEDIDO ---
async function handleConfirmarPedido(chatId) {
  const session = getSession(chatId);
  const cfg = await loadConfig();

  if (!session.cart.length) {
    await sendMessage(chatId, 'Tu carrito está vacío 🧺');
    return;
  }

  session.mode = 'CHOOSING_DELIVERY';

  const opciones = [];
  if (cfg.UsaRetiroLocal === 'SI') opciones.push([{ text: '🏬 Retiro en local' }]);
  if (cfg.UsaEnvioDomicilio === 'SI') opciones.push([{ text: '🚚 Envío a domicilio' }]);
  opciones.push([{ text: '⬅️ Cancelar' }]);

  await sendMessage(chatId, 'Elegí cómo querés recibir tu pedido:', {
    reply_markup: { keyboard: opciones, resize_keyboard: true }
  });
}

async function prepararPedido(chatId, tipo) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || 'ARS';
  const alias = cfg.AliasPago || '';
  const session = getSession(chatId);

  const totalProductos = session.cartTotal || 0;
  const costoEnvio = tipo === 'ENVIO' ? Number(cfg.CostoEnvioBase || 0) : 0;
  const totalFinal = totalProductos + costoEnvio;

  session.pendingOrder = { tipo, totalProductos, costoEnvio, totalFinal };

  let txt =
    `🧾 <b>Resumen del pedido</b>\n\n` +
    `Tipo: ${tipo === 'ENVIO' ? 'Envío a domicilio' : 'Retiro en local'}\n` +
    `Total productos: ${totalProductos} ${moneda}\n` +
    (costoEnvio ? `Costo envío: ${costoEnvio} ${moneda}\n` : '') +
    `\n<b>Total a aprobar:</b> ${totalFinal} ${moneda}\n`;

  if (alias)
    txt += `\n💳 Podés abonar al alias:\n<b>${alias}</b>\n`;

  txt +=
    `\nTu pedido ya está listo.\nSolo queda aprobar el pago para que podamos prepararlo 😊.\n` +
    `Apenas el local confirme tu pago, te avisamos al instante.`;

  await sendMessage(chatId, txt);

  if (cfg.ChatIdVendedor) {
    const detalle = formatCart(session, moneda);
    const aviso = cfg.TextoAvisoVendedor || 'Pago pendiente de aprobación';

    const msgV =
      `${aviso}\n\n${detalle}\n\n` +
      `Tipo: ${tipo === 'ENVIO' ? 'Envío a domicilio' : 'Retiro'}\n` +
      (costoEnvio ? `Costo envío: ${costoEnvio}\n` : '') +
      `Total final: ${totalFinal}\n\n` +
      `Cliente (chatId): ${chatId}`;

    const keyboard = {
      inline_keyboard: [[{ text: '✅ Confirmar pago', callback_data: `CONFIRM_PAY:${chatId}` }]]
    };

    await sendMessage(cfg.ChatIdVendedor, msgV, { reply_markup: keyboard });
  }

  session.mode = 'IDLE';
  await sendMainMenu(chatId);
}

// --- TEXTOS ---
async function handleTextMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const session = getSession(chatId);

  if (session.mode === 'WAITING_QUANTITY') {
    await handleQuantity(chatId, text);
    return;
  }

  if (session.mode === 'CHOOSING_DELIVERY') {
    if (text.includes('Retiro')) return prepararPedido(chatId, 'RETIRO');
    if (text.includes('Envío') || text.includes('Envio')) return prepararPedido(chatId, 'ENVIO');
    session.mode = 'IDLE';
    return sendMainMenu(chatId);
  }

  if (text === '/start') return sendWelcome(chatId);
  if (text === '🛒 Ver catálogo') return sendCatalogoCompleto(chatId);
  if (text === '🗂️ Catálogo rápido') return sendCatalogoRapido(chatId);
  if (text === '🛍️ Mi carrito') return sendCart(chatId);
  if (text === '🏆 Mis sellos y puntos') return sendEstadoCliente(chatId);
  if (text === '🏬 Información del local') return sendInfoLocal(chatId);
  if (text === '🧹 Vaciar carrito') { clearCart(session); return sendMainMenu(chatId); }
  if (text === '⬅️ Volver al menú' || text === '⬅️ Cancelar') { session.mode='IDLE'; return sendMainMenu(chatId); }
  if (text === '✅ Confirmar pedido') return handleConfirmarPedido(chatId);

  if (/^[A-Za-z0-9]+$/.test(text)) return startPurchaseByCode(chatId, text);

  await sendMessage(chatId, 'No entendí 🤔. Podés usar los botones o escribir un código como <b>TQ01</b>.');
  await sendMainMenu(chatId);
}

// --- CALLBACKS ---
async function handleCallbackQuery(cb) {
  const id = cb.id;
  const data = cb.data;
  const chatIdV = cb.message.chat.id;

  if (data.startsWith('CONFIRM_PAY:')) {
    const clientId = data.split(':')[1];
    const cfg = await loadConfig();
    const moneda = cfg.Moneda || 'ARS';
    const session = getSession(clientId);
    const order = session.pendingOrder;

    if (!order) {
      await answerCallbackQuery(id, 'Pedido no encontrado.');
      return;
    }

    await answerCallbackQuery(id, 'Pago confirmado');

    axios.get(`${SHEETS_URL}?accion=registrarCompra&chatId=${clientId}&monto=${order.totalFinal}`);

    const txt =
      `🎉 <b>Pago aprobado</b>\n\n` +
      `${cfg.TextoConfirmacionPedido || 'Tu pedido fue confirmado y ya lo estamos preparando.'}\n\n` +
      `Total abonado: <b>${order.totalFinal} ${moneda}</b>`;

    await sendMessage(clientId, txt);

    clearCart(session);
    await sendMainMenu(clientId);

    await sendMessage(chatIdV, 'Pago confirmado y pedido marcado como en preparación.');
    return;
  }

  await answerCallbackQuery(id, '');
}

// --- RUTAS ---
app.get('/', (_, res) => res.json({ ok: true }));
app.post('/webhook', async (req, res) => {
  try {
    if (req.body.message) await handleTextMessage(req.body.message);
    if (req.body.callback_query) await handleCallbackQuery(req.body.callback_query);
  } catch (err) {
    console.error(err);
  }
  res.sendStatus(200);
});

// --- START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('EzerBot ejecutándose en Render'));
