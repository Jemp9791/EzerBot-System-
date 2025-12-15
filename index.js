import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL; // Debe devolver { ok:true, config:{...}, productos:[...] }
const WEBHOOK_URL = process.env.WEBHOOK_URL; // ej: https://ezerbot-system.onrender.com
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");

// ================== APP ==================
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

// ================== BOT INIT ==================
const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });

// Si usás webhook, lo seteamos y procesamos updates
if (WEBHOOK_URL) {
  const path = "/webhook";
  bot.setWebHook(WEBHOOK_URL + path);
  app.post(path, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  // Si usás polling, por las dudas borramos webhook viejo
  bot.deleteWebHook().catch(() => {});
}

app.listen(PORT, () => console.log("Server up on", PORT));

// ================== DEBUG ==================
let lastUpdateAt = null;
let lastChatId = null;
let lastText = null;
let lastError = null;

app.get("/debug", async (_, res) => {
  try {
    const me = await bot.getMe();
    const cached = await getCachedDataSafe();
    res.status(200).json({
      ok: true,
      bootedAt: bootedAtISO(),
      bot: me,
      lastUpdateAt,
      lastChatId,
      lastText,
      lastError,
      cache: {
        hasConfig: !!cached.config,
        hasProductos: Array.isArray(cached.productos) && cached.productos.length > 0,
        categories: cached.categories || [],
      },
      webhookMode: !!WEBHOOK_URL,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

function bootedAtISO() {
  return new Date().toISOString();
}

// ================== STATE ==================
/**
 * stateByChatId:
 * {
 *   mode: "idle" | "catalog" | "await_qty" | "checkout_choose" | "checkout_done",
 *   categories: string[],
 *   productos: [],
 *   currentCategory: string|null,
 *   pageIndex: number,
 *   pendingProduct: object|null,
 *   cart: [{codigo,nombre,unidad,precioUnit,cantidad,cantidadText,subtotal}],
 *   lastTicket: string|null
 * }
 */
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
      lastTicket: null,
    });
  }
  return stateByChatId.get(chatId);
}

// ================== HELPERS ==================
function formatARS(n) {
  const num = Number(n || 0);
  return new Intl.NumberFormat("es-AR").format(num);
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function normalizeBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "si" || s === "sí" || s === "yes";
}

function nowLocalString() {
  // Argentina GMT-3 aproximado (Render corre en UTC). Igual sirve visual.
  const d = new Date();
  return d.toLocaleString("es-AR", { hour12: false });
}

function makeTicket(prefix = "TQ") {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${n}`;
}

function escapeUrl(u) {
  return encodeURIComponent(String(u || ""));
}

function guessEmojiCategory(c) {
  const s = String(c || "").toLowerCase();
  if (s.includes("promo")) return "🎁";
  if (s.includes("ques")) return "🧀";
  if (s.includes("fiam")) return "🍖";
  if (s.includes("lact")) return "🥛";
  if (s.includes("pan")) return "🥖";
  if (s.includes("beb")) return "🥤";
  if (s.includes("cafe")) return "☕";
  if (s.includes("post")) return "🍰";
  return "📦";
}

function isKgUnit(prod) {
  const u = String(prod.unidad || "").toLowerCase();
  return u.includes("kg") || u.includes("kilo") || u.includes("gram");
}

function priceForProduct(prod) {
  // Soportamos PRECIOPORKG / PRECIOPORKILO / precioporkg / precioporkilo
  const ppk =
    Number(prod.precioporkg || 0) ||
    Number(prod.precioporkilo || 0) ||
    Number(prod.precioporkilO || 0) ||
    Number(prod.PRECIOPORKG || 0) ||
    Number(prod.PRECIOPORKILO || 0);

  const p = Number(prod.precio || 0) || Number(prod.PRECIO || 0);
  return ppk > 0 ? ppk : p;
}

function cartTotal(state) {
  return state.cart.reduce((acc, x) => acc + Number(x.subtotal || 0), 0);
}

function cartText(state, moneda = "ARS") {
  if (!state.cart.length) return "🛒 Tu carrito está vacío.";

  const lines = state.cart.map((x, i) => {
    return `${i + 1}) ${x.nombre} (${x.codigo})\n   Cantidad: ${x.cantidadText}\n   Subtotal: ${moneda} $${formatARS(x.subtotal)}`;
  });

  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: ${moneda} $${formatARS(cartTotal(state))}`;
}

// ================== UI (Keyboards) ==================
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
  const mapped = categories.map((c) => ({
    raw: c,
    label: `${guessEmojiCategory(c)} ${c}`,
  }));

  for (let i = 0; i < mapped.length; i += 2) {
    const row = [{ text: mapped[i].label }];
    if (mapped[i + 1]) row.push({ text: mapped[i + 1].label });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú" }]);

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
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
    `🛍️ ${prod.nombre}\n💵 $${formatARS(prod.precio)}\n🆔 ${code}\n\nPedilo desde el bot 👇`
  );
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent("https://t.me")}&text=${shareText}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `BUY:${code}` },
          { text: "📣 Compartir promo", url: tgShare },
        ],
        [{ text: "↩️ Volver a categoría", callback_data: "NAV_CATS" }],
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

