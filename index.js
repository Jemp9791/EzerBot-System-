// Estado por usuario: catálogo tipo libro + carrito + checkout
const userState = new Map(); // chatId -> state

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      catFilter: "ALL",
      // "Book view" (1 producto por vez)
      bookIndex: 0,
      bookMsgId: null,
      bookHasPhoto: false,
      cart: new Map(), // code -> { prod, qty }
      awaitingQtyFor: null, // code
      flow: null, // checkout object
    });
  }
  return userState.get(chatId);
}

function moneyARS(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  // Acepta "kg", "kilo", "kilos", etc.
  if (s.includes("kg") || s.includes("kilo")) return "kg";
  return "unidad";
}

function qtyStepForUnit(unit) {
  return unit === "kg" ? 0.1 : 1;
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100; // 2 dec
  return Math.round(n);
}

function pickFirstNumber(v, fallback = 10) {
  const s = safeStr(v);
  if (!s) return fallback;
  // si viene "10|30|50" o "10,30,50"
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return isFinite(n) && n > 0 ? n : fallback;
}

// =====================
// 5) UI builders
// =====================
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir el bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = safeStr(cfg.NegocioNombre) || "Mi negocio";
  const dir = safeStr(cfg.Direccion) || "Dirección no configurada";
  const hor = safeStr(cfg.Horarios) || "Horarios no configurados";
  const tel = safeStr(cfg.TelefonoNegocio) || "Teléfono no configurado";
  const ig = safeStr(cfg.Instagram) || "";
  const logo = safeStr(cfg.LogoURL);

  // Saludo configurable (si existe en Config)
  const saludoConfig = safeStr(cfg.SaludoInicial) || safeStr(cfg.TextoSaludo) || "";
  const saludoDefault = `¡Hola! 👋 Bienvenid@ a *${negocio}* 🧀✨\nElegí del *Catálogo*, armá tu carrito y confirmá en 1 minuto. ¿Arrancamos? 😄`;

  let text = "";
  if (saludoConfig) text += `${saludoConfig}\n\n`;
  else text += `${saludoDefault}\n\n`;

  text += `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig && ig.toUpperCase() !== "NO") text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;
  const desc = safeStr(cfg.Descripcion);
  if (desc) text += `\n${desc}\n`;
  text += `\nElegí una opción del menú para empezar 👇`;

  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {
      // fallback
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

function shareInlineButtons(cfg = {}) {
  // Permite configurar el link del bot desde Config (si querés)
  const botLink = safeStr(cfg.BotLink) || safeStr(cfg.LinkBot) || "https://t.me/EzerBot";
  const waText = encodeURIComponent(`Pedí por el bot 🧀👇\n${botLink}`);
  const mailSubj = encodeURIComponent("Te comparto el bot para pedir");
  const mailBody = encodeURIComponent(`Hola! Te comparto el bot para pedir:\n${botLink}`);

  return {
    inline_keyboard: [
      [{ text: "💬 WhatsApp", url: `https://wa.me/?text=${waText}` }],
      [
        {
          text: "✈️ Telegram",
          url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("Pedí por el bot:")}`,
        },
      ],
      [{ text: "📧 Email", url: `mailto:?subject=${mailSubj}&body=${mailBody}` }],
    ],
  };
}

async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = (safeStr(cfg.UsaSellos) || "NO").toUpperCase() === "SI";

  // OJO: en tu Config se ve "SelloURL" como URL a imagen, y también tenés "TarjetaURL"
  const cardUrl = safeStr(cfg.TarjetaURL) || safeStr(cfg.SelloURL);
  // Premio: si tenés algo tipo BeneficioSellos o BeneficioNivel, usar eso primero
  const premio =
    safeStr(cfg.PremioSellos) ||
    safeStr(cfg.BeneficioSellos) ||
    safeStr(cfg.BeneficioCumple) ||
    "Premio configurable";

  // Evita NaN si viene "10|30|50"
  const meta = pickFirstNumber(cfg.SellosPorNivel, 10);

  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Por ahora queda en 0 (como estaba), después lo conectás por cliente
  const sellos = 0;

  const bar = "🟩".repeat(Math.min(sellos, meta)) + "⬜".repeat(Math.max(0, meta - sellos));

  const text =
    `🎫 *Tarjeta de sellos*\n\n` +
    `${bar}\n\n` +
    `Sellos: *${sellos} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: cada compra confirmada suma 1 sello automático.`;

  if (cardUrl) {
    try {
      await bot.sendPhoto(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {
      // fallback
    }
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 6) CATÁLOGO (tipo libro con imágenes)
// =====================
function uniqueCategories(list) {
  const set = new Set();
  for (const p of list) {
    const c = safeStr(p.categoria);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function filterCatalog(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter((p) => safeStr(p.categoria) === filter);
}

function productCaption(p, idx, total, filterLabel) {
  const nombre = safeStr(p.nombre);
  const precio = Number(p.precio || 0);
  const unidad = normalizeUnit(p.unidad);
  const extra = unidad === "kg" ? " (x kg)" : "";
  const desc = safeStr(p.descripcion);

  let cap = `🛍️ *Catálogo*${filterLabel ? ` — _${filterLabel}_` : ""}\n`;
  cap += `📖 Producto *${idx + 1}* de *${total}*\n\n`;
  cap += `🧀 *${nombre}*\n`;
  cap += `💰 ${moneyARS(precio)}${extra}\n`;
  cap += `📦 Unidad: *${unidad === "kg" ? "Pesable (kg)" : "Por unidad"}*\n`;
  if (desc) cap += `\n📝 ${desc}\n`;
  return cap;
}

function bookButtons(st, canPrev, canNext, code) {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "BOOK:PREV" },
        { text: "➕ Quiero este", callback_data: `BOOK:ADD:${code}` },
        { text: "➡️", callback_data: "BOOK:NEXT" },
      ],
      [
        { text: "📤 Compartir", callback_data: `BOOK:SHARE:${code}` },
        { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
      ],
      [
        { text: "🏷️ Categorías", callback_data: "BOOK:CATS" },
      ],
    ].map((row) => row.filter(Boolean)),
  };
}

async function renderBook(chatId, forceNewMessage = false) {
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filterCatalog(full, st.catFilter);
  const cats = uniqueCategories(full);

  if (!list.length) {
    await bot.sendMessage(chatId, "Por ahora no hay productos cargados en el catálogo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (st.bookIndex < 0) st.bookIndex = 0;
  if (st.bookIndex >= list.length) st.bookIndex = list.length - 1;

  const p = list[st.bookIndex];
  const code = safeStr(p.codigo || p.id);
  const img = safeStr(p.imagen); // importante: en tu sheet la col se llama IMAGEN
  const caption = productCaption(p, st.bookIndex, list.length, st.catFilter !== "ALL" ? st.catFilter : "");
  const canPrev = st.bookIndex > 0;
  const canNext = st.bookIndex < list.length - 1;

  // Botones con navegación
  const markup = bookButtons(st, canPrev, canNext, code);

  // Si no hay imagen -> mensaje normal (igual editable con editMessageText)
  if (!img) {
    // Intento editar si tengo msgId y no forzo nuevo
    if (st.bookMsgId && !forceNewMessage) {
      try {
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: st.bookMsgId,
          parse_mode: "Markdown",
          reply_markup: markup,
        });
        st.bookHasPhoto = false;
        return;
      } catch {
        // si falla, cae a enviar nuevo
      }
    }
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: markup });
    st.bookMsgId = sent.message_id;
    st.bookHasPhoto = false;
    return;
  }

  // Con imagen: preferimos editar la misma "página" para no ensuciar el chat
  if (st.bookMsgId && !forceNewMessage) {
    try {
      // Si el mensaje anterior tenía foto: editMessageMedia
      if (st.bookHasPhoto) {
        await bot.editMessageMedia(
          {
            type: "photo",
            media: img,
            caption,
            parse_mode: "Markdown",
          },
          {
            chat_id: chatId,
            message_id: st.bookMsgId,
            reply_markup: markup,
          }
        );
        return;
      }

      // Si el anterior era texto y ahora es foto, a veces Telegram no deja cambiar tipo:
      // En ese caso mandamos uno nuevo y guardamos msgId.
    } catch {
      // fallback a nuevo
    }
  }

  // Enviar nuevo con foto
  const sent = await bot.sendPhoto(chatId, img, {
    caption,
    parse_mode: "Markdown",
    reply_markup: markup,
  });
  st.bookMsgId = sent.message_id;
  st.bookHasPhoto = true;

  // Opcional: mostramos categorías (solo si el usuario las pide con botón)
  // (Para no recargar el chat)
}

async function sendCategoriesInline(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  if (!cats.length) {
    await bot.sendMessage(chatId, "No hay categorías cargadas todavía.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Armamos filas de 3 botones para que no quede gigante
  const rows = [];
  const allBtn = [{ text: "📚 Todas", callback_data: "CATF:ALL" }];
  rows.push(allBtn);

  let row = [];
  for (const c of cats) {
    row.push({ text: c.slice(0, 14), callback_data: `CATF:${c}` });
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  rows.push([{ text: "⬅️ Volver al catálogo", callback_data: "OPEN:CAT" }]);

  await bot.sendMessage(chatId, "🏷️ Elegí una categoría:", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function addToCart(chatId, code, askQty = true) {
  const st = getState(chatId);
  const catalog = await getCatalog();
  const prod = catalog.find((p) => safeStr(p.codigo || p.id) === code);

  if (!prod) {
    await bot.sendMessage(chatId, "No encontré ese producto en el catálogo. Probá de nuevo desde *Catálogo*.", {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Si pedimos cantidad, dejamos esperando
  if (askQty) {
    // Aseguramos que exista en carrito con qty temporal
    if (!st.cart.has(code)) st.cart.set(code, { prod, qty: 0 });

    st.awaitingQtyFor = code;

    const unit = normalizeUnit(prod.unidad);
    if (unit === "kg") {
      await bot.sendMessage(
        chatId,
        `✅ Elegiste *${safeStr(prod.nombre)}*.\n\n🧀 Es *pesable*.\nEscribí cuánto querés (en kg o gramos).\nEjemplos:\n• 0.3 (300g)\n• 0.5 (500g)\n• 1 (1kg)`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await bot.sendMessage(
        chatId,
        `✅ Elegiste *${safeStr(prod.nombre)}*.\n\n📦 Es *por unidad*.\nEscribí cuántas unidades querés.\nEjemplos:\n• 1\n• 2\n• 3`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
    }
    return;
  }

  // Si no preguntamos cantidad, sumar por step
  const unit = normalizeUnit(prod.unidad);
  const step = qtyStepForUnit(unit);

  if (st.cart.has(code)) {
    const it = st.cart.get(code);
    it.qty = roundQty(Number(it.qty) + step, unit);
    st.cart.set(code, it);
  } else {
    st.cart.set(code, { prod, qty: step });
  }

  await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(prod.nombre)}*`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 7) CARRITO
