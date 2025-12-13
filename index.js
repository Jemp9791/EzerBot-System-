import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // tu URL base de Render (sin /webhook)
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");

// ===== App =====
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true, mode: WEBHOOK_URL ? "webhook" : "polling" }));

// ===== Bot init =====
const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });

// Logs de errores (para que no quede “mudo”)
bot.on("polling_error", (err) => console.error("polling_error:", err?.message || err));
bot.on("webhook_error", (err) => console.error("webhook_error:", err?.message || err));
bot.on("error", (err) => console.error("bot_error:", err?.message || err));

// ===== Webhook route =====
if (WEBHOOK_URL) {
  const path = "/webhook";
  const full = WEBHOOK_URL.replace(/\/$/, "") + path;

  bot.setWebHook(full)
    .then(() => console.log("✅ Webhook seteado en:", full))
    .catch((e) => console.error("❌ Error setWebHook:", e?.message || e));

  app.post(path, (req, res) => {
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (e) {
      console.error("processUpdate error:", e?.message || e);
      res.sendStatus(200);
    }
  });
}

app.listen(PORT, () => console.log("Server up on", PORT, "| mode:", WEBHOOK_URL ? "webhook" : "polling"));

// ===================== Estado simple en memoria =====================
const stateByChatId = new Map();
function getState(chatId) {
  if (!stateByChatId.has(chatId)) {
    stateByChatId.set(chatId, {
      mode: "idle",
      categories: [],
      productos: [],
      currentCategory: null,
      pageIndex: 0,
      pendingProduct: null,
      cart: [],
      cfg: null,
      lastCfgTs: 0,
    });
  }
  return stateByChatId.get(chatId);
}

// ===================== Helpers UI =====================
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "🎁 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
        [{ text: "🔄 Recargar catálogo" }],
      ],
      resize_keyboard: true,
    },
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  const pretty = (c) => {
    const s = String(c || "").toLowerCase();
    if (s.includes("ques")) return "🧀 Quesos";
    if (s.includes("fiam")) return "🍖 Fiambres";
    if (s.includes("lact")) return "🥛 Lácteos";
    if (s.includes("pan")) return "🥖 Panificados";
    if (s.includes("promo")) return "🎁 Promos";
    return "📦 " + c;
  };

  const mapped = categories.map((c) => ({ raw: c, label: pretty(c) }));

  for (let i = 0; i < mapped.length; i += 2) {
    const row = [{ text: mapped[i].label }];
    if (mapped[i + 1]) row.push({ text: mapped[i + 1].label });
    rows.push(row);
  }

  rows.push([{ text: "🏠 Menú" }]);

  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

function navInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️ Anterior", callback_data: "NAV_PREV" },
          { text: "📂 Categorías", callback_data: "NAV_CATS" },
          { text: "➡️ Siguiente", callback_data: "NAV_NEXT" },
        ],
      ],
    },
  };
}

