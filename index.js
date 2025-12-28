/**
 * EZERBOT - Bot + Catálogo carrusel + Carrito + Checkout + Vendedor confirma pago + Sellos + Referidos
 * (MEJORA: Categorías con emoji automático + paginado + texto vendedor)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL              (ej: https://ezerbot-system.onrender.com  sin / final)
 * - SHEETS_API_BASE         (endpoint JSON)
 *    - ?type=config   -> { KEY: VALUE, ... }
 *    - ?type=catalog  -> [{ codigo,nombre,precio,unidad,descripcion,imagen,categoria, ... }]
 *
 * Webhook:
 * - POST /telegram
 * - Set webhook => PUBLIC_URL + "/telegram"
 */

import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------- ENV ----------------
const PORT = Number(process.env.PORT || 10000);
const TOKEN = String(process.env.TELEGRAM_TOKEN || "").trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEETS_API_BASE = String(process.env.SHEETS_API_BASE || "").trim();

if (!TOKEN) console.log("❌ Falta TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.log("❌ Falta PUBLIC_URL");
if (!SHEETS_API_BASE) console.log("❌ Falta SHEETS_API_BASE");

// ---------------- Telegram API ----------------
const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) console.log("⚠️ Telegram API error:", method, data);
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
  return tgCall("editMessageCaption", { chat_id, message_id, caption, parse_mode: "HTML", ...extra });
}
async function answerCallbackQuery(id) {
  return tgCall("answerCallbackQuery", { callback_query_id: id }).catch(() => {});
}

// ---------------- Utils ----------------
const safe = (v) => String(v ?? "").trim();

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function moneyARS(n) {
  const v = Number(String(n || 0).replace(",", "."));
  if (!isFinite(v)) return "$0";
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function normalizeUnit(u) {
  const s = safe(u).toLowerCase();
  if (s.includes("kg") || s.includes("kilo")) return "kg";
  return "unidad";
}

// Limpia markdown tipo [url](url) o corchetes
function normalizeUrl(u) {
  const t = safe(u);
  if (!t) return "";
  const m = t.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1].trim();
  return t.replace(/^\[|\]$/g, "").trim();
}

function pick(cfg, key, fallback = "") {
  const v = safe(cfg?.[key]);
  return v ? v : fallback;
}

function yes(cfg, key) {
  return safe(cfg?.[key]).toUpperCase() === "SI";
}

function splitPipe(s) {
  return safe(s)
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------- Cache Config / Catalog ----------------
const CACHE_TTL = 30_000;
let cache = { at: 0, config: null, catalog: null };

async function fetchJSON(url) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`Respuesta no JSON: ${t.slice(0, 220)}`);
  }
}

async function getConfig() {
  const now = Date.now();
  if (cache.config && now - cache.at < CACHE_TTL) return cache.config;
  const data = await fetchJSON(`${SHEETS_API_BASE}?type=config&_=${now}`);
  cache.at = now;
  cache.config = data || {};
  return cache.config;
}

async function getCatalog() {
  const now = Date.now();
  if (cache.catalog && now - cache.at < CACHE_TTL) return cache.catalog;
  const data = await fetchJSON(`${SHEETS_API_BASE}?type=catalog&_=${now}`);
  cache.at = now;
  cache.catalog = Array.isArray(data) ? data : [];
  return cache.catalog;
}

// ---------------- Persistencia simple (sellos + referidos) ----------------
const DATA_FILE = path.join(process.cwd(), "ezerbot_data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { users: {} };
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj?.users) return { users: {} };
    return obj;
  } catch {
    return { users: {} };
  }
}

