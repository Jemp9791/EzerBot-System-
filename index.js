/**
 * EzerBot / Todo Queso — Bot (Telegram) — ÚNICO index.js
 *
 * Lee Config y Catálogo desde Google Apps Script por:
 *   DATA_API_URL?type=config   (puede devolver JSON o CSV CLAVE,VALOR)
 *   DATA_API_URL?type=catalog  (puede devolver JSON o CSV con encabezados)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN  (obligatorio)
 * - PUBLIC_URL      (obligatorio) ej https://ezerbot-system.onrender.com   (sin barra final)
 * - DATA_API_URL    (obligatorio) ej https://script.google.com/macros/s/XXXX/exec (sin query)
 * - BOT_USERNAME    (opcional) sin @ (si no está, se detecta con getMe)
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
function nowId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function cfgBool(cfg, key, def = false) {
  const v = cfg?.[key];
  if (v === undefined || v === null || String(v).trim() === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "si" || s === "true" || s === "1";
}
function cfgStr(cfg, key, def = "") {
  const v = cfg?.[key];
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  return s.length ? s : def;
}

// ---------------- CSV Parser (simple y robusto) ----------------
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function parseCsv(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (!lines.length) return { headers: [], rows: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = (cols[c] ?? "").trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

// ---------------- Fetch JSON o CSV ----------------
async function fetchSmart(url) {
  const res = await fetch(url, { method: "GET" });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const txt = await res.text();

  // Intentar JSON aunque venga con content-type raro
  try {
    const j = JSON.parse(txt);
    return { kind: "json", data: j, contentType: ct, raw: txt };
  } catch (_) {}

  // CSV seguro
  if (
    ct.includes("text/csv") ||
    txt.trim().startsWith("CLAVE,") ||
    txt.trim().toUpperCase().startsWith("CODIGO,") ||
    txt.trim().toUpperCase().startsWith("CÓDIGO,")
  ) {
    return { kind: "csv", data: parseCsv(txt), contentType: ct, raw: txt };
  }

  // Fallback: intentar csv igual
  const maybe = parseCsv(txt);
  if (maybe.headers.length >= 2) return { kind: "csv", data: maybe, contentType: ct, raw: txt };

  console.error("❌ Respuesta NO JSON/CSV desde:", url);
  console.error("Content-Type:", ct);
  console.error("Primeros 200 chars:", txt.slice(0, 200));
  throw new Error("DATA_API_URL no devuelve JSON ni CSV válido.");
}

// ---------------- Cache Config / Catalog ----------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, data: { items: [], categories: [] } };

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 20_000) return configCache.data;

  const url = `${DATA_API_URL}?type=config`;
  const smart = await fetchSmart(url);

  let cfg = {};
  if (smart.kind === "json") {
    cfg = (smart.data?.config && typeof smart.data.config === "object") ? smart.data.config : smart.data;
  } else {
    const { rows } = smart.data;
    for (const r of rows) {
      const k = r["CLAVE"] ?? r["Clave"] ?? r["key"] ?? r["KEY"] ?? "";
      const v = r["VALOR"] ?? r["Valor"] ?? r["value"] ?? r["VALUE"] ?? "";
      if (String(k || "").trim()) cfg[String(k).trim()] = String(v ?? "").trim();
    }
  }

  configCache = { at: now, data: cfg || {} };
  return configCache.data;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.data.items?.length && now - catalogCache.at < 20_000) return catalogCache.data;

  const url = `${DATA_API_URL}?type=catalog`;
  const smart = await fetchSmart(url);

  let rawItems = [];
  let rawCats = [];

  if (smart.kind === "json") {
    const cat = (smart.data?.catalog && typeof smart.data.catalog === "object") ? smart.data.catalog : smart.data;
    rawItems = Array.isArray(cat?.items) ? cat.items : [];
    rawCats = Array.isArray(cat?.categories) ? cat.categories : [];
  } else {
    const { rows } = smart.data;
    rawItems = rows;
    rawCats = [];
  }

  const items = rawItems
    .map((x) => {
      const codigo = String(x.codigo ?? x.CODIGO ?? x["CÓDIGO"] ?? x.id ?? x.ID ?? "").trim();
      const nombre = String(x.nombre ?? x.NOMBRE ?? "").trim();
      const precio = toNumberSafe(x.precio ?? x.PRECIO ?? 0);
      const unidad = String(x.unidad ?? x.UNIDAD ?? "").trim();
      const descripcion = String(x.descripcion ?? x.DESCRIPCION ?? x["DESCRIPCIÓN"] ?? "").trim();
      const imagen = normalizeUrl(
        x.imagen ?? x.IMAGEN ?? x.imagenUrl ?? x.IMAGENURL ?? x.imagen1 ?? x.IMAGEN1 ?? x.imagenUrl1 ?? x.IMAGENURL1 ?? ""
      );
      const categoria = String(x.categoria ?? x.CATEGORIA ?? "Sin categoría").trim();

      const activoRaw = x.activo ?? x.ACTIVO;
      const activo =
        (activoRaw === undefined || activoRaw === null || String(activoRaw).trim() === "")
          ? true
          : (String(activoRaw).trim().toLowerCase() === "si" || String(activoRaw).trim().toLowerCase() === "true");

      const precioPorKilo = toNumberSafe(x.precioPorKilo ?? x.PRECIOPORKILO ?? x.precioKilo ?? x.PRECIOKILO ?? 0);
      const pesable = lower(unidad) === "kg" || precioPorKilo > 0;

      return { codigo, nombre, precio, unidad, descripcion, imagen, categoria, activo, precioPorKilo, pesable };
    })
    .filter((x) => x.activo && x.nombre);

  const categories =
    rawCats.length
      ? rawCats.map(String)
      : [...new Set(items.map((x) => x.categoria))].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  catalogCache = { at: now, data: { items, categories } };
  return catalogCache.data;
}

function isPesable(item) {
  const u = lower(item?.unidad);
  if (["kg", "kilo", "kilos", "gr", "g", "gramo", "gramos"].includes(u)) return true;
  if (item?.pesable === true) return true;
  if (Number(item?.precioPorKilo || 0) > 0) return true;
  return false;
}

// ---------------- Estado por usuario (en memoria) ----------------
// Nota: esto se pierde si Render reinicia. Para POST lo vamos a persistir.
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

// ---------------- UI: MENÚ PRINCIPAL (solo 4) ----------------
function mainMenuKeyboardReply() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }],
      [{ text: "🏷️ Sellos / Tarjeta" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

// Botones del flujo de compra (inline)
function inlineFlowButtons() {
  return {
    inline_keyboard: [
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
    ],
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
  const moneda = cfgStr(cfg, "Moneda", "$");
  const mostrarPrecio = lower(cfgStr(cfg, "CatalogoMostrarPrecios", "si")) !== "no";
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
    return { messageId: msg?.result?.message_id || null };
  } else {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null };
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
    return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboardReply() });
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
  const pesable = isPesable(item);

  const txt = pesable
    ? `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuánto querés en <b>gramos</b>.\nEj: <b>200g</b> o <b>500g</b>`
    : `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuántas <b>unidades</b> querés.\nEj: <b>1</b> o <b>2</b>`;

  const st = getState(chat_id);
  st.awaitingQty = true;
  st.pendingItem = item;
  userState.set(chat_id, st);

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

async function addToCart(chat_id, item, qty) {
  const cart = getCart(chat_id);
  const cfg = await loadConfig();
  const moneda = cfgStr(cfg, "Moneda", "$");

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

  const msg =
    `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> (${escapeHtml(qty.text)}).\n\n` +
    `¿Qué querés hacer ahora?`;

  return sendMessage(chat_id, msg, {
    parse_mode: "HTML",
    reply_markup: inlineFlowButtons(),
  });
}

// ---------------- Carrito (solo dentro del flujo) ----------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const moneda = cfgStr(cfg, "Moneda", "$");
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "🧾 <b>Carrito</b>\n\nTodavía no agregaste productos.\n👉 Tocá <b>🛍️ Catálogo</b> para empezar 😉", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const lines = cart.items.map((x, i) => {
    const sub = money(x.subtotal, moneda).replace(`${moneda} `, "");
    return `${i + 1}) <b>${escapeHtml(x.nombre)}</b> — <i>${escapeHtml(x.qtyText)}</i> — <b>${escapeHtml(moneda)} ${escapeHtml(sub)}</b>`;
  });

  const txt =
    `🧾 <b>Tu carrito</b>\n\n` +
    lines.join("\n") +
    `\n\n<b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(cart.total)}\n\n` +
    `✅ Si ya está, tocá <b>Finalizar compra</b>.`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
        [{ text: "🏠 Menú", callback_data: "HOME" }],
      ],
    },
  });
}

// ---------------- Checkout ----------------
async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "Tu carrito está vacío 😊 Tocá 🛍️ Catálogo para agregar productos.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const usaEnvio = cfgBool(cfg, "UsaEnvíoDomicilio", false) || cfgBool(cfg, "UsaEnvioDomicilio", false) || cfgBool(cfg, "UsaEnvio", false);
  const usaRetiro = cfgBool(cfg, "UsaRetiroLocal", true);
  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const moneda = cfgStr(cfg, "Moneda", "$");

  const opciones = [];
  if (usaRetiro) opciones.push([{ text: "🏠 Retiro en local", callback_data: "CHECKOUT:RETIRO" }]);
  if (usaEnvio) opciones.push([{ text: `🚚 Envío a domicilio (+${money(costoEnvio, moneda)})`, callback_data: "CHECKOUT:ENVIO" }]);
  if (!opciones.length) opciones.push([{ text: "✅ Continuar", callback_data: "CHECKOUT:RETIRO" }]);

  const od = orders.get(chat_id) || {};
  od.id = nowId();
  od.delivery = null;
  od.address = "";
  od.payment = null;
  orders.set(chat_id, od);

  return sendMessage(chat_id, `✅ <b>Finalizar compra</b>\n\nElegí cómo querés recibir tu pedido:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: opciones },
  });
}

async function chooseDelivery(chat_id, delivery) {
  const cfg = await loadConfig();
  const od = orders.get(chat_id) || { id: nowId() };
  od.delivery = delivery;
  orders.set(chat_id, od);

  if (delivery === "ENVIO") {
    const texto = cfgStr(cfg, "TextoEnvíoDomicilio", cfgStr(cfg, "TextoEnvioDomicilio", "Escribime la dirección completa (calle, número, localidad y una referencia)."));
    const st = getState(chat_id);
    st.awaitingAddress = true;
    userState.set(chat_id, st);

    return sendMessage(chat_id, `🚚 <b>Envío a domicilio</b>\n\n${escapeHtml(texto)}`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  return choosePaymentMenu(chat_id);
}

async function choosePaymentMenu(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const permitirPagoOnline = cfgBool(cfg, "PermitirPagoOnline", true);
  const tipoPagoOnline = cfgStr(cfg, "TipoPagoOnline", "TRANSFERENCIA").toUpperCase();
  const moneda = cfgStr(cfg, "Moneda", "$");

  const od = orders.get(chat_id) || { id: nowId() };
  orders.set(chat_id, od);

  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const botones = [];
  botones.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);
  if (permitirPagoOnline && tipoPagoOnline === "TRANSFERENCIA") {
    botones.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);
  }

  return sendMessage(chat_id, `💳 <b>Forma de pago</b>\n\nTotal a pagar: <b>${escapeHtml(moneda)} ${escapeHtml(total)}</b>\nElegí una opción:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: botones },
  });
}

// WhatsApp: MIN CONFIG
// - UsaWhatsApp = SI/NO (default SI)
// - WhatsAppConfirmacionEfectivo = OBLIGATORIA | OPCIONAL | NINGUNA (default OBLIGATORIA)
// - WhatsAppConfirmacionTransferencia = OBLIGATORIA | OPCIONAL | NINGUNA (default OPCIONAL)
function getWhatsAppMode(cfg, key, def) {
  const v = cfgStr(cfg, key, def).toUpperCase();
  if (["OBLIGATORIA", "OPCIONAL", "NINGUNA"].includes(v)) return v;
  return def;
}

function buildWhatsAppLink(cfg, chat_id) {
  const cart = getCart(chat_id);
  recalcCart(cart);
  const od = orders.get(chat_id) || {};

  const negocio = cfgStr(cfg, "NegocioNombre", "Todo Queso");
  const tel = normalizeUrl(cfgStr(cfg, "NegocioTelefono", ""));
  const waBase = normalizeUrl(cfgStr(cfg, "WhatsAppLink", ""));

  const waMsg =
    `Hola! Quiero confirmar/consultar este pedido (${od.id}) en ${negocio}:\n\n` +
    cart.items.map((x) => `- ${x.nombre} (${x.qtyText})`).join("\n") +
    `\n\nEntrega: ${od.delivery === "ENVIO" ? "Envío a domicilio" : "Retiro en local"}` +
    (od.delivery === "ENVIO" ? `\nDirección: ${od.address || ""}` : "") +
    `\nPago: ${od.payment === "TRANSFER" ? "Transferencia" : "Efectivo"}`;

  if (waBase && waBase.startsWith("http")) return waBase;
  if (tel) return `https://wa.me/${tel.replace(/\D/g, "")}?text=${encodeURIComponent(waMsg)}`;
  return `https://wa.me/?text=${encodeURIComponent(waMsg)}`;
}

function buildOrderText(cfg, chat_id) {
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || {};
  const moneda = cfgStr(cfg, "Moneda", "$");
  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const itemsTxt = cart.items.map((x) => `- ${x.nombre} (${x.qtyText})`).join("\n");

  const entrega =
    od.delivery === "ENVIO"
      ? `🚚 Envío a domicilio\n📍 Dirección: ${od.address || "(no informada)"}\n💲 Envío: ${moneda} ${costoEnvio}`
      : `🏠 Retiro en local`;

  const pago =
    od.payment === "TRANSFER"
      ? "🏦 Transferencia (con comprobante)"
      : od.payment === "CASH"
        ? "💵 Efectivo"
        : "(no definido)";

  const negocio = cfgStr(cfg, "NegocioNombre", "Negocio");

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
  const vendorChat = String(cfgStr(cfg, "VendedorChatId", "")).trim();
  if (!vendorChat) return { ok: false, reason: "No VendedorChatId" };

  await sendMessage(vendorChat, orderText, { parse_mode: "HTML" });

  if (proofMessageId) {
    await forwardMessage(vendorChat, from_chat_id, proofMessageId);
  }
  return { ok: true };
}

async function finalizeOrder(chat_id, transferProofReceived, proofMessageId = null) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);
  const od = orders.get(chat_id) || { id: nowId() };

  // Aviso al negocio (con comprobante si existe)
  const orderText = buildOrderText(cfg, chat_id);
  await notifyBusiness(cfg, chat_id, orderText, proofMessageId);

  const usarWA = cfgBool(cfg, "UsaWhatsApp", true);
  const modoCash = getWhatsAppMode(cfg, "WhatsAppConfirmacionEfectivo", "OBLIGATORIA");
  const modoTransf = getWhatsAppMode(cfg, "WhatsAppConfirmacionTransferencia", "OPCIONAL");

  const waUrl = buildWhatsAppLink(cfg, chat_id);
  const labelWA = cfgStr(cfg, "TextoBotonWhatsApp", "📲 WhatsApp");

  let txt = `✅ <b>Pedido enviado</b>\n\n🆔 ID: <b>${escapeHtml(od.id)}</b>\n`;

  if (od.payment === "TRANSFER") {
    if (transferProofReceived) {
      txt += `📎 Comprobante recibido.\n📌 Queda <b>pendiente</b> hasta validar la transferencia.\n`;
    } else {
      txt += `📌 Queda <b>pendiente</b> hasta recibir/validar el comprobante.\n`;
    }

    if (usarWA) {
      if (modoTransf === "OBLIGATORIA") txt += `\nPara confirmarlo, tocá WhatsApp 👇`;
      if (modoTransf === "OPCIONAL") txt += `\nSi necesitás, podés escribirnos por WhatsApp (opcional) 👇`;
    }
  } else {
    txt += `\n📌 Pagás en efectivo al recibir/retirar.\n`;
    if (usarWA) {
      if (modoCash === "OBLIGATORIA") txt += `\nPara confirmarlo, tocá WhatsApp 👇`;
      if (modoCash === "OPCIONAL") txt += `\nSi querés, podés avisarnos por WhatsApp (opcional) 👇`;
    }
  }

  const buttons = [];

  const showWA =
    usarWA &&
    (
      (od.payment === "TRANSFER" && modoTransf !== "NINGUNA") ||
      (od.payment === "CASH" && modoCash !== "NINGUNA")
    );

  if (showWA) buttons.push([{ text: labelWA, url: waUrl }]);

  buttons.push([{ text: "🛍️ Volver al catálogo", callback_data: "CAT_MENU" }]);
  buttons.push([{ text: "🏠 Menú", callback_data: "HOME" }]);

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function setPayment(chat_id, payment) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || { id: nowId() };
  od.payment = payment;
  orders.set(chat_id, od);

  if (payment === "CASH") {
    return finalizeOrder(chat_id, false, null);
  }

  if (payment === "TRANSFER") {
    const moneda = cfgStr(cfg, "Moneda", "$");
    const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
    const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

    const alias = cfgStr(cfg, "AliasTransferencia", "");
    const cbu = cfgStr(cfg, "CBUPago", "");
    const msg = cfgStr(cfg, "MensajeTransferencia", "Hacé la transferencia y enviá el comprobante por acá.");

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

    return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }

  return choosePaymentMenu(chat_id);
}

// ---------------- Compartir bot ----------------
async function handleShareBot(chat_id) {
  const cfg = await loadConfig();
  const link = botStartLink("B");
  const texto = cfgStr(cfg, "TextoSistema", "¿Querés este sistema para tu negocio? Contactanos");
  const mail = cfgStr(cfg, "EmailSistema", "");

  const msg =
    `📣 <b>Compartir el bot</b>\n\n` +
    `🧀 Comprá por Telegram en <b>${escapeHtml(cfgStr(cfg, "NegocioNombre", "Todo Queso"))}</b>:\n${escapeHtml(link)}\n\n` +
    `✨ ${escapeHtml(texto)}${mail ? `\n✉️ ${escapeHtml(mail)}` : ""}`;

  const wa = `https://wa.me/?text=${encodeURIComponent(`🧀 Mirá este bot:\n${link}\n\n${texto}`)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(texto)}`;

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
    return sendMessage(chat_id, "🧀 Te compartieron un producto, pero no lo encontré. Tocá 🛍️ Catálogo para verlo.", {
      reply_markup: mainMenuKeyboardReply(),
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

  if (isHttp(item.imagen)) return sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
}

async function handleStart(chat_id, payload = "") {
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();
  const negocio = cfgStr(cfg, "NegocioNombre", "Todo Queso");
  const logo = normalizeUrl(cfgStr(cfg, "LogoURL", ""));
  const desc = cfgStr(cfg, "Descripcion", "");
  const direccion = cfgStr(cfg, "NegocioDireccion", "");
  const horario = cfgStr(cfg, "NegocioHorario", "");
  const tel = cfgStr(cfg, "NegocioTelefono", "");
  const estado = lower(cfgStr(cfg, "Estado", ""));

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
    `👇 Elegí una opción del menú:\n` +
    `• 🛍️ <b>Catálogo</b> para ver productos y agregar.\n` +
    `• 🏷️ <b>Sellos / Tarjeta</b> para tu beneficio.\n` +
    `• 📣 <b>Compartir bot</b> para enviarlo a un amigo.\n` +
    `• 🆘 <b>Ayuda</b> si tenés dudas.`;

  // Si viene /start con producto compartido
  if (payload && payload.startsWith("P_")) {
    if (isHttp(logo)) await sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
    else await sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
    return showSharedProduct(chat_id, payload.slice(2));
  }

  if (isHttp(logo)) return sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  return sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Ayuda (más idónea) ----------------
async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const custom = cfgStr(cfg, "TextoAyuda", "");

  const txt =
    custom
      ? escapeHtml(custom)
      : `🆘 <b>Ayuda</b>\n\n` +
        `✅ <b>Cómo comprar</b>\n` +
        `1) Tocá 🛍️ <b>Catálogo</b>\n` +
        `2) Elegí una <b>categoría</b>\n` +
        `3) En el producto tocá <b>🟢 Quiero este</b>\n` +
        `4) Escribí la cantidad:\n` +
        `   • Si es por peso: <b>200g</b> / <b>500g</b>\n` +
        `   • Si es por unidad: <b>1</b> / <b>2</b>\n` +
        `5) Te van a aparecer botones para:\n` +
        `   • 🧾 Ver carrito\n` +
        `   • ✅ Finalizar compra\n` +
        `\n📦 <b>Envío / Retiro</b>\n` +
        `• Si elegís <b>Envío</b>, escribí tu dirección completa.\n` +
        `• Si elegís <b>Retiro</b>, te preparamos el pedido para que pases.\n` +
        `\n🏦 <b>Transferencia</b>\n` +
        `• Te mostramos el alias/CBU.\n` +
        `• Después enviás el <b>comprobante</b> por acá (foto o archivo).\n` +
        `\nSi querés, decime: <b>"Quiero comprar"</b> y te llevo al catálogo 😊`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Sellos / Tarjeta (placeholder listo para POST) ----------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const nombre = cfgStr(cfg, "NegocioNombre", "Todo Queso");

  // Placeholder: en POST vamos a conectar sellos reales desde Sheets
  const txt =
    `🏷️ <b>Sellos / Tarjeta</b>\n\n` +
    `Esta sección ya está lista para conectar tu tarjeta real de <b>${escapeHtml(nombre)}</b>.\n` +
    `En la próxima etapa (POST) vamos a mostrar:\n` +
    `• tus sellos actuales\n` +
    `• tu próximo beneficio\n` +
    `• y tu tarjeta virtual.\n\n` +
    `Mientras tanto podés comprar desde 🛍️ <b>Catálogo</b> 😊`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
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
  const text = (message?.text || "").trim();

  if (text === "/start") return handleStart(chat_id, "");
  if (text.startsWith("/start ")) return handleStart(chat_id, (text.split(" ")[1] || "").trim());

  const st = getState(chat_id);

  // Dirección
  if (st.awaitingAddress) {
    const od = orders.get(chat_id) || { id: nowId() };
    od.address = text;
    orders.set(chat_id, od);
    st.awaitingAddress = false;
    userState.set(chat_id, st);
    return choosePaymentMenu(chat_id);
  }

  // Cantidad
  if (st.awaitingQty && st.pendingItem) {
    const qty = parseQty(text);
    if (!qty) {
      const pesable = isPesable(st.pendingItem);
      return sendMessage(chat_id, pesable ? "Decime gramos 😊 Ej: <b>200g</b>" : "Decime unidades 😊 Ej: <b>1</b> o <b>2</b>", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }
    if (!isPesable(st.pendingItem) && qty.kind === "GRAMOS") {
      return sendMessage(chat_id, "Este producto se pide por <b>unidades</b>. Ej: <b>1</b> o <b>2</b> 😊", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }
    if (isPesable(st.pendingItem) && qty.kind === "UNIDADES") {
      return sendMessage(chat_id, "Este producto es por peso 😊 Decime gramos. Ej: <b>200g</b>", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }

    st.awaitingQty = false;
    const item = st.pendingItem;
    st.pendingItem = null;
    userState.set(chat_id, st);
    return addToCart(chat_id, item, qty);
  }

  // Menú principal (solo 4)
  if (text === "🛍️ Catálogo" || text.toUpperCase() === "CATÁLOGO" || text.toUpperCase() === "CATALOGO" || lower(text) === "quiero comprar") {
    return handleCatalogMenu(chat_id);
  }
  if (text === "🏷️ Sellos / Tarjeta" || lower(text) === "sellos" || lower(text) === "tarjeta") return handleSellos(chat_id);
  if (text === "📣 Compartir bot") return handleShareBot(chat_id);
  if (text === "🆘 Ayuda" || lower(text) === "ayuda") return handleHelp(chat_id);

  return sendMessage(chat_id, "👋 Para empezar tocá 🛍️ <b>Catálogo</b> 😊", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboardReply(),
  });
}

// ---------------- Comprobante (foto/archivo) ----------------
async function handleProof(chat_id, updateMessage) {
  const st = getState(chat_id);
  if (!st.awaitingProof) return;

  st.awaitingProof = false;
  userState.set(chat_id, st);

  // En transferencia: al recibir comprobante, cerramos pedido y avisamos al vendedor (con forward)
  return finalizeOrder(chat_id, true, updateMessage.message_id);
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - BOT LIVE"));

app.get("/debug", async (req, res) => {
  try {
    const cfg = await loadConfig();
    const cat = await loadCatalog();
    res.status(200).json({
      ok: true,
      env: {
        hasToken: Boolean(TOKEN),
        publicUrl: PUBLIC_URL || null,
        dataApiUrl: DATA_API_URL || null,
        botUsername: BOT_USERNAME || null,
      },
      configKeysSample: Object.keys(cfg).slice(0, 80),
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
    if (upd.callback_query) return handleCallback(upd.callback_query);

    if (upd.message) {
      const chat_id = upd.message.chat.id;
      const st = getState(chat_id);

      if (st.awaitingProof && (upd.message.photo || upd.message.document)) {
        return handleProof(chat_id, upd.message);
      }

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
