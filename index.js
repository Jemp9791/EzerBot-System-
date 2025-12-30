/**
 * TODO_QUESO - Telegram Bot (Render) + DATA_API_URL (Apps Script JSON)
 * - Carrusel con imágenes (editMessageMedia) sin ensuciar chat
 * - Catálogo por categorías
 * - Carrito real + Finalizar compra (envío/retiro + transferencia)
 * - Compartir producto (deep link /start P_<codigo>)
 * - TODO texto y parámetros salen desde Config (Apps Script)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = ...
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com   (sin / final)
 * - DATA_API_URL     = https://script.google.com/macros/s/XXXXX/exec   (sin params)
 * - BOT_USERNAME     = Ezer_IA_Bot (opcional)
 * - ADMIN_CHAT_ID    = (opcional) chat id del negocio para recibir pedidos/avisos
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/+$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || "").trim(); // opcional

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!DATA_API_URL) console.error("Falta ENV DATA_API_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ------------------ Telegram API ------------------
async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) console.error("Telegram API error:", method, data);
  return data;
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", { chat_id, text, ...extra });
}
async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tgCall("sendPhoto", { chat_id, photo, caption, ...extra });
}
async function editMessageMedia(chat_id, message_id, photo, caption, extra = {}) {
  return tgCall("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    ...extra,
  });
}
async function editMessageCaption(chat_id, message_id, caption, extra = {}) {
  return tgCall("editMessageCaption", { chat_id, message_id, caption, ...extra });
}
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}

// ------------------ Utils ------------------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function urlEncode(s) {
  return encodeURIComponent(String(s || ""));
}
function normalizeUrl(u) {
  if (!u) return "";
  return String(u).trim();
}
function yes(v) {
  return String(v || "").trim().toLowerCase() === "si";
}
function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  // formato simple ARS sin decimales
  return x.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

// ------------------ DATA API (Apps Script) ------------------
let dataCache = { at: 0, config: {}, catalog: { items: [], categories: [] } };

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch (e) {
    console.error("JSON inválido desde", url, "->", t.slice(0, 200));
    throw new Error("JSON inválido");
  }
}

async function loadData() {
  const now = Date.now();
  if (dataCache.at && now - dataCache.at < 60_000) return dataCache;

  if (!DATA_API_URL) throw new Error("DATA_API_URL vacío");

  const cfgRes = await fetchJson(`${DATA_API_URL}?type=config`);
  const catRes = await fetchJson(`${DATA_API_URL}?type=catalog`);

  const cfg = (cfgRes && cfgRes.ok && cfgRes.config) ? cfgRes.config : (cfgRes || {});
  const rawItems = (catRes && catRes.ok && catRes.items) ? catRes.items : (catRes?.catalog?.items || catRes?.items || []);

  // Normalizamos items a un formato interno único
  const items = (rawItems || [])
    .filter((x) => x && (x.activo === true || String(x.activo || "").toLowerCase() === "true" || String(x.activo || "").toLowerCase() === "si" || x.activo === undefined))
    .map((x) => ({
      codigo: String(x.codigo || x.CODIGO || "").trim(),
      nombre: String(x.nombre || x.NOMBRE || "").trim(),
      precio: Number(x.precio ?? x.PRECIO ?? 0),
      unidad: String(x.unidad || x.UNIDAD || "").trim().toLowerCase(), // "kg" o "unidad"
      precioPorKilo: Number(x.precioPorKilo ?? x.PrecioPorKilo ?? x.precio_por_kilo ?? 0),
      descripcion: String(x.descripcion || x.DESCRIPCION || "").trim(),
      imagen: normalizeUrl(x.imagenUrl || x.imagen || x.IMAGEN || x.IMAGENURL || ""),
      categoria: String(x.categoria || x.CATEGORIA || "Sin categoría").trim() || "Sin categoría",
    }))
    .filter((x) => x.nombre);

  const categories = [...new Set(items.map((x) => x.categoria))]
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  dataCache = { at: now, config: cfg || {}, catalog: { items, categories } };
  return dataCache;
}

async function loadConfig() {
  const d = await loadData();
  return d.config || {};
}
async function loadCatalog() {
  const d = await loadData();
  return d.catalog || { items: [], categories: [] };
}

// ------------------ Estado ------------------
/**
 * userState: chatId -> {
 *   mode: "CATALOG" | "CHECKOUT",
 *   list: items[],
 *   index: number,
 *   messageId: number|null,
 *   shareMode: boolean,
 *   categoryLabel: string,
 *   awaitingQty: boolean,
 *   pendingItemCode: string|null,
 *   checkoutStep: "NONE"|"DELIVERY"|"PAYMENT"|"CONFIRM_TRANSFER"|"DONE",
 *   deliveryChoice: "ENVIO"|"RETIRO"|null,
 *   paymentChoice: "TRANSFERENCIA"|null
 * }
 */