// =====================
function cartTotal(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    total += Number(prod.precio || 0) * Number(qty || 0);
  }
  return total;
}

async function showCart(chatId) {
  const st = getState(chatId);
  if (!st.cart.size) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.\n\nEntrá a *Catálogo* para agregar productos.", {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  let text = "🛒 *Tu carrito*\n\n";
  const rows = [];

  for (const [code, item] of st.cart.entries()) {
    const p = item.prod;
    const unit = normalizeUnit(p.unidad);
    const qty = item.qty;
    const lineTotal = Number(p.precio || 0) * Number(qty || 0);

    text += `• *${safeStr(p.nombre)}*\n  Cant: *${qty}* ${unit} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;

    rows.push([
      { text: "➖", callback_data: `QTY:DEC:${code}` },
      { text: "✍️ Cantidad", callback_data: `QTY:SET:${code}` },
      { text: "➕", callback_data: `QTY:INC:${code}` },
      { text: "🗑️", callback_data: `DEL:${code}` },
    ]);
  }

  text += `Total: *${moneyARS(cartTotal(st))}*`;

  const inline = {
    inline_keyboard: [
      ...rows,
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "🛍️ Seguir comprando", callback_data: "OPEN:CAT" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

  st.flow = null;
}

// =====================
// 9) HANDLERS (text)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safeStr(msg.text);
  const text = textRaw.toLowerCase();

  const st = getState(chatId);

  // Si está esperando cantidad manual:
  if (st.awaitingQtyFor) {
    const code = st.awaitingQtyFor;
    const it = st.cart.get(code);
    st.awaitingQtyFor = null;

    if (!it) {
      await bot.sendMessage(chatId, "Ese producto ya no está en el carrito.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const unit = normalizeUnit(it.prod.unidad);

    // Acepta: "300", "300g", "0.3", "0,3", "1kg"
    const raw = safeStr(textRaw).toLowerCase().replace(",", ".");
    let n = Number(raw.replace(/[^0-9.]/g, ""));

    if (!isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "Cantidad inválida. Probá con un número.\nEj: 2 (unidades) o 0.5 (kg) o 300g.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Si es kg y escribió un número grande (ej 300), lo interpretamos como gramos
    if (unit === "kg") {
      if (raw.includes("g") && !raw.includes("kg")) {
        n = n / 1000;
      } else if (n >= 10) {
        // 300 => 0.3kg
        n = n / 1000;
      }
    }

    it.qty = roundQty(n, unit);
    if (it.qty <= 0) {
      st.cart.delete(code);
      await bot.sendMessage(chatId, "🗑️ Cantidad en 0. Producto eliminado.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    st.cart.set(code, it);
    await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(it.prod.nombre)}* → *${it.qty}* ${unit}`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

    // Sugerencia suave (vendedor)
    const cfg = await getConfig();
    const suger = safeStr(cfg.TextoSugerenciaVendedor) || "💡 Tip: si querés, sumá algo más del catálogo y aprovechás el pedido 😉";
    await bot.sendMessage(chatId, suger, { reply_markup: mainMenuKeyboard() });
    // catálogo tipo libro
    st.bookIndex = 0;
    await renderBook(chatId, true);
    return;
  }
  if (textRaw === "🛒 Mi carrito") {
    await showCart(chatId);
    return;
  }
  if (textRaw === "✅ Finalizar compra") {
    startCheckout(chatId);
    return;
  }
  if (textRaw === "🎫 Tarjeta de sellos") {
    await sendStampsCard(chatId);
    return;
  }
  if (textRaw === "📣 Compartir el bot") {
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "Compartí el bot con tus contactos 👇", { reply_markup: shareInlineButtons(cfg) });
    return;
  }

  // Default: re-mostrar menú
  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
});