function checkoutChoiceInlineKeyboard(cfg) {
  const inline = [];
  const envioOn = normalizeBool(cfg.UsaEnvíoDomicilio);
  const retiroOn = normalizeBool(cfg.UsaRetiroLocal);

  if (envioOn) inline.push([{ text: "🚚 Envío a domicilio", callback_data: "CHECKOUT_ENVIO" }]);
  if (retiroOn) inline.push([{ text: "🏪 Retiro en el local", callback_data: "CHECKOUT_RETIRO" }]);

  inline.push([{ text: "↩️ Volver al carrito", callback_data: "BACK_TO_CART" }]);

  return { reply_markup: { inline_keyboard: inline } };
}

// ================== DATA FETCH (Config + Catalogo) ==================
let cache = { ts: 0, data: null };

async function fetchData() {
  const res = await fetch(GAS_URL, { method: "GET" });
  const json = await res.json();
  return json;
}

function normalizeProducto(p) {
  // Soportar columnas en mayúsculas como las tuyas
  return {
    codigo: p.codigo ?? p.CODIGO,
    nombre: p.nombre ?? p.NOMBRE,
    precio: Number(p.precio ?? p.PRECIO ?? 0),
    unidad: p.unidad ?? p.UNIDAD,
    precioporkg:
      p.precioporkg ??
      p.PRECIOPORKG ??
      p.precioporkilo ??
      p.PRECIOPORKILO ??
      p.PRECIOPORKILO,
    codigobarras: p.codigobarras ?? p.CODIGOBARRAS,
    descripcion: p.descripcion ?? p.DESCRIPCION,
    imagen: p.imagen ?? p.IMAGEN,
    categoria: p.categoria ?? p.CATEGORIA,
  };
}

