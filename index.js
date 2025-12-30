/**
 * EzerBot / Todo Queso — Bot + POS (Telegram) — ÚNICO index.js
 * Lee TODO desde Google Apps Script (JSON):
 *   DATA_API_URL?type=config
 *   DATA_API_URL?type=catalog
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN  (obligatorio)
 * - PUBLIC_URL      (obligatorio) ej https://ezerbot-system.onrender.com   (sin barra final)
 * - DATA_API_URL    (obligatorio) ej https://script.google.com/macros/s/XXXX/exec  (sin query)
 * - BOT_USERNAME    (opcional) sin @ (si no está, se detecta con getMe)
 *
 * CONFIG (hoja Config) — claves recomendadas:
 * - NegocioNombre, LogoURL, Estado, Descripcion, NegocioDireccion, NegocioHorario, NegocioTelefono, WhatsAppLink, Moneda
 * - CatalogoMostrarPrecios (SI/NO)
 * - UsaEnvíoDomicilio (SI/NO), CostoEnvio, TextoEnvíoDomicilio
 * - UsaRetiroLocal (SI/NO), TextoRetiroLocal
 * - PermitirPagoOnline (SI/NO)  // si SI, se muestran métodos
 * - TipoPagoOnline (TRANSFERENCIA / MERCADOPAGO / OTRO)  // hoy implementamos TRANSFERENCIA
 * - AliasTransferencia, CBUPago, MensajeTransferencia
 * - VendedorChatId (opcional)  // chatId del vendedor o grupo para recibir pedidos y comprobantes
 * - TextoAyuda (opcional)      // si no está usa default
 * - TextoSistema, EmailSistema (para “Compartir bot”)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
let DATA_API_URL = (process.env.DATA_API_URL || "").trim().replace(/\/+$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

DATA_API_URL = DATA_API_URL.replace(/^"+|"+$/g, "").trim();

if (!TOKEN) console.error("❌ Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta ENV PUBLIC_URL");
if (!DATA_API_URL) console.error("❌ Falta ENV DATA_API_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---------------- Telegram API ----------------
async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
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
async function forwardMessage(chat_id, from_chat_id, message_id) {
  return tgCall("forwardMessage", { chat_id, from_chat_id, message_id });
}

// ---------------- Utils ----------------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function urlEncode(s) {
  return encodeURIComponent(String(s || ""));
}
function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}
function normalizeUrl(u) {
  if (!u) return "";
  return String(u).trim().replace(/^"+|"+$/g, "");
}
function lower(s) {
  return String(s || "").trim().toLowerCase();
}
function money(n, moneda = "$") {
  const x = Number(n || 0);
  return `${moneda} ${x.toLocaleString("es-AR")}`;
}
function isPesable(item) {
  const u = lower(item?.unidad);
  if (["kg", "kilo", "kilos", "gr", "g", "gramo", "gramos"].includes(u)) return true;
  if (item?.pesable === true) return true;
  if (item?.precioPorKilo || item?.precioKilo) return true;
  return false;
}
function nowId() {
  // ID simple para pedido
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------- Fetch JSON robusto ----------------
async function fetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  const ct = res.headers.get("content-type") || "";
  const txt = await res.text();

  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error("❌ Respuesta NO JSON desde:", url);
    console.error("Content-Type:", ct);
    console.error("Primeros 200 chars:", txt.slice(0, 200));
    throw new Error("DATA_API_URL no devuelve JSON válido (posible HTML).");
  }
}

// ---------------- Cache Config / Catalog ----------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, data: { items: [], categories: [] } };

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 20_000) return configCache.data;

  const url = `${DATA_API_URL}?type=config`;
  const j = await fetchJson(url);
  const cfg = (j?.config && typeof j.config === "object") ? j.config : j;

  configCache = { at: now, data: cfg || {} };
  return configCache.data;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.data.items?.length && now - catalogCache.at < 20_000) return catalogCache.data;

  const url = `${DATA_API_URL}?type=catalog`;
  const j = await fetchJson(url);
  const cat = (j?.catalog && typeof j.catalog === "object") ? j.catalog : j;

  const rawItems = Array.isArray(cat?.items) ? cat.items : [];
  const items = rawItems
    .filter((x) => x && (x.activo === undefined || x.activo === true || lower(x.activo) === "si"))
    .map((x) => ({
      codigo: String(x.codigo || x.id || "").trim(),
      nombre: String(x.nombre || "").trim(),
      precio: Number(x.precio || 0),
      unidad: String(x.unidad || "").trim(),
      descripcion: String(x.descripcion || "").trim(),
      imagen: normalizeUrl(x.imagenUrl || x.imagen || x.imagen1 || x.imagenUrl1 || ""),
      categoria: String(x.categoria || "Sin categoría").trim(),
      pesable: x.pesable === true,
    }))
    .filter((x) => x.nombre);

  const categories =
    Array.isArray(cat?.categories) && cat.categories.length
      ? cat.categories.map(String)
      : [...new Set(items.map((x) => x.categoria))].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  catalogCache = { at: now, data: { items, categories } };
  return catalogCache.data;
}

// ---------------- Estado por usuario ----------------
const userState = new Map(); // chatId -> state
const carts = new Map(); // chatId -> cart
const orders = new Map(); // chatId -> current order draft

function getState(chatId) {
  if (!userState.has(chatId)) userState.set(chatId, {});
  return userState.get(chatId);
}
function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, { items: [], total: 0 });
  return carts.get(chatId);
}
function recalcCart(cart) {
  cart.total = cart.items.reduce((a, x) => a + (Number(x.subtotal) || 0), 0);
}

// ---------------- UI ----------------
function mainMenuKeyboardReply(cfg) {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]);
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT:${urlEncode(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${urlEncode(b)}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(cfg, item, pos, total, categoryLabel) {
  const moneda = cfg?.Moneda || "$";
  const mostrarPrecio = lower(cfg?.CatalogoMostrarPrecios) !== "no";
  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const priceLine = mostrarPrecio ? `💰 <b>${escapeHtml(moneda)} ${escapeHtml(item.precio || "-")}</b> ${unidadTxt}\n` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = categoryLabel ? `\n📁 <i>${escapeHtml(categoryLabel)}</i>` : "";
  return (
    `🧀 <b>${escapeHtml(item.nombre)}</b>\n` +
    priceLine +
    `📌 <i>${pos} de ${total}</i>${cat}` +
    `${desc}\n\n` +
    `✅ <b>Para agregar:</b> tocá <b>🟢 Quiero este</b>`
  );
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "P:PREV" },
        { text: "Siguiente ➡️", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE_MENU" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function shareOptionsKeyboard(item) {
  const payload = `P_${(item.codigo || "").slice(0, 30)}`;
  const botLink = botStartLink(payload);

  const text =
    `🧀 Todo Queso — Mirá esto:\n` +
    `${item.nombre}\n` +
    `💰 $ ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrilo y pedilo acá 👉 ${botLink}`;

  const wa = `https://wa.me/?text=${urlEncode(text)}`;
  const tg = `https://t.me/share/url?url=${urlEncode(botLink)}&text=${urlEncode(text)}`;

  return {
    inline_keyboard: [
      [{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

// ---------------- Carrusel ----------------
async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const cfg = await loadConfig();
  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total, categoryLabel);
  const kb = productNavKeyboard();

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

async function updateCarousel(chat_id, st) {
  const cfg = await loadConfig();
  const { list, index, messageId, categoryLabel } = st;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total, categoryLabel);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, categoryLabel);
    st.messageId = created.messageId;
    userState.set(chat_id, st);
    return;
  }

  if (isHttp(item.imagen)) {
    const edited = await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: productNavKeyboard() });
    if (!edited?.ok) {
      const created = await showProductCarousel(chat_id, list, index, categoryLabel);
      st.messageId = created.messageId;
      userState.set(chat_id, st);
    }
  } else {
    const edited = await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: productNavKeyboard(),
    });
    if (!edited?.ok) {
      const created = await showProductCarousel(chat_id, list, index, categoryLabel);
      st.messageId = created.messageId;
      userState.set(chat_id, st);
    }
  }
}

// ---------------- Catálogo ----------------
async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
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
    return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboardReply(cfg) });
  }

  const st = getState(chat_id);
  st.mode = "CATALOG";
  st.categoryLabel = label;
  st.list = list;
  st.index = 0;
  st.messageId = null;
  st.awaitingQty = false;
  st.pendingItem = null;

  const created = await showProductCarousel(chat_id, list, 0, label);
  st.messageId = created.messageId;
  userState.set(chat_id, st);
}

// ---------------- Cantidad (pesable vs unidad) ----------------
function parseQty(text) {
  const t = String(text || "").trim().toLowerCase();
  const g = t.match(/^(\d+)\s*(g|gr|gramos)?$/);
  if (g) return { kind: "GRAMOS", value: Number(g[1]), text: `${Number(g[1])}g` };
  const u = t.match(/^(\d+)$/);
  if (u) return { kind: "UNIDADES", value: Number(u[1]), text: `${Number(u[1])}` };
  return null;
}

async function askQuantity(chat_id, item) {
  const cfg = await loadConfig();
  const pesable = isPesable(item);

  const txt = pesable
    ? `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuánto querés en <b>gramos</b>.\nEj: <b>200g</b> o <b>500g</b>`
    : `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuántas <b>unidades</b> querés.\nEj: <b>1</b> o <b>2</b>`;

  const st = getState(chat_id);
  st.awaitingQty = true;
  st.pendingItem = item;
  userState.set(chat_id, st);

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

async function addToCart(chat_id, item, qty) {
  const cart = getCart(chat_id);
  const cfg = await loadConfig();
  const moneda = cfg?.Moneda || "$";

  let subtotal = 0;
  if (isPesable(item)) {
    const kilos = (qty.value || 0) / 1000;
    subtotal = Math.round((Number(item.precio) || 0) * kilos);
  } else {
    subtotal = Math.round((Number(item.precio) || 0) * (qty.value || 0));
  }

  cart.items.push({
    codigo: item.codigo,
    nombre: item.nombre,
    unidad: item.unidad,
    pesable: isPesable(item),
    qtyText: qty.text,
    qtyValue: qty.value,
    subtotal,
  });
  recalcCart(cart);

  return sendMessage(chat_id, `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> (${escapeHtml(qty.text)}).`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// ---------------- Carrito ----------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const moneda = cfg?.Moneda || "$";
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "🧾 <b>Carrito</b>\n\nTodavía no agregaste productos.\n👉 Tocá <b>Catálogo</b> para empezar 😉", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const lines = cart.items.map((x) => {
    const sub = money(x.subtotal, moneda).replace(`${moneda} `, "");
    return `• <b>${escapeHtml(x.nombre)}</b> — <i>${escapeHtml(x.qtyText)}</i> — <b>${escapeHtml(moneda)} ${escapeHtml(sub)}</b>`;
  });

  const txt =
    `🧾 <b>Tu carrito</b>\n\n` +
    lines.join("\n") +
    `\n\n<b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(cart.total)}\n\n` +
    `✅ Tocá <b>Finalizar compra</b> cuando quieras.`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// ---------------- Checkout (Envío / Retiro / Pago / Transferencia) ----------------
function getCfgBool(cfg, key) {
  return lower(cfg?.[key]) === "si" || cfg?.[key] === true;
}

async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "Tu carrito está vacío 😊 Tocá Catálogo para agregar productos.", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const usaEnvio = getCfgBool(cfg, "UsaEnvíoDomicilio") || getCfgBool(cfg, "UsaEnvioDomicilio");
  const usaRetiro = getCfgBool(cfg, "UsaRetiroLocal");
  const costoEnvio = Number(cfg?.CostoEnvio || 0);
  const moneda = cfg?.Moneda || "$";

  const opciones = [];
  if (usaRetiro) opciones.push([{ text: "🏠 Retiro en local", callback_data: "CHECKOUT:RETIRO" }]);
  if (usaEnvio) opciones.push([{ text: `🚚 Envío a domicilio (+${money(costoEnvio, moneda)})`, callback_data: "CHECKOUT:ENVIO" }]);

  if (!opciones.length) opciones.push([{ text: "✅ Continuar", callback_data: "CHECKOUT:RETIRO" }]);

  const txt =
    `✅ <b>Finalizar compra</b>\n\n` +
    `Elegí cómo querés recibir tu pedido:`;

  // armamos draft de pedido
  const od = orders.get(chat_id) || {};
  od.id = nowId();
  od.delivery = null;
  od.address = "";
  od.payment = null;
  od.pendingProof = false;
  orders.set(chat_id, od);

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: opciones } });
}

async function chooseDelivery(chat_id, delivery) {
  const cfg = await loadConfig();
  const od = orders.get(chat_id) || { id: nowId() };
  od.delivery = delivery;
  orders.set(chat_id, od);

  if (delivery === "ENVIO") {
    const texto = cfg?.["TextoEnvíoDomicilio"] || cfg?.TextoEnvioDomicilio || "Escribime la dirección completa (calle, número, localidad y referencia).";
    const st = getState(chat_id);
    st.awaitingAddress = true;
    userState.set(chat_id, st);
    return sendMessage(chat_id, `🚚 <b>Envío a domicilio</b>\n\n${escapeHtml(texto)}`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  // retiro: directo a pago
  return choosePaymentMenu(chat_id);
}

async function choosePaymentMenu(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const permitirPagoOnline = getCfgBool(cfg, "PermitirPagoOnline");
  const tipoPagoOnline = String(cfg?.TipoPagoOnline || "").trim().toUpperCase();
  const moneda = cfg?.Moneda || "$";

  const od = orders.get(chat_id) || { id: nowId() };
  orders.set(chat_id, od);

  const costoEnvio = Number(cfg?.CostoEnvio || 0);
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const botones = [];

  // Siempre doy una opción “Efectivo” (sirve también para “pago al retirar”)
  botones.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);

  // Transferencia si está activada
  if (permitirPagoOnline && tipoPagoOnline === "TRANSFERENCIA") {
    botones.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);
  }

  const txt =
    `💳 <b>Forma de pago</b>\n\n` +
    `Total a pagar: <b>${escapeHtml(moneda)} ${escapeHtml(total)}</b>\n` +
    `Elegí una opción:`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: botones } });
}

async function setPayment(chat_id, payment) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || { id: nowId() };
  od.payment = payment;
  orders.set(chat_id, od);

  const moneda = cfg?.Moneda || "$";
  const costoEnvio = Number(cfg?.CostoEnvio || 0);
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  if (payment === "CASH") {
    // Pedido listo: enviamos a negocio (si hay chatId) + damos botón WA al cliente
    return finalizeOrder(chat_id, { needsProof: false });
  }

  if (payment === "TRANSFER") {
    const alias = cfg?.AliasTransferencia || "";
    const cbu = cfg?.CBUPago || "";
    const msg = cfg?.MensajeTransferencia || "Hacé la transferencia y enviá el comprobante por acá.";

    const texto =
      `🏦 <b>Transferencia</b>\n\n` +
      `Total: <b>${escapeHtml(moneda)} ${escapeHtml(total)}</b>\n\n` +
      (alias ? `🔑 Alias: <b>${escapeHtml(alias)}</b>\n` : "") +
      (cbu ? `🏷️ CBU: <b>${escapeHtml(cbu)}</b>\n` : "") +
      `\n${escapeHtml(msg)}\n\n` +
      `📎 <b>Ahora enviá el comprobante</b> (foto o archivo).`;

    const st = getState(chat_id);
    st.awaitingProof = true;
    userState.set(chat_id, st);

    // marcamos pendiente
    od.pendingProof = true;
    orders.set(chat_id, od);

    return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }

  return choosePaymentMenu(chat_id);
}

function buildOrderText(cfg, chat_id) {
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || {};
  const moneda = cfg?.Moneda || "$";
  const costoEnvio = Number(cfg?.CostoEnvio || 0);

  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const itemsTxt = cart.items
    .map((x) => `- ${x.nombre} (${x.qtyText})`)
    .join("\n");

  const entrega =
    od.delivery === "ENVIO"
      ? `🚚 Envío a domicilio\n📍 Dirección: ${od.address || "(no informada)"}\n💲 Envío: ${moneda} ${costoEnvio}`
      : `🏠 Retiro en local`;

  const pago =
    od.payment === "TRANSFER"
      ? "🏦 Transferencia (pendiente comprobante/validación)"
      : od.payment === "CASH"
        ? "💵 Efectivo"
        : "(no definido)";

  const negocio = cfg?.NegocioNombre || "Negocio";

  return (
    `🧾 <b>PEDIDO</b> — <b>${escapeHtml(negocio)}</b>\n` +
    `🆔 ID: <b>${escapeHtml(od.id || "")}</b>\n\n` +
    `🛒 <b>Detalle</b>\n${escapeHtml(itemsTxt)}\n\n` +
    `📦 <b>Entrega</b>\n${escapeHtml(entrega)}\n\n` +
    `💳 <b>Pago</b>\n${escapeHtml(pago)}\n\n` +
    `💰 <b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(total)}`
  );
}

async function notifyBusiness(cfg, from_chat_id, orderText, proofMessageId = null) {
  const vendorChat = String(cfg?.VendedorChatId || "").trim();
  if (!vendorChat) return { ok: false, reason: "No VendedorChatId" };

  // enviamos el pedido al chat del negocio
  const sent = await sendMessage(vendorChat, orderText, { parse_mode: "HTML" });

  // si hay comprobante, lo reenviamos también
  if (proofMessageId) {
    await forwardMessage(vendorChat, from_chat_id, proofMessageId);
  }

  return { ok: Boolean(sent?.ok) };
}

async function finalizeOrder(chat_id, { needsProof }) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);
  const od = orders.get(chat_id) || { id: nowId() };

  const orderText = buildOrderText(cfg, chat_id);

  // notificamos negocio si hay chat id
  await notifyBusiness(cfg, chat_id, orderText, null);

  // WA link cliente
  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const tel = normalizeUrl(cfg?.NegocioTelefono || "");
  const waBase = normalizeUrl(cfg?.WhatsAppLink || "");
  const waMsg =
    `Hola! Quiero confirmar este pedido (${od.id}) en ${negocio}:\n\n` +
    cart.items.map((x) => `- ${x.nombre} (${x.qtyText})`).join("\n") +
    `\n\nEntrega: ${od.delivery === "ENVIO" ? "Envío a domicilio" : "Retiro en local"}` +
    (od.delivery === "ENVIO" ? `\nDirección: ${od.address || ""}` : "") +
    `\nPago: ${od.payment === "TRANSFER" ? "Transferencia" : "Efectivo"}`;

  const wa =
    waBase && waBase.startsWith("http")
      ? waBase
      : tel
        ? `https://wa.me/${tel.replace(/\D/g, "")}?text=${urlEncode(waMsg)}`
        : `https://wa.me/?text=${urlEncode(waMsg)}`;

  let txt =
    `✅ <b>Pedido armado</b>\n\n` +
    `🆔 ID: <b>${escapeHtml(od.id)}</b>\n` +
    `Ahora podés confirmarlo por WhatsApp.\n`;

  if (needsProof) {
    txt += `\n📌 Tu pedido queda <b>pendiente</b> hasta que el negocio valide la transferencia.`;
  }

  // NO reseteo el carrito automáticamente: lo dejás para “seguir” si querés.
  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 Confirmar por WhatsApp", url: wa }],
        [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
        [{ text: "🛍️ Volver al catálogo", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// ---------------- Compartir bot (venta del sistema) ----------------
async function handleShareBot(chat_id) {
  const cfg = await loadConfig();
  const link = botStartLink("B");
  const texto = cfg?.TextoSistema || "¿Querés este sistema para tu negocio? Contactanos";
  const mail = cfg?.EmailSistema || "";

  const msg =
    `📣 <b>Compartir el bot</b>\n\n` +
    `🧀 Comprá por Telegram en ${escapeHtml(cfg?.NegocioNombre || "Todo Queso")}:\n${escapeHtml(link)}\n\n` +
    `✨ ${escapeHtml(texto)}${mail ? `\n✉️ ${escapeHtml(mail)}` : ""}`;

  const wa = `https://wa.me/?text=${urlEncode(`🧀 Mirá este bot:\n${link}\n\n${texto}`)}`;
  const tg = `https://t.me/share/url?url=${urlEncode(link)}&text=${urlEncode(texto)}`;

  return sendMessage(chat_id, msg, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }]] },
  });
}

// ---------------- Start / producto compartido ----------------
async function showSharedProduct(chat_id, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const item = items.find((x) => lower(x.codigo) === lower(code));

  if (!item) {
    return sendMessage(chat_id, "🧀 Te compartieron un producto, pero no lo encontré. Tocá Catálogo para verlo.", {
      reply_markup: mainMenuKeyboardReply(cfg),
    });
  }

  const caption =
    `🎁 <b>Te compartieron este producto</b>\n\n` +
    productCaption(cfg, item, 1, 1, item.categoria);

  const kb = {
    inline_keyboard: [
      [{ text: "🟢 Quiero este", callback_data: "P:BUY_SHARED" }],
      [{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
    ],
  };

  const st = getState(chat_id);
  st.mode = "SHARED";
  st.categoryLabel = item.categoria;
  st.list = [item];
  st.index = 0;
  st.messageId = null;
  st.awaitingQty = false;
  st.pendingItem = null;

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
    st.messageId = msg?.result?.message_id || null;
    userState.set(chat_id, st);
    return;
  }

  const msg = await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
  st.messageId = msg?.result?.message_id || null;
  userState.set(chat_id, st);
}

async function handleStart(chat_id, payload = "") {
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();

  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const logo = normalizeUrl(cfg?.LogoURL || "");
  const desc = cfg?.Descripcion || "";
  const direccion = cfg?.NegocioDireccion || "";
  const horario = cfg?.NegocioHorario || "";
  const tel = cfg?.NegocioTelefono || "";
  const estado = lower(cfg?.Estado || "");

  const estadoTxt =
    estado.includes("abier") ? "✅ <b>Estamos atendiendo</b>" :
    estado.includes("cerr") ? "🚫 <b>Ahora estamos cerrados</b>" :
    "";

  const bienvenida =
    `👋 <b>¡Hola!</b> Bienvenido/a a <b>${escapeHtml(negocio)}</b> 🧀\n` +
    (estadoTxt ? `${estadoTxt}\n` : "") +
    (direccion ? `📍 ${escapeHtml(direccion)}\n` : "") +
    (horario ? `🕒 ${escapeHtml(horario)}\n` : "") +
    (tel ? `📲 ${escapeHtml(tel)}\n` : "") +
    (desc ? `\n${escapeHtml(desc)}\n` : "\n") +
    `👉 Tocá <b>🛍️ Catálogo</b> para ver productos con foto.\n` +
    `👉 Tocá <b>🧾 Carrito</b> para finalizar.\n` +
    `👉 Si necesitás una mano, tocá <b>🆘 Ayuda</b>.`;

  // Si entra por producto compartido
  if (payload && payload.startsWith("P_")) {
    if (isHttp(logo)) await sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
    else await sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });

    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }

  if (isHttp(logo)) return sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  return sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ---------------- Ayuda ----------------
async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const custom = cfg?.TextoAyuda || "";
  const txt =
    custom
      ? escapeHtml(custom)
      : `🆘 <b>Ayuda</b>\n\n` +
        `• Tocá <b>🛍️ Catálogo</b> y elegí una categoría.\n` +
        `• En cada producto: tocá <b>🟢 Quiero este</b> para agregar.\n` +
        `• Para ver lo que agregaste: <b>🧾 Carrito</b>.\n` +
        `• Para enviar tu pedido: <b>Finalizar compra</b>.\n\n` +
        `Si querés, escribí <b>CATÁLOGO</b> y te lo abro 😉`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
}

// ---------------- Callbacks ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id);

  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat === "__ALL__" ? "__ALL__" : cat);
  }

  if (data === "P:NEXT" || data === "P:PREV") {
    const st = getState(chat_id);
    if (!st?.list?.length) return;

    const total = st.list.length;
    st.index = data === "P:NEXT" ? (st.index + 1) % total : (st.index - 1 + total) % total;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  if (data === "P:SHARE_MENU") {
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!st?.messageId || !item) return;
    return editMessageReplyMarkup(chat_id, st.messageId, shareOptionsKeyboard(item));
  }

  if (data === "SH:BACK") {
    const st = getState(chat_id);
    if (!st?.messageId) return;
    return editMessageReplyMarkup(chat_id, st.messageId, productNavKeyboard());
  }

  if (data === "P:BUY" || data === "P:BUY_SHARED") {
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!item) return;
    return askQuantity(chat_id, item);
  }

  if (data === "CART:VIEW") return showCart(chat_id);
  if (data === "CHECKOUT:START") return startCheckout(chat_id);
  if (data === "CHECKOUT:RETIRO") return chooseDelivery(chat_id, "RETIRO");
  if (data === "CHECKOUT:ENVIO") return chooseDelivery(chat_id, "ENVIO");

  if (data === "PAY:CASH") return setPayment(chat_id, "CASH");
  if (data === "PAY:TRANSFER") return setPayment(chat_id, "TRANSFER");
}

// ---------------- Mensajes ----------------
async function handleTextMessage(chat_id, message) {
  const cfg = await loadConfig();
  const text = (message?.text || "").trim();

  // /start con payload
  if (text === "/start") return handleStart(chat_id, "");
  if (text.startsWith("/start ")) {
    const payload = text.split(" ")[1] || "";
    return handleStart(chat_id, payload);
  }

  const st = getState(chat_id);

  // esperando dirección (envío)
  if (st.awaitingAddress) {
    const od = orders.get(chat_id) || { id: nowId() };
    od.address = text;
    orders.set(chat_id, od);
    st.awaitingAddress = false;
    userState.set(chat_id, st);
    return choosePaymentMenu(chat_id);
  }

  // esperando cantidad
  if (st.awaitingQty && st.pendingItem) {
    const qty = parseQty(text);
    if (!qty) {
      const pesable = isPesable(st.pendingItem);
      return sendMessage(
        chat_id,
        pesable ? "Decime gramos 😊 Ej: <b>200g</b>" : "Decime unidades 😊 Ej: <b>1</b> o <b>2</b>",
        { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) }
      );
    }
    if (!isPesable(st.pendingItem) && qty.kind === "GRAMOS") {
      return sendMessage(chat_id, "Este producto se pide por <b>unidades</b>. Ej: <b>1</b> o <b>2</b> 😊", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(cfg),
      });
    }
    if (isPesable(st.pendingItem) && qty.kind === "UNIDADES") {
      return sendMessage(chat_id, "Este producto es por peso 😊 Decime gramos. Ej: <b>200g</b>", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(cfg),
      });
    }

    st.awaitingQty = false;
    const item = st.pendingItem;
    st.pendingItem = null;
    userState.set(chat_id, st);
    return addToCart(chat_id, item, qty);
  }

  // menú rápido
  if (text === "🛍️ Catálogo" || text.toUpperCase() === "CATÁLOGO" || text.toUpperCase() === "CATALOGO") return handleCatalogMenu(chat_id);
  if (text === "🧾 Carrito") return showCart(chat_id);
  if (text === "📣 Compartir bot") return handleShareBot(chat_id);
  if (text === "🆘 Ayuda") return handleHelp(chat_id);

  // Sellos (por ahora no rompe)
  if (text === "🏷️ Sellos") {
    const txt = `🏷️ <b>Sellos</b>\n\nEsta sección queda lista para conectar sellos reales.\nPor ahora: usá <b>Catálogo</b> + <b>Carrito</b> 😉`;
    return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply(cfg) });
  }

  // fallback
  return sendMessage(chat_id, "👋 Para empezar tocá <b>Catálogo</b> o <b>Carrito</b> 😊", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboardReply(cfg),
  });
}

// ---------------- Comprobante (foto/archivo) ----------------
async function handleProof(chat_id, updateMessage) {
  const cfg = await loadConfig();
  const st = getState(chat_id);
  if (!st.awaitingProof) return;

  st.awaitingProof = false;
  userState.set(chat_id, st);

  const od = orders.get(chat_id) || { id: nowId() };
  od.pendingProof = true;
  orders.set(chat_id, od);

  const orderText = buildOrderText(cfg, chat_id);

  // Notificar negocio + reenviar comprobante
  const proofMsgId = updateMessage.message_id;
  await notifyBusiness(cfg, chat_id, orderText, proofMsgId);

  // y mostramos confirmación al cliente
  await finalizeOrder(chat_id, { needsProof: true });
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - BOT LIVE"));

app.get("/debug", async (req, res) => {
  try {
    const cfg = await loadConfig();
    const cat = await loadCatalog();
    res.status(200).json({
      ok: true,
      env: { hasToken: Boolean(TOKEN), publicUrl: PUBLIC_URL || null, dataApiUrl: DATA_API_URL || null, botUsername: BOT_USERNAME || null },
      configKeysSample: Object.keys(cfg).slice(0, 40),
      catalogSample: { items: cat.items.slice(0, 3), categories: cat.categories },
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body || {};

  try {
    // callback
    if (upd.callback_query) return handleCallback(upd.callback_query);

    // message (texto / foto / documento)
    if (upd.message) {
      const chat_id = upd.message.chat.id;

      // comprobante: foto o documento
      const st = getState(chat_id);
      if (st.awaitingProof && (upd.message.photo || upd.message.document)) {
        return handleProof(chat_id, upd.message);
      }

      // texto
      if (upd.message.text) return handleTextMessage(chat_id, upd.message);
      return;
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---------------- Boot ----------------
async function boot() {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");

  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) {
    BOT_USERNAME = me.result.username;
    console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  }

  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG OK. Keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ Error leyendo CONFIG:", String(e?.message || e));
  }

  try {
    const cat = await loadCatalog();
    console.log("✅ CATALOGO OK. Items:", cat.items.length, "Cats:", cat.categories.length);
  } catch (e) {
    console.log("❌ Error leyendo CATALOGO:", String(e?.message || e));
  }
}

app.listen(PORT, boot);