// =====================
// 10) HANDLERS (callbacks)
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = safeStr(q.data);
  const st = getState(chatId);

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  // Open catalog book
  if (data === "OPEN:CAT") {
    await renderBook(chatId, false);
    return;
  }

  // Categorías
  if (data === "BOOK:CATS") {
    await sendCategoriesInline(chatId);
    return;
  }

  // Filtro categoría
  if (data.startsWith("CATF:")) {
    const f = data.slice("CATF:".length);
    st.catFilter = f === "ALL" ? "ALL" : f;
    st.bookIndex = 0;
    await renderBook(chatId, true);
    return;
  }

  // Navegación del libro
  if (data === "BOOK:PREV") {
    st.bookIndex = Math.max(0, st.bookIndex - 1);
    await renderBook(chatId, false);
    return;
  }
  if (data === "BOOK:NEXT") {
    st.bookIndex = st.bookIndex + 1;
    await renderBook(chatId, false);
    return;
  }

  // Agregar producto desde libro
  if (data.startsWith("BOOK:ADD:")) {
    const code = data.slice("BOOK:ADD:".length);
    await addToCart(chatId, code, true); // pregunta cantidad según unidad
    return;
  }

  // Compartir un producto (por ahora comparte el bot; después lo hacemos producto + link)
  if (data.startsWith("BOOK:SHARE:")) {
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "📤 Compartilo por donde quieras 👇", { reply_markup: shareInlineButtons(cfg) });
    return;
  }

  // Carrito
  if (data === "OPEN:CART") {
    await showCart(chatId);
    return;
  }

  if (data.startsWith("DEL:")) {
    const code = data.slice("DEL:".length);
    st.cart.delete(code);
    await bot.sendMessage(chatId, "🗑️ Producto eliminado del carrito.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("QTY:SET:")) {
    const code = data.slice("QTY:SET:".length);
    const it = st.cart.get(code);
    if (!it) return;

    st.awaitingQtyFor = code;
    const unit = normalizeUnit(it.prod.unidad);
    const example = unit === "kg" ? "0.5 o 300g" : "2";
    await bot.sendMessage(chatId, `Escribí la cantidad para *${safeStr(it.prod.nombre)}*.\nEjemplo: ${example}`, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