const userState = new Map();

/**
 * cart: chatId -> [{ codigo, nombre, unidad, precio, precioPorKilo, qty, subtotal }]
 * - unidad "kg": qty en gramos
 * - unidad "unidad": qty en unidades
 */
const carts = new Map();

// ------------------ UI (Reply keyboard principal) ------------------
function mainMenuKeyboardReply(cfg = {}, chatId = null) {
  const cartCount = chatId ? (carts.get(chatId)?.length || 0) : 0;
  const carritoTxt = cartCount > 0 ? `🧾 Carrito (${cartCount})` : "🧾 Carrito";

  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: carritoTxt }],
      [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

// ------------------ UI (Inline) ------------------
function categoriesKeyboard(categories) {
  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]);

  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${encodeURIComponent(b)}` });
    rows.push(row);
  }

  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total, cfg = {}) {
  const moneda = cfg.Moneda || "ARS";
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = item.categoria ? `\n📁 ${escapeHtml(item.categoria)}` : "";
  return (
    `🛍️ <b>${escapeHtml(item.nombre)}</b>\n` +
    `💰 <b>${escapeHtml(moneda)} ${escapeHtml(money(item.precio))}</b> ${escapeHtml(unidadTxt)}\n` +
    `📌 <i>${pos} de ${total}</i>${cat}${desc}\n\n` +
    `✅ Tocá <b>🟢 Quiero este</b> y te pido la cantidad 😊`
  );
}

function productNavKeyboard(chatId) {
  const cartCount = carts.get(chatId)?.length || 0;
  const cartBtn = cartCount > 0 ? `🧾 Ver carrito (${cartCount})` : "🧾 Ver carrito";

  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "P:PREV" },
        { text: "Siguiente ➡️", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "P:ADD" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE_MENU" }],
      [
        { text: "📁 Categorías", callback_data: "CAT_MENU" },
        { text: cartBtn, callback_data: "CART:VIEW" },
      ],
      [{ text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function shareOptionsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", callback_data: "SH:WA" },
        { text: "✈️ Telegram", callback_data: "SH:TG" },
      ],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

function cartKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      [{ text: "🧹 Vaciar carrito", callback_data: "CART:CLEAR" }],
      [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      [{ text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function deliveryKeyboard(cfg = {}) {
  const envioOk = yes(cfg.UsaEnvíoDomicilio);
  const retiroOk = yes(cfg.UsaRetiroLocal);

  const rows = [];
  if (envioOk) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:ENVIO" }]);
  if (retiroOk) rows.push([{ text: "🏠 Retiro en el local", callback_data: "DELIVERY:RETIRO" }]);
  rows.push([{ text: "⬅️ Volver al carrito", callback_data: "CART:VIEW" }]);
  return { inline_keyboard: rows };
}

function paymentKeyboard(cfg = {}) {
  // Por ahora: Transferencia (según tu config actual)
  const permitir = yes(cfg.PermitirPagoOnline);
  const tipo = String(cfg.TipoPagoOnline || "").toUpperCase();

  const rows = [];
  if (permitir && (tipo === "TRANSFERENCIA" || !tipo)) {
    rows.push([{ text: "🏦 Pagar por transferencia", callback_data: "PAY:TRANSFERENCIA" }]);
  }
  rows.push([{ text: "⬅️ Volver", callback_data: "CHECKOUT:BACK_DELIVERY" }]);
  return { inline_keyboard: rows };
}

// ------------------ Links compartir ------------------
function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function shareLinksForText(text) {
  const t = urlEncode(text);
  return {
    wa: `https://wa.me/?text=${t}`,
    tg: `https://t.me/share/url?url=${t}`,
  };
}