function normalizeConfig(cfg) {
  // cfg viene con claves como las que listaste
  const c = cfg || {};
  return {
    NegocioNombre: c.NegocioNombre ?? "Tu Negocio",
    LogoURL: c.LogoURL ?? "",
    Direccion: c.Dirección ?? c.Direccion ?? "",
    Horarios: c.Horarios ?? "",
    TelefonoNegocio: c.TeléfonoNegocio ?? c.TelefonoNegocio ?? "",
    Instagram: c.Instagram ?? "",
    Facebook: c.Facebook ?? "",
    WhatsAppLink: c.WhatsAppLink ?? "",
    Descripcion: c.Descripcion ?? "",
    Moneda: c.Moneda ?? "ARS",
    CatalogoActivo: c.CatalogoActivo ?? "SI",
    CatalogoMostrarPrecios: c.CatalogoMostrarPrecios ?? "SI",

    PermitirPagoOnline: c.PermitirPagoOnline ?? "SI",
    TipoPagoOnline: c.TipoPagoOnline ?? "",
    AliasPago: c.AliasPago ?? "",
    CBUPago: c.CBUPago ?? "",
    MensajePostCompra: c.MensajePostCompra ?? "",

    UsaEnvíoDomicilio: c.UsaEnvíoDomicilio ?? "SI",
    CostoEnvíoBase: c.CostoEnvíoBase ?? "0",
    TextoEnvíoDomicilio: c.TextoEnvíoDomicilio ?? "Tu envío será coordinado por WhatsApp.",
    UsaRetiroLocal: c.UsaRetiroLocal ?? "SI",
    TextoRetiroLocal: c.TextoRetiroLocal ?? "Tu pedido se prepara y lo retirás por el local.",

    UsaSellos: c.UsaSellos ?? "NO",
    TarjetaURL: c.TarjetaURL ?? "",
    SelloURL: c.SelloURL ?? "",
    MontoPorSello: c.MontoPorSello ?? "0",

    UsaCumpleanios: c.UsaCumpleanios ?? "NO",
    MensajeCumpleCliente: c.MensajeCumpleCliente ?? "",

    ChatIdVendedor: c.ChatIdVendedor ?? "",
    TextoAvisoVendedor: c.TextoAvisoVendedor ?? "📦 Nuevo pedido. Revisar pago y preparar.",
    TextoConfirmacionPedido: c.TextoConfirmacionPedido ?? "✅ Pago confirmado. ¡Ya lo preparamos!",
    TextoCompartirBot: c.TextoCompartirBot ?? "Compartí este bot con tus amigos 😊",
  };
}

async function getCachedDataSafe(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.ts < 30_000) return cache.data;

  try {
    const json = await fetchData();

    const cfg = normalizeConfig(json?.config || {});
    const productosRaw = Array.isArray(json?.productos) ? json.productos : [];
    const productos = productosRaw
      .map(normalizeProducto)
      .filter((p) => safeStr(p.codigo) && safeStr(p.nombre) && safeStr(p.categoria) && safeStr(p.imagen));

    const categories = [...new Set(productos.map((p) => safeStr(p.categoria)).filter(Boolean))];

    cache = { ts: now, data: { ok: true, config: cfg, productos, categories } };
    return cache.data;
  } catch (e) {
    lastError = String(e?.message || e);
    // fallback mínimo
    const fallback = {
      ok: false,
      config: normalizeConfig({}),
      productos: [],
      categories: [],
    };
    cache = { ts: now, data: fallback };
    return fallback;
  }
}

// ================== MENU TEXTS (Cálido) ==================
function buildWelcomeText(cfg, firstName = "Hola") {
  const nameBiz = safeStr(cfg.NegocioNombre);
  const desc = safeStr(cfg.Descripcion);

  return (
    `Hola ${firstName} 👋\n` +
    `Soy el asistente de *${nameBiz}* 🧀\n\n` +
    (desc ? `${desc}\n\n` : "") +
    `¿Qué te gustaría hacer hoy?\n` +
    `• Ver el catálogo\n` +
    `• Armar tu pedido\n` +
    `• Finalizar compra\n\n` +
    `👇 Elegí una opción`
  );
}

function buildLocalInfoText(cfg) {
  const nameBiz = safeStr(cfg.NegocioNombre);
  const dir = safeStr(cfg.Direccion);
  const hor = safeStr(cfg.Horarios);
  const tel = safeStr(cfg.TelefonoNegocio);
  const ig = safeStr(cfg.Instagram);
  const fb = safeStr(cfg.Facebook);

  const lines = [];
  lines.push(`🏪 *${nameBiz}*`);
  if (dir) lines.push(`📍 ${dir}`);
  if (hor) lines.push(`🕒 ${hor}`);
  if (tel) lines.push(`📞 ${tel}`);
  if (ig) lines.push(`📷 Instagram: ${ig}`);
  if (fb) lines.push(`📘 Facebook: ${fb}`);

  return lines.join("\n");
}

