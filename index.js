/**
 * EzerBot / Todo Queso — Bot (Telegram) — ÚNICO index.js
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN  (obligatorio)
 * - PUBLIC_URL      (obligatorio) ej https://tuservicio.onrender.com   (sin barra final)
 * - DATA_API_URL    (obligatorio) ej https://script.google.com/macros/s/XXXX/exec (sin query)
 * - BOT_USERNAME    (opcional) sin @ (si no está, se detecta con getMe)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "6mb" }));

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
function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
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

// ---------------- CSV Parser ----------------
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

  try {
    const j = JSON.parse(txt);
    return { kind: "json", data: j, contentType: ct, raw: txt };
  } catch (_) {}

  if (ct.includes("text/csv") || txt.trim().startsWith("CLAVE,") || txt.trim().startsWith("CODIGO,")) {
    return { kind: "csv", data: parseCsv(txt), contentType: ct, raw: txt };
  }

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
    rawItems = smart.data.rows;
    rawCats = [];
  }

  const items = rawItems
    .map((x) => {
      const codigo = String(x.codigo ?? x.CODIGO ?? x.id ?? x.ID ?? "").trim();
      const nombre = String(x.nombre ?? x.NOMBRE ?? "").trim();
      const precio = toNumberSafe(x.precio ?? x.PRECIO ?? 0);
      const unidad = String(x.unidad ?? x.UNIDAD ?? "").trim();
      const descripcion = String(x.descripcion ?? x.DESCRIPCION ?? "").trim();
      const imagen = normalizeUrl(
        x.imagen ?? x.IMAGEN ?? x.imagenUrl ?? x.IMAGENURL ?? x.imagen1 ?? x.IMAGEN1 ?? ""
      );
      const categoria = String(x.categoria ?? x.CATEGORIA ?? "Sin categoría").trim();

      const activoRaw = x.activo ?? x.ACTIVO;
      const activo =
        (activoRaw === undefined || activoRaw === null || String(activoRaw).trim() === "")
          ? true
          : (String(activoRaw).trim().toLowerCase() === "si" || String(activoRaw).trim().toLowerCase() === "true");

      const precioPorKilo = toNumberSafe(x.precioPorKilo ?? x.PRECIOPORKILO ?? x.precioKilo ?? x.PRECIOKILO ?? 0);

      const pesable =
        lower(unidad) === "kg" ||
        lower(unidad) === "kilo" ||
        lower(unidad) === "gramos" ||
        lower(unidad) === "gr" ||
        lower(unidad) === "g" ||
        precioPorKilo > 0;

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
  return item?.pesable === true || Number(item?.precioPorKilo || 0) > 0 || lower(item?.unidad) === "kg";
}

function getCfgBool(cfg, key) {
  return lower(cfg?.[key]) === "si" || cfg?.[key] === true;
}

// ---------------- Estado por usuario ----------------
const userState = new Map(); // chatId -> state
const carts = new Map(); // chatId -> cart
const orders = new Map(); // chatId -> order

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
function clearFlow(chatId) {
  userState.set(chatId, {});
  orders.delete(chatId);
}

// ---------------- Menú principal (solo 4) ----------------
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

// ---------------- Links compartir ----------------
function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function buildShareProductText(cfg, item) {
  const moneda = cfg?.Moneda || "$";
  const basePrecio = (isPesable(item) && Number(item.precioPorKilo || 0) > 0) ? item.precioPorKilo : item.precio;

  const precioTxt =
    (isPesable(item) && Number(item.precioPorKilo || 0) > 0)
      ? `${moneda} ${basePrecio} (por kg)`
      : `${moneda} ${basePrecio}`;

  const linkDirecto = botStartLink(`PROD_${item.codigo || ""}`);
  const negocio = cfg?.NegocioNombre || "Todo Queso";

  return (
    `🧀 ${item.nombre}\n` +
    `💰 ${precioTxt}\n` +
    (item.descripcion ? `📝 ${item.descripcion}\n` : "") +
    `\n📲 Pedilo por acá (${negocio}):\n${linkDirecto}`
  ).trim();
}

function shareLinksForText(text) {
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent("")}&text=${encodeURIComponent(text)}`;
  return { wa, tg };
}

// ---------------- Categorías ----------------
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

// ---------------- Producto ----------------
function productCaption(cfg, item, pos, total, categoryLabel) {
  const moneda = cfg?.Moneda || "$";
  const mostrarPrecio = lower(cfg?.CatalogoMostrarPrecios) !== "no";

  const basePrecio = (isPesable(item) && Number(item.precioPorKilo || 0) > 0) ? item.precioPorKilo : item.precio;
  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const extraKilo = (isPesable(item) && Number(item.precioPorKilo || 0) > 0)
    ? `\n⚖️ <i>Precio por kg: ${escapeHtml(moneda)} ${escapeHtml(basePrecio)}</i>`
    : "";
  const priceLine = mostrarPrecio
    ? `💰 <b>${escapeHtml(moneda)} ${escapeHtml(basePrecio || "-")}</b> ${unidadTxt}${extraKilo}\n`
    : "";

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
      [{ text: "📤 Compartir producto", callback_data: "P:SHARE" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

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

async function handleOpenProductByCode(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "").trim() === String(code || "").trim());
  if (!item) {
    return sendMessage(chat_id, "No encontré ese producto. Tocá Catálogo para ver la lista 😊", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }
  const st = getState(chat_id);
  st.mode = "CATALOG";
  st.categoryLabel = item.categoria || "Producto";
  st.list = [item];
  st.index = 0;
  st.messageId = null;
  st.awaitingQty = false;
  st.pendingItem = null;

  const created = await showProductCarousel(chat_id, st.list, 0, st.categoryLabel);
  st.messageId = created.messageId;
  userState.set(chat_id, st);
}

// ---------------- Cantidad ----------------
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

  const priceForCalc = (isPesable(item) && Number(item.precioPorKilo || 0) > 0)
    ? Number(item.precioPorKilo || 0)
    : Number(item.precio || 0);

  let subtotal = 0;
  if (isPesable(item)) {
    const kilos = (qty.value || 0) / 1000;
    subtotal = Math.round(priceForCalc * kilos);
  } else {
    subtotal = Math.round(priceForCalc * (qty.value || 0));
  }

  cart.items.push({
    codigo: item.codigo,
    nombre: item.nombre,
    unidad: item.unidad,
    pesable: isPesable(item),
    qtyText: qty.text,
    qtyValue: qty.value,
    priceForCalc,
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

// ---------------- Carrito + Checkout ----------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const moneda = cfg?.Moneda || "$";
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "🧾 <b>Carrito</b>\n\nTodavía no agregaste productos.\n👉 Tocá <b>Catálogo</b> para empezar 😉", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const lines = cart.items.map((x) => {
    const sub = money(x.subtotal, moneda);
    return `• <b>${escapeHtml(x.nombre)}</b> — <i>${escapeHtml(x.qtyText)}</i> — <b>${escapeHtml(sub)}</b>`;
  });

  const txt =
    `🧾 <b>Tu carrito</b>\n\n` +
    lines.join("\n") +
    `\n\n<b>Total:</b> ${escapeHtml(money(cart.total, moneda))}\n\n` +
    `✅ Cuando estés listo/a, tocá <b>Finalizar compra</b>.`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
        [{ text: "🧹 Vaciar carrito", callback_data: "CART:CLEAR" }],
      ],
    },
  });
}

async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "Tu carrito está vacío 😊 Tocá Catálogo para agregar productos.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const usaEnvio = getCfgBool(cfg, "UsaEnvioDomicilio") || getCfgBool(cfg, "UsaEnvíoDomicilio");
  const usaRetiro = getCfgBool(cfg, "UsaRetiroLocal");
  const costoEnvio = Number(cfg?.CostoEnvio || 0);

  const opciones = [];
  if (usaRetiro) opciones.push([{ text: "🏠 Retiro en local", callback_data: "CHECKOUT:RETIRO" }]);
  if (usaEnvio) opciones.push([{ text: `🚚 Envío a domicilio (+${money(costoEnvio, cfg?.Moneda || "$")})`, callback_data: "CHECKOUT:ENVIO" }]);
  if (!opciones.length) opciones.push([{ text: "✅ Continuar", callback_data: "CHECKOUT:RETIRO" }]);

  const od = orders.get(chat_id) || {};
  od.id = nowId();
  od.delivery = null;
  od.customerData = "";
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

  const st = getState(chat_id);

  if (delivery === "ENVIO") {
    const horario = cfg?.TextoEnvioDomicilio || cfg?.TextoEnvíoDomicilio || "";
    const prompt =
      `🚚 <b>Envío a domicilio</b>\n\n` +
      `Escribime estos datos en un solo mensaje:\n` +
      `• <b>Nombre</b>\n• <b>Dirección</b> (calle y número)\n• <b>Localidad</b>\n• <b>Referencia</b> (opcional)\n\n` +
      (horario ? `🕒 ${escapeHtml(horario)}\n\n` : "") +
      `Ejemplo:\n<i>Jenny, Carlos Pellegrini 526, Garín. Timbre rojo.</i>`;

    st.awaitingCustomerData = true;
    userState.set(chat_id, st);

    return sendMessage(chat_id, prompt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }

  st.awaitingCustomerData = false;
  userState.set(chat_id, st);
  return choosePaymentMenu(chat_id);
}

async function choosePaymentMenu(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const permitirPagoOnline = getCfgBool(cfg, "PermitirPagoOnline");
  const tipoPagoOnline = String(cfg?.TipoPagoOnline || "").trim().toUpperCase();

  const od = orders.get(chat_id) || { id: nowId() };
  orders.set(chat_id, od);

  const costoEnvio = Number(cfg?.CostoEnvio || 0);
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const botones = [];
  botones.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);
  if (permitirPagoOnline && tipoPagoOnline === "TRANSFERENCIA") {
    botones.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);
  }

  return sendMessage(chat_id, `💳 <b>Forma de pago</b>\n\nTotal a pagar: <b>${escapeHtml(money(total, cfg?.Moneda || "$"))}</b>\nElegí una opción:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: botones },
  });
}

function buildOrderText(cfg, chat_id) {
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || {};
  const moneda = cfg?.Moneda || "$";
  const costoEnvio = Number(cfg?.CostoEnvio || 0);
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const itemsTxt = cart.items.map((x) => `- ${x.nombre} (${x.qtyText})`).join("\n");

  const entrega =
    od.delivery === "ENVIO"
      ? `🚚 Envío a domicilio\n📍 Datos: ${od.customerData || "(no informado)"}\n💲 Envío: ${money(costoEnvio, moneda)}`
      : `🏠 Retiro en local`;

  const pago =
    od.payment === "TRANSFER"
      ? "🏦 Transferencia (a confirmar con comprobante)"
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
    `💰 <b>Total:</b> ${escapeHtml(money(total, moneda))}`
  );
}

async function notifyBusiness(cfg, from_chat_id, orderText, proofMessageId = null) {
  const vendorChat = String(cfg?.VendedorChatId || "").trim();
  if (!vendorChat) return { ok: false, reason: "No VendedorChatId" };

  await sendMessage(vendorChat, orderText, { parse_mode: "HTML" });

  if (proofMessageId) {
    await forwardMessage(vendorChat, from_chat_id, proofMessageId);
  }
  return { ok: true };
}

async function finalizeOrderTelegramOnly(chat_id, isTransferPending) {
  const cfg = await loadConfig();
  const orderText = buildOrderText(cfg, chat_id);

  await notifyBusiness(cfg, chat_id, orderText, null);

  const od = orders.get(chat_id) || {};
  const txt =
    `✅ <b>Pedido enviado al local</b>\n\n` +
    `🆔 ID: <b>${escapeHtml(od.id || "")}</b>\n` +
    (isTransferPending ? `📌 Estado: <b>Pendiente</b> hasta validar el comprobante.\n` : `📌 Estado: <b>En preparación</b>.\n`) +
    `\nGracias 😊`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛍️ Volver al catálogo", callback_data: "CAT_MENU" }],
        [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      ],
    },
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
    return finalizeOrderTelegramOnly(chat_id, false);
  }

  if (payment === "TRANSFER") {
    const moneda = cfg?.Moneda || "$";
    const costoEnvio = Number(cfg?.CostoEnvio || 0);
    const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

    const alias = cfg?.AliasTransferencia || "";
    const cbu = cfg?.CBUPago || "";

    const instruccionesCfg =
      cfg?.TextoTransferenciaInstrucciones ||
      cfg?.InstruccionesTransferencia ||
      "Hacé la transferencia y luego enviá el comprobante por acá (foto o archivo).";

    const texto =
      `🏦 <b>Transferencia</b>\n\n` +
      `Total: <b>${escapeHtml(money(total, moneda))}</b>\n\n` +
      (alias ? `🔑 Alias: <b>${escapeHtml(alias)}</b>\n` : "") +
      (cbu ? `🏷️ CBU: <b>${escapeHtml(cbu)}</b>\n` : "") +
      `\n${escapeHtml(instruccionesCfg)}\n\n` +
      `📎 <b>Ahora enviá el comprobante</b> (foto o archivo).`;

    const st = getState(chat_id);
    st.awaitingProof = true;
    userState.set(chat_id, st);

    return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }

  return choosePaymentMenu(chat_id);
}

// ---------------- Compartir bot (solo leyenda) ----------------
async function handleShareBot(chat_id) {
  return sendMessage(chat_id, "¿Querés este sistema para tu negocio?", {
    reply_markup: mainMenuKeyboardReply(),
  });
}

// ---------------- Start ----------------
async function handleStart(chat_id, payload = "") {
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  if (payload && payload.startsWith("PROD_")) {
    const code = payload.replace("PROD_", "");
    return handleOpenProductByCode(chat_id, code);
  }

  const cfg = await loadConfig();
  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const logo = normalizeUrl(cfg?.LogoURL || "");
  const desc = cfg?.Descripcion || "";
  const direccion = cfg?.NegocioDireccion || "";
  const horario = cfg?.NegocioHorario || "";
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
    (desc ? `\n${escapeHtml(desc)}\n\n` : "\n") +
    `👉 Tocá <b>🛍️ Catálogo</b> para ver productos.\n` +
    `👉 En cada producto tocá <b>🟢 Quiero este</b> para agregar.\n` +
    `👉 Si necesitás una mano tocá <b>🆘 Ayuda</b>.`;

  if (isHttp(logo)) return sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  return sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Ayuda ----------------
async function handleHelp(chat_id) {
  const txt =
    `🆘 <b>Ayuda rápida</b>\n\n` +
    `1) Tocá <b>🛍️ Catálogo</b> y elegí una categoría.\n` +
    `2) En el producto tocá <b>🟢 Quiero este</b>.\n` +
    `   • Si es por peso: escribí <b>200g</b>, <b>500g</b>.\n` +
    `   • Si es por unidad: escribí <b>1</b>, <b>2</b>.\n` +
    `3) Tocá <b>🧾 Ver carrito</b> y luego <b>Finalizar compra</b>.\n` +
    `4) Si elegís transferencia: enviá el <b>comprobante</b> por acá.\n\n` +
    `Si te trabaste, mandá <b>/cancel</b> para reiniciar.`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Comprobante ----------------
async function handleProof(chat_id, updateMessage) {
  const cfg = await loadConfig();
  const st = getState(chat_id);
  if (!st.awaitingProof) return;

  st.awaitingProof = false;
  userState.set(chat_id, st);

  const orderText = buildOrderText(cfg, chat_id);
  await notifyBusiness(cfg, chat_id, orderText, updateMessage.message_id);

  const confirmUser =
    cfg?.TextoTransferenciaComprobanteRecibido ||
    "✅ Comprobante recibido. ¡Gracias! Ya estamos preparando tu pedido 😊";

  await sendMessage(chat_id, escapeHtml(confirmUser), { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });

  return finalizeOrderTelegramOnly(chat_id, true);
}

// ---------------- Callbacks ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id);
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

  if (data === "P:BUY") {
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!item) return;
    return askQuantity(chat_id, item);
  }

  // ✅ Compartir producto
  if (data === "P:SHARE") {
    const cfg = await loadConfig();
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!item) return;

    const shareText = buildShareProductText(cfg, item);
    const { wa, tg } = shareLinksForText(shareText);

    return sendMessage(chat_id, `📤 <b>Compartir producto</b>\n\n${escapeHtml(shareText)}`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }],
          [{ text: "🛍️ Volver al catálogo", callback_data: "CAT_MENU" }],
        ],
      },
    });
  }

  if (data === "CART:VIEW") return showCart(chat_id);
  if (data === "CART:CLEAR") {
    carts.set(chat_id, { items: [], total: 0 });
    clearFlow(chat_id);
    return sendMessage(chat_id, "🧹 Listo. Vacío el carrito ✅", { reply_markup: mainMenuKeyboardReply() });
  }

  if (data === "CHECKOUT:START") return startCheckout(chat_id);
  if (data === "CHECKOUT:RETIRO") return chooseDelivery(chat_id, "RETIRO");
  if (data === "CHECKOUT:ENVIO") return chooseDelivery(chat_id, "ENVIO");

  if (data === "PAY:CASH") return setPayment(chat_id, "CASH");
  if (data === "PAY:TRANSFER") return setPayment(chat_id, "TRANSFER");
}

// ---------------- Mensajes ----------------
async function handleTextMessage(chat_id, message) {
  const text = (message?.text || "").trim();

  if (text.startsWith("/start")) return;
  if (text === "/cancel") {
    clearFlow(chat_id);
    return sendMessage(chat_id, "✅ Listo. Reinicié el flujo. Podés tocar Catálogo para empezar de nuevo.", { reply_markup: mainMenuKeyboardReply() });
  }

  const st = getState(chat_id);

  if (st.awaitingCustomerData) {
    const od = orders.get(chat_id) || { id: nowId() };
    od.customerData = text;
    orders.set(chat_id, od);

    st.awaitingCustomerData = false;
    userState.set(chat_id, st);

    return choosePaymentMenu(chat_id);
  }

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

  if (text === "🛍️ Catálogo" || text.toUpperCase() === "CATÁLOGO" || text.toUpperCase() === "CATALOGO") return handleCatalogMenu(chat_id);
  if (text === "📣 Compartir bot") return handleShareBot(chat_id);
  if (text === "🆘 Ayuda") return handleHelp(chat_id);

  if (text === "🏷️ Sellos / Tarjeta") {
    return sendMessage(chat_id, `🏷️ <b>Sellos / Tarjeta</b>\n\nEsta sección queda lista para conectar tarjeta virtual y sellos.\nPor ahora: usá <b>Catálogo</b> para comprar 😉`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  return sendMessage(chat_id, "👋 Tocá <b>🛍️ Catálogo</b> para empezar 😊", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboardReply(),
  });
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

      if (upd.message.text && upd.message.text.startsWith("/start")) {
        const parts = upd.message.text.split(" ");
        const payload = (parts[1] || "").trim();
        return handleStart(chat_id, payload);
      }

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