function productInlineKeyboard(prod) {
  const code = prod.codigo;
  const shareText = encodeURIComponent(
    `🛍️ ${prod.nombre}\n💵 $${formatARS(displayPrice(prod))} ARS\n🆔 ${code}\n\nPedilo desde el bot 👇`
  );

  const tgShare = `https://t.me/share/url?url=${encodeURIComponent("https://t.me/share/url")}&text=${shareText}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `BUY:${code}` },
          { text: "📣 Compartir promo", url: tgShare },
        ],
        [{ text: "↩️ Volver a categorías", callback_data: "NAV_CATS" }],
      ],
    },
  };
}

function cartInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT" }],
        [
          { text: "🛍️ Seguir comprando", callback_data: "NAV_CATS" },
          { text: "🧹 Vaciar carrito", callback_data: "CART_CLEAR" },
        ],
      ],
    },
  };
}

function deliveryInlineKeyboard(cfg) {
  const rows = [];
  if (isTrue(cfg.UsaEnvíoDomicilio)) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY_HOME" }]);
  if (isTrue(cfg.UsaRetiroLocal)) rows.push([{ text: "🏪 Retiro en el local", callback_data: "DELIVERY_PICKUP" }]);
  rows.push([{ text: "↩️ Volver al carrito", callback_data: "BACK_TO_CART" }]);

  return { reply_markup: { inline_keyboard: rows } };
}

function formatARS(n) {
  const num = Number(n || 0);
  return new Intl.NumberFormat("es-AR").format(num);
}

function isTrue(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "si" || s === "sí" || s === "true" || s === "1" || s === "on";
}

function displayPrice(prod) {
  // si trae precio por kg, mostramos ese, sino precio
  const ppk = Number(prod.precioporkg || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// ===================== Fetch GAS (cache) =====================
let cacheCatalog = { ts: 0, data: null };
async function fetchCatalog(force = false) {
  const now = Date.now();
  if (!force && cacheCatalog.data && now - cacheCatalog.ts < 30_000) return cacheCatalog.data;

  const res = await fetch(GAS_URL, { method: "GET" });
  const json = await res.json();

  if (!json || json.ok !== true || !Array.isArray(json.productos)) {
    return { ok: false, productos: [], debug: json?.debug };
  }

  cacheCatalog = { ts: now, data: json };
  return json;
}

async function fetchConfig(force = false) {
  const now = Date.now();
  const url = GAS_URL.includes("?") ? `${GAS_URL}&type=config` : `${GAS_URL}?type=config`;

  // cache por chat en estado (mejor por multi-tenant después)
  // acá cache global simple:
  if (!force && globalThis.__cfgCache && now - globalThis.__cfgCache.ts < 30_000) return globalThis.__cfgCache.cfg;

  const res = await fetch(url, { method: "GET" });
  const json = await res.json();
  const cfg = (json && json.ok && json.config) ? json.config : {};

  globalThis.__cfgCache = { ts: now, cfg };
  return cfg;
}

function normalizeCategoryLabelToRaw(state, label) {
  const plain = String(label).replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
  const raw =
    state.categories.find((c) => String(c).toLowerCase().includes(plain)) ||
    state.categories.find((c) => plain.includes(String(c).toLowerCase()));
  if (raw) return raw;

  const possible = label.replace(/^.*?\s/, "");
  return state.categories.find((c) => String(c).toLowerCase() === String(possible).toLowerCase()) || null;
}

function isKgUnit(prod) {
  const u = String(prod.unidad || "").toLowerCase();
  return u.includes("kg") || u.includes("kilo");
}

function priceForProduct(prod) {
  const ppk = Number(prod.precioporkg || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// ===================== Render catálogo (más tolerante) =====================
async function showCategories(chatId, force = false) {
  const state = getState(chatId);
  const data = await fetchCatalog(force);

  // ⚠️ CAMBIO CLAVE: ya NO filtramos por imagen obligatoria.
  // Si falta imagen, lo mostramos igual (y el envío usa mensaje en vez de foto).
  const productos = (data.productos || []).filter(
    (p) => p && p.categoria && p.codigo && p.nombre && (Number(p.precio || 0) > 0 || Number(p.precioporkg || 0) > 0)
  );

  const categories = [...new Set(productos.map((p) => String(p.categoria).trim()).filter(Boolean))];

  state.productos = productos;
  state.categories = categories;
  state.currentCategory = null;
  state.pageIndex = 0;
  state.mode = "catalog";

  if (!categories.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ No estoy encontrando categorías válidas en tu catálogo.\n\nProbá: /diag\n(Te dice cuántos productos llegan desde GAS y por qué se caen).",
      mainMenuKeyboard()
    );
    return;
  }

  await bot.sendMessage(chatId, "📂 Elegí una categoría:", categoriesKeyboard(categories));
}

async function showCategoryPage(chatId, category, pageIndex) {
  const state = getState(chatId);
  const items = state.productos.filter(
    (p) => String(p.categoria).trim().toLowerCase() === String(category).trim().toLowerCase()
  );

  if (!items.length) {
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos visibles todavía.", categoriesKeyboard(state.categories));
    return;
  }

  const pageSize = 3;
  const pages = Math.ceil(items.length / pageSize);
  const safeIndex = Math.max(0, Math.min(pageIndex, pages - 1));
  state.pageIndex = safeIndex;
  state.currentCategory = category;

  await bot.sendMessage(chatId, `🧾 ${category} — Página ${safeIndex + 1}/${pages}`, removeKeyboard());

  const slice = items.slice(safeIndex * pageSize, safeIndex * pageSize + pageSize);

  for (const prod of slice) {
    const caption =
      `${prod.nombre}\n` +
      `💵 $${formatARS(displayPrice(prod))} ARS\n` +
      `🆔 ${prod.codigo}`;

    if (prod.imagen && String(prod.imagen).startsWith("http")) {
      await bot.sendPhoto(chatId, prod.imagen, { caption, ...productInlineKeyboard(prod) });
    } else {
      await bot.sendMessage(chatId, caption, productInlineKeyboard(prod));
    }
  }

  await bot.sendMessage(chatId, "🧭 Navegación:", navInlineKeyboard());
}

// ===================== Carrito =====================
function cartTotal(state) {
  return state.cart.reduce((acc, x) => acc + Number(x.subtotal || 0), 0);
}

function cartText(state) {
  if (!state.cart.length) return "🛒 Tu carrito está vacío.";

  const lines = state.cart.map((x, i) => {
    return `${i + 1}) ${x.nombre} (${x.codigo})\n   Cantidad: ${x.cantidadText}\n   Subtotal: $${formatARS(x.subtotal)} ARS`;
  });

  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${formatARS(cartTotal(state))} ARS`;
}

