// ===============================
//  EzerBot - Todo Queso POS + Bot
// ===============================

const TelegramBot = require('node-telegram-bot-api');

// 1) CONFIG BÁSICA (reemplazá el token por el tuyo o usá process.env.BOT_TOKEN)
const TOKEN = process.env.BOT_TOKEN || 'PONÉ_ACÁ_TU_TOKEN';
const BOT_PUBLIC_LINK = 'https://t.me/Ezer_IA_Bot';

// 2) CONFIG DEL NEGOCIO (MISMO ESQUEMA QUE TU HOJA CONFIG)
const config = {
  NegocioNombre: 'Todo Queso',
  LogoURL: 'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg',
  UsaSellos: 'SI',
  TarjetaURL: 'https://i.postimg.cc/yx8qCptV/Blue-and-Yellow-Retro-Membership-Loyalty-Card-Animated-Instagram-Post.png',
  SelloURL: 'https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg',
  MontoPorSello: 10000,
  UsaNiveles: 'SI',
  NombresNiveles: 'TQ Bronce|TQ Plata| TQ Oro',
  SellosPorNivel: '10|30|50',
  BeneficiosPorNivel:
    '2 prepizzas, 400 grs de queso, 200 grs de paleta|Picada para 2, Coca Cola x 1,5 litros|Picada premium para 4, 4 cervezas lata, 500 grs de pan fresco',
  Dirección: 'Fructuoso Díaz 893, Garin',
  Horarios: 'LUN a SAB 08:30-14:00/16:30-21:00',
  TeléfonoNegocio: '5493484230184',
  Instagram: '@todoqueso.club',
  Facebook: 'NO',
  WhatsAppLink: 'https://wa.me/5493484230184?text=Hola%20quiero%20hacer%20una%20consulta',
  Descripcion:
    'Somos Todo Queso. Aquí encontrarás los mejores precios, las picadas más ricas y los mejores beneficios de ser parte de nuestro club.',
  CatalogoActivo: 'SI',
  Moneda: 'ARS',
  CatalogoMostrarPrecios: 'SI',
  PermitirPagoOnline: 'SI',
  TipoPagoOnline: 'TRANSFERENCIA',
  AliasPago: 'jennyocampos.mp',
  CBUPago: '',
  MensajePostCompra: 'Agradecemos tu compra. Ya sumaste tus  puntos ',
  UsaEnvíoDomicilio: 'SI',
  CostoEnvíoBase: 2000,
  TextoEnvíoDomicilio: 'Tu envío se realizará a partir de las 16:00 hs',
  UsaRetiroLocal: 'SI',
  TextoRetiroLocal: 'Tu pedido será preparado y podés pasar a retirarlo hasta las 20:00 hs',
  ChatIdVendedor: 7454984023,
  TextoAvisoVendedor: 'Tenés un pago pendiente de confirmación  ✅',
  TextoConfirmacionPedido: 'Gracias. Tu compra fué confirmada y está en preparación.  ✅',
  CompartirBotActivo: 'SI',
  TextoCompartirBot: 'Compartí este Ezerbot con tus amigos y ganá sellos extras.',
  ResetSellosAlCanjear: 'SI',
  MensajeNivelCompletado: '🎉 ¡Felicitaciones! Completaste tu nivel y podés canjear tu beneficio'
};