function saveData(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

const db = loadData();
/**
 * db.users[chatId] = {
 *   sellos: number,
 *   referredBy: chatId|null,
 *   rewardedReferrer: boolean,
 *   lastTicketId: string|null
 * }
 */
function getUser(chatId) {
  const id = String(chatId);
  if (!db.users[id]) db.users[id] = { sellos: 0, referredBy: null, rewardedReferrer: false, lastTicketId: null };
  return db.users[id];
}

function addSellos(chatId, n) {
  const u = getUser(chatId);
  u.sellos = Math.max(0, Number(u.sellos || 0) + Number(n || 0));
  saveData(db);
  return u.sellos;
}

// ---------------- Estado en memoria ----------------
const state = new Map();
/**
 * state[chatId] = {
 *  catFilter, index, messageId,
 *  listSnapshot: [],
 *  awaitingQty: { code, unit } | null,
 *  cart: Map(code -> {prod, qty}),
 *  checkout: null | {...},
 *  catsPage: number
 * }
 */
function getState(chatId) {
  const id = String(chatId);
  if (!state.has(id)) {
    state.set(id, {
      catFilter: "ALL",
      index: 0,
      messageId: null,
      listSnapshot: [],
      awaitingQty: null,
      cart: new Map(),
      checkout: null,
      catsPage: 0,
    });
  }
  return state.get(id);
}

// ---------------- ✅ Emoji categorías (AUTO + opcional) ----------------
function stripEmojiPrefix(name) {
  // quita emoji al inicio si ya viene "🥛 Lácteos"
  return safe(name).replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "").trim();
}
function hasEmojiPrefix(name) {
  return /^[\p{Extended_Pictographic}\uFE0F]/u.test(safe(name));
}
function emojiForCategory(catRaw) {
  const cat = stripEmojiPrefix(catRaw).toLowerCase();

  const rules = [
    { keys: ["promo", "oferta", "combo", "descuento", "sale"], e: "🧨" },
    { keys: ["láct", "lact", "leche", "yog", "ques", "mante", "crema"], e: "🥛" },
    { keys: ["fiambre", "jam", "salame", "mort", "bond", "palet"], e: "🥓" },
    { keys: ["pan", "panif", "fact", "medial", "torta"], e: "🍞" },
    { keys: ["beb", "gase", "agua", "vino", "cerve", "jugo"], e: "🥤" },
    { keys: ["dulce", "postre", "helado", "choco", "caramelo"], e: "🍫" },
    { keys: ["fruta", "verd", "ensalada"], e: "🥗" },
    { keys: ["café", "cafe", "té", "te", "mate"], e: "☕" },
    { keys: ["mascota", "perro", "gato"], e: "🐾" },
    { keys: ["limpieza", "hogar"], e: "🧼" },
    { keys: ["farm", "medic", "salud"], e: "💊" },
    { keys: ["ferre", "herram"], e: "🛠️" },
    { keys: ["ropa", "indument"], e: "👕" },
    { keys: ["regalo", "gift"], e: "🎁" },
  ];

  for (const r of rules) {
    if (r.keys.some((k) => cat.includes(k))) return r.e;
  }
  return "🛍️"; // genérico
}

function formatCategoryButtonLabel(catRaw) {
  const raw = safe(catRaw);
  if (!raw) return "🛍️ Sin categoría";
  if (hasEmojiPrefix(raw)) return raw; // respetar si ya trae
  const clean = stripEmojiPrefix(raw);
  return `${emojiForCategory(clean)} ${clean}`;
}

// ---------------- Menú principal (teclado) ----------------
function replyMenu(cfg) {
  // (No cambio tu estructura acá para no romperte nada)
  const rows = [
    [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
    [{ text: "✅ Finalizar compra" }],
    [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
  ];
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false };
}

// ---------------- Categorías (paginadas) ----------------
const CATS_PER_PAGE = 8; // 4 filas de 2 botones

function uniqueCategories(items) {
  const set = new Set();
  for (const p of items) {
    const c = safe(p.categoria || p.CATEGORIA);
    if (c) set.add(stripEmojiPrefix(c)); // guardamos limpio
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function categoriesKeyboardPaged(categories, page = 0) {
  const rows = [];

  // primera fila "Todas"
  rows.push([{ text: "📚 Todas", callback_data: "CAT:ALL" }]);

  const totalPages = Math.max(1, Math.ceil(categories.length / CATS_PER_PAGE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const start = p * CATS_PER_PAGE;
  const slice = categories.slice(start, start + CATS_PER_PAGE);

  let r = [];
  for (const c of slice) {
    const label = formatCategoryButtonLabel(c);
    r.push({ text: label, callback_data: `CAT:${encodeURIComponent(c)}` }); // filtro usa limpio
    if (r.length === 2) {
      rows.push(r);
      r = [];
    }
  }
  if (r.length) rows.push(r);

  // paginación
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️", callback_data: `CATS:PAGE:${Math.max(0, p - 1)}` },
      { text: `📄 ${p + 1}/${totalPages}`, callback_data: "CATS:NOOP" },
      { text: "➡️", callback_data: `CATS:PAGE:${Math.min(totalPages - 1, p + 1)}` },
    ]);
  }

  rows.push([{ text: "🛒 Carrito", callback_data: "OPEN:CART" }]);
  return { inline_keyboard: rows };
}

// ---------------- Productos (carrusel book) ----------------
function productNavKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "P:PREV" },
        { text: "➡️ Siguiente", callback_data: "P:NEXT" },
      ],
      [
        { text: "🟢 Quiero éste", callback_data: "P:ADD" },
        { text: "📣 Compartir", callback_data: "P:SHARE" },
      ],
      [
        { text: "📁 Categorías", callback_data: "OPEN:CATS" },
        { text: "🛒 Carrito", callback_data: "OPEN:CART" },
      ],
    ],
  };
}

function afterAddKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }],
    ],
  };
}

function shareOptionsKeyboard(waUrl, tgUrl) {
  return {
    inline_keyboard: [
      [{ text: "💬 WhatsApp", url: waUrl }, { text: "✈️ Telegram", url: tgUrl }],
    ],
  };
}

function filterCatalog(items, filter) {
  if (!filter || filter === "ALL") return items;
  return items.filter((p) => stripEmojiPrefix(safe(p.categoria || p.CATEGORIA)) === stripEmojiPrefix(filter));
}