function buildTicketText(cfg, ticketNo, itemsText, subtotal, deliveryLabel, deliveryCost, total) {
  const negocio = cfg.NegocioNombre || "Tu Negocio";
  const alias = cfg.AliasPago ? String(cfg.AliasPago) : "-";
  const cbu = cfg.CBUPago ? String(cfg.CBUPago) : "-";
  const msgPost = cfg.MensajePostCompra ? String(cfg.MensajePostCompra) : "¡Gracias por tu compra!";

  return (
    `🧾 *${negocio}*\n` +
    `Ticket N° *${ticketNo}*\n` +
    `📅 ${new Date().toLocaleString("es-AR")}\n\n` +
    `${itemsText}\n\n` +
    `💰 Subtotal: *$${formatARS(subtotal)} ARS*\n` +
    `${deliveryLabel ? `🚚 ${deliveryLabel}: *$${formatARS(deliveryCost)} ARS*\n` : ""}` +
    `🧾 *TOTAL: $${formatARS(total)} ARS*\n\n` +
    `🏦 Alias: *${alias}*\n` +
    `🏦 CBU: *${cbu}*\n\n` +
    `📩 *Enviá el comprobante* para preparar tu pedido.\n\n` +
    `${msgPost}`
  );
}

// ===================== Info local (CON LOGO desde Config) =====================
async function sendBusinessInfo(chatId) {
  const cfg = await fetchConfig(false);

  const nombre = cfg.NegocioNombre || "Todo Queso";
  const direccion = cfg.Dirección || cfg.Direccion || "-";
  const horarios = cfg.Horarios || "-";
  const tel = cfg.TeléfonoNegocio || cfg.TelefonoNegocio || "-";
  const desc = cfg.Descripcion || "";
  const ig = cfg.Instagram || "";
  const fb = cfg.Facebook || "";
  const wa = cfg.WhatsAppLink || "";

  const lines = [
    `🏪 *${nombre}*`,
    `📍 ${direccion}`,
    `🕒 ${horarios}`,
    `📞 ${tel}`,
    desc ? `\n${desc}` : "",
    ig ? `\n📷 Instagram: ${ig}` : "",
    fb ? `\n📘 Facebook: ${fb}` : "",
  ].filter(Boolean).join("\n");

  // Si hay LogoURL, lo mostramos como foto (como querés)
  const logo = String(cfg.LogoURL || "").trim();
  if (logo && logo.startsWith("http")) {
    await bot.sendPhoto(chatId, logo, {
      caption: lines,
      parse_mode: "Markdown",
      reply_markup: wa
        ? { inline_keyboard: [[{ text: "📲 Hablar por WhatsApp", url: wa }]] }
        : undefined,
    });
  } else {
    await bot.sendMessage(chatId, lines, {
      parse_mode: "Markdown",
      reply_markup: wa
        ? { inline_keyboard: [[{ text: "📲 Hablar por WhatsApp", url: wa }]] }
        : undefined,
    });
  }
}