// 3) CATÁLOGO DE EJEMPLO (después podés reemplazar por lectura desde Sheets)
const catalog = {
  Promos: [
    {
      id: 'PROMO1',
      nombre: 'DULCE DE BATATA',
      descripcion: 'Dulce de batata de cajón',
      precioKg: 4000,
      precioUnidad: null,
      unidad: 'gramos',
      imagen: 'https://i.postimg.cc/Gh1z1WXr/dulce-batata.jpg'
    },
    {
      id: 'PROMO2',
      nombre: 'DULCE DE BATATA C/CHOCO',
      descripcion: 'Dulce de batata con chocolate',
      precioKg: 4000,
      precioUnidad: null,
      unidad: 'gramos',
      imagen: 'https://i.postimg.cc/Vvz3jDJQ/dulce-batata-choco.jpg'
    },
    {
      id: 'PROMO3',
      nombre: 'DULCE DE MEMBRILLO',
      descripcion: 'Dulce de membrillo de cajón',
      precioKg: 4000,
      precioUnidad: null,
      unidad: 'gramos',
      imagen: 'https://i.postimg.cc/hG3Yv3WN/dulce-membrillo.jpg'
    }
  ],
  Panificados: [
    {
      id: 'PAN1',
      nombre: 'PAN FRANCÉS',
      descripcion: 'Pan francés crocante recién horneado',
      precioKg: 2500,
      precioUnidad: null,
      unidad: 'gramos',
      imagen: 'https://i.postimg.cc/yNmBM8HW/pan-frances.jpg'
    }
  ],
  Fiambres: [
    {
      id: 'FIAM1',
      nombre: 'JAMÓN COCIDO OFERTA',
      descripcion: 'Jamón cocido oferta',
      precioKg: 20000,
      precioUnidad: null,
      unidad: 'gramos',
      imagen: 'https://i.postimg.cc/sXNV4DmH/jamon-cocido.jpg'
    }
  ]
};

const categories = Object.keys(catalog);

// 4) ESTADO EN MEMORIA
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      cart: [],
      catalogView: null,
      flow: null, // para envío / retiro / pago
      pendingQuantity: null // producto pendiente de cantidad
    };
  }
  return sessions[chatId];
}

// 5) UTILIDADES

function formatMoney(v) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v);
}

function cartTotals(cart) {
  let subtotal = 0;
  let items = 0;
  cart.forEach((it) => {
    subtotal += it.total;
    items += 1;
  });
  return { subtotal, items };
}