function shareTextForProduct(item) {
  const payload = `P_${(item.codigo || "").slice(0, 40)}`;
  const link = botStartLink(payload);
  const txt =
    `🧀 Todo Queso — Mirá este producto:\n` +
    `${item.nombre}\n` +
    `💰 ${money(item.precio)} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrí el bot y pedilo acá 👉 ${link}`;
  return txt;
}

function shareTextForBot(cfg = {}) {
  const link = botStartLink("B");
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const textoSistema = cfg.TextoSistema || "¿Querés este sistema para tu negocio? Contactanos";
  return `🧀 ${nombre} — Compras por Telegram\nAbrí el bot acá 👉 ${link}\n\n${textoSistema}`;
}

// ------------------ Carrito helpers ------------------
function getCart(chatId) {
  return carts.get(chatId) || [];
}

function addToCart(chatId, item, qty) {
  const cart = getCart(chatId);

  let subtotal = 0;
  if (item.unidad === "kg") {
    const gramos = Number(qty || 0);
    const precioKilo = item.precioPorKilo || item.precio || 0;
    subtotal = Math.round((gramos / 1000) * precioKilo);
  } else {
    const unidades = Number(qty || 0);
    subtotal = Math.round(unidades * (item.precio || 0));
  }

  cart.push({
    codigo: item.codigo,
    nombre: item.nombre,
    unidad: item.unidad,
    precio: item.precio,
    precioPorKilo: item.precioPorKilo || 0,
    qty: Number(qty || 0),
    subtotal,
  });

  carts.set(chatId, cart);
}

function cartText(cfg, chatId) {
  const moneda = cfg.Moneda || "ARS";
  const cart = getCart(chatId);
  if (!cart.length) return "🧾 <b>Tu carrito está vacío</b>\n\nTocá <b>🛍️ Catálogo</b> para empezar 😊";

  let total = 0;
  const lines = cart.map((x, i) => {
    total += Number(x.subtotal || 0);
    const qtyTxt = x.unidad === "kg" ? `${x.qty} g` : `${x.qty} u`;
    return `• <b>${escapeHtml(x.nombre)}</b> — ${escapeHtml(qtyTxt)} → <b>${escapeHtml(moneda)} ${escapeHtml(money(x.subtotal))}</b>`;
  });

  return (
    `🧾 <b>Tu carrito</b>\n\n` +
    lines.join("\n") +
    `\n\n🧮 <b>Total:</b> ${escapeHtml(moneda)} <b>${escapeHtml(money(total))}</b>\n\n` +
    `Cuando quieras, tocá <b>✅ Finalizar compra</b>.`
  );
}

function cartTotal(cfg, chatId) {
  const cart = getCart(chatId);
  return cart.reduce((a, b) => a + Number(b.subtotal || 0), 0);
}

// ------------------ Start / Home ------------------
async function ensureBotUsername() {
  if (BOT_USERNAME) return;
  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) BOT_USERNAME = me.result.username;
}