// ===================== Comandos =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);
  state.mode = "idle";

  const cfg = await fetchConfig(false);
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const logo = String(cfg.LogoURL || "").trim();

  const welcome =
    `Hola Jenny 👋\n` +
    `Soy el asistente de *${nombre}* 🧀\n\n` +
    `Desde acá podés:\n• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra\n\n👇 Elegí una opción`;

  // Si hay logo, arrancamos con el logo visible
  if (logo && logo.startsWith("http")) {
    await bot.sendPhoto(chatId, logo, { caption: welcome, parse_mode: "Markdown", ...mainMenuKeyboard() });
  } else {
    await bot.sendMessage(chatId, welcome, { parse_mode: "Markdown", ...mainMenuKeyboard() });
  }
});

bot.onText(/\/ping/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "🏓 Pong. Estoy online ✅");
});

// ✅ Diagnóstico: te dice qué devuelve GAS (si el problema es data)
bot.onText(/\/diag/, async (msg) => {
  const chatId = msg.chat.id;
  const url = GAS_URL.includes("?") ? `${GAS_URL}&type=catalogo` : `${GAS_URL}?type=catalogo`;
  try {
    const res = await fetch(url);
    const json = await res.json();

    const productos = (json && json.productos) ? json.productos : [];
    const cats = [...new Set(productos.map(p => String(p?.categoria || "").trim()).filter(Boolean))];

    const lines = [
      `🔎 DIAG GAS`,
      `• ok: ${json?.ok === true ? "true" : "false"}`,
      `• productos: ${productos.length}`,
      `• categorías: ${cats.length} ${cats.length ? `(${cats.slice(0, 8).join(", ")}${cats.length > 8 ? ", ..." : ""})` : ""}`,
      json?.debug ? `• debug.kept: ${json.debug.kept} | dropped: ${json.debug.dropped}` : "",
      json?.debug?.reasons ? `• reasons: ${JSON.stringify(json.debug.reasons)}` : "",
    ].filter(Boolean).join("\n");

    await bot.sendMessage(chatId, lines);
  } catch (e) {
    await bot.sendMessage(chatId, "❌ /diag error: " + (e?.message || String(e)));
  }
});