// ================== CATEGORIES NORMALIZE ==================
function normalizeCategoryLabelToRaw(state, label) {
  const plain = String(label).replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
  const raw =
    state.categories.find((c) => String(c).toLowerCase().includes(plain)) ||
    state.categories.find((c) => plain.includes(String(c).toLowerCase()));
  if (raw) return raw;

  const possible = label.replace(/^.*?\s/, "");
  return state.categories.find((c) => String(c).toLowerCase() === String(possible).toLowerCase()) || null;
}

// ================== CATALOGO ==================
async function showCategories(chatId) {
  const state = getState(chatId);
  const data = await getCachedDataSafe(false);
  const cfg = data.config;

  state.productos = data.productos || [];
  state.categories = data.categories || [];
  state.currentCategory = null;
  state.pageIndex = 0;
  state.mode = "catalog";

  if (!state.categories.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ Todavía no veo productos/categorías.\nRevisá que tu GAS devuelva `productos` con: CODIGO, NOMBRE, PRECIO, IMAGEN, CATEGORIA (y opcional PRECIOPORKILO).",
      mainMenuKeyboard()
    );
    return;
  }

  await bot.sendMessage(chatId, "📂 Elegí una categoría:", categoriesKeyboard(state.categories));
}

async function showCategoryPage(chatId, category, pageIndex) {
  const state = getState(chatId);
  const data = await getCachedDataSafe(false);
  const cfg = data.config;
  const moneda = safeStr(cfg.Moneda) || "ARS";

  const items = state.productos.filter(
    (p) => String(p.categoria).trim().toLowerCase() === String(category).trim().toLowerCase()
  );

  if (!items.length) {
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos cargados.", categoriesKeyboard(state.categories));
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
    const showPrice = normalizeBool(cfg.CatalogoMostrarPrecios);
    const priceTxt = showPrice ? `💵 ${moneda} $${formatARS(prod.precio)}` : `💵 Consultar precio`;
    const caption = `${prod.nombre}\n${priceTxt}\n🆔 ${prod.codigo}`;

    await bot.sendPhoto(chatId, prod.imagen, {
      caption,
      ...productInlineKeyboard(prod),
    });
  }

  await bot.sendMessage(chatId, "🧭 Navegación:", navInlineKeyboard());
}

// ================== CHECKOUT (Módulo A) ==================
async function startCheckout(chatId) {
  const state = getState(chatId);
  const data = await getCachedDataSafe(false);
  const cfg = data.config;
  const moneda = safeStr(cfg.Moneda) || "ARS";

  if (!state.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenuKeyboard());
    return;
  }

  state.mode = "checkout_choose";

  const txt =
    `✅ *Finalizar compra*\n\n` +
    `${cartText(state, moneda)}\n\n` +
    `¿Cómo querés recibir tu pedido?`;

  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...checkoutChoiceInlineKeyboard(cfg) });
}