function productCaption(cfg, p, filterLabel, index, total) {
  const nombre = escapeHtml(safe(p.nombre || p.NOMBRE));
  const desc = escapeHtml(safe(p.descripcion || p.DESCRIPCION));
  const unidad = normalizeUnit(p.unidad || p.UNIDAD);
  const precio = safe(p.precio || p.PRECIO);
  const moneda = pick(cfg, "Moneda", "ARS");

  const head =
    filterLabel && filterLabel !== "ALL"
      ? `🛍️ <b>${escapeHtml(filterLabel)}</b>\n`
      : `🛍️ <b>Catálogo</b>\n`;

  const pos = `📖 <i>${index + 1} de ${total}</i>\n\n`;

  let cap = head + pos;
  cap += `🧀 <b>${nombre}</b>\n`;
  if (yes(cfg, "CatalogoMostrarPrecios")) {
    cap += `💰 <b>${escapeHtml(moneda)} ${escapeHtml(precio || "-")}</b> ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  }
  if (desc) cap += `📝 ${desc}\n`;
  return cap;
}

async function renderCarousel(chatId, forceNew = false) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const all = await getCatalog();
  const list = filterCatalog(all, st.catFilter);

  if (!list.length) {
    await sendMessage(chatId, "Todavía no hay productos en esa categoría.", {
      reply_markup: { inline_keyboard: [[{ text: "📁 Categorías", callback_data: "OPEN:CATS" }]] },
    });
    return;
  }

  if (st.index < 0) st.index = 0;
  if (st.index >= list.length) st.index = list.length - 1;

  st.listSnapshot = list;

  const p = list[st.index];
  const img = normalizeUrl(p.imagen || p.IMAGEN || "");
  const label = st.catFilter === "ALL" ? "Catálogo" : st.catFilter;
  const caption = productCaption(cfg, p, label, st.index, list.length);
  const kb = productNavKeyboard();

  if (!forceNew && st.messageId) {
    if (img && img.startsWith("http")) {
      await editMessageMedia(chatId, st.messageId, img, caption, { reply_markup: kb });
    } else {
      await editMessageCaption(chatId, st.messageId, caption, { reply_markup: kb });
    }
    return;
  }

  let created;
  if (img && img.startsWith("http")) {
    created = await sendPhoto(chatId, img, caption, { parse_mode: "HTML", reply_markup: kb });
  } else {
    created = await sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: kb });
  }
  st.messageId = created?.result?.message_id || null;
}

// ---------------- Share links (bot + producto) ----------------
function buildBotStartLink(cfg, payload) {
  const botLink = pick(cfg, "BotLink", "");
  if (botLink) {
    if (payload) return `${botLink}?start=${encodeURIComponent(payload)}`;
    return botLink;
  }
  return payload ? `https://t.me/${encodeURIComponent("Ezer_IA_Bot")}?start=${encodeURIComponent(payload)}` : "";
}

function shareUrlsForText(text) {
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(" ")}&text=${encodeURIComponent(text)}`;
  return { wa, tg };
}

async function sendShareBot(chatId) {
  const cfg = await getConfig();
  if (!yes(cfg, "CompartirBotActivo")) {
    await sendMessage(chatId, "Por ahora el compartir bot está desactivado.", { reply_markup: replyMenu(cfg) });
    return;
  }

  const payload = `ref_${chatId}`;
  const link = buildBotStartLink(cfg, payload);

  const texto = `${pick(cfg, "TextoCompartirBot", "Compartí este bot")} 🧀\n\n${link}\n\n${pick(cfg, "TextoSistema", "")}`.trim();
  const { wa, tg } = shareUrlsForText(texto);

  await sendMessage(chatId, "📣 Elegí dónde querés compartir el bot:", {
    reply_markup: shareOptionsKeyboard(wa, tg),
  });
}

async function sendShareProduct(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const p = st.listSnapshot?.[st.index];
  if (!p) return;

  const code = safe(p.codigo || p.CODIGO || "");
  const nombre = safe(p.nombre || p.NOMBRE || "Producto");
  const payload = `prod_${code}__ref_${chatId}`;
  const link = buildBotStartLink(cfg, payload);

  const text = `🧀 ${pick(cfg, "NegocioNombre", "Todo Queso")} te recomienda:\n${nombre}\n\nEntrá directo acá 👇\n${link}`;
  const { wa, tg } = shareUrlsForText(text);

  await sendMessage(chatId, "📣 Compartir este producto:", {
    reply_markup: shareOptionsKeyboard(wa, tg),
  });
}

// ---------------- ✅ Welcome “vendedor” ----------------
async function sendWelcome(chatId, startPayload = "") {
  const cfg = await getConfig();

  const negocio = pick(cfg, "NegocioNombre", "Todo Queso");
  const dir = pick(cfg, "NegocioDireccion", "");
  const hor = pick(cfg, "NegocioHorario", "");
  const tel = pick(cfg, "NegocioTelefono", "");
  const ig = pick(cfg, "NegocioInstagram", "");
  const logo = normalizeUrl(pick(cfg, "LogoURL", ""));
  const desc = safe(cfg?.Descripcion || "");
  const estado = pick(cfg, "Estado", "Abierto");

  let text = `🧀 <b>${escapeHtml(negocio)}</b>\n\n`;
  if (estado) text += `🟢 <b>${escapeHtml(estado)}</b>\n`;
  if (dir) text += `📍 ${escapeHtml(dir)}\n`;
  if (hor) text += `🕒 ${escapeHtml(hor)}\n`;
  if (tel) text += `📞 ${escapeHtml(tel)}\n`;
  if (ig) text += `📸 ${escapeHtml(ig)}\n`;

  if (desc) text += `\n${escapeHtml(desc)}\n`;

  // “Vendedor” sin ser pesado:
  text += `\n💡 Tip rápido: si querés algo para hoy, mirá <b>Promos</b> o <b>Picadas</b> primero 😉\n`;
  text += `¿Qué te tienta más ahora? 👇`;

  // registrar referido / producto igual que tu lógica anterior
  if (startPayload) {
    const u = getUser(chatId);

    if (startPayload.startsWith("ref_")) {
      const ref = startPayload.slice(4);
      if (ref && ref !== String(chatId)) {
        u.referredBy = ref;
        saveData(db);
      }
    }

    if (startPayload.startsWith("prod_")) {
      const parts = startPayload.split("__ref_");
      const ref = parts[1] ? parts[1] : "";
      if (ref && ref !== String(chatId)) {
        u.referredBy = ref;
        saveData(db);
      }
    }
  }

  if (logo && logo.startsWith("http")) {
    const sent = await sendPhoto(chatId, logo, text, {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
    if (startPayload?.startsWith("prod_")) {
      await openProductFromPayload(chatId, startPayload);
    }
    return sent;
  }

  const sent = await sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  if (startPayload?.startsWith("prod_")) {
    await openProductFromPayload(chatId, startPayload);
  }
  return sent;
}

// ---------------- ✅ Categorías con paginado + vendedor ----------------
async function openCategories(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const all = await getCatalog();
  const categories = uniqueCategories(all);

  const negocio = pick(cfg, "NegocioNombre", "el local");
  const vendedorText =
    `🧑‍💼 <b>${escapeHtml(negocio)}</b>\n\n` +
    `¿Qué estás buscando hoy?\n` +
    `• Algo para picar ahora 😋\n` +
    `• Una promo para llevar 🎁\n` +
    `• Quesos y fiambres para la semana 🧀\n\n` +
    `Elegí una categoría 👇`;

  await sendMessage(chatId, vendedorText, {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboardPaged(categories, st.catsPage || 0),
  });
}

async function openProductFromPayload(chatId, payload) {
  const code = payload.split("__ref_")[0].slice(5);
  if (!code) return;

  const all = await getCatalog();
  const found = all.find((x) => safe(x.codigo || x.CODIGO) === code);
  if (!found) return;

  const st = getState(chatId);
  st.catFilter = stripEmojiPrefix(safe(found.categoria || found.CATEGORIA)) || "ALL";

  const list = filterCatalog(all, st.catFilter);
  const idx = list.findIndex((x) => safe(x.codigo || x.CODIGO) === code);
  st.index = idx >= 0 ? idx : 0;
  st.messageId = null;

  await renderCarousel(chatId, true);
}

// ---------------- Carrito (tu código intacto) ----------------
function cartTotal(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    const price = Number(String(prod.precio || prod.PRECIO || 0).replace(",", "."));
    total += (isFinite(price) ? price : 0) * Number(qty || 0);
  }
  return total;
}

async function showCart(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);

  if (!st.cart.size) {
    await sendMessage(chatId, "🛒 Tu carrito está vacío.\n\nEntrá a <b>Catálogo</b> para agregar productos.", {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
    return;
  }

  let text = "🛒 <b>Tu carrito</b>\n\n";
  for (const { prod, qty } of st.cart.values()) {
    const name = escapeHtml(safe(prod.nombre || prod.NOMBRE));
    const unit = normalizeUnit(prod.unidad || prod.UNIDAD);
    const price = Number(String(prod.precio || prod.PRECIO || 0).replace(",", "."));
    const line = (isFinite(price) ? price : 0) * Number(qty || 0);
    text += `• <b>${name}</b>\n  Cant: <b>${qty}</b> ${unit === "kg" ? "kg" : "unid"} — Subtotal: <b>${escapeHtml(moneyARS(line))}</b>\n\n`;
  }
  text += `🧾 Total productos: <b>${escapeHtml(moneyARS(cartTotal(st)))}</b>`;

  await sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      ],
    },
  });
}

// ---------------- Cantidad ----------------
async function askQty(chatId, prod) {
  const cfg = await getConfig();
  const st = getState(chatId);

  const code = safe(prod.codigo || prod.CODIGO);
  const unit = normalizeUnit(prod.unidad || prod.UNIDAD);
  st.awaitingQty = { code, unit };

  const name = escapeHtml(safe(prod.nombre || prod.NOMBRE));

  if (unit === "kg") {
    const msg =
      `¿Cuántos <b>gramos</b> querés de <b>${name}</b>?\n` +
      `Ejemplos: 250, 400, 1000\n\n` +
      `Escribí el número (desde 100g).`;
    await sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  } else {
    const msg =
      `¿Cuántas <b>unidades</b> querés de <b>${name}</b>?\n` +
      `Ejemplos: 1, 2, 3\n\n` +
      `Escribí el número.`;
    await sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  }
}

function roundQty(n, unit) {
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100;
  return Math.round(n);
}

async function addToCart(chatId, prod, qty) {
  const cfg = await getConfig();
  const st = getState(chatId);

  const code = safe(prod.codigo || prod.CODIGO);
  const unit = normalizeUnit(prod.unidad || prod.UNIDAD);

  const q = roundQty(qty, unit);
  if (q <= 0) return;

  if (st.cart.has(code)) {
    const it = st.cart.get(code);
    it.qty = roundQty(Number(it.qty) + q, unit);
    st.cart.set(code, it);
  } else {
    st.cart.set(code, { prod, qty: q });
  }

  await sendMessage(
    chatId,
    `✅ Agregado: <b>${escapeHtml(safe(prod.nombre || prod.NOMBRE))}</b> — <b>${q}</b> ${unit === "kg" ? "kg" : "unid"}`,
    { parse_mode: "HTML", reply_markup: afterAddKeyboard() }
  );
}

// ---------------- Checkout + sellos + vendedor confirma (TU CÓDIGO ORIGINAL) ----------------
// (Para no romperte nada, dejo todo igual a tu script desde acá hacia abajo)

// ---- shipping / order id
function shippingCost(cfg) {
  const raw = String(pick(cfg, "CostoEnvio", "0")).replace(",", ".");
  const v = Number(raw);
  return isFinite(v) ? v : 0;
}
function nextOrderId() {
  return `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// ... (TODO: mantengo exactamente tu código desde startCheckout hasta el final, sin cambios)

async function startCheckout(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);

  if (!st.cart.size) {
    await sendMessage(chatId, "Tu carrito está vacío. Agregá productos desde el catálogo.", { reply_markup: replyMenu(cfg) });
    return;
  }

  st.checkout = {
    step: "delivery",
    delivery: "",
    address: "",
    name: "",
    phone: "",
    payMethod: "",
    awaitingProof: false,
    orderId: nextOrderId(),
    proofText: "",
  };

  const rows = [];
  if (yes(cfg, "UsaEnvíoDomicilio")) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:HOME" }]);
  if (yes(cfg, "UsaRetiroLocal")) rows.push([{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:PICKUP" }]);
  rows.push([{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]);

  await sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", { reply_markup: { inline_keyboard: rows } });
}

async function checkoutAskAddress(chatId) {
  const st = getState(chatId);
  st.checkout.step = "address";
  await sendMessage(chatId, "📍 Decime tu <b>dirección completa</b> (calle y número).", { parse_mode: "HTML" });
}
async function checkoutAskName(chatId) {
  const st = getState(chatId);
  st.checkout.step = "name";
  await sendMessage(chatId, "👤 Decime tu <b>nombre</b>.", { parse_mode: "HTML" });
}
async function checkoutAskPhone(chatId) {
  const st = getState(chatId);
  st.checkout.step = "phone";
  await sendMessage(chatId, "📞 Escribí tu <b>teléfono</b> (solo números, con código de área).", { parse_mode: "HTML" });
}
async function checkoutAskPayment(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  st.checkout.step = "pay";

  const rows = [];
  rows.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);

  if (yes(cfg, "PermitirPagoOnline") || safe(cfg.TipoPagoOnline).toUpperCase() === "TRANSFERENCIA") {
    rows.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);
  }

  await sendMessage(chatId, "💳 Elegí método de pago 👇", { reply_markup: { inline_keyboard: rows } });
}

function buildTicketText(cfg, st) {
  const c = st.checkout;
  const sub = cartTotal(st);
  const envio = c.delivery === "HOME" ? shippingCost(cfg) : 0;
  const total = sub + envio;

  let text = `🧾 <b>Resumen de pedido</b>\n\n`;
  text += `<b>${escapeHtml(pick(cfg, "NegocioNombre", "Todo Queso"))}</b>\n`;
  text += `Entrega: ${c.delivery === "HOME" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local"}\n`;
  if (c.delivery === "HOME") text += `Dirección: ${escapeHtml(c.address)}\n`;
  text += `Nombre: ${escapeHtml(c.name)}\n`;
  text += `Teléfono: ${escapeHtml(c.phone)}\n`;
  text += `Pago: ${c.payMethod === "TRANSFER" ? "Transferencia" : "Efectivo"}\n`;
  text += `ID: <b>${escapeHtml(c.orderId)}</b>\n\n`;

  text += `📦 <b>Detalle</b>\n`;
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad || prod.UNIDAD);
    const price = Number(String(prod.precio || prod.PRECIO || 0).replace(",", "."));
    const line = (isFinite(price) ? price : 0) * Number(qty || 0);
    text += `- ${escapeHtml(safe(prod.nombre || prod.NOMBRE))} | ${qty} ${unit === "kg" ? "kg" : "unid"} | ${escapeHtml(moneyARS(line))}\n`;
  }

  text += `\n🧺 Total productos: <b>${escapeHtml(moneyARS(sub))}</b>\n`;
  text += `🚚 Envío: <b>${escapeHtml(moneyARS(envio))}</b>\n`;
  text += `💰 Total final: <b>${escapeHtml(moneyARS(total))}</b>\n`;

  return { text, sub, envio, total };
}