async function handleHome(chat_id, payload = "") {
  await ensureBotUsername();
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const logo = normalizeUrl(cfg.LogoURL || cfg.LOGO_URL || "");
  const descripcion = cfg.Descripcion || "";
  const estado = String(cfg.Estado || "").toLowerCase();

  let estadoTxt = "";
  if (estado.includes("cerr")) estadoTxt = "🚫 <b>Ahora estamos cerrados</b>\n";
  if (estado.includes("ab")) estadoTxt = "✅ <b>Estamos atendiendo</b>\n";

  const msg =
    `👋 <b>¡Hola!</b> Soy el bot de <b>${escapeHtml(nombre)}</b> 🧀\n` +
    (estadoTxt ? `${estadoTxt}` : "") +
    (descripcion ? `\n${escapeHtml(descripcion)}\n` : "\n") +
    `\n👉 Tocá <b>🛍️ Catálogo</b> para ver productos con foto.\n` +
    `👉 Tocá <b>🧾 Carrito</b> para finalizar tu compra.\n` +
    `👉 Si necesitás una mano, tocá <b>🆘 Ayuda</b> 😊`;

  const kb = mainMenuKeyboardReply(cfg, chat_id);

  // Deep links
  if (payload && payload.startsWith("P_")) {
    // mostrar home cortito + producto directo
    if (logo && logo.startsWith("http")) {
      await sendPhoto(chat_id, logo, msg, { parse_mode: "HTML", reply_markup: kb });
    } else {
      await sendMessage(chat_id, msg, { parse_mode: "HTML", reply_markup: kb });
    }
    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }

  if (payload === "B") {
    // entró por compartir bot
    if (logo && logo.startsWith("http")) {
      await sendPhoto(chat_id, logo, msg, { parse_mode: "HTML", reply_markup: kb });
    } else {
      await sendMessage(chat_id, msg, { parse_mode: "HTML", reply_markup: kb });
    }
    // sugiero catálogo automáticamente sin obligar
    return sendMessage(chat_id, "¿Querés que te muestre las promos más elegidas? 👇\nTocá 🛍️ Catálogo y elegí <b>Promos</b> 😊", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }

  // normal
  if (logo && logo.startsWith("http")) {
    await sendPhoto(chat_id, logo, msg, { parse_mode: "HTML", reply_markup: kb });
  } else {
    await sendMessage(chat_id, msg, { parse_mode: "HTML", reply_markup: kb });
  }
}

// ------------------ Sellos / Ayuda (simple, desde config) ------------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const tarjeta = normalizeUrl(cfg.CARD_URL || cfg.CardURL || "");
  const txt =
    `🏷️ <b>Sellos y beneficios</b>\n\n` +
    `Este módulo está activo y lo dejamos estable 😊\n` +
    `Si querés que la tarjeta se vea acá, dejame el link en <b>CARD_URL</b>.`;

  if (tarjeta && tarjeta.startsWith("http")) {
    return sendPhoto(chat_id, tarjeta, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) });
  }
  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) });
}

async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const tel = cfg.NegocioTelefono || "";
  const wa = cfg.WhatsAppLink || "";
  const insta = cfg.NegocioInstagram || "";
  const horarios = cfg.NegocioHorario || "";
  const dir = cfg.NegocioDireccion || "";

  const txt =
    `🆘 <b>Ayuda</b>\n\n` +
    `• Para comprar: tocá <b>🛍️ Catálogo</b> → elegí un producto → <b>🟢 Quiero este</b>\n` +
    `• Para pagar: tocá <b>🧾 Carrito</b> → <b>✅ Finalizar compra</b>\n\n` +
    (dir ? `📍 ${escapeHtml(dir)}\n` : "") +
    (horarios ? `🕒 ${escapeHtml(horarios)}\n` : "") +
    (tel ? `📲 ${escapeHtml(tel)}\n` : "") +
    (insta ? `📸 ${escapeHtml(insta)}\n` : "") +
    (wa ? `\n👉 WhatsApp: ${escapeHtml(wa)}\n` : "");

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) });
}

// ------------------ Catálogo / Carrusel ------------------
async function handleCatalogMenu(chat_id) {
  const cfg = await loadConfig();
  const { categories } = await loadCatalog();

  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const cfg = await loadConfig();
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, cfg);
  const kb = productNavKeyboard(chat_id);

  // si no hay imagen válida, mandamos texto (y después el resto igual navega)
  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return { messageId: msg?.result?.message_id || null, isPhoto: true };
}

async function updateCarousel(chat_id, st) {
  const cfg = await loadConfig();
  const { list, index, messageId } = st;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, cfg);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, st.categoryLabel || "Catálogo");
    st.messageId = created.messageId;
    userState.set(chat_id, st);
    return;
  }

  // siempre volvemos a botones normales del carrusel cuando navega
  st.shareMode = false;
  userState.set(chat_id, st);

  const kb = productNavKeyboard(chat_id);

  if (item.imagen && item.imagen.startsWith("http")) {
    return editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  }

  return editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();

  let list = items;
  let label = "Todas";

  if (category && category !== "__ALL__") {
    label = category;
    list = items.filter((x) => x.categoria === category);
  }

  if (!list.length) {
    const cfg = await loadConfig();
    return sendMessage(chat_id, "No hay productos en esta categoría.", {
      reply_markup: mainMenuKeyboardReply(cfg, chat_id),
    });
  }

  const st = {
    mode: "CATALOG",
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
    shareMode: false,
    awaitingQty: false,
    pendingItemCode: null,
    checkoutStep: "NONE",
    deliveryChoice: null,
    paymentChoice: null,
  };

  const created = await showProductCarousel(chat_id, list, 0, label);
  st.messageId = created.messageId;
  userState.set(chat_id, st);
}