async function finalizeCheckout(chatId, tipo) {
  const state = getState(chatId);
  const data = await getCachedDataSafe(false);
  const cfg = data.config;
  const moneda = safeStr(cfg.Moneda) || "ARS";

  const envio = tipo === "envio";
  const costoEnvio = envio ? Number(cfg.CostoEnvíoBase || 0) : 0;

  const subtotal = cartTotal(state);
  const total = subtotal + costoEnvio;

  const ticketPrefix = safeStr(cfg.PrefijoCodigoCanje) || "TQ";
  const ticket = makeTicket(ticketPrefix);
  state.lastTicket = ticket;

  const alias = safeStr(cfg.AliasPago);
  const cbu = safeStr(cfg.CBUPago);

  const detalleLineas = state.cart.map((x) => `• ${x.nombre} (${x.cantidadText})  ${moneda} $${formatARS(x.subtotal)}`);

  const textoEntrega = envio ? safeStr(cfg.TextoEnvíoDomicilio) : safeStr(cfg.TextoRetiroLocal);

  const ticketText =
    `🧾 *${safeStr(cfg.NegocioNombre)}*\n` +
    `Ticket N° *${ticket}*\n` +
    `🗓️ ${nowLocalString()}\n\n` +
    `${detalleLineas.join("\n")}\n\n` +
    (envio ? `🚚 Envío: ${moneda} $${formatARS(costoEnvio)}\n` : "") +
    `💰 *TOTAL: ${moneda} $${formatARS(total)}*\n\n` +
    (alias ? `🏷️ Alias: *${alias}*\n` : "") +
    (cbu ? `🏦 CBU: *${cbu}*\n` : "") +
    `\n📩 *Enviá el comprobante* para preparar tu pedido.\n` +
    (textoEntrega ? `\n${textoEntrega}\n` : "") +
    `\n🤍 Gracias por tu compra. ¡Ya estamos con tu pedido!`;

  // Mostrar ticket estilo POS
  await bot.sendMessage(chatId, ticketText, { parse_mode: "Markdown", ...mainMenuKeyboard() });

  // (Opcional) Aviso a vendedor (Módulo B lo profundizamos después)
  const chatVendedor = safeStr(cfg.ChatIdVendedor);
  if (chatVendedor) {
    const resumen = `📦 *Nuevo pedido*\nTicket: *${ticket}*\nTotal: ${moneda} $${formatARS(total)}\nEntrega: ${envio ? "Envío" : "Retiro"}\nClienteChatId: ${chatId}`;
    bot.sendMessage(chatVendedor, `${safeStr(cfg.TextoAvisoVendedor)}\n\n${resumen}`, { parse_mode: "Markdown" }).catch(() => {});
  }

  // Vaciar carrito (si querés que quede “pendiente”, lo cambiamos)
  state.cart = [];
  state.mode = "checkout_done";
}