function generateTicketId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `TQ-${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

function buildPosTicket({
  cliente,
  telefono,
  entregaTipo,
  direccion,
  horario,
  cart,
  subtotal,
  envio,
  total,
  pago,
  chatIdCliente
}) {
  const ticketId = generateTicketId();
  const now = new Date();
  const fechaStr = now.toLocaleString('es-AR');

  let lines = [];
  lines.push('TICKET POS');
  lines.push('');
  lines.push(config.NegocioNombre.toUpperCase());
  lines.push('----------------------------------------');
  lines.push(`Ticket: ${ticketId}`);
  lines.push(`Fecha: ${fechaStr}`);
  lines.push('----------------------------------------');
  lines.push(`Cliente: ${cliente || '-'}`);
  lines.push(`Tel: ${telefono || '-'}`);
  lines.push(`Entrega: ${entregaTipo}`);
  if (entregaTipo === 'ENVÍO') {
    lines.push(`Dirección: ${direccion || '-'}`);
  }
  lines.push(`Horario: ${horario || '-'}`);
  lines.push('----------------------------------------');

  cart.forEach((item) => {
    if (item.unidad === 'gramos') {
      lines.push(` ${item.cantidad}g  ${item.nombre}`);
    } else {
      lines.push(` ${item.cantidad}u  ${item.nombre}`);
    }
    lines.push(`${formatMoney(item.total)} `.padStart(10));
  });

  lines.push('----------------------------------------');
  lines.push(`SUBTOTAL: ${formatMoney(subtotal)}`);
  lines.push(`Envío: ${formatMoney(envio)}`);
  lines.push(`TOTAL: ${formatMoney(total)}`);
  lines.push('----------------------------------------');
  lines.push(`Pago: ${pago}`);
  lines.push(`ChatID: ${chatIdCliente}`);
  lines.push('----------------------------------------');

  if (pago === 'Transferencia' && config.AliasPago) {
    lines.push('Alias / CBU para transferencia:');
    lines.push(`Alias: ${config.AliasPago}`);
    if (config.CBUPago) lines.push(`CBU: ${config.CBUPago}`);
    lines.push('Envianos el comprobante por WhatsApp 🙌');
  }

  return lines.join('\n');
}

// MENÚ PRINCIPAL
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['🛍 Catálogo', '🛒 Ver carrito'],
      ['✅ Finalizar compra', '🎟 Mis sellos'],
      ['📍 Horarios y dirección', '📣 Compartir bot']
    ],
    resize_keyboard: true
  };
}

// 6) INICIO DEL BOT
const bot = new TelegramBot(TOKEN, { polling: true });

bot.on('polling_error', console.error);

function sendWelcome(chatId) {
  const text =
    `👋 ¡Hola! Soy el bot de *${config.NegocioNombre}*.\n\n` +
    `${config.Descripcion}\n\n` +
    `📍 *Dirección:* ${config.Dirección}\n` +
    `🕒 *Horarios:* ${config.Horarios}\n` +
    `📞 *Tel:* +${config.TeléfonoNegocio}\n` +
    (config.Instagram && config.Instagram !== 'NO' ? `📸 Instagram: ${config.Instagram}\n` : '') +
    '\n👇 Elegí una opción del menú para empezar:';

  if (config.LogoURL) {
    bot.sendPhoto(chatId, config.LogoURL, {
      caption: text,
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard()
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard()
    });
  }
}

// 7) CATÁLOGO

function sendCategories(chatId) {
  const session = getSession(chatId);
  session.catalogView = null;

  const inline_keyboard = categories.map((cat) => [
    {
      text: cat,
      callback_data: `cat:${cat}`
    }
  ]);

  inline_keyboard.push([
    { text: '🛒 Ver carrito', callback_data: 'cart:view' },
    { text: '🏠 Menú', callback_data: 'menu:home' }
  ]);

  bot.sendMessage(chatId, '🛍 Elegí una categoría:', {
    reply_markup: { inline_keyboard }
  });
}

function sendProductPage(chatId, catName, index, messageIdToEdit) {
  const items = catalog[catName] || [];
  if (!items.length) {
    bot.sendMessage(chatId, 'No hay productos en esta categoría por ahora.');
    return;
  }
  if (index < 0) index = items.length - 1;
  if (index >= items.length) index = 0;

  const product = items[index];
  const pageLabel = `${index + 1}/${items.length}`;

  const captionLines = [];
  captionLines.push(`*${product.nombre}*`);
  if (config.CatalogoMostrarPrecios === 'SI') {
    if (product.unidad === 'gramos') {
      captionLines.push(`💰 ${formatMoney(product.precioKg)} / kg`);
    } else {
      captionLines.push(`💰 ${formatMoney(product.precioUnidad)} c/u`);
    }
  }
  if (product.descripcion) {
    captionLines.push(`📝 ${product.descripcion}`);
  }

  const caption = captionLines.join('\n');

  const inline_keyboard = [
    [
      { text: '🟢 Quiero éste', callback_data: `prod:buy:${catName}:${index}` },
      { text: '📣 Compartir', callback_data: `prod:share:${catName}:${index}` }
    ],
    [
      { text: '⬅️ Anterior', callback_data: `prod:prev:${catName}:${index}` },
      { text: pageLabel, callback_data: 'noop' },
      { text: '➡️ Siguiente', callback_data: `prod:next:${catName}:${index}` }
    ],
    [
      { text: '📂 Categorías', callback_data: 'cat:list' },
      { text: '🛒 Carrito', callback_data: 'cart:view' },
      { text: '🏠 Menú', callback_data: 'menu:home' }
    ]
  ];

  const options = {
    caption,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard }
  };

  if (messageIdToEdit) {
    bot
      .editMessageMedia(
        {
          type: 'photo',
          media: product.imagen,
          caption,
          parse_mode: 'Markdown'
        },
        {
          chat_id: chatId,
          message_id: messageIdToEdit,
          reply_markup: { inline_keyboard }
        }
      )
      .catch((err) => {
        console.error('Error editMessageMedia:', err.message);
      });
  } else {
    bot.sendPhoto(chatId, product.imagen, options);
  }

  const session = getSession(chatId);
  session.catalogView = { category: catName, index };
}

// 8) MANEJO DE CALLBACKS (botones inline)

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const messageId = query.message.message_id;
  const session = getSession(chatId);

  try {
    if (data === 'noop') {
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'cat:list') {
      await bot.answerCallbackQuery(query.id);
      return sendCategories(chatId);
    }

    if (data.startsWith('cat:')) {
      const catName = data.split(':')[1];
      await bot.answerCallbackQuery(query.id);
      return sendProductPage(chatId, catName, 0, messageId);
    }

    if (data.startsWith('prod:prev:')) {
      const [, , catName, indexStr] = data.split(':');
      const index = parseInt(indexStr, 10) - 1;
      await bot.answerCallbackQuery(query.id);
      return sendProductPage(chatId, catName, index, messageId);
    }

    if (data.startsWith('prod:next:')) {
      const [, , catName, indexStr] = data.split(':');
      const index = parseInt(indexStr, 10) + 1;
      await bot.answerCallbackQuery(query.id);
      return sendProductPage(chatId, catName, index, messageId);
    }

    if (data.startsWith('prod:buy:')) {
      const [, , catName, indexStr] = data.split(':');
      const index = parseInt(indexStr, 10);
      const product = catalog[catName][index];
      session.pendingQuantity = {
        product
      };
      session.flow = { type: 'quantity' };

      const unidadMsg =
        product.unidad === 'gramos'
          ? '¿Cuántos gramos querés? (ej: 250, 500, 1000)'
          : '¿Cuántas unidades querés? (ej: 1, 2, 3)';

      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, unidadMsg);
    }

    if (data.startsWith('prod:share:')) {
      const [, , catName, indexStr] = data.split(':');
      const index = parseInt(indexStr, 10);
      const product = catalog[catName][index];

      const shareText =
        `Te recomiendo *${product.nombre}* de ${config.NegocioNombre} 🧀\n` +
        (product.descripcion ? `📝 ${product.descripcion}\n` : '') +
        (config.WhatsAppLink ? `Escribiles acá: ${config.WhatsAppLink}` : '');

      const wa = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
      const tg = `https://t.me/share/url?url=${encodeURIComponent(
        BOT_PUBLIC_LINK
      )}&text=${encodeURIComponent(shareText)}`;
      const mail = `mailto:?subject=${encodeURIComponent(
        `Recomendación - ${product.nombre}`
      )}&body=${encodeURIComponent(shareText)}`;

      const inline_keyboard = [
        [{ text: '📲 WhatsApp', url: wa }],
        [{ text: '✉️ Email', url: mail }],
        [{ text: '📨 Telegram', url: tg }]
      ];

      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, 'Compartí este producto:', {
        reply_markup: { inline_keyboard },
        parse_mode: 'Markdown'
      });
    }

    if (data === 'cart:view') {
      await bot.answerCallbackQuery(query.id);
      return showCart(chatId);
    }

    if (data === 'menu:home') {
      await bot.answerCallbackQuery(query.id);
      return sendWelcome(chatId);
    }

    // ENVÍO / RETIRO / PAGO / CONFIRMAR
    if (data === 'delivery:envio' || data === 'delivery:retiro' || data === 'delivery:cancel') {
      await bot.answerCallbackQuery(query.id);
      return handleDeliveryChoice(chatId, data);
    }

    if (data === 'pago:efectivo' || data === 'pago:transferencia') {
      await bot.answerCallbackQuery(query.id);
      return handlePagoChoice(chatId, data);
    }

    if (data === 'pedido:confirmar') {
      await bot.answerCallbackQuery(query.id);
      return finalizeOrder(chatId);
    }

    if (data === 'pedido:cancelar') {
      await bot.answerCallbackQuery(query.id);
      getSession(chatId).flow = null;
      return bot.sendMessage('Operación cancelada. Podés seguir mirando el catálogo 😊', {
        reply_markup: mainMenuKeyboard()
      });
    }
  } catch (e) {
    console.error('Error en callback_query:', e);
    bot.answerCallbackQuery(query.id, { text: 'Ups, algo se mezcló en la tabla 😅 Probá de nuevo.' });
  }
});

// 9) VER CARRITO

function showCart(chatId) {
  const session = getSession(chatId);
  const cart = session.cart;

  if (!cart.length) {
    return bot.sendMessage(chatId, '🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?', {
      reply_markup: mainMenuKeyboard()
    });
  }

  const { subtotal, items } = cartTotals(cart);

  let text = '🛒 *Tu carrito*\n\n';
  cart.forEach((item, idx) => {
    const lineaCant =
      item.unidad === 'gramos' ? `${item.cantidad}g x ${item.nombre}` : `${item.cantidad}u x ${item.nombre}`;
    text += `${idx + 1}. ${lineaCant} — ${formatMoney(item.total)}\n`;
  });
  text += '\n';
  text += `Subtotal: *${formatMoney(subtotal)}*\n\n`;
  text +=
    '👉 Si querés seguir mirando, tocá 🛍 *Catálogo*.\n' +
    '👉 Si ya está, tocá ✅ *Finalizar compra* y cerramos el pedido.';

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
}

// 10) FLUJO ENVÍO / RETIRO / PAGO

async function handleDeliveryChoice(chatId, data) {
  const session = getSession(chatId);
  const cart = session.cart;

  if (!cart.length) {
    return bot.sendMessage(chatId, 'Tu carrito está vacío. Primero agregá algún producto 🛒', {
      reply_markup: mainMenuKeyboard()
    });
  }

  if (!session.flow || session.flow.type !== 'checkout') {
    session.flow = { type: 'checkout', etapa: 'delivery_choice', data: {} };
  }

  if (data === 'delivery:cancel') {
    session.flow = null;
    return bot.sendMessage(chatId, 'Operación cancelada. Podés seguir mirando el catálogo 😊', {
      reply_markup: mainMenuKeyboard()
    });
  }

  if (data === 'delivery:envio') {
    session.flow = {
      type: 'checkout',
      etapa: 'ask_address',
      data: { entregaTipo: 'ENVÍO' }
    };
    return bot.sendMessage(chatId, '📍 Decime tu *dirección completa* para el envío:', { parse_mode: 'Markdown' });
  }

  if (data === 'delivery:retiro') {
    session.flow = {
      type: 'checkout',
      etapa: 'ask_nombre',
      data: { entregaTipo: 'RETIRO' }
    };
    return bot.sendMessage(chatId, '🧾 Decime tu *nombre* para el pedido:', { parse_mode: 'Markdown' });
  }
}

async function handlePagoChoice(chatId, data) {
  const session = getSession(chatId);
  if (!session.flow || session.flow.type !== 'checkout') return;

  const { subtotal } = cartTotals(session.cart);
  const envio =
    session.flow.data.entregaTipo === 'ENVÍO' && config.UsaEnvíoDomicilio === 'SI' ? Number(config.CostoEnvíoBase) : 0;
  const total = subtotal + envio;

  let pago = 'Efectivo';
  if (data === 'pago:transferencia') pago = 'Transferencia';

  session.flow.data.pago = pago;
  session.flow.data.subtotal = subtotal;
  session.flow.data.envio = envio;
  session.flow.data.total = total;

  const ticket = buildPosTicket({
    cliente: session.flow.data.nombre,
    telefono: session.flow.data.telefono,
    entregaTipo: session.flow.data.entregaTipo,
    direccion: session.flow.data.direccion,
    horario: session.flow.data.horario,
    cart: session.cart,
    subtotal,
    envio,
    total,
    pago,
    chatIdCliente: chatId
  });

  await bot.sendMessage(chatId, '🧾 *TICKET POS*\n```' + ticket + '```', {
    parse_mode: 'Markdown'
  });

  const inline_keyboard = [
    [{ text: '✅ Confirmar pedido', callback_data: 'pedido:confirmar' }],
    [{ text: '❌ Cancelar', callback_data: 'pedido:cancelar' }]
  ];

  await bot.sendMessage(chatId, '¿Confirmás el pedido?', {
    reply_markup: { inline_keyboard }
  });
}

async function finalizeOrder(chatId) {
  const session = getSession(chatId);
  if (!session.flow || session.flow.type !== 'checkout') return;

  const flow = session.flow;
  const cart = session.cart;

  // Aviso al vendedor
  if (config.ChatIdVendedor) {
    let resumen = `🧾 Nuevo pedido de *${config.NegocioNombre}*\n\n`;
    resumen += `Cliente: ${flow.data.nombre || '-'}\n`;
    resumen += `Tel: ${flow.data.telefono || '-'}\n`;
    resumen += `Entrega: ${flow.data.entregaTipo}\n`;
    if (flow.data.entregaTipo === 'ENVÍO') {
      resumen += `Dirección: ${flow.data.direccion || '-'}\n`;
    }
    resumen += `Horario: ${flow.data.horario || '-'}\n`;
    resumen += '\nDetalle:\n';
    cart.forEach((item) => {
      const lineaCant =
        item.unidad === 'gramos' ? `${item.cantidad}g x ${item.nombre}` : `${item.cantidad}u x ${item.nombre}`;
      resumen += `• ${lineaCant} — ${formatMoney(item.total)}\n`;
    });
    resumen += '\n';
    resumen += `Subtotal: ${formatMoney(flow.data.subtotal)}\n`;
    resumen += `Envío: ${formatMoney(flow.data.envio)}\n`;
    resumen += `TOTAL: ${formatMoney(flow.data.total)}\n`;
    resumen += `Pago: ${flow.data.pago}\n`;
    resumen += `ChatID cliente: ${chatId}\n\n`;
    resumen += config.TextoAvisoVendedor || '';

    try {
      await bot.sendMessage(config.ChatIdVendedor, resumen, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Error enviando aviso vendedor:', e.message);
    }
  }

  // Mensaje al cliente
  await bot.sendMessage(chatId, config.TextoConfirmacionPedido || 'Gracias. Tu compra fue confirmada. ✅');

  // Sellos aproximados
  if (config.UsaSellos === 'SI' && config.MontoPorSello) {
    const sellosGanados = Math.floor(flow.data.total / Number(config.MontoPorSello));
    if (sellosGanados > 0) {
      let txt = `🎟 Con esta compra ganás *${sellosGanados} sello(s)* para tu tarjeta Todo Queso Club.\n`;
      txt += 'Mostrá este ticket en el local para que te los carguen.';

      await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }
  }

  session.cart = [];
  session.flow = null;

  await bot.sendMessage(chatId, 'Tu carrito está vacío. ¿Querés que te muestre el catálogo?', {
    reply_markup: mainMenuKeyboard()
  });
}

// 11) MANEJO DE MENSAJES DE TEXTO

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  const session = getSession(chatId);

  // Si estamos esperando una cantidad
  if (session.flow && session.flow.type === 'quantity' && session.pendingQuantity) {
    const cant = parseInt(text.replace(/\D/g, ''), 10);
    if (!cant || cant <= 0) {
      return bot.sendMessage(chatId, 'No entendí la cantidad 😅 Probá con un número, por ejemplo 250, 500 o 1000.');
    }

    const product = session.pendingQuantity.product;
    let total = 0;

    if (product.unidad === 'gramos') {
      total = (product.precioKg * cant) / 1000;
    } else {
      total = (product.precioUnidad || 0) * cant;
    }

    session.cart.push({
      id: product.id,
      nombre: product.nombre,
      unidad: product.unidad,
      cantidad: cant,
      total
    });

    session.pendingQuantity = null;
    session.flow = null;

    const { subtotal, items } = cartTotals(session.cart);

    let respuesta =
      `Listo, lo sumé a tu carrito 🛒\n` +
      `Ahora tenés *${items} producto(s)* y un subtotal de *${formatMoney(subtotal)}*.\n\n` +
      '👉 Si querés seguir mirando, tocá 🛍 *Catálogo*.\n' +
      '👉 Si ya está, tocá ✅ *Finalizar compra* y cerramos el pedido.';

    return bot.sendMessage(chatId, respuesta, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard()
    });
  }

  // Si estamos en flujo de checkout (envío / retiro / pago)
  if (session.flow && session.flow.type === 'checkout') {
    const etapa = session.flow.etapa;

    if (etapa === 'ask_address') {
      session.flow.data.direccion = text;
      session.flow.etapa = 'ask_nombre';
      return bot.sendMessage(chatId, '🧾 Decime tu *nombre* para el pedido:', { parse_mode: 'Markdown' });
    }

    if (etapa === 'ask_nombre') {
      session.flow.data.nombre = text;
      session.flow.etapa = 'ask_telefono';
      return bot.sendMessage(chatId, '📞 Pasame tu *teléfono*:', { parse_mode: 'Markdown' });
    }

    if (etapa === 'ask_telefono') {
      session.flow.data.telefono = text;
      session.flow.etapa = 'ask_horario';
      return bot.sendMessage(
        chatId,
        '⏰ ¿En qué horario te conviene pasar o recibir el envío? (ej: 17:00)',
        { parse_mode: 'Markdown' }
      );
    }

    if (etapa === 'ask_horario') {
      session.flow.data.horario = text;
      session.flow.etapa = 'pago';

      // Resumen
      let resumen = 'Perfecto! Resumen:\n\n';
      resumen += `Tipo: ${session.flow.data.entregaTipo === 'ENVÍO' ? 'Envío a domicilio 🚚' : 'Retiro en el local 🏪'}\n`;
      if (session.flow.data.direccion) resumen += `Dirección: ${session.flow.data.direccion}\n`;
      resumen += `Nombre: ${session.flow.data.nombre}\n`;
      resumen += `Teléfono: ${session.flow.data.telefono}\n`;
      resumen += `Horario: ${session.flow.data.horario}\n\n`;
      resumen += 'Ahora elegí *método de pago*:';

      const inline_keyboard = [[{ text: '💵 Efectivo', callback_data: 'pago:efectivo' }]];

      if (config.PermitirPagoOnline === 'SI' && config.TipoPagoOnline === 'TRANSFERENCIA') {
        inline_keyboard[0].push({ text: '💳 Transferencia', callback_data: 'pago:transferencia' });
      }

      return bot.sendMessage(chatId, resumen, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard }
      });
    }
  }

  // MENSAJES NORMALES (FUERA DE FLOJOS)

  const lower = text.toLowerCase();

  if (text === '/start' || lower === 'hola' || lower === 'buen día' || lower === 'buen dia') {
    return sendWelcome(chatId);
  }

  if (lower === '🛍 catálogo'.toLowerCase() || lower === 'catalogo' || lower === 'catálogo') {
    return sendCategories(chatId);
  }

  if (lower === '🛒 ver carrito'.toLowerCase() || lower === 'ver carrito') {
    return showCart(chatId);
  }

  if (lower === '✅ finalizar compra'.toLowerCase() || lower === 'finalizar compra') {
    const cart = session.cart;
    if (!cart.length) {
      return bot.sendMessage(chatId, 'Tu carrito está vacío. Primero agregá algún producto 🛒', {
        reply_markup: mainMenuKeyboard()
      });
    }

    const { subtotal, items } = cartTotals(cart);

    let texto =
      `Perfecto, cerremos tu pedido 🙌\n\n` +
      `Tenés *${items} producto(s)* y un subtotal de *${formatMoney(subtotal)}*.\n\n` +
      'Primero decime cómo querés recibirlo:';

    const inline_keyboard = [];

    if (config.UsaEnvíoDomicilio === 'SI') {
      inline_keyboard.push([{ text: '🚚 Envío a domicilio', callback_data: 'delivery:envio' }]);
    }
    if (config.UsaRetiroLocal === 'SI') {
      inline_keyboard.push([{ text: '🏪 Retiro en el local', callback_data: 'delivery:retiro' }]);
    }
    inline_keyboard.push([{ text: '❌ Cancelar', callback_data: 'delivery:cancel' }]);

    session.flow = { type: 'checkout', etapa: 'delivery_choice', data: {} };

    return bot.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard }
    });
  }

  if (lower === '📍 horarios y dirección'.toLowerCase() || lower.includes('horario')) {
    const info =
      `*${config.NegocioNombre}*\n` +
      `🕒 ${config.Horarios}\n` +
      `📍 ${config.Dirección}\n` +
      (config.Instagram && config.Instagram !== 'NO' ? `📸 ${config.Instagram}\n` : '') +
      `📞 +${config.TeléfonoNegocio}`;

    return bot.sendMessage(chatId, info, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
  }

  if (lower === '📣 compartir bot'.toLowerCase() || lower.includes('compartir')) {
    if (config.CompartirBotActivo !== 'SI') {
      return bot.sendMessage(chatId, 'Por ahora este bot no está disponible para compartir 🙈', {
        reply_markup: mainMenuKeyboard()
      });
    }

    const baseText = `${config.TextoCompartirBot} 🧀\n\nLink directo del bot:\n${BOT_PUBLIC_LINK}`;

    const wa = `https://wa.me/?text=${encodeURIComponent(baseText)}`;
    const tg = `https://t.me/share/url?url=${encodeURIComponent(BOT_PUBLIC_LINK)}&text=${encodeURIComponent(baseText)}`;
    const mail = `mailto:?subject=${encodeURIComponent(
      `Recomendación - ${config.NegocioNombre}`
    )}&body=${encodeURIComponent(baseText)}`;

    const inline_keyboard = [
      [{ text: '📲 Compartir por WhatsApp', url: wa }],
      [{ text: '✉️ Compartir por Email', url: mail }],
      [{ text: '📨 Compartir por Telegram', url: tg }]
    ];

    return bot.sendMessage(chatId, baseText, {
      reply_markup: { inline_keyboard }
    });
  }

  if (lower === '🎟 mis sellos'.toLowerCase() || lower.includes('sellos')) {
    if (config.UsaSellos !== 'SI') {
      return bot.sendMessage(chatId, 'Este negocio todavía no usa sellos digitales.', {
        reply_markup: mainMenuKeyboard()
      });
    }

    let texto =
      '🎟 *Todo Queso Club*\n\n' +
      'Cada compra suma sellos según el monto. Cuando llegues a cada nivel, podés canjear tu beneficio.\n\n' +
      `Monto por sello: *${formatMoney(config.MontoPorSello)}*\n\n`;

    const nombres = config.NombresNiveles.split('|').map((s) => s.trim());
    const sellos = config.SellosPorNivel.split('|').map((s) => s.trim());
    const beneficios = config.BeneficiosPorNivel.split('|').map((s) => s.trim());

    nombres.forEach((nom, i) => {
      if (!nom) return;
      texto += `• *${nom}*: ${sellos[i] || '?'} sellos → ${beneficios[i] || ''}\n`;
    });

    texto += '\n*Mostrá tu tarjeta en el local para ver cuántos sellos tenés.*';

    if (config.TarjetaURL) {
      await bot.sendPhoto(chatId, config.TarjetaURL, {
        caption: texto,
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard()
      });
    } else {
      await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    }

    return;
  }

  // Cualquier otra cosa: recordar menú
  return bot.sendMessage(chatId, 'No te entendí bien, pero acá tenés el menú 😊', {
    reply_markup: mainMenuKeyboard()
  });
});

console.log('EzerBot Todo Queso iniciado con éxito');