// ------------------ Compartir (sin ensuciar carrusel; solo 1 mensaje al compartir) ------------------
async function openShareMenu(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;
  st.shareMode = true;
  userState.set(chat_id, st);
  return editMessageReplyMarkup(chat_id, st.messageId, shareOptionsKeyboard());
}

async function closeShareMenu(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;
  st.shareMode = false;
  userState.set(chat_id, st);
  return editMessageReplyMarkup(chat_id, st.messageId, productNavKeyboard(chat_id));
}

async function handleShareOption(chat_id, kind) {
  const st = userState.get(chat_id);
  const item = st?.list?.[st?.index];
  if (!item) return;

  const text = shareTextForProduct(item);
  const links = shareLinksForText(text);

  if (kind === "WA") {
    return sendMessage(chat_id, `📣 <b>Compartir por WhatsApp</b>\n\n${escapeHtml(text)}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: links.wa }]] },
    });
  }
  if (kind === "TG") {
    return sendMessage(chat_id, `✈️ <b>Compartir por Telegram</b>\n\n${escapeHtml(text)}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Compartir en Telegram", url: links.tg }]] },
    });
  }
}

// ------------------ Producto compartido al receptor ------------------
async function showSharedProduct(chat_id, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const item = items.find((x) => (x.codigo || "").toLowerCase() === (code || "").toLowerCase());

  if (!item) {
    return sendMessage(
      chat_id,
      "🧀 Te compartieron un producto, pero no lo encontré en el catálogo.\nTocá 🛍️ Catálogo para ver todo 😊",
      { reply_markup: mainMenuKeyboardReply(cfg, chat_id) }
    );
  }

  const caption =
    `🎁 <b>Te compartieron este producto</b>\n\n` +
    productCaption(item, 1, 1, cfg) +
    `\n\n🟢 Tocá <b>Agregar al carrito</b> y te pido la cantidad.`;

  const kb = {
    inline_keyboard: [
      [{ text: "🟢 Agregar al carrito", callback_data: `SHARED:ADD:${encodeURIComponent(item.codigo)}` }],
      [{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
    ],
  };

  if (item.imagen && item.imagen.startsWith("http")) {
    return sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  }
  return sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
}

// ------------------ Agregar al carrito (cantidad según unidad) ------------------
async function askQuantityForItem(chat_id, item) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id) || {};
  st.awaitingQty = true;
  st.pendingItemCode = item.codigo;
  userState.set(chat_id, st);

  if (item.unidad === "kg") {
    return sendMessage(
      chat_id,
      `✅ Perfecto 😊\n¿Cuántos <b>gramos</b> de <b>${escapeHtml(item.nombre)}</b> querés?\n\nEj: <b>200</b> (para 200g)`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) }
    );
  }

  return sendMessage(
    chat_id,
    `✅ Perfecto 😊\n¿Cuántas <b>unidades</b> de <b>${escapeHtml(item.nombre)}</b> querés?\n\nEj: <b>2</b>`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) }
  );
}

