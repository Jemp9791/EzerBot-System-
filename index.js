/**
 * TODO_QUESO — Bot Telegram (Config + Catálogo carrusel con fotos + Carrito + Checkout + Compartir limpio)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = ...
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com   (sin barra final)
 * - DATA_API_URL     = https://script.google.com/macros/s/...../exec
 * - BOT_USERNAME     = Ezer_IA_Bot   (sin @)  (opcional)
 *
 * DATA_API_URL debe responder:
 *   ?type=config  -> { ok:true, data:{...} }  (o directo {...})
 *   ?type=catalog -> { ok:true, items:[...], categories:[...] } (o directo {...})
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/+$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

if (!TOKEN) console.error("❌ Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta ENV PUBLIC_URL");
if (!DATA_API_URL) console.error("❌ Falta ENV DATA_API_URL");

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
  const m = String(u).match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return String(u).replace(/^\[|\]$/g, "").trim();
}
function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}
function toNum(x) {
  const n = Number(String(x || "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
function unitKind(unidadRaw) {
  const u = String(unidadRaw || "").trim().toLowerCase();
  if (!u) return "unit";
  if (u.includes("kg") || u.includes("kilo") || u.includes("gr") || u === "g") return "weight";
  return "unit";
}
function parseQtyWeight(txt) {
  // acepta "200g", "0.5kg", "250 gr"
  const s = String(txt || "").trim().toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d+(?:[.,]\d+)?)(kg|g|gr)$/i);
  if (!m) return null;
  let v = Number(String(m[1]).replace(",", "."));
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === "kg") return { grams: Math.round(v * 1000), label: `${v}kg` };
  // g / gr
  return { grams: Math.round(v), label: `${Math.round(v)}g` };
}
function parseQtyUnits(txt) {
  const s = String(txt || "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { units: n, label: `${n}` };
}

// ------------------ Data Cache ------------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, items: [], categories: [] };

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    // por si Apps Script devuelve texto raro, intentamos limpiar
    const cleaned = txt.trim();
    return JSON.parse(cleaned);
  }
}

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 30_000) return configCache.data;

  const j = await fetchJson(`${DATA_API_URL}?type=config`);
  const data = j?.data && typeof j.data === "object" ? j.data : j;
  configCache = { at: now, data: data || {} };
  return configCache.data;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 30_000) return catalogCache;

  const j = await fetchJson(`${DATA_API_URL}?type=catalog`);
  const itemsRaw = j?.items || j?.data?.items || j?.catalog?.items || j?.data || [];
  const catsRaw = j?.categories || j?.data?.categories || j?.catalog?.categories || [];

  const items = (itemsRaw || [])
    .map((x) => ({
      codigo: String(x.codigo || x.CODIGO || "").trim(),
      nombre: String(x.nombre || x.NOMBRE || "").trim(),
      precio: String(x.precio || x.PRECIO || "").trim(),
      unidad: String(x.unidad || x.UNIDAD || "").trim(),
      descripcion: String(x.descripcion || x.DESCRIPCION || "").trim(),
      imagen: normalizeUrl(x.imagen || x.IMAGEN || ""),
      categoria: String(x.categoria || x.CATEGORIA || "Sin categoría").trim() || "Sin categoría",
    }))
    .filter((x) => x.nombre);

  const categories =
    (catsRaw && catsRaw.length ? catsRaw : [...new Set(items.map((x) => x.categoria))]).sort((a, b) =>
      String(a).localeCompare(String(b), "es", { sensitivity: "base" })
    );

  catalogCache = { at: now, items, categories };
  return catalogCache;
}

// ------------------ State (por chat) ------------------
const userState = new Map(); // chatId -> {...}
const carts = new Map(); // chatId -> { items: [{codigo,nombre,kind,qtyLabel,qtyValue,precioUnit,subtotal}], total }
const pending = new Map(); // chatId -> { mode, itemCodigo } (esperando cantidad / comprobante / etc.)

function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, { items: [], total: 0 });
  return carts.get(chatId);
}
function recalcCart(chatId) {
  const c = getCart(chatId);
  let total = 0;
  for (const it of c.items) total += toNum(it.subtotal);
  c.total = total;
  carts.set(chatId, c);
  return c;
}
function addToCart(chatId, item, qty) {
  const kind = unitKind(item.unidad);
  let subtotal = 0;

  const precioUnit = toNum(item.precio);
  if (kind === "weight") {
    // precio por kg (según tu catálogo hoy)
    const grams = qty.grams;
    subtotal = (precioUnit * grams) / 1000;
    getCart(chatId).items.push({
      codigo: item.codigo,
      nombre: item.nombre,
      kind,
      qtyLabel: qty.label,
      qtyValue: grams,
      precioUnit,
      subtotal: Math.round(subtotal),
    });
  } else {
    const units = qty.units;
    subtotal = precioUnit * units;
    getCart(chatId).items.push({
      codigo: item.codigo,
      nombre: item.nombre,
      kind,
      qtyLabel: qty.label,
      qtyValue: units,
      precioUnit,
      subtotal: Math.round(subtotal),
    });
  }
  recalcCart(chatId);
}

// ------------------ UI Keyboards ------------------
function mainMenuKeyboardReply(cfg) {
  const textoCatalogo = cfg?.TextoBotonCatalogo || "🛍️ Catálogo";
  const textoCarrito = cfg?.TextoBotonCarrito || "🧾 Carrito";
  const textoSellos = cfg?.TextoBotonSellos || "🏷️ Sellos";
  const textoCompartir = cfg?.TextoBotonCompartirBot || "📣 Compartir bot";
  const textoAyuda = cfg?.TextoBotonAyuda || "🆘 Ayuda";

  return {
    keyboard: [
      [{ text: textoCatalogo }, { text: textoCarrito }],
      [{ text: textoSellos }, { text: textoCompartir }],
      [{ text: textoAyuda }],
    ],
    resize_keyboard: true,
  };
}

function categoriesKeyboard(categories, cfg) {
  const titulo = cfg?.TextoCategoriasTitulo || "Categorías";
  const btnTodas = cfg?.TextoCategoriasTodas || "📚 Todas";
  const btnMenu = cfg?.TextoBotonMenu || "🏠 Menú";

  const rows = [];
  rows.push([{ text: btnTodas, callback_data: "CAT:__ALL__" }]);

  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: String(a), callback_data: `CAT:${encodeURIComponent(String(a))}` }];
    if (b) row.push({ text: String(b), callback_data: `CAT:${encodeURIComponent(String(b))}` });
    rows.push(row);
  }
  rows.push([{ text: btnMenu, callback_data: "HOME" }]);

  return {
    inline_keyboard: rows,
    _title: titulo,
  };
}

function productCaption(item, pos, total, cfg) {
  const moneda = cfg?.Moneda || "$";
  const showPrice = String(cfg?.CatalogoMostrarPrecios || "si").toLowerCase() !== "no";

  const categoriaTxt = cfg?.TextoProductoCategoria || "📁";
  const descLabel = cfg?.TextoProductoDescripcion || "📝";
  const posLabel = cfg?.TextoProductoPosicion || "📌";
  const pedirLabel = cfg?.TextoProductoPedir || "✅ Para pedir: tocá 🟢 Quiero este";

  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const priceLine = showPrice ? `💰 <b>${escapeHtml(moneda)} ${escapeHtml(item.precio || "-")}</b> ${unidadTxt}` : "";

  const desc = item.descripcion ? `\n${descLabel} ${escapeHtml(item.descripcion)}` : "";
  const cat = item.categoria ? `\n${categoriaTxt} ${escapeHtml(item.categoria)}` : "";

  return (
    `🧀 <b>${escapeHtml(item.nombre)}</b>\n` +
    (priceLine ? `${priceLine}\n` : "") +
    `${posLabel} <i>${pos} de ${total}</i>` +
    cat +
    desc +
    `\n\n${escapeHtml(pedirLabel)}`
  );
}

function productNavKeyboard(cfg, includeCartButton = true) {
  const btnPrev = cfg?.TextoBotonAnterior || "⬅️ Anterior";
  const btnNext = cfg?.TextoBotonSiguiente || "➡️ Siguiente";
  const btnBuy = cfg?.TextoBotonQuieroEste || "🟢 Quiero este";
  const btnShare = cfg?.TextoBotonCompartirPromo || "📣 Compartir";
  const btnCats = cfg?.TextoBotonCategorias || "📁 Categorías";
  const btnMenu = cfg?.TextoBotonMenu || "🏠 Menú";
  const btnCart = cfg?.TextoBotonVerCarrito || "🧾 Ver carrito";
  const btnCheckout = cfg?.TextoBotonFinalizar || "✅ Finalizar compra";

  const rows = [
    [
      { text: btnPrev, callback_data: "P:PREV" },
      { text: btnNext, callback_data: "P:NEXT" },
    ],
    [{ text: btnBuy, callback_data: "P:BUY" }],
    [{ text: btnShare, callback_data: "P:SHARE_MENU" }],
    [{ text: btnCats, callback_data: "CAT_MENU" }, { text: btnMenu, callback_data: "HOME" }],
  ];

  if (includeCartButton) {
    rows.splice(3, 0, [
      { text: btnCart, callback_data: "CART:VIEW" },
      { text: btnCheckout, callback_data: "CART:CHECKOUT" },
    ]);
  }

  return { inline_keyboard: rows };
}

function shareMenuKeyboard(item, cfg, botLink, productLinkText) {
  const btnWa = cfg?.TextoCompartirWhatsApp || "📣 WhatsApp";
  const btnTg = cfg?.TextoCompartirTelegram || "✈️ Telegram";
  const btnBack = cfg?.TextoCompartirVolver || "⬅️ Volver";

  const text = productLinkText;
  const wa = `https://wa.me/?text=${urlEncode(text)}`;
  const tg = `https://t.me/share/url?url=${urlEncode(text)}`;

  return {
    inline_keyboard: [
      [
        { text: btnWa, url: wa },
        { text: btnTg, url: tg },
      ],
      [{ text: "🧀 Abrir bot", url: botLink }],
      [{ text: btnBack, callback_data: "SH:BACK" }],
    ],
  };
}

// ------------------ Links compartir ------------------
function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function shareTextForProduct(item) {
  const payload = `P_${(item.codigo || "").slice(0, 40)}`;
  const link = botStartLink(payload);
  return (
    `🧀 Todo Queso — Mirá este producto:\n` +
    `${item.nombre}\n` +
    `💰 $ ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrí el bot y pedilo acá 👉 ${link}`
  );
}

function shareTextForBot(cfg) {
  const link = botStartLink("B");
  const titulo = cfg?.TextoCompartirBotTitulo || "🧀 Todo Queso — Pedí por Telegram";
  const cuerpo =
    cfg?.TextoCompartirBotCuerpo ||
    "Abrí el bot, mirá el catálogo con fotos y armá tu pedido en minutos 😉";
  const sistema =
    cfg?.TextoSistemaVender ||
    "¿Querés este sistema para tu negocio? Contactanos: ezerbot.assistant@gmail.com";
  return `${titulo}\n${cuerpo}\n\n👉 ${link}\n\n${sistema}`;
}

// ------------------ START / HOME ------------------
async function handleStart(chat_id, payload = "") {
  // asegurar username del bot
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();

  const negocio = cfg.NegocioNombre || cfg.BUSINESS_NAME || "Todo Queso";
  const direccion = cfg.NegocioDireccion || cfg.ADDRESS || "";
  const horarios = cfg.NegocioHorario || cfg.HOURS || "";
  const telefono = cfg.NegocioTelefono || cfg.WHATSAPP || "";
  const insta = cfg.NegocioInstagram || "";
  const logo = normalizeUrl(cfg.LogoURL || cfg.LOGO_URL || "");
  const estado = String(cfg.Estado || cfg.STATUS || "").toLowerCase();

  const saludo =
    cfg.SaludoTexto ||
    `👋 <b>¡Hola!</b> Bienvenido/a a <b>${escapeHtml(negocio)}</b> 🧀\n\n` +
      `¿Qué te preparo hoy? 😊`;

  const estadoTxt =
    estado.includes("cerr") ? "🚫 <b>Ahora estamos cerrados</b>" : estado.includes("ab") ? "✅ <b>Estamos atendiendo</b>" : "";

  const ayudaMini =
    cfg.AyudaMini ||
    `👉 Tocá <b>Catálogo</b> para ver productos con foto.\n👉 Tocá <b>Carrito</b> para ver tu pedido.\n👉 Tocá <b>Ayuda</b> si necesitás una mano.`;

  const info = [
    saludo,
    estadoTxt,
    direccion ? `📍 ${escapeHtml(direccion)}` : "",
    horarios ? `🕒 ${escapeHtml(horarios)}` : "",
    telefono ? `📲 ${escapeHtml(telefono)}` : "",
    insta ? `📸 ${escapeHtml(insta)}` : "",
    "",
    ayudaMini,
  ]
    .filter(Boolean)
    .join("\n");

  // si entra por producto compartido
  if (payload && payload.startsWith("P_")) {
    if (isHttp(logo)) {
      await sendPhoto(chat_id, logo, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
    } else {
      await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
    }
    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }

  // link del bot (B)
  if (isHttp(logo)) {
    await sendPhoto(chat_id, logo, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  } else {
    await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }
}

// ------------------ HELP ------------------
async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const texto =
    cfg.AyudaTexto ||
    `🆘 <b>Ayuda</b>\n\n` +
      `🛍️ <b>Catálogo</b>: elegí una categoría y navegá con “Anterior / Siguiente”.\n` +
      `🟢 <b>Quiero este</b>: si es pesable te pide gramos (ej: 200g). Si es por unidad, cantidad (ej: 2).\n` +
      `🧾 <b>Carrito</b>: revisá tu pedido y finalizá.\n` +
      `🚚 <b>Envío / Retiro</b>: al finalizar te va a preguntar.\n` +
      `💳 <b>Transferencia</b>: te muestra alias y te pide comprobante.\n\n` +
      `Si querés hablar con alguien del local, usá el WhatsApp del menú 😊`;

  return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ------------------ SELL0S (placeholder) ------------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const tarjeta = normalizeUrl(cfg.SelloURL || cfg.SelloUrl || cfg.CARD_URL || cfg.CARD_URL || "");
  const txt =
    cfg.SellosTexto ||
    `🏷️ <b>Sellos</b>\n\n` +
      `Los sellos se suman con las compras.\n` +
      `En breve queda 100% automático con el carrito 😉`;

  if (isHttp(tarjeta)) {
    return sendPhoto(chat_id, tarjeta, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }
  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ------------------ CATALOGO / CAROUSEL ------------------
async function handleCatalogMenu(chat_id, preferEdit = true) {
  const cfg = await loadConfig();
  const { categories } = await loadCatalog();
  const title = cfg.TextoCategoriasIntro || "Elegí una categoría para ver productos:";
  const kb = categoriesKeyboard(categories, cfg);

  const st = userState.get(chat_id);
  // si ya tenemos un mensaje del carrusel, lo reutilizamos para no ensuciar
  if (preferEdit && st?.messageId) {
    // convertimos el mensaje del carrusel en “menú categorías” (solo caption + botones)
    const caption = `📚 <b>${escapeHtml(kb._title || "Categorías")}</b>\n${escapeHtml(title)}`;
    // intentamos editar caption; si no se puede, mandamos uno nuevo y actualizamos state
    const r = await editMessageCaption(chat_id, st.messageId, caption, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb.inline_keyboard },
    });
    if (r?.ok) {
      st.mode = "CATS";
      st.shareMode = false;
      userState.set(chat_id, st);
      return;
    }
  }

  // si no hay messageId, enviamos un mensaje nuevo
  const msg = await sendMessage(chat_id, `📚 <b>${escapeHtml(kb._title || "Categorías")}</b>\n${escapeHtml(title)}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb.inline_keyboard },
  });

  userState.set(chat_id, { mode: "CATS", messageId: msg?.result?.message_id || null, list: [], index: 0, categoryLabel: "" });
}

async function showProductCarousel(chat_id, list, index, label) {
  const cfg = await loadConfig();
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, cfg);
  const kb = productNavKeyboard(cfg, true);

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
    return { messageId: msg?.result?.message_id || null, isPhoto: true };
  } else {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }
}

async function safeUpdateCarousel(chat_id, state) {
  const cfg = await loadConfig();
  const { list, index } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, cfg);
  const kb = productNavKeyboard(cfg, true);

  // si no hay messageId, creamos
  if (!state.messageId) {
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "");
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  // intentamos editar el mismo mensaje (no ensuciar chat)
  let ok = false;
  if (isHttp(item.imagen)) {
    const r = await editMessageMedia(chat_id, state.messageId, item.imagen, caption, { reply_markup: kb });
    ok = Boolean(r?.ok);
  } else {
    const r = await editMessageCaption(chat_id, state.messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    ok = Boolean(r?.ok);
  }

  // si falló (Telegram a veces falla el edit), mandamos UNO nuevo y actualizamos messageId
  if (!ok) {
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "");
    state.messageId = created.messageId;
    userState.set(chat_id, state);
  }
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();
  const list =
    category && category !== "__ALL__" ? items.filter((x) => x.categoria === category) : items.slice();

  if (!list.length) {
    const cfg = await loadConfig();
    return sendMessage(chat_id, cfg.TextoSinProductos || "No hay productos en esta categoría.", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const stPrev = userState.get(chat_id) || {};
  const state = {
    mode: "CATALOG",
    categoryLabel: category === "__ALL__" ? "Todas" : category,
    list,
    index: 0,
    messageId: stPrev.messageId || null, // reusar si existe para no ensuciar
    shareMode: false,
  };

  userState.set(chat_id, state);
  return safeUpdateCarousel(chat_id, state);
}

// ------------------ SHARE (sin mensajes nuevos: usa botones URL en el mismo mensaje) ------------------
async function openShareMenu(chat_id) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id);
  if (!st?.messageId || !st?.list?.length) return;

  const item = st.list[st.index];
  const text = shareTextForProduct(item);
  const botLink = botStartLink("");

  st.shareMode = true;
  userState.set(chat_id, st);

  return editMessageReplyMarkup(chat_id, st.messageId, shareMenuKeyboard(item, cfg, botLink, text));
}

async function closeShareMenu(chat_id) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id);
  if (!st?.messageId) return;

  st.shareMode = false;
  userState.set(chat_id, st);

  return editMessageReplyMarkup(chat_id, st.messageId, productNavKeyboard(cfg, true));
}

// ------------------ SHARED PRODUCT (cuando entra por link) ------------------
async function showSharedProduct(chat_id, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "").toLowerCase() === String(code || "").toLowerCase());

  if (!item) {
    return sendMessage(chat_id, cfg.TextoProductoCompartidoNoEncontrado || "Te compartieron un producto, pero no lo encontré. Probá entrando a Catálogo.", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const caption =
    `🎁 <b>${escapeHtml(cfg.TextoProductoCompartidoTitulo || "Te compartieron este producto")}</b>\n\n` +
    productCaption(item, 1, 1, cfg);

  const kb = {
    inline_keyboard: [
      [{ text: cfg.TextoBotonVerCatalogo || "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
      [{ text: cfg.TextoBotonQuieroEste || "🟢 Quiero este", callback_data: `BUY_CODE:${encodeURIComponent(item.codigo || "")}` }],
      [{ text: cfg.TextoBotonVerCarrito || "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      [{ text: cfg.TextoBotonFinalizar || "✅ Finalizar compra", callback_data: "CART:CHECKOUT" }],
    ],
  };

  // mostramos con foto si hay
  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
    userState.set(chat_id, { mode: "SHARED", messageId: msg?.result?.message_id || null, list: [item], index: 0, categoryLabel: "" });
    return;
  }

  const msg = await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
  userState.set(chat_id, { mode: "SHARED", messageId: msg?.result?.message_id || null, list: [item], index: 0, categoryLabel: "" });
}

// ------------------ CART / CHECKOUT ------------------
async function handleCartView(chat_id) {
  const cfg = await loadConfig();
  const c = recalcCart(chat_id);

  if (!c.items.length) {
    return sendMessage(chat_id, cfg.TextoCarritoVacio || "🧾 Tu carrito está vacío. Tocá Catálogo para agregar productos 😊", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const moneda = cfg.Moneda || "$";
  const lines = c.items.map((it, i) => {
    const qty = it.kind === "weight" ? it.qtyLabel : `${it.qtyLabel} un.`;
    return `${i + 1}) ${it.nombre} — <b>${qty}</b> — <b>${moneda} ${it.subtotal}</b>`;
  });

  const txt =
    `🧾 <b>${escapeHtml(cfg.TextoCarritoTitulo || "Tu carrito")}</b>\n\n` +
    `${lines.join("\n")}\n\n` +
    `💰 <b>Total: ${escapeHtml(moneda)} ${Math.round(c.total)}</b>`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: cfg.TextoBotonFinalizar || "✅ Finalizar compra", callback_data: "CART:CHECKOUT" }],
        [{ text: cfg.TextoBotonVaciarCarrito || "🗑️ Vaciar carrito", callback_data: "CART:CLEAR" }],
      ],
    },
  });
}

async function handleCartClear(chat_id) {
  const cfg = await loadConfig();
  carts.set(chat_id, { items: [], total: 0 });
  pending.delete(chat_id);
  return sendMessage(chat_id, cfg.TextoCarritoVaciado || "Listo ✅ Vacié tu carrito.", { reply_markup: mainMenuKeyboardReply(cfg) });
}

async function handleCheckout(chat_id) {
  const cfg = await loadConfig();
  const c = recalcCart(chat_id);

  if (!c.items.length) {
    return sendMessage(chat_id, cfg.TextoCarritoVacio || "Tu carrito está vacío.", { reply_markup: mainMenuKeyboardReply(cfg) });
  }

  // opciones de entrega desde Config
  const usaEnvio = String(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "si").toLowerCase() !== "no";
  const usaRetiro = String(cfg.UsaRetiroLocal || "si").toLowerCase() !== "no";

  const btnEnvio = cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "🚚 Envío a domicilio";
  const btnRetiro = cfg.TextoRetiroLocal || "🏪 Retiro en el local";

  const rows = [];
  if (usaEnvio) rows.push([{ text: btnEnvio, callback_data: "CHK:DELIVERY" }]);
  if (usaRetiro) rows.push([{ text: btnRetiro, callback_data: "CHK:PICKUP" }]);
  rows.push([{ text: cfg.TextoBotonMenu || "🏠 Menú", callback_data: "HOME" }]);

  return sendMessage(chat_id, cfg.TextoCheckoutInicio || "✅ Perfecto. ¿Cómo querés recibir tu pedido?", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function handlePaymentMenu(chat_id, shippingMode) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || "$";
  const c = recalcCart(chat_id);
  const total = Math.round(c.total);

  const permitirOnline = String(cfg.PermitirPagoOnline || "si").toLowerCase() !== "no";
  const alias = cfg.AliasTransferencia || "";
  const mensajeTransfer = cfg.MensajeTransferencia || "Transferencia";
  const btnCash = cfg.TextoPagoEfectivo || "💵 Efectivo";
  const btnTransf = cfg.TextoPagoTransferencia || "🏦 Transferencia";
  const btnMenu = cfg.TextoBotonMenu || "🏠 Menú";

  pending.set(chat_id, { mode: "CHECKOUT", shippingMode });

  const rows = [[{ text: btnCash, callback_data: "PAY:CASH" }]];
  if (permitirOnline && alias) rows.push([{ text: btnTransf, callback_data: "PAY:TRANSFER" }]);
  rows.push([{ text: btnMenu, callback_data: "HOME" }]);

  const shippingTxt =
    shippingMode === "DELIVERY"
      ? (cfg.TextoEnvioResumen || "🚚 Envío a domicilio")
      : (cfg.TextoRetiroResumen || "🏪 Retiro en el local");

  const text =
    `🧾 <b>${escapeHtml(cfg.TextoResumenPedido || "Resumen del pedido")}</b>\n` +
    `${escapeHtml(shippingTxt)}\n` +
    `💰 Total: <b>${escapeHtml(moneda)} ${total}</b>\n\n` +
    `${escapeHtml(cfg.TextoElegirPago || "Elegí cómo querés pagar:")}`;

  return sendMessage(chat_id, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
}

async function handlePayCash(chat_id) {
  const cfg = await loadConfig();
  const c = recalcCart(chat_id);
  if (!c.items.length) return;

  // acá después conectamos aviso a vendedor / pedido
  const msg =
    cfg.TextoPagoEfectivoOk ||
    "✅ Listo. Tu pedido quedó tomado.\n\nSi querés agregar algo más, tocá Catálogo 😊";

  pending.delete(chat_id);
  return sendMessage(chat_id, msg, { reply_markup: mainMenuKeyboardReply(cfg) });
}

async function handlePayTransfer(chat_id) {
  const cfg = await loadConfig();
  const alias = cfg.AliasTransferencia || "";
  const texto = cfg.MensajeTransferencia || "Hacé la transferencia y pegá acá el comprobante (texto o captura).";

  pending.set(chat_id, { mode: "WAIT_RECEIPT" });

  const msg =
    `🏦 <b>${escapeHtml(cfg.TextoTransferenciaTitulo || "Transferencia")}</b>\n\n` +
    (alias ? `Alias: <b>${escapeHtml(alias)}</b>\n\n` : "") +
    `${escapeHtml(texto)}`;

  return sendMessage(chat_id, msg, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

async function handleReceipt(chat_id, messageText) {
  const cfg = await loadConfig();

  // NO repetimos confirmaciones: solo 1 mensaje final
  pending.delete(chat_id);

  const ok =
    cfg.TextoTransferenciaRecibida ||
    "✅ Recibido. Estamos verificando tu transferencia.\nTu pedido se está preparando 🧀";

  return sendMessage(chat_id, ok, { reply_markup: mainMenuKeyboardReply(cfg) });
}

// ------------------ COMPARTIR BOT (vender el sistema) ------------------
async function handleShareBot(chat_id) {
  const cfg = await loadConfig();
  const text = shareTextForBot(cfg);
  const wa = `https://wa.me/?text=${urlEncode(text)}`;
  const tg = `https://t.me/share/url?url=${urlEncode(text)}`;

  return sendMessage(chat_id, `<b>${escapeHtml(cfg.TextoCompartirBotTituloUI || "📣 Compartir el bot")}</b>\n\n${escapeHtml(text)}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: cfg.TextoCompartirWhatsApp || "📣 WhatsApp", url: wa },
          { text: cfg.TextoCompartirTelegram || "✈️ Telegram", url: tg },
        ],
      ],
    },
  });
}

// ------------------ BUY FLOW (correcto: pesable vs unidad) ------------------
async function startBuyForCurrent(chat_id) {
  const cfg = await loadConfig();
  const st = userState.get(chat_id);
  const item = st?.list?.[st?.index];
  if (!item) return;

  pending.set(chat_id, { mode: "WAIT_QTY", itemCodigo: item.codigo });

  const kind = unitKind(item.unidad);
  if (kind === "weight") {
    const txt =
      cfg.TextoPedirPeso ||
      "✅ Dale 😊\nDecime cuántos gramos.\nEj: <b>200g</b> o <b>1kg</b>";
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  } else {
    const txt =
      cfg.TextoPedirUnidades ||
      "✅ Dale 😊\nDecime cuántas unidades.\nEj: <b>2</b>";
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }
}

async function startBuyByCode(chat_id, codigo) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "") === String(codigo || ""));
  if (!item) return;

  pending.set(chat_id, { mode: "WAIT_QTY", itemCodigo: item.codigo });

  const kind = unitKind(item.unidad);
  if (kind === "weight") {
    const txt =
      cfg.TextoPedirPeso ||
      `✅ ${escapeHtml(item.nombre)}\nDecime cuántos gramos.\nEj: <b>200g</b> o <b>1kg</b>`;
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  } else {
    const txt =
      cfg.TextoPedirUnidades ||
      `✅ ${escapeHtml(item.nombre)}\nDecime cuántas unidades.\nEj: <b>2</b>`;
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }
}

async function finishQty(chat_id, qtyText) {
  const cfg = await loadConfig();
  const p = pending.get(chat_id);
  if (!p || p.mode !== "WAIT_QTY") return;

  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "") === String(p.itemCodigo || ""));
  if (!item) {
    pending.delete(chat_id);
    return sendMessage(chat_id, cfg.TextoErrorProducto || "No pude encontrar el producto. Volvé a Catálogo.", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const kind = unitKind(item.unidad);
  const qty =
    kind === "weight" ? parseQtyWeight(qtyText) : parseQtyUnits(qtyText);

  if (!qty) {
    const txt =
      kind === "weight"
        ? (cfg.TextoErrorPeso || "No entendí. Probá así: <b>200g</b> o <b>1kg</b>")
        : (cfg.TextoErrorUnidades || "No entendí. Probá así: <b>2</b>");
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }

  addToCart(chat_id, item, qty);
  pending.delete(chat_id);

  const c = recalcCart(chat_id);
  const moneda = cfg.Moneda || "$";

  const ok =
    cfg.TextoAgregadoCarrito ||
    `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> (${escapeHtml(qty.label)})\n\n` +
      `🧾 Total carrito: <b>${escapeHtml(moneda)} ${Math.round(c.total)}</b>\n\n` +
      `¿Querés seguir? Tocá <b>Catálogo</b> o mirá <b>Carrito</b>.`;

  return sendMessage(chat_id, ok, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ------------------ Callback Handler ------------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id, true);

  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = raw === "__ALL__" ? "__ALL__" : decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }

  // carrusel prev/next
  if (data === "P:NEXT" || data === "P:PREV") {
    const st = userState.get(chat_id);
    if (!st?.list?.length) return;
    const total = st.list.length;

    if (data === "P:NEXT") st.index = (st.index + 1) % total;
    if (data === "P:PREV") st.index = (st.index - 1 + total) % total;

    st.shareMode = false;
    userState.set(chat_id, st);
    return safeUpdateCarousel(chat_id, st);
  }

  // comprar
  if (data === "P:BUY") return startBuyForCurrent(chat_id);
  if (data.startsWith("BUY_CODE:")) {
    const code = decodeURIComponent(data.split(":")[1] || "");
    return startBuyByCode(chat_id, code);
  }

  // compartir promo (sin mensajes nuevos)
  if (data === "P:SHARE_MENU") return openShareMenu(chat_id);
  if (data === "SH:BACK") return closeShareMenu(chat_id);

  // carrito
  if (data === "CART:VIEW") return handleCartView(chat_id);
  if (data === "CART:CLEAR") return handleCartClear(chat_id);
  if (data === "CART:CHECKOUT") return handleCheckout(chat_id);

  // checkout envío/retiro
  if (data === "CHK:DELIVERY") return handlePaymentMenu(chat_id, "DELIVERY");
  if (data === "CHK:PICKUP") return handlePaymentMenu(chat_id, "PICKUP");

  // pago
  if (data === "PAY:CASH") return handlePayCash(chat_id);
  if (data === "PAY:TRANSFER") return handlePayTransfer(chat_id);
}

// ------------------ Text Messages ------------------
async function handleTextMessage(chat_id, text) {
  const cfg = await loadConfig();
  const t = (text || "").trim();

  // /start y payload
  if (t === "/start") return handleStart(chat_id, "");
  if (t.startsWith("/start ")) {
    const payload = t.split(" ")[1] || "";
    return handleStart(chat_id, payload);
  }

  // si estamos esperando comprobante
  const p = pending.get(chat_id);
  if (p?.mode === "WAIT_RECEIPT") {
    return handleReceipt(chat_id, t);
  }

  // si estamos esperando cantidad
  if (p?.mode === "WAIT_QTY") {
    return finishQty(chat_id, t);
  }

  // botones reply del menú
  const btnCatalogo = cfg?.TextoBotonCatalogo || "🛍️ Catálogo";
  const btnCarrito = cfg?.TextoBotonCarrito || "🧾 Carrito";
  const btnSellos = cfg?.TextoBotonSellos || "🏷️ Sellos";
  const btnCompartir = cfg?.TextoBotonCompartirBot || "📣 Compartir bot";
  const btnAyuda = cfg?.TextoBotonAyuda || "🆘 Ayuda";

  if (t === btnCatalogo) return handleCatalogMenu(chat_id, true);
  if (t === btnCarrito) return handleCartView(chat_id);
  if (t === btnSellos) return handleSellos(chat_id);
  if (t === btnCompartir) return handleShareBot(chat_id);
  if (t === btnAyuda) return handleHelp(chat_id);

  // fallback amable
  const fallback =
    cfg.TextoFallback ||
    "👋 Estoy acá 😊\nTocá <b>Catálogo</b> para ver productos con foto o <b>Carrito</b> para finalizar tu pedido.";
  return sendMessage(chat_id, fallback, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ------------------ Routes ------------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO BOT LIVE"));

app.get("/debug", async (req, res) => {
  const cfg = await loadConfig().catch(() => ({}));
  const cat = await loadCatalog().catch(() => ({ items: [], categories: [] }));
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      dataApiUrl: DATA_API_URL || null,
      botUsername: BOT_USERNAME || null,
    },
    configKeysSample: Object.keys(cfg).slice(0, 40),
    catalogSample: {
      items: cat.items.slice(0, 3),
      categories: cat.categories,
    },
  });
});

// Webhook "/"
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

  // detectar username real del bot
  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) {
    BOT_USERNAME = me.result.username;
    console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  } else {
    console.log("⚠️ No pude detectar BOT_USERNAME por getMe");
  }

  // test config/catalog
  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG cargada. Keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ Error leyendo Config:", String(e?.message || e));
  }

  try {
    const cat = await loadCatalog();
    console.log("✅ CATALOGO cargado. Items:", cat.items.length, "Cats:", cat.categories.length);
  } catch (e) {
    console.log("❌ Error leyendo Catalogo:", String(e?.message || e));
  }
}

app.listen(PORT, boot);