// ================== COMMANDS (RESPONDE A TODO) ==================
async function sendWarmMenu(chatId, msg) {
  const data = await getCachedDataSafe(false);
  const cfg = data.config;

  const firstName = msg?.from?.first_name || "Jenny";
  const logo = safeStr(cfg.LogoURL);

  // Si hay logo, lo mostramos con caption cálido
  if (logo) {
    await bot.sendPhoto(chatId, logo, {
      caption: buildWelcomeText(cfg, firstName),
      parse_mode: "Markdown",
      ...mainMenuKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, buildWelcomeText(cfg, firstName), { parse_mode: "Markdown", ...mainMenuKeyboard() });
  }
}

// ================== HANDLERS ==================

// 1) /start siempre
bot.onText(/\/start\b/i, async (msg) => {
  const chatId = msg.chat.id;
  lastUpdateAt = new Date().toISOString();
  lastChatId = chatId;
  lastText = "/start";
  try {
    const state = getState(chatId);
    state.mode = "idle";
    await sendWarmMenu(chatId, msg);
  } catch (e) {
    lastError = String(e?.message || e);
  }
});

// 2) CUALQUIER comando /loquesea => también responde (esto es lo que pediste)
bot.onText(/\/.+/i, async (msg) => {
  const chatId = msg.chat.id;
  const text = safeStr(msg.text);
  lastUpdateAt = new Date().toISOString();
  lastChatId = chatId;
  lastText = text;

  try {
    // Evitamos duplicar /start (ya lo agarra el handler anterior)
    if (/^\/start\b/i.test(text)) return;

    await bot.sendMessage(chatId, "👋 Te leo. ¿Qué querés hacer?", mainMenuKeyboard());
  } catch (e) {
    lastError = String(e?.message || e);
  }
});

// 3) Mensajes normales + teclado
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = safeStr(msg.text);
  const state = getState(chatId);

  lastUpdateAt = new Date().toISOString();
  lastChatId = chatId;
  lastText = text;

  // Ignorar si no es texto (stickers/fotos) para no romper
  if (!text) return;

  try {
    const data = await getCachedDataSafe(false);
    const cfg = data.config;

    // Si estamos esperando cantidad (pesables)
    if (state.mode === "await_qty" && state.pendingProduct) {
      const prod = state.pendingProduct;

      // Parse: "250g", "0.5kg", "1kg", "200"
      const raw = text.toLowerCase().replace(",", ".").replace(/\s+/g, "");
      let grams = null;

      const kgMatch = raw.match(/^(\d+(\.\d+)?)kg$/);
      const gMatch = raw.match(/^(\d+(\.\d+)?)g$/);
      const numMatch = raw.match(/^(\d+(\.\d+)?)$/);

      if (kgMatch) grams = Math.round(Number(kgMatch[1]) * 1000);
      else if (gMatch) grams = Math.round(Number(gMatch[1]));
      else if (numMatch) grams = Math.round(Number(numMatch[1])); // asume gramos
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

      await bot.sendMessage(
        chatId,
        `✅ Listo 😊\nAgregué *${prod.nombre}*\nCantidad: *${grams} g*\nSubtotal: *${safeStr(cfg.Moneda)} $${formatARS(subtotal)}*`,
        { parse_mode: "Markdown", ...cartInlineKeyboard() }
      );
      return;
    }

    // MENU
    if (text === "🏠 Menú" || text.toLowerCase() === "menu" || text.toLowerCase() === "menú") {
      await bot.sendMessage(chatId, "🏠 Menú principal:", mainMenuKeyboard());
      return;
    }

    if (text === "🔄 Recargar catálogo") {
      await getCachedDataSafe(true);
      await bot.sendMessage(chatId, "🔄 Listo. Recargué el catálogo ✅", mainMenuKeyboard());
      await showCategories(chatId);
      return;
    }

    // Catálogo
    if (text === "🛍️ Catálogo" || text.toLowerCase() === "catálogo" || text.toLowerCase() === "catalogo") {
      await showCategories(chatId);
      return;
    }

    // Carrito
    if (text === "🛒 Mi carrito" || text.toLowerCase() === "mi carrito") {
      await bot.sendMessage(chatId, cartText(state, safeStr(cfg.Moneda)), cartInlineKeyboard());
      return;
    }

    // Sellos (por ahora informativo, lo activamos en módulo sellos)
    if (text === "🎁 Mis sellos") {
      if (normalizeBool(cfg.UsaSellos) && safeStr(cfg.TarjetaURL)) {
        await bot.sendMessage(chatId, `🎁 Tu tarjeta de sellos:\n${safeStr(cfg.TarjetaURL)}`, mainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, "🎁 Tu tarjeta de sellos todavía no está visible en este módulo.\nLa activamos en el siguiente paso (sellos/niveles).", mainMenuKeyboard());
      }
      return;
    }

    // Hablar con vendedor (WhatsApp)
    if (text === "💬 Hablar con el vendedor") {
      const wa = safeStr(cfg.WhatsAppLink);
      if (wa) {
        await bot.sendMessage(chatId, "💬 Hablá con nosotros por WhatsApp 👇", {
          reply_markup: {
            inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: wa }]],
          },
        });
      } else {
        await bot.sendMessage(chatId, "💬 Decime tu consulta y te respondemos a la brevedad 😊", mainMenuKeyboard());
      }
      return;
    }

    // Info del local (con logo)
    if (text === "🏪 Información del local") {
      const logo = safeStr(cfg.LogoURL);
      const info = buildLocalInfoText(cfg);

      if (logo) {
        await bot.sendPhoto(chatId, logo, { caption: info, parse_mode: "Markdown", ...mainMenuKeyboard() });
      } else {
        await bot.sendMessage(chatId, info, { parse_mode: "Markdown", ...mainMenuKeyboard() });
      }
      return;
    }

    // Compartir bot (simple por ahora)
    if (text === "📣 Compartir el bot") {
      await bot.sendMessage(chatId, safeStr(cfg.TextoCompartirBot) || "📣 Compartí el bot desde el botón de compartir de Telegram.", mainMenuKeyboard());
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

    // Fallback universal: RESPONDE SIEMPRE (lo que te faltaba)
    await bot.sendMessage(chatId, "😊 Te leo. Elegí una opción del menú para seguir:", mainMenuKeyboard());
  } catch (e) {
    lastError = String(e?.message || e);
    await bot.sendMessage(chatId, "⚠️ Uy, algo falló. Probá de nuevo con /start.", mainMenuKeyboard());
  }
});

