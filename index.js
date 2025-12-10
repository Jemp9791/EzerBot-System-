import express from 'express';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !SHEETS_URL) {
  console.error('Faltan BOT_TOKEN o SHEETS_URL en las variables de entorno');
  process.exit(1);
}

// ---------------------------
//   CONFIG Y CATÁLOGO CACHE
// ---------------------------

let configCache = null;
let configCacheTime = 0;
const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutos

let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_TTL_MS = 2 * 60 * 1000; // 2 minutos

async function fetchConfig() {
  const now = Date.now();
  if (configCache && now - configCacheTime < CONFIG_TTL_MS) return configCache;

  const url = `${SHEETS_URL}?accion=config`;
  const res = await axios.get(url);
  configCache = res.data || {};
  configCacheTime = now;
  return configCache;
}

async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogCacheTime < CATALOG_TTL_MS) return catalogCache;

  const url = `${SHEETS_URL}?accion=catalogo`;
  const res = await axios.get(url);
  const items = (res.data && res.data.items) || [];

  // Normalizamos campos
  const normalizados = items.map((it, idx) => ({
    codigo: (it.codigo || it.CODIGO || `P${idx + 1}`).toString().trim(),
    nombre: it.nombre || it.NOMBRE || 'Producto',
    descripcion: it.descripcion || it.DESCRIPCION || '',
    precio: Number(it.precio || it.PRECIO || 0),
    moneda: it.moneda || it.MONEDA || res.data.moneda || 'ARS',
    unidad: (it.unidad || it.UNIDAD || '').toString().toLowerCase(), // 'kg' o 'unidad'
    precioPorKg: Number(it.precioPorKg || it.PRECIOPORKG || it.precio || 0),
    imagenUrl: it.imagenUrl || it.IMAGEN || it.imagen || '',
  }));

  catalogCache = normalizados;
  catalogCacheTime = now;
  return normalizados;
}

async function fetchEstadoCliente(chatId) {
  const url = `${SHEETS_URL}?accion=estadoCliente&chatId=${encodeURIComponent(
    chatId
  )}`;
  const res = await axios.get(url);
  return res.data || {};
}

// ---------------------------
//   CARRITOS EN MEMORIA
// ---------------------------

const carts = new Map(); // chatId -> [{codigo, nombre, unidad, cantidad, gramos, precioUnitario, subtotal}]
const pendingQuantity = new Map(); // chatId -> {codigo}

// ---------------------------
//   TELEGRAM BOT + EXPRESS
// ---------------------------

const bot = new TelegramBot(BOT_TOKEN);

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('EzerBot está vivo ✅');
});

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`EzerBot escuchando en puerto ${PORT}`);
});

// ---------------------------
//   MENÚ PRINCIPAL
// ---------------------------

function mainMenuKeyboard() {
  return {
    keyboard: [
      ['🛒 Ver catálogo', '👜 Mi carrito'],
      ['🏆 Mi tarjeta de sellos', '💬 Hablar con el vendedor'],
      ['🏬 Información del local', '📤 Compartir TodoQueso'],
    ],
    resize_keyboard: true,
  };
}

// ---------------------------
//   UTILIDADES
// ---------------------------

function formatMoney(valor, moneda = 'ARS') {
  const n = Number(valor) || 0;
  return `${n.toLocaleString('es-AR')} ${moneda}`;
}