async function handleQtyText(chat_id, text) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id);
  if (!st?.awaitingQty || !st?.pendingItemCode) return false;

  const { items } = await loadCatalog();
  const item = items.find((x) => (x.codigo || "").toLowerCase() === (st.pendingItemCode || "").toLowerCase());
  if (!item) {
    st.awaitingQty = false;
    st.pendingItemCode = null;
    userState.set(chat_id, st);
    await sendMessage(chat_id, "Uy, no encontré ese producto. Probá de nuevo desde el catálogo 😊", {
      reply_markup: mainMenuKeyboardReply(cfg, chat_id),
    });
    return true;
  }

  // parse num
  const raw = String(text || "").trim().replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    await sendMessage(chat_id, "Decime un número válido 😊\nEj: 200 (gramos) o 2 (unidades).", {
      reply_markup: mainMenuKeyboardReply(cfg, chat_id),
    });
    return true;
  }

  // reglas
  if (item.unidad === "kg") {
    // gramos razonables
    if (n < 50) {
      await sendMessage(chat_id, "¿Te referís a gramos? 😊\nPoné por ejemplo 200 para 200g.", {
        reply_markup: mainMenuKeyboardReply(cfg, chat_id),
      });
      return true;
    }
    addToCart(chat_id, item, Math.round(n));
  } else {
    addToCart(chat_id, item, Math.round(n));
  }

  // limpiar estado qty
  st.awaitingQty = false;
  st.pendingItemCode = null;
  userState.set(chat_id, st);

  const cartCount = getCart(chat_id).length;
  await sendMessage(
    chat_id,
    `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> al carrito.\n🧾 Ahora tenés <b>${cartCount}</b> producto(s) en el carrito.\n\n¿Querés seguir comprando o finalizar?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
          [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
          [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        ],
      },
    }
  );
  return true;
}

// ------------------ Carrito / Checkout ------------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const txt = cartText(cfg, chat_id);
  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: cartKeyboard(),
  });
}

async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  if (!cart.length) {
    return sendMessage(chat_id, "Tu carrito está vacío 😊\nTocá 🛍️ Catálogo para empezar.", {
      reply_markup: mainMenuKeyboardReply(cfg, chat_id),
    });
  }

  const st = userState.get(chat_id) || {};
  st.mode = "CHECKOUT";
  st.checkoutStep = "DELIVERY";
  userState.set(chat_id, st);

  const envioOk = yes(cfg.UsaEnvíoDomicilio);
  const retiroOk = yes(cfg.UsaRetiroLocal);

  let txt = `✅ <b>Finalizar compra</b>\n\nPrimero, elegí cómo querés recibir tu pedido:`;
  if (!envioOk && !retiroOk) {
    txt += `\n\n⚠️ En Config no está habilitado Envío ni Retiro. Revisá <b>UsaEnvíoDomicilio</b> / <b>UsaRetiroLocal</b>.`;
  }

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: deliveryKeyboard(cfg),
  });
}

async function chooseDelivery(chat_id, choice) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id) || {};
  st.mode = "CHECKOUT";
  st.checkoutStep = "PAYMENT";
  st.deliveryChoice = choice;
  userState.set(chat_id, st);

  const costoEnvio = Number(cfg.CostoEnvio || 0);
  const total = cartTotal(cfg, chat_id) + (choice === "ENVIO" ? costoEnvio : 0);

  const txt =
    `✅ <b>Ok</b> — ${choice === "ENVIO" ? "🚚 Envío a domicilio" : "🏠 Retiro en el local"}\n\n` +
    (choice === "ENVIO" ? (cfg.TextoEnvíoDomicilio ? `${escapeHtml(cfg.TextoEnvíoDomicilio)}\n\n` : "") : (cfg.TextoRetiroLocal ? `${escapeHtml(cfg.TextoRetiroLocal)}\n\n` : "")) +
    `🧮 <b>Total a pagar:</b> ${escapeHtml(cfg.Moneda || "ARS")} <b>${escapeHtml(money(total))}</b>\n\n` +
    `Ahora elegí el método de pago:`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: paymentKeyboard(cfg),
  });
}

async function choosePaymentTransfer(chat_id) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id) || {};
  st.mode = "CHECKOUT";
  st.checkoutStep = "CONFIRM_TRANSFER";
  st.paymentChoice = "TRANSFERENCIA";
  userState.set(chat_id, st);

  const alias = cfg.AliasTransferencia || "";
  const cbu = cfg.CBUPago || "";
  const msgTrans = cfg.MensajeTransferencia || "Hacé la transferencia y respondé acá con 'LISTO' 😊";
  const avisoPend = cfg.TextoAvisoVendedor || "Tu pago queda pendiente de confirmación ✅";
  const costoEnvio = Number(cfg.CostoEnvio || 0);
  const total = cartTotal(cfg, chat_id) + (st.deliveryChoice === "ENVIO" ? costoEnvio : 0);

  const txt =
    `🏦 <b>Pago por transferencia</b>\n\n` +
    `🧮 Total: ${escapeHtml(cfg.Moneda || "ARS")} <b>${escapeHtml(money(total))}</b>\n\n` +
    (alias ? `• <b>Alias:</b> <code>${escapeHtml(alias)}</code>\n` : "") +
    (cbu ? `• <b>CBU:</b> <code>${escapeHtml(cbu)}</code>\n` : "") +
    `\n${escapeHtml(msgTrans)}\n\n` +
    `👉 Cuando termines, escribí <b>LISTO</b>.\n` +
    `(${escapeHtml(avisoPend)})`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ya transferí (LISTO)", callback_data: "PAY:DONE" }],
        [{ text: "⬅️ Volver", callback_data: "CHECKOUT:BACK_PAYMENT" }],
      ],
    },
  });
}

async function confirmTransferDone(chat_id) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id) || {};

  const cart = getCart(chat_id);
  const costoEnvio = Number(cfg.CostoEnvio || 0);
  const total = cartTotal(cfg, chat_id) + (st.deliveryChoice === "ENVIO" ? costoEnvio : 0);

  const resumen =
    cart.map((x) => {
      const qtyTxt = x.unidad === "kg" ? `${x.qty} g` : `${x.qty} u`;
      return `- ${x.nombre} (${qtyTxt})`;
    }).join("\n") || "- (vacío)";

  const txtCliente =
    `✅ <b>¡Listo!</b> Gracias 😊\n\n` +
    `Tu pedido quedó <b>pendiente de confirmación</b>.\n` +
    `En cuanto lo validemos, te avisamos.\n\n` +
    `🧾 <b>Resumen:</b>\n${escapeHtml(resumen)}\n\n` +
    `🧮 Total: ${escapeHtml(cfg.Moneda || "ARS")} <b>${escapeHtml(money(total))}</b>\n\n` +
    `¿Querés seguir mirando el catálogo?`;

  // Notificar al negocio si hay ADMIN_CHAT_ID
  if (ADMIN_CHAT_ID) {
    const tel = cfg.NegocioTelefono || "";
    const dir = cfg.NegocioDireccion || "";
    const envioTxt = st.deliveryChoice === "ENVIO" ? "ENVÍO" : "RETIRO";
    const nota =
      `🧾 NUEVO PEDIDO (pendiente transferencia)\n\n` +
      `Cliente: ${chat_id}\n` +
      `Entrega: ${envioTxt}\n` +
      (dir ? `Negocio: ${dir}\n` : "") +
      (tel ? `Tel: ${tel}\n` : "") +
      `\nItems:\n${resumen}\n\n` +
      `Total: ${cfg.Moneda || "ARS"} ${money(total)}`;

    await sendMessage(ADMIN_CHAT_ID, nota).catch(() => {});
  }

  // vaciar carrito al confirmar “LISTO” (si preferís mantenerlo, comentá estas 2 líneas)
  carts.set(chat_id, []);

  // reset checkout state
  st.checkoutStep = "DONE";
  st.deliveryChoice = null;
  st.paymentChoice = null;
  userState.set(chat_id, st);

  return sendMessage(chat_id, txtCliente, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛍️ Volver al catálogo", callback_data: "CAT_MENU" }],
        [{ text: "🏠 Menú", callback_data: "HOME" }],
      ],
    },
  });
}

// ------------------ Compartir bot (más “venta del sistema”) ------------------
async function handleShareBot(chat_id) {
  await ensureBotUsername();
  const cfg = await loadConfig();
  const text = shareTextForBot(cfg);
  const links = shareLinksForText(text);

  const txt =
    `📣 <b>Compartir el bot</b>\n\n` +
    `Si querés invitar a alguien a comprar por Telegram, compartilo desde acá 😊\n\n` +
    `${escapeHtml(text)}`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📣 WhatsApp", url: links.wa },
          { text: "✈️ Telegram", url: links.tg },
        ],
      ],
    },
  });
}

// ------------------ Callback handler ------------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  const message_id = cb.message?.message_id;
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  // HOME / Cat menu
  if (data === "HOME") return handleHome(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id);

  // categorías
  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat === "__ALL__" ? "__ALL__" : cat);
  }

  // carrusel nav
  if (data === "P:NEXT" || data === "P:PREV") {
    const st = userState.get(chat_id);
    if (!st?.list?.length) return;
    const total = st.list.length;

    if (data === "P:NEXT") st.index = (st.index + 1) % total;
    if (data === "P:PREV") st.index = (st.index - 1 + total) % total;

    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  // add from carousel
  if (data === "P:ADD") {
    const st = userState.get(chat_id);
    const item = st?.list?.[st?.index];
    if (!item) return;
    return askQuantityForItem(chat_id, item);
  }

  // share menu
  if (data === "P:SHARE_MENU") return openShareMenu(chat_id);
  if (data === "SH:BACK") return closeShareMenu(chat_id);
  if (data === "SH:WA") return handleShareOption(chat_id, "WA");
  if (data === "SH:TG") return handleShareOption(chat_id, "TG");

  // shared product add
  if (data.startsWith("SHARED:ADD:")) {
    const code = decodeURIComponent(data.split(":").slice(2).join(":") || "");
    const { items } = await loadCatalog();
    const item = items.find((x) => (x.codigo || "").toLowerCase() === (code || "").toLowerCase());
    if (!item) return;
    return askQuantityForItem(chat_id, item);
  }

  // cart
  if (data === "CART:VIEW") return showCart(chat_id);
  if (data === "CART:CLEAR") {
    carts.set(chat_id, []);
    const cfg = await loadConfig();
    return sendMessage(chat_id, "🧹 Listo, vacié el carrito 😊", { reply_markup: mainMenuKeyboardReply(cfg, chat_id) });
  }

  // checkout
  if (data === "CHECKOUT:START") return startCheckout(chat_id);

  if (data === "DELIVERY:ENVIO") return chooseDelivery(chat_id, "ENVIO");
  if (data === "DELIVERY:RETIRO") return chooseDelivery(chat_id, "RETIRO");

  if (data === "CHECKOUT:BACK_DELIVERY") return startCheckout(chat_id);

  if (data === "PAY:TRANSFERENCIA") return choosePaymentTransfer(chat_id);

  if (data === "CHECKOUT:BACK_PAYMENT") {
    const cfg = await loadConfig();
    return sendMessage(chat_id, "Volvamos un paso 😊 Elegí el método de pago:", {
      parse_mode: "HTML",
      reply_markup: paymentKeyboard(cfg),
    });
  }

  if (data === "PAY:DONE") return confirmTransferDone(chat_id);

  // fallback: no hacemos nada
  if (message_id) return;
}

// ------------------ Text handler ------------------
async function handleTextMessage(chat_id, text) {
  const cfg = await loadConfig();
  const t = (text || "").trim();

  // qty flow takes priority
  const used = await handleQtyText(chat_id, t);
  if (used) return;

  if (t === "/start") return handleHome(chat_id, "");
  if (t.startsWith("/start ")) {
    const payload = t.split(" ")[1] || "";
    return handleHome(chat_id, payload);
  }

  if (t === "🛍️ Catálogo") return handleCatalogMenu(chat_id);
  if (t.startsWith("🧾 Carrito")) return showCart(chat_id);
  if (t === "🏷️ Sellos") return handleSellos(chat_id);
  if (t === "📣 Compartir bot") return handleShareBot(chat_id);
  if (t === "🆘 Ayuda") return handleHelp(chat_id);

  // confirmar transferencia por texto
  if (t.toUpperCase() === "LISTO") {
    const st = userState.get(chat_id);
    if (st?.checkoutStep === "CONFIRM_TRANSFER") return confirmTransferDone(chat_id);
  }

  // fallback humano
  return sendMessage(
    chat_id,
    `Estoy acá 😊\nTocá <b>🛍️ Catálogo</b> para ver productos con foto o <b>🧾 Carrito</b> para finalizar.`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg, chat_id) }
  );
}

// ------------------ Routes ------------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO BOT LIVE"));

app.get("/debug", async (req, res) => {
  try {
    await ensureBotUsername();
    const d = await loadData();
    res.status(200).json({
      ok: true,
      env: {
        hasToken: Boolean(TOKEN),
        publicUrl: PUBLIC_URL || null,
        dataApiUrl: DATA_API_URL || null,
        botUsername: BOT_USERNAME || null,
        hasAdminChatId: Boolean(ADMIN_CHAT_ID),
      },
      configKeysSample: Object.keys(d.config || {}).slice(0, 40),
      catalogSample: {
        count: d.catalog.items.length,
        categories: d.catalog.categories,
        first: d.catalog.items[0] || null,
      },
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

// Webhook root "/"
app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";
      return handleTextMessage(chat_id, text);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ------------------ Boot ------------------
async function boot() {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");

  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) {
    BOT_USERNAME = me.result.username;
    console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  } else {
    console.log("⚠️ No pude detectar BOT_USERNAME por getMe");
  }

  try {
    const d = await loadData();
    console.log("✅ DATA cargada. Config keys:", Object.keys(d.config || {}).length, "Catalog items:", d.catalog.items.length);
  } catch (e) {
    console.log("❌ Error leyendo DATA_API_URL:", String(e?.message || e));
  }
}

app.listen(PORT, boot);