// ================== CALLBACKS ==================
bot.on("callback_query", async (cq) => {
  const chatId = cq.message.chat.id;
  const dataCb = cq.data || "";
  const state = getState(chatId);

  lastUpdateAt = new Date().toISOString();
  lastChatId = chatId;
  lastText = `[callback] ${dataCb}`;

  try {
    const data = await getCachedDataSafe(false);
    const cfg = data.config;
    const moneda = safeStr(cfg.Moneda) || "ARS";

    if (dataCb === "NAV_CATS") {
      await bot.answerCallbackQuery(cq.id);
      await showCategories(chatId);
      return;
    }

    if (dataCb === "NAV_NEXT" || dataCb === "NAV_PREV") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.currentCategory) {
        await showCategories(chatId);
        return;
      }
      const items = state.productos.filter(
        (p) => String(p.categoria).trim().toLowerCase() === String(state.currentCategory).trim().toLowerCase()
      );
      const pageSize = 3;
      const pages = Math.ceil(items.length / pageSize);
      const delta = dataCb === "NAV_NEXT" ? 1 : -1;

      let nextIndex = state.pageIndex + delta;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex > pages - 1) nextIndex = pages - 1;

      await showCategoryPage(chatId, state.currentCategory, nextIndex);
      return;
    }

    if (dataCb.startsWith("BUY:")) {
      await bot.answerCallbackQuery(cq.id);
      const code = dataCb.split(":")[1];
      const prod = state.productos.find((p) => String(p.codigo) === String(code));
      if (!prod) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto en el catálogo.");
        return;
      }

      if (isKgUnit(prod) && Number(priceForProduct(prod)) > 0 && String(prod.unidad || "").toLowerCase().includes("kg")) {
        state.mode = "await_qty";
        state.pendingProduct = prod;
        await bot.sendMessage(
          chatId,
          `🧀 Elegiste: *${prod.nombre}* (${prod.codigo})\nDecime la cantidad:\nEj: 250g / 0.5kg / 500`,
          { parse_mode: "Markdown", ...removeKeyboard() }
        );
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

        await bot.sendMessage(
          chatId,
          `✅ Agregado 😊\n*${prod.nombre}*\nSubtotal: *${moneda} $${formatARS(subtotal)}*`,
          { parse_mode: "Markdown", ...cartInlineKeyboard() }
        );
        return;
      }
    }

    if (dataCb === "CART_CLEAR") {
      await bot.answerCallbackQuery(cq.id);
      state.cart = [];
      await bot.sendMessage(chatId, "🧹 Listo. Vacíe tu carrito ✅", mainMenuKeyboard());
      return;
    }

    if (dataCb === "CHECKOUT") {
      await bot.answerCallbackQuery(cq.id);
      await startCheckout(chatId);
      return;
    }

    if (dataCb === "BACK_TO_CART") {
      await bot.answerCallbackQuery(cq.id);
      await bot.sendMessage(chatId, cartText(state, moneda), cartInlineKeyboard());
      return;
    }

    if (dataCb === "CHECKOUT_ENVIO") {
      await bot.answerCallbackQuery(cq.id);
      await finalizeCheckout(chatId, "envio");
      return;
    }

    if (dataCb === "CHECKOUT_RETIRO") {
      await bot.answerCallbackQuery(cq.id);
      await finalizeCheckout(chatId, "retiro");
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    lastError = String(e?.message || e);
    try { await bot.answerCallbackQuery(cq.id); } catch (_) {}
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error interno. Probá /start.", mainMenuKeyboard());
  }
});