// ===================== Mensajes =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const state = getState(chatId);

  // Esperando cantidad (kg)
  if (state.mode === "await_qty" && state.pendingProduct) {
    const prod = state.pendingProduct;

    const raw = text.toLowerCase().replace(",", ".").replace(/\s+/g, "");
    let grams = null;

    const kgMatch = raw.match(/^(\d+(\.\d+)?)kg$/);
    const gMatch = raw.match(/^(\d+(\.\d+)?)g$/);
    const numMatch = raw.match(/^(\d+(\.\d+)?)$/);

    if (kgMatch) grams = Math.round(Number(kgMatch[1]) * 1000);
    else if (gMatch) grams = Math.round(Number(gMatch[1]));
    else if (numMatch) grams = Math.round(Number(numMatch[1]));
    else grams = null;

    if (!grams || grams <= 0) {
      await bot.sendMessage(chatId, "⚠️ Decime la cantidad en gramos o kilos.\nEj: 250g / 0.5kg / 500", removeKeyboard());
      return;
    }

    const unitPrice = priceForProduct(prod); // precio por kg
    const subtotal = Math.round((grams / 1000) * unitPrice);

    state.cart.push({
      codigo: prod.codigo,
      nombre: prod.nombre,
      unidad: "kg",
      precioUnit: unitPrice,
      cantidad: grams,
      cantidadText: `${grams} g`,
      subtotal,
    });

    state.pendingProduct = null;
    state.mode = "catalog";

    await bot.sendMessage(chatId, `✅ Agregado al carrito:\n${prod.nombre}\nCantidad: ${grams} g\nSubtotal: $${formatARS(subtotal)} ARS\n\n¿Sumamos algo más? 😁`, cartInlineKeyboard());
    return;
  }

  // Menú principal
  if (text === "🛍️ Catálogo" || text === "Catálogo") {
    await showCategories(chatId, false);
    return;
  }

  if (text === "🔄 Recargar catálogo") {
    cacheCatalog = { ts: 0, data: null };
    await bot.sendMessage(chatId, "🔄 Listo. Recargando catálogo…");
    await showCategories(chatId, true);
    return;
  }

  if (text === "🛒 Mi carrito" || text === "Mi carrito") {
    await bot.sendMessage(chatId, cartText(state), cartInlineKeyboard());
    return;
  }

  if (text === "🏠 Menú" || text === "Menú") {
    await bot.sendMessage(chatId, "🏠 Menú principal:", mainMenuKeyboard());
    return;
  }

  // Categorías
  if (state.mode === "catalog" && state.categories.length) {
    const rawCat = normalizeCategoryLabelToRaw(state, text);
    if (rawCat) {
      await showCategoryPage(chatId, rawCat, 0);
      return;
    }
  }

  if (text === "💬 Hablar con el vendedor") {
    const cfg = await fetchConfig(false);
    const wa = String(cfg.WhatsAppLink || "").trim();
    if (wa) {
      await bot.sendMessage(chatId, "Hablá con nosotros por WhatsApp 👇", {
        reply_markup: { inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: wa }]] },
      });
    } else {
      await bot.sendMessage(chatId, "💬 WhatsAppLink no está configurado en Config todavía.");
    }
    return;
  }

  if (text === "🏪 Información del local") {
    await sendBusinessInfo(chatId);
    return;
  }

  if (text === "📣 Compartir el bot") {
    const cfg = await fetchConfig(false);
    const texto = cfg.TextoCompartirBot || "📣 Compartí el bot desde el botón de compartir de Telegram.";
    await bot.sendMessage(chatId, String(texto), mainMenuKeyboard());
    return;
  }

  if (text === "🎁 Mis sellos") {
    await bot.sendMessage(chatId, "Tu tarjeta de sellos todavía no está visible en este módulo.\nLa activamos en el siguiente paso (sellos/niveles).", mainMenuKeyboard());
    return;
  }
});