async function sendBienvenida(chatId, firstName) {
  const cfg = await fetchConfig();
  const negocio = cfg.NegocioNombre || 'Tu negocio favorito';
  const descripcion =
    cfg.Descripcion ||
    'Comprás fácil, ganás sellos y canjeás premios por ser parte del Club.';

  const logoUrl = cfg.LogoURL || cfg.SelloURL || null;

  const texto =
    `🧀 Bienvenid@ ${firstName || ''} a *${negocio}* \n\n` +
    `Aquí vas a poder:\n` +
    `• Hojear el catálogo y armar tu pedido\n` +
    `• Sumar sellos por cada compra\n` +
    `• Canjear beneficios y promos exclusivas\n` +
    `• Chatear directo con el vendedor\n\n` +
    `Elegí una opción del menú de abajo para empezar.`;

  if (logoUrl) {
    await bot.sendPhoto(chatId, logoUrl, {
      caption: texto,
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }
}

async function mostrarCatalogoLista(chatId) {
  const cfg = await fetchConfig();
  const items = await fetchCatalog();
  const moneda = (items[0] && items[0].moneda) || cfg.Moneda || 'ARS';

  if (!items.length) {
    await bot.sendMessage(
      chatId,
      'Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  let texto = '🛒 *Catálogo Todo Queso*\n\n';
  texto +=
    'Hacé *scroll* para ver todo el listado. Cuando veas algo que te guste, escribí el *CÓDIGO* (por ejemplo: `TQ01`) para ver la foto grande y agregarlo a tu carrito.\n\n';

  for (const it of items) {
    texto += `• *${it.codigo}* – ${it.nombre} – ${formatMoney(
      it.precio,
      moneda
    )}\n`;
  }

  await bot.sendMessage(chatId, texto, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
}

async function mostrarProductoPorCodigo(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find(
    (p) => p.codigo.toUpperCase() === codigo.toUpperCase()
  );

  if (!item) {
    await bot.sendMessage(
      chatId,
      `No encontré el producto con código *${codigo}*. Probá de nuevo o tocá "🛒 Ver catálogo" para ver la lista completa.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const unidadTexto =
    item.unidad === 'kg' ? 'por kg' : item.unidad || 'por unidad';
  const caption =
    `🧀 *${item.codigo} – ${item.nombre}*\n` +
    `💲 Precio: ${formatMoney(item.precio, item.moneda)} ${unidadTexto}\n\n` +
    `${item.descripcion || ''}\n\n` +
    `Si querés comprarlo, tocá el botón de abajo o escribí cuánta cantidad querés.`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: '🛒 Agregar al carrito',
          callback_data: `ADD_${item.codigo}`,
        },
      ],
      [
        {
          text: '📤 Compartir esta promo',
          callback_data: `SHARE_${item.codigo}`,
        },
      ],
      [
        {
          text: '⬅️ Volver al catálogo',
          callback_data: 'VOLVER_CATALOGO',
        },
      ],
    ],
  };

  if (item.imagenUrl) {
    await bot.sendPhoto(chatId, item.imagenUrl, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: inlineKeyboard,
    });
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: inlineKeyboard,
    });
  }
}

// ---------------------------
//   CARRITO
// ---------------------------

function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, []);
  return carts.get(chatId);
}

function clearCart(chatId) {
  carts.delete(chatId);
}

async function askQuantity(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find(
    (p) => p.codigo.toUpperCase() === codigo.toUpperCase()
  );
  if (!item) {
    await bot.sendMessage(
      chatId,
      'No encontré el producto. Probá de nuevo desde el catálogo.',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  pendingQuantity.set(chatId, { codigo: item.codigo });

  if (item.unidad === 'kg') {
    await bot.sendMessage(
      chatId,
      `¿Cuántos *gramos* de *${item.nombre}* querés? (escribí un número, por ej: 250, 500, 800)`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `¿Cuántas *unidades* de *${item.nombre}* querés? (escribí un número, por ej: 1, 2, 3)`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
  }
}

async function handleQuantity(chatId, text) {
  const pendiente = pendingQuantity.get(chatId);
  if (!pendiente) return false;

  const cantidadNum = parseInt(text.replace(/\D/g, ''), 10);
  if (isNaN(cantidadNum) || cantidadNum <= 0) {
    await bot.sendMessage(
      chatId,
      'No entendí la cantidad. Escribí solo un número, por ejemplo 1, 2, 3 o 500.',
      { reply_markup: mainMenuKeyboard() }
    );
    return true;
  }

  const items = await fetchCatalog();
  const item = items.find(
    (p) => p.codigo.toUpperCase() === pendiente.codigo.toUpperCase()
  );
  if (!item) {
    pendingQuantity.delete(chatId);
    await bot.sendMessage(
      chatId,
      'No encontré el producto. Probá de nuevo desde el catálogo.',
      { reply_markup: mainMenuKeyboard() }
    );
    return true;
  }

  let subtotal = 0;
  let detalleCantidad = '';

  if (item.unidad === 'kg') {
    subtotal = (item.precioPorKg || item.precio) * (cantidadNum / 1000);
    detalleCantidad = `${cantidadNum} g`;
  } else {
    subtotal = item.precio * cantidadNum;
    detalleCantidad = `${cantidadNum} un.`;
  }

  subtotal = Math.round(subtotal);
  const cart = getCart(chatId);

  cart.push({
    codigo: item.codigo,
    nombre: item.nombre,
    unidad: item.unidad === 'kg' ? 'kg' : 'unidad',
    cantidad: item.unidad === 'kg' ? null : cantidadNum,
    gramos: item.unidad === 'kg' ? cantidadNum : null,
    precioUnitario: item.unidad === 'kg' ? item.precioPorKg : item.precio,
    subtotal,
  });

  pendingQuantity.delete(chatId);

  const total = cart.reduce((acc, it) => acc + it.subtotal, 0);

  await bot.sendMessage(
    chatId,
    `🛒 Agregué *${detalleCantidad} de ${item.nombre}* a tu carrito.\n` +
      `Subtotal de este producto: *${formatMoney(
        subtotal,
        item.moneda
      )}*\n` +
      `Total actual del carrito: *${formatMoney(total, item.moneda)}*\n\n` +
      `Podés seguir viendo el catálogo o tocar *"👜 Mi carrito"* para revisar y confirmar tu pedido.`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );

  return true;
}

async function mostrarCarrito(chatId) {
  const cfg = await fetchConfig();
  const cart = getCart(chatId);

  if (!cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío por ahora. Tocá *"🛒 Ver catálogo"* para elegir algo rico 😋',
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const moneda = cfg.Moneda || 'ARS';
  let texto = '👜 *Tu carrito*\n\n';
  let total = 0;

  cart.forEach((item, idx) => {
    total += item.subtotal;
    const lineaCantidad =
      item.unidad === 'kg'
        ? `${item.gramos} g`
        : `${item.cantidad} un.`;

    texto +=
      `${idx + 1}) ${item.nombre} – ${lineaCantidad} – ${formatMoney(
        item.subtotal,
        moneda
      )}\n`;
  });

  texto += `\n*Total:* ${formatMoney(total, moneda)}`;

  const inlineKeyboard = {
    inline_keyboard: [
      [{ text: '✅ Confirmar pedido', callback_data: 'CONFIRMAR_PEDIDO' }],
      [{ text: '🗑 Vaciar carrito', callback_data: 'VACIAR_CARRITO' }],
    ],
  };

  await bot.sendMessage(chatId, texto, {
    parse_mode: 'Markdown',
    reply_markup: inlineKeyboard,
  });
}

async function elegirTipoEntrega(chatId) {
  const cfg = await fetchConfig();
  const cart = getCart(chatId);
  if (!cart.length) {
    await bot.sendMessage(
      chatId,
      'Tu carrito está vacío. Agregá algún producto desde el catálogo.',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const moneda = cfg.Moneda || 'ARS';
  const total = cart.reduce((acc, it) => acc + it.subtotal, 0);

  await bot.sendMessage(
    chatId,
    `Total de los productos: *${formatMoney(total, moneda)}*\n\n` +
      '¿Cómo querés recibir tu pedido?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏬 Retiro en local', callback_data: 'RETIRA_LOCAL' }],
          [{ text: '🚚 Envío a domicilio', callback_data: 'ENVIO_DOMICILIO' }],
        ],
      },
    }
  );
}

async function finalizarPedido(chatId, tipoEntrega) {
  const cfg = await fetchConfig();
  const cart = getCart(chatId);
  if (!cart.length) return;

  const moneda = cfg.Moneda || 'ARS';
  const costoEnvioBase = Number(cfg.CostoEnvioBase || 0);
  const aliasPago = cfg.AliasPago || '';
  const tipoPago = cfg.TipoPagoOnline || 'TRANSFERENCIA';
  const mensajePost = cfg.MensajePostCompra || '';

  const totalProductos = cart.reduce((acc, it) => acc + it.subtotal, 0);
  const total = tipoEntrega === 'ENVIO' ? totalProductos + costoEnvioBase : totalProductos;

  let textoCliente =
    '🎉 *Pedido registrado*\n\n' +
    `Tipo de entrega: *${
      tipoEntrega === 'ENVIO' ? 'Envío a domicilio' : 'Retiro en local'
    }*\n` +
    `Total productos: ${formatMoney(totalProductos, moneda)}\n`;

  if (tipoEntrega === 'ENVIO' && costoEnvioBase > 0) {
    textoCliente += `Costo de envío: ${formatMoney(costoEnvioBase, moneda)}\n`;
  }

  textoCliente += `*Total a abonar: ${formatMoney(total, moneda)}*\n\n`;

  if (aliasPago) {
    textoCliente +=
      `Podés abonar por *${tipoPago}* al alias:\n` +
      `\`${aliasPago}\`\n\n`;
  }

  textoCliente +=
    '🧾 Apenas registremos tu pago te vamos a enviar un mensaje confirmando que tu pedido está en preparación.\n\n' +
    (mensajePost || '¡Gracias por tu compra y por ser parte del Club Todo Queso! 🧀');

  await bot.sendMessage(chatId, textoCliente, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });

  try {
    const chatIdVendedor = cfg.ChatIdVendedor;
    if (chatIdVendedor) {
      let textoVend = (cfg.TextoAvisoVendedor || 'Nuevo pedido recibido') + '\n\n';
      textoVend += `Cliente (chatId): ${chatId}\n`;
      textoVend += `Tipo de entrega: ${
        tipoEntrega === 'ENVIO' ? 'Envío a domicilio' : 'Retiro en local'
      }\n\n`;
      textoVend += 'Detalle:\n';

      cart.forEach((item, idx) => {
        const lineaCantidad =
          item.unidad === 'kg'
            ? `${item.gramos} g`
            : `${item.cantidad} un.`;
        textoVend += `${idx + 1}) ${item.nombre} – ${lineaCantidad} – ${formatMoney(
          item.subtotal,
          moneda
        )}\n`;
      });

      textoVend += `\nTotal cliente: ${formatMoney(total, moneda)}`;

      await bot.sendMessage(chatIdVendedor, textoVend, {
        parse_mode: 'Markdown',
      });
    }
  } catch (e) {
    console.error('Error enviando aviso a vendedor:', e.message);
  }

  clearCart(chatId);
}

// ---------------------------
//   TARJETA DE SELLOS
// ---------------------------

async function mostrarTarjetaSellos(chatId) {
  const estado = await fetchEstadoCliente(chatId);
  const cfg = await fetchConfig();

  if (!estado.tieneTarjeta) {
    await bot.sendMessage(
      chatId,
      'Todavía no encontré una tarjeta a tu nombre, pero quedate tranqui: ' +
        'cada compra que hagas en el local se registra con tu número y se van sumando tus sellos automáticamente 🧀\n\n' +
        'En cuanto tengas tu primera compra, acá vas a ver tu tarjeta y tu progreso.',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const texto =
    '🏆 *Tu tarjeta de sellos*\n\n' +
    `Nombre: *${estado.nombreCliente || ''}*\n` +
    `Nivel actual: *${estado.nivelActual || '-'}*\n` +
    `Sellos en este nivel: *${estado.sellosActuales || 0}/${
      estado.sellosNivelActual || 0
    }*\n` +
    `Sellos acumulados: *${estado.sellosTotalesAcumulados || 0}*\n\n` +
    (estado.beneficioProximo
      ? `Próximo beneficio: *${estado.beneficioProximo}*\n`
      : '') +
    (estado.beneficioDisponible
      ? `\n🎁 ¡Tenés un beneficio listo para canjear!`
      : '') +
    (estado.venceEl ? `\nVence el: ${estado.venceEl}` : '');

  if (estado.tarjetaImagenUrl) {
    await bot.sendPhoto(chatId, estado.tarjetaImagenUrl, {
      caption: texto,
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }
}

// ---------------------------
//   INFO DEL LOCAL
// ---------------------------

async function mostrarInfoLocal(chatId) {
  const cfg = await fetchConfig();
  const negocio = cfg.NegocioNombre || 'Todo Queso';
  const direccion = cfg.Direccion || '';
  const horarios = cfg.Horarios || '';
  const telefono = cfg.TelefonoNegocio || '';
  const insta = cfg.Instagram || '';
  const logoUrl = cfg.LogoURL || cfg.SelloURL || null;

  let texto = `🏬 *${negocio}*\n\n`;
  if (direccion) texto += `📍 *Dirección:* ${direccion}\n`;
  if (horarios) texto += `🕒 *Horarios:* ${horarios}\n`;
  if (telefono) texto += `📞 *Teléfono:* ${telefono}\n`;
  if (insta) texto += `📸 *Instagram:* ${insta}\n`;
  texto += '\nGracias por ser parte de Todo Queso Club 🧀';

  if (logoUrl) {
    await bot.sendPhoto(chatId, logoUrl, {
      caption: texto,
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }
}

// ---------------------------
//   COMPARTIR BOT
// ---------------------------

async function compartirBot(chatId) {
  const cfg = await fetchConfig();
  const textoBase =
    cfg.TextoCompartirBot ||
    'Compartí este EzerBot con tus amigos y ganá sellos extras.';

  const mensaje =
    `📤 *Compartí Todo Queso Club*\n\n` +
    `${textoBase}\n\n` +
    `Enlace del bot:\n` +
    `👉 https://t.me/${cfg.BotUsername || 'EzerBot'}\n\n` +
    (cfg.AliasPago
      ? `Y si quieren comprar directo, pueden pagar por transferencia al alias:\n\`${cfg.AliasPago}\`\n`
      : '');

  await bot.sendMessage(chatId, mensaje, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
}

// ---------------------------
//   COMPARTIR PROMO
// ---------------------------

async function compartirPromo(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find(
    (p) => p.codigo.toUpperCase() === codigo.toUpperCase()
  );
  if (!item) {
    await bot.sendMessage(
      chatId,
      'No encontré esa promo. Probá desde el catálogo de nuevo.',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const texto =
    `📤 *Compartí esta promo de Todo Queso*\n\n` +
    `Producto: *${item.nombre}* (código: *${item.codigo}*)\n` +
    `Precio: ${formatMoney(item.precio, item.moneda)}\n\n` +
    `Si tu amig@ compra usando el bot, ambos pueden ganar sellos extras 😄\n` +
    `👉 https://t.me/EzerBot`;

  await bot.sendMessage(chatId, texto, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
}

// ---------------------------
//   HABLAR CON EL VENDEDOR
// ---------------------------

async function hablarConVendedor(chatId) {
  const cfg = await fetchConfig();
  const whats = cfg.WhatsAppLink || '';
  let texto =
    '💬 Si tenés alguna duda sobre productos, promos o tu pedido, podés hablar directo con el vendedor.\n\n';

  if (whats) {
    texto += `👉 [Escribir por WhatsApp](${whats})`;
    await bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
      disable_web_page_preview: true,
    });
  } else {
    texto +=
      'Por ahora, escribí tu consulta acá mismo en el chat y te respondemos lo antes posible. 🧀';
    await bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }
}

// ---------------------------
//   HANDLERS TELEGRAM
// ---------------------------

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  try {
    if (data.startsWith('ADD_')) {
      const codigo = data.replace('ADD_', '');
      await askQuantity(chatId, codigo);
    } else if (data.startsWith('SHARE_')) {
      const codigo = data.replace('SHARE_', '');
      await compartirPromo(chatId, codigo);
    } else if (data === 'VOLVER_CATALOGO') {
      await mostrarCatalogoLista(chatId);
    } else if (data === 'CONFIRMAR_PEDIDO') {
      await elegirTipoEntrega(chatId);
    } else if (data === 'VACIAR_CARRITO') {
      clearCart(chatId);
      await bot.sendMessage(chatId, 'Vacié tu carrito 🧹', {
        reply_markup: mainMenuKeyboard(),
      });
    } else if (data === 'RETIRA_LOCAL') {
      await finalizarPedido(chatId, 'LOCAL');
    } else if (data === 'ENVIO_DOMICILIO') {
      await finalizarPedido(chatId, 'ENVIO');
    }
  } catch (e) {
    console.error('Error en callback_query:', e.message);
    await bot.sendMessage(
      chatId,
      'Ocurrió un error procesando tu acción. Probá de nuevo en un momento.',
      { reply_markup: mainMenuKeyboard() }
    );
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  try {
    if (pendingQuantity.has(chatId)) {
      const handled = await handleQuantity(chatId, text);
      if (handled) return;
    }

    if (text.startsWith('/start')) {
      await sendBienvenida(chatId, msg.from.first_name);
      return;
    }

    if (text === '🛒 Ver catálogo') {
      await mostrarCatalogoLista(chatId);
      return;
    }
    if (text === '👜 Mi carrito') {
      await mostrarCarrito(chatId);
      return;
    }
    if (text === '🏆 Mi tarjeta de sellos') {
      await mostrarTarjetaSellos(chatId);
      return;
    }
    if (text === '🏬 Información del local') {
      await mostrarInfoLocal(chatId);
      return;
    }
    if (text === '📤 Compartir TodoQueso') {
      await compartirBot(chatId);
      return;
    }
    if (text === '💬 Hablar con el vendedor') {
      await hablarConVendedor(chatId);
      return;
    }

    if (/^[A-Za-z]{1,5}\d{1,4}$/.test(text)) {
      await mostrarProductoPorCodigo(chatId, text.toUpperCase());
      return;
    }

    await sendBienvenida(chatId, msg.from.first_name);
  } catch (e) {
    console.error('Error en message handler:', e.message);
    await bot.sendMessage(
      chatId,
      'Tuvimos un pequeño problema procesando tu mensaje. Probá de nuevo en unos segundos.',
      { reply_markup: mainMenuKeyboard() }
    );
  }
});