async function checkoutSendTransferInfo(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const alias = pick(cfg, "AliasTransferencia", "");
  const msgPendiente = pick(cfg, "MensajeTransferencia", "Perfecto. Transferí y mandá el comprobante por acá.");

  let text = `🏦 <b>Transferencia</b>\n\n`;
  if (alias) text += `Alias: <b>${escapeHtml(alias)}</b>\n`;
  const cbu = pick(cfg, "CBUPago", "");
  if (cbu) text += `CBU: <b>${escapeHtml(cbu)}</b>\n`;
  text += `\n${escapeHtml(msgPendiente)}\n\n`;
  text += `📎 Pegá acá el <b>comprobante</b> (texto o captura).`;

  st.checkout.awaitingProof = true;
  st.checkout.step = "proof";

  await sendMessage(chatId, text, { parse_mode: "HTML" });
}

async function notifyVendorPending(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const vendorChat = pick(cfg, "ChatIdVendedor", "");
  if (!vendorChat) return;

  const { text } = buildTicketText(cfg, st);

  const aviso = pick(cfg, "TextoAvisoVendedor", "Tenés un pago pendiente de confirmación  ✅");
  const payload = `VCONF:${st.checkout.orderId}:${chatId}`;

  await sendMessage(vendorChat, `🧑‍💼 <b>${escapeHtml(aviso)}</b>\n\n${text}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Confirmar pago", callback_data: `${payload}:OK` }],
        [{ text: "❌ Rechazar", callback_data: `${payload}:NO` }],
      ],
    },
  });
}

async function checkoutFinishPending(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);

  const { text } = buildTicketText(cfg, st);

  let msg = `✅ <b>Pedido tomado</b>\n\n${text}\n`;
  msg += `\n🕐 Queda <b>pendiente de confirmación</b>. Te avisamos apenas lo validemos ✅`;

  await sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  await notifyVendorPending(chatId);
}

async function vendorConfirm(orderId, buyerChatId, ok) {
  const cfg = await getConfig();
  const st = getState(buyerChatId);
  const u = getUser(buyerChatId);

  if (!st.checkout || st.checkout.orderId !== orderId) {
    if (ok) {
      await sendMessage(buyerChatId, `✅ Pago confirmado. Si no ves tu pedido, escribí /start.`, { reply_markup: replyMenu(cfg) });
    } else {
      await sendMessage(buyerChatId, `❌ No pudimos confirmar el pago. Escribinos y lo resolvemos.`, { reply_markup: replyMenu(cfg) });
    }
    return;
  }

  if (!ok) {
    await sendMessage(buyerChatId, `❌ No pudimos confirmar el pago del pedido <b>${escapeHtml(orderId)}</b>. Revisá el comprobante o escribinos.`, {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
    st.checkout = null;
    return;
  }

  const montoPorSello = Number(String(pick(cfg, "MontoPorSello", "10000")).replace(",", "."));
  const total = cartTotal(st) + (st.checkout.delivery === "HOME" ? shippingCost(cfg) : 0);

  if (isFinite(montoPorSello) && montoPorSello > 0) {
    const earned = Math.floor(Number(total) / montoPorSello);
    if (earned > 0) addSellos(buyerChatId, earned);
  }

  const bonus = Number(String(pick(cfg, "BonusSellosShare", "0")).replace(",", "."));
  if (bonus > 0 && u.referredBy && !u.rewardedReferrer) {
    addSellos(u.referredBy, bonus);
    u.rewardedReferrer = true;
    saveData(db);

    await sendMessage(u.referredBy, `🎉 ¡Genial! Un referido compró desde tu link. Sumaste <b>${bonus}</b> sello(s) extra ✅`, {
      parse_mode: "HTML",
    });
  }

  const confirmText = pick(cfg, "TextoConfirmacionPedido", "Gracias. Tu compra fué confirmada y está en preparación.  ✅");
  const ticket = buildTicketText(cfg, st).text;

  await sendMessage(buyerChatId, `✅ <b>${escapeHtml(confirmText)}</b>\n\n${ticket}`, {
    parse_mode: "HTML",
    reply_markup: replyMenu(cfg),
  });

  st.cart = new Map();
  st.awaitingQty = null;
  st.checkout = null;
}

// ---------------- Tarjeta Sellos ----------------
function progressBar(current, meta) {
  const m = Math.max(1, Number(meta || 10));
  const c = Math.max(0, Math.min(m, Number(current || 0)));
  const filled = "🟩".repeat(Math.min(c, 10));
  const empty = "⬜".repeat(Math.max(0, 10 - filled.length));
  return filled + empty;
}

async function showStamps(chatId) {
  const cfg = await getConfig();
  if (!yes(cfg, "UsaSellos")) {
    await sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: replyMenu(cfg) });
    return;
  }

  const u = getUser(chatId);
  const sellos = Number(u.sellos || 0);

  const nombres = splitPipe(pick(cfg, "NombresNiveles", ""));
  const metas = splitPipe(pick(cfg, "SellosPorNivel", ""));
  const beneficios = splitPipe(pick(cfg, "BeneficiosPorNivel", ""));
  const usaNiveles = yes(cfg, "UsaNiveles");

  let text = `🎫 <b>Tarjeta de sellos</b>\n\n`;
  text += `Sellos actuales: <b>${sellos}</b>\n`;

  if (usaNiveles && metas.length) {
    let nextMeta = null;
    let nextName = "";
    let nextBen = "";
    for (let i = 0; i < metas.length; i++) {
      const m = Number(String(metas[i]).replace(",", "."));
      if (isFinite(m) && sellos < m) {
        nextMeta = m;
        nextName = nombres[i] || `Nivel ${i + 1}`;
        nextBen = beneficios[i] || "";
        break;
      }
    }
    if (nextMeta !== null) {
      const faltan = nextMeta - sellos;
      text += `\nSiguiente nivel: <b>${escapeHtml(nextName)}</b>\n`;
      text += `Te faltan: <b>${faltan}</b> sello(s)\n`;
      if (nextBen) text += `Beneficio: <i>${escapeHtml(nextBen)}</i>\n`;
      text += `\n${progressBar(sellos, nextMeta)}\n`;
    } else {
      text += `\n🎉 ¡Ya estás en el nivel máximo!\n`;
    }
  }

  const cardUrl = normalizeUrl(pick(cfg, "CARD_URL", "")) || normalizeUrl(pick(cfg, "TarjetaURL", ""));
  if (cardUrl && cardUrl.startsWith("http")) {
    await sendPhoto(chatId, cardUrl, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  } else {
    await sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  }
}

// ---------------- Handlers ----------------
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const txt = safe(update.message.text);
      const t = txt.toLowerCase();
      const st = getState(chatId);
      const cfg = await getConfig();

      if (t.startsWith("/start")) {
        const payload = safe(txt.split(" ")[1] || "");
        await sendWelcome(chatId, payload);
        return;
      }

      if (st.awaitingQty) {
        const all = await getCatalog();
        const code = st.awaitingQty.code;
        const prod = all.find((p) => safe(p.codigo || p.CODIGO) === code);

        const unit = st.awaitingQty.unit;
        st.awaitingQty = null;

        if (!prod) {
          await sendMessage(chatId, "Ese producto ya no está disponible. Volvé a categorías.", {
            reply_markup: { inline_keyboard: [[{ text: "📁 Categorías", callback_data: "OPEN:CATS" }]] },
          });
          return;
        }

        const n = Number(String(txt).replace(",", "."));
        if (!isFinite(n) || n <= 0) {
          const hint = unit === "kg" ? "Cantidad inválida. Escribí gramos (ej: 250) o kg (ej: 0.5)." : "Cantidad inválida. Escribí un número (ej: 1, 2, 3).";
          await sendMessage(chatId, hint, { reply_markup: replyMenu(cfg) });
          return;
        }

        let qty = n;
        if (unit === "kg") {
          if (n >= 100) qty = n / 1000;
        }

        await addToCart(chatId, prod, qty);
        return;
      }

      if (st.checkout && st.checkout.step) {
        const step = st.checkout.step;

        if (step === "address") {
          st.checkout.address = txt;
          await checkoutAskName(chatId);
          return;
        }
        if (step === "name") {
          st.checkout.name = txt;
          await checkoutAskPhone(chatId);
          return;
        }
        if (step === "phone") {
          st.checkout.phone = txt;
          await checkoutAskPayment(chatId);
          return;
        }
        if (step === "proof" && st.checkout.awaitingProof) {
          st.checkout.proofText = txt;
          st.checkout.awaitingProof = false;

          await sendMessage(chatId, "✅ Comprobante recibido. Lo validamos y te confirmamos enseguida 🙌", {
            reply_markup: replyMenu(cfg),
          });

          const vendorChat = pick(cfg, "ChatIdVendedor", "");
          if (vendorChat) {
            const aviso = pick(cfg, "TextoAvisoVendedor", "Tenés un pago pendiente de confirmación ✅");
            const { text } = buildTicketText(cfg, st);
            const payload = `VCONF:${st.checkout.orderId}:${chatId}`;

            await sendMessage(vendorChat, `📎 <b>Comprobante recibido</b>\n<b>${escapeHtml(aviso)}</b>\n\n<b>Pedido:</b>\n${text}\n\n<b>Comprobante:</b>\n${escapeHtml(txt)}`, {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ Confirmar pago", callback_data: `${payload}:OK` }],
                  [{ text: "❌ Rechazar", callback_data: `${payload}:NO` }],
                ],
              },
            });
          }

          await checkoutFinishPending(chatId);
          return;
        }
      }

      if (t === "hola" || t === "buen día" || t === "buen dia" || t === "buenas") {
        await sendWelcome(chatId, "");
        return;
      }

      if (txt === "🛍️ Catálogo") {
        await openCategories(chatId);
        return;
      }
      if (txt === "🛒 Carrito") {
        await showCart(chatId);
        return;
      }
      if (txt === "✅ Finalizar compra") {
        await startCheckout(chatId);
        return;
      }
      if (txt === "🎫 Tarjeta de sellos") {
        await showStamps(chatId);
        return;
      }
      if (txt === "📣 Compartir bot") {
        await sendShareBot(chatId);
        return;
      }

      await sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: replyMenu(cfg) });
      return;
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = safe(cb.data);
      if (!chatId) return;

      await answerCallbackQuery(cb.id);

      const cfg = await getConfig();
      const st = getState(chatId);

      if (data === "OPEN:CATS") {
        await openCategories(chatId);
        return;
      }
      if (data === "OPEN:CART") {
        await showCart(chatId);
        return;
      }

      // paginado categorías
      if (data.startsWith("CATS:PAGE:")) {
        const p = Number(data.split(":")[2] || "0");
        st.catsPage = isFinite(p) ? p : 0;
        await openCategories(chatId);
        return;
      }
      if (data === "CATS:NOOP") return;

      if (data.startsWith("CAT:")) {
        const f = data.slice(4);
        st.catFilter = f === "ALL" ? "ALL" : decodeURIComponent(f);
        st.index = 0;
        st.messageId = null;
        await renderCarousel(chatId, true);
        return;
      }

      if (data === "P:NEXT") {
        const list = st.listSnapshot || [];
        if (!list.length) {
          await renderCarousel(chatId, true);
          return;
        }
        st.index = (st.index + 1) % list.length;
        await renderCarousel(chatId, false);
        return;
      }
      if (data === "P:PREV") {
        const list = st.listSnapshot || [];
        if (!list.length) {
          await renderCarousel(chatId, true);
          return;
        }
        st.index = (st.index - 1 + list.length) % list.length;
        await renderCarousel(chatId, false);
        return;
      }

      if (data === "P:ADD") {
        const p = st.listSnapshot?.[st.index];
        if (!p) return;
        await askQty(chatId, p);
        return;
      }

      if (data === "P:SHARE") {
        await sendShareProduct(chatId);
        return;
      }

      if (data === "CHECKOUT:START") {
        await startCheckout(chatId);
        return;
      }

      if (data.startsWith("DELIVERY:")) {
        const mode = data.split(":")[1];
        if (!st.checkout) {
          st.checkout = {
            step: "delivery",
            delivery: "",
            address: "",
            name: "",
            phone: "",
            payMethod: "",
            awaitingProof: false,
            orderId: nextOrderId(),
            proofText: "",
          };
        }
        st.checkout.delivery = mode;
        if (mode === "HOME") {
          await checkoutAskAddress(chatId);
        } else {
          st.checkout.address = "";
          await checkoutAskName(chatId);
        }
        return;
      }

      if (data.startsWith("PAY:")) {
        const pm = data.split(":")[1];
        if (!st.checkout) return;
        st.checkout.payMethod = pm;

        if (pm === "TRANSFER") {
          await checkoutSendTransferInfo(chatId);
          return;
        }

        await checkoutFinishPending(chatId);
        return;
      }

      if (data.startsWith("VCONF:")) {
        const parts = data.split(":");
        const orderId = parts[1] || "";
        const buyer = parts[2] || "";
        const decision = parts[3] || "";
        const ok = decision === "OK";

        await vendorConfirm(orderId, buyer, ok);

        await sendMessage(chatId, ok ? "✅ Listo. Pedido confirmado al cliente." : "❌ Rechazado. Se avisó al cliente.", {
          reply_markup: replyMenu(cfg),
        });
        return;
      }

      await sendMessage(chatId, "✅", { reply_markup: replyMenu(cfg) });
      return;
    }
  } catch (e) {
    console.log("❌ Handler error:", e?.message || e);
  }
});

// ---------------- Health + webhook helpers ----------------
app.get("/", (req, res) => res.status(200).send("OK - EZERBOT LIVE"));
app.get("/health", async (req, res) => {
  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    res.json({
      ok: true,
      env: { hasToken: Boolean(TOKEN), publicUrl: PUBLIC_URL, hasSheets: Boolean(SHEETS_API_BASE) },
      configKeys: Object.keys(cfg || {}).length,
      catalogItems: Array.isArray(cat) ? cat.length : 0,
      webhook_should_be: PUBLIC_URL ? `${PUBLIC_URL}/telegram` : null,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/setwebhook", async (req, res) => {
  const url = PUBLIC_URL ? `${PUBLIC_URL}/telegram` : "";
  const r = await tgCall("setWebhook", { url });
  res.status(200).json({ ok: true, result: r, set_to: url });
});
app.get("/deletewebhook", async (req, res) => {
  const r = await tgCall("deleteWebhook", { drop_pending_updates: true });
  res.status(200).json({ ok: true, result: r });
});

// ---------------- Start ----------------
app.listen(PORT, async () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook endpoint:", "/telegram");

  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    console.log("✅ Warmup ok. Config keys:", Object.keys(cfg || {}).length, "Catalog items:", Array.isArray(cat) ? cat.length : 0);
  } catch (e) {
    console.log("⚠️ Warmup error:", e?.message || e);
  }
});