// ===================== Callbacks =====================
bot.on("callback_query", async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const state = getState(chatId);

  try {
    if (data === "NAV_CATS") {
      await bot.answerCallbackQuery(cq.id);
      await showCategories(chatId, false);
      return;
    }

    if (data === "NAV_NEXT" || data === "NAV_PREV") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.currentCategory) return showCategories(chatId, false);

      const items = state.productos.filter(
        (p) => String(p.categoria).trim().toLowerCase() === String(state.currentCategory).trim().toLowerCase()
      );
      const pageSize = 3;
      const pages = Math.ceil(items.length / pageSize);
      const delta = data === "NAV_NEXT" ? 1 : -1;

      let nextIndex = state.pageIndex + delta;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex > pages - 1) nextIndex = pages - 1;

      await showCategoryPage(chatId, state.currentCategory, nextIndex);
      return;
    }

    if (data.startsWith("BUY:")) {
      await bot.answerCallbackQuery(cq.id);
      const code = data.split(":")[1];
      const prod = state.productos.find((p) => String(p.codigo) === String(code));
      if (!prod) return bot.sendMessage(chatId, "⚠️ No encontré ese producto en el catálogo.");

      if (isKgUnit(prod)) {
        state.mode = "await_qty";
        state.pendingProduct = prod;
        await bot.sendMessage(chatId, `🧀 Elegiste: ${prod.nombre} (${prod.codigo})\nDecime la cantidad.\nEj: 250g / 0.5kg / 500`, removeKeyboard());
        return;
      } else {
        const subtotal = Number(prod.precio || 0);
        state.cart.push({
          codigo: prod.codigo,
          nombre: prod.nombre,
          unidad: prod.unidad || "unidad",
          precioUnit: Number(prod.precio || 0),
          cantidad: 1,
          cantidadText: "1",
          subtotal,
        });
        await bot.sendMessage(chatId, `✅ Agregado al carrito:\n${prod.nombre}\nSubtotal: $${formatARS(subtotal)} ARS\n\n¿Sumamos algo más? 😁`, cartInlineKeyboard());
        return;
      }
    }

    if (data === "CART_CLEAR") {
      await bot.answerCallbackQuery(cq.id);
      state.cart = [];
      await bot.sendMessage(chatId, "🧹 Listo. Carrito vacío.", mainMenuKeyboard());
      return;
    }

    // ✅ CHECKOUT (A): pregunta envío/retiro usando Config
    if (data === "CHECKOUT") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.cart.length) return bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenuKeyboard());

      const cfg = await fetchConfig(false);
      const subtotal = cartTotal(state);

      const msg =
        `🧾 *Finalizar compra*\n\n` +
        `${cartText(state)}\n\n` +
        `¿Cómo querés recibir tu pedido?`;

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...deliveryInlineKeyboard(cfg) });
      return;
    }

    if (data === "BACK_TO_CART") {
      await bot.answerCallbackQuery(cq.id);
      await bot.sendMessage(chatId, cartText(state), cartInlineKeyboard());
      return;
    }

    // Entrega: envío / retiro -> arma ticket
    if (data === "DELIVERY_HOME" || data === "DELIVERY_PICKUP") {
      await bot.answerCallbackQuery(cq.id);
      const cfg = await fetchConfig(false);

      const subtotal = cartTotal(state);
      const deliveryCost = (data === "DELIVERY_HOME") ? Number(cfg.CostoEnvíoBase || cfg.CostoEnvioBase || 0) : 0;
      const total = subtotal + deliveryCost;

      const ticketNo = `TQ-${Math.floor(100000 + Math.random() * 900000)}`;

      const itemsText = state.cart.map(x =>
        `• ${x.nombre} (${x.cantidadText})  $${formatARS(x.subtotal)} ARS`
      ).join("\n");

      // textos desde Config
      if (data === "DELIVERY_HOME") {
        const t = cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "🚚 Tu envío será coordinado por WhatsApp.";
        await bot.sendMessage(chatId, String(t));
      } else {
        const t = cfg.TextoRetiroLocal || "🏪 Tu pedido será preparado y podés pasar a retirarlo.";
        await bot.sendMessage(chatId, String(t));
      }

      const ticket = buildTicketText(
        cfg,
        ticketNo,
        itemsText,
        subtotal,
        data === "DELIVERY_HOME" ? "Envío" : "Retiro",
        deliveryCost,
        total
      );

      await bot.sendMessage(chatId, ticket, { parse_mode: "Markdown", ...mainMenuKeyboard() });

      // por ahora NO guardo pedido en Sheets (lo hacemos en B cuando avisamos al vendedor)
      // y también dejamos el carrito (si querés, lo vaciamos después de confirmar pago)
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    console.error(e);
    try { await bot.answerCallbackQuery(cq.id); } catch (_) {}
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error interno. Probá de nuevo.");
  }
});
