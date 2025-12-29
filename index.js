/**
 * EZERBOT - Bot + Catálogo carrusel con imágenes + Carrito/Checkout "sin ensuciar" + Sellos + Compartir + Ayuda
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

function slugKey(s) {
  return safe(s)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

// ---------------- Estado en memoria (carrito/checkout/carrusel) ----------------
const state = new Map();
/**
 * state[chatId] = {
 *  catFilter, index, messageId, messageIsPhoto,
 *  listSnapshot: [],
 *  awaitingQty: { code, unit } | null,
 *  cart: Map(code -> {prod, qty}),
 *  checkout: null | { step, delivery, address, name, phone, payMethod, awaitingProof, orderId, proofText }
 *  catPage: number
 * }
 */
function getState(chatId) {
  const id = String(chatId);
  if (!state.has(id)) {
    state.set(id, {
      catFilter: "ALL",
      index: 0,
      messageId: null,
      messageIsPhoto: false,
      listSnapshot: [],
      awaitingQty: null,
      cart: new Map(),
      checkout: null,
      catPage: 0,
    });
  }
  return state.get(id);
}

// ---------------- Menú principal (SOLO 4 botones) ----------------
function replyMenu(cfg) {
  const rows = [
    [{ text: "🛍️ Catálogo" }, { text: "🎫 Sellos" }],
    [{ text: "📣 Compartir bot" }, { text: "🆘 Ayuda" }],
  ];
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false };
}

// ---------------- Catálogo: categorías + emoji opcional ----------------
function uniqueCategories(items) {
  const set = new Set();
  for (const p of items) {
    const c = safe(p.categoria || p.CATEGORIA);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

// Emoji opcional por categoría.
// Soporta en Config:
// - EMOJI_CAT_<SLUG>   (ej: EMOJI_CAT_LACTEOS = 🥛)
// - Si no existe, no pone emoji (sirve para cualquier rubro sin romper).
function categoryLabel(cfg, cat) {
  const slug = slugKey(cat);
  const em = pick(cfg, `EMOJI_CAT_${slug}`, "");
  return em ? `${em} ${cat}` : cat;
}

function categoriesKeyboardPaged(cfg, categories, page = 0) {
  const pageSize = 6; // 3 filas x 2 (se ve "limpio")
  const totalPages = Math.max(1, Math.ceil(categories.length / pageSize));
  const p = Math.max(0, Math.min(totalPages - 1, page));

  const start = p * pageSize;
  const slice = categories.slice(start, start + pageSize);

  const rows = [];
  // Botón "Todas" arriba
  rows.push([{ text: "📚 Todas", callback_data: "CAT:ALL" }]);

  // 2 por fila
  let r = [];
  for (const c of slice) {
    r.push({ text: categoryLabel(cfg, c), callback_data: `CAT:${encodeURIComponent(c)}` });
    if (r.length === 2) {
      rows.push(r);
      r = [];
    }
  }
  if (r.length) rows.push(r);

  // Navegación páginas
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️", callback_data: "CATPAGE:PREV" },
      { text: `📄 ${p + 1}/${totalPages}`, callback_data: "CATPAGE:NOOP" },
      { text: "➡️", callback_data: "CATPAGE:NEXT" },
    ]);
  }

  // Ver carrito solo acá (no en menú principal)
  rows.push([{ text: "🧾 Ver carrito", callback_data: "OPEN:CART" }]);

  return { inline_keyboard: rows };
}

function filterCatalog(items, filter) {
  if (!filter || filter === "ALL") return items;
  return items.filter((p) => safe(p.categoria || p.CATEGORIA) === filter);
}

// ---------------- Carrusel producto ----------------
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
        { text: "🧾 Ver carrito", callback_data: "OPEN:CART" },
      ],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
    ],
  };
}

function afterAddKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
      [{ text: "🧾 Ver carrito", callback_data: "OPEN:CART" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
    ],
  };
}

function productCaption(cfg, p, filterLabel, index, total) {
  const nombre = escapeHtml(safe(p.nombre || p.NOMBRE));
  const desc = escapeHtml(safe(p.descripcion || p.DESCRIPCION));
  const unidad = normalizeUnit(p.unidad || p.UNIDAD);
  const precio = safe(p.precio || p.PRECIO);
  const moneda = pick(cfg, "Moneda", "ARS");

  // NO mostrar “Categoría 1/2” nunca
  const head = filterLabel && filterLabel !== "ALL" ? `🛍️ <b>${escapeHtml(filterLabel)}</b>\n` : `🛍️ <b>Catálogo</b>\n`;
  const pos = `📖 <i>${index + 1} de ${total}</i>\n\n`;

  let cap = head + pos;
  cap += `🧀 <b>${nombre}</b>\n`;

  if (yes(cfg, "CatalogoMostrarPrecios")) {
    cap += `💰 <b>${escapeHtml(moneda)} ${escapeHtml(precio || "-")}</b> ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  }
  if (desc) cap += `📝 ${desc}\n`;

  cap += `\n✨ Tocá <b>Quiero éste</b> y decime la cantidad 😊`;
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

  const hasImg = img && img.startsWith("http");

  // ⚠️ Importante Telegram: NO se puede transformar un mensaje de texto en foto editando.
  // Si antes se envió sin foto, y ahora el producto tiene foto, mandamos un mensaje nuevo con foto.
  const mustCreateNew = forceNew || !st.messageId || (hasImg && !st.messageIsPhoto);

  if (!mustCreateNew) {
    // editar sobre el existente
    if (hasImg && st.messageIsPhoto) {
      await editMessageMedia(chatId, st.messageId, img, caption, { reply_markup: kb });
    } else {
      await editMessageCaption(chatId, st.messageId, caption, { reply_markup: kb });
    }
    return;
  }

  // crear mensaje nuevo
  let created;
  if (hasImg) {
    created = await sendPhoto(chatId, img, caption, { parse_mode: "HTML", reply_markup: kb });
    st.messageIsPhoto = true;
  } else {
    created = await sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: kb });
    st.messageIsPhoto = false;
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
  // fallback
  return payload ? `https://t.me/${encodeURIComponent("Ezer_IA_Bot")}?start=${encodeURIComponent(payload)}` : "";
}

function shareUrlsForText(text) {
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(" ")}&text=${encodeURIComponent(text)}`;
  return { wa, tg };
}

function shareOptionsKeyboard(waUrl, tgUrl) {
  return { inline_keyboard: [[{ text: "💬 WhatsApp", url: waUrl }, { text: "✈️ Telegram", url: tgUrl }]] };
}

async function sendShareBot(chatId) {
  const cfg = await getConfig();
  const payload = `ref_${chatId}`;
  const link = buildBotStartLink(cfg, payload);

  const mailSistema = pick(cfg, "MailSistema", "ezerbot.assistant@gmail.com");
  const texto =
    `${pick(cfg, "TextoCompartirBot", "Comprá fácil por el bot")} 🧀\n\n` +
    `${link}\n\n` +
    `🤖 ¿Querés este sistema para tu negocio?\n✉️ ${mailSistema}`.trim();

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

  const text =
    `🧀 ${pick(cfg, "NegocioNombre", "Todo Queso")}\n` +
    `👉 ${nombre}\n\n` +
    `Entrá directo acá 👇\n${link}`;

  const { wa, tg } = shareUrlsForText(text);

  await sendMessage(chatId, "📣 Compartir este producto:", {
    reply_markup: shareOptionsKeyboard(wa, tg),
  });
}

// ---------------- Welcome + Ayuda ----------------
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

  text += `\n¿Arrancamos? Tocá <b>Catálogo</b> y te muestro todo con foto 😊`;

  // Referidos / producto directo
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
    const sent = await sendPhoto(chatId, logo, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
    if (startPayload?.startsWith("prod_")) await openProductFromPayload(chatId, startPayload);
    return sent;
  }

  const sent = await sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  if (startPayload?.startsWith("prod_")) await openProductFromPayload(chatId, startPayload);
  return sent;
}

async function sendHelp(chatId) {
  const cfg = await getConfig();

  const negocio = pick(cfg, "NegocioNombre", "Todo Queso");
  const dir = pick(cfg, "NegocioDireccion", "");
  const hor = pick(cfg, "NegocioHorario", "");
  const tel = pick(cfg, "NegocioTelefono", "");
  const estado = pick(cfg, "Estado", "");
  const vac = pick(cfg, "Vacaciones", "NO"); // opcional en Config
  const mailSistema = pick(cfg, "MailSistema", "ezerbot.assistant@gmail.com");

  let text = `🆘 <b>Ayuda</b>\n\n`;
  text += `👋 Hola, soy el asistente de <b>${escapeHtml(negocio)}</b>.\n`;
  if (estado) text += `📌 Estado: <b>${escapeHtml(estado)}</b>\n`;
  if (safe(vac).toUpperCase() === "SI") text += `🏖️ Hoy estamos con vacaciones/cierre especial.\n`;
  if (dir) text += `📍 Dirección: ${escapeHtml(dir)}\n`;
  if (hor) text += `🕒 Horario: ${escapeHtml(hor)}\n`;

  text += `\nSi querés hablar con una persona del local, tocá WhatsApp 👇`;

  const kb = {
    inline_keyboard: [
      ...(tel
        ? [[{ text: "💬 WhatsApp (hablar con el local)", url: `https://wa.me/${tel.replace(/\D/g, "")}` }]]
        : []),
      [
        { text: "🛍️ Ver catálogo", callback_data: "OPEN:CATS" },
        { text: "🎫 Ver sellos", callback_data: "OPEN:SELLOS" },
      ],
      [
        { text: "📣 Compartir bot", callback_data: "OPEN:SHAREBOT" },
      ],
      [
        { text: "✉️ Sistema para tu negocio", callback_data: "OPEN:SISTEMA" },
      ],
    ],
  };

  await sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });

  // Mensaje “vende el sistema” sin molestar: solo si lo tocan
  // (lo manda el callback OPEN:SISTEMA)
}

async function sendSystemInfo(chatId) {
  const cfg = await getConfig();
  const mailSistema = pick(cfg, "MailSistema", "ezerbot.assistant@gmail.com");
  const text =
    `💼 <b>Sistema para tu negocio</b>\n\n` +
    `Este bot se puede adaptar a cualquier rubro: catálogo con fotos, carrito, pagos, sellos y referidos.\n\n` +
    `✉️ Contacto directo: <b>${escapeHtml(mailSistema)}</b>`;
  await sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
}

// ---------------- Categorías ----------------
async function openCategories(chatId, resetPage = false) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const all = await getCatalog();
  const categories = uniqueCategories(all);

  if (resetPage) st.catPage = 0;

  await sendMessage(chatId, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboardPaged(cfg, categories, st.catPage),
  });
}

async function openProductFromPayload(chatId, payload) {
  const code = payload.split("__ref_")[0].slice(5);
  if (!code) return;

  const all = await getCatalog();
  const found = all.find((x) => safe(x.codigo || x.CODIGO) === code);
  if (!found) return;

  const st = getState(chatId);
  st.catFilter = safe(found.categoria || found.CATEGORIA) || "ALL";

  const list = filterCatalog(all, st.catFilter);
  const idx = list.findIndex((x) => safe(x.codigo || x.CODIGO) === code);
  st.index = idx >= 0 ? idx : 0;
  st.messageId = null;
  st.messageIsPhoto = false;
  await renderCarousel(chatId, true);
}

// ---------------- Carrito / Checkout ----------------
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
    await sendMessage(chatId, "🧾 Todavía no agregaste productos.\n\nEntrá a <b>Catálogo</b> para elegir con foto 😊", {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
    return;
  }

  let text = "🧾 <b>Tu carrito</b>\n\n";
  for (const { prod, qty } of st.cart.values()) {
    const name = escapeHtml(safe(prod.nombre || prod.NOMBRE));
    const unit = normalizeUnit(prod.unidad || prod.UNIDAD);
    const price = Number(String(prod.precio || prod.PRECIO || 0).replace(",", "."));
    const line = (isFinite(price) ? price : 0) * Number(qty || 0);
    text += `• <b>${name}</b>\n  Cant: <b>${qty}</b> ${unit === "kg" ? "kg" : "unid"} — Subtotal: <b>${escapeHtml(moneyARS(line))}</b>\n\n`;
  }
  text += `💰 Total productos: <b>${escapeHtml(moneyARS(cartTotal(st)))}</b>`;

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

// Cantidad
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
      `Ej: 200, 300, 500, 1000\n\n` +
      `📌 Escribí solo el número.`;
    await sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: replyMenu(cfg) });
  } else {
    const msg =
      `¿Cuántas <b>unidades</b> querés de <b>${name}</b>?\n` +
      `Ej: 1, 2, 3\n\n` +
      `📌 Escribí solo el número.`;
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

// Checkout
function shippingCost(cfg) {
  const raw = String(pick(cfg, "CostoEnvio", "0")).replace(",", ".");
  const v = Number(raw);
  return isFinite(v) ? v : 0;
}

function nextOrderId() {
  return `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

async function startCheckout(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);

  if (!st.cart.size) {
    await sendMessage(chatId, "Todavía no agregaste productos. Entrá a <b>Catálogo</b> 😊", {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
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
  rows.push([{ text: "🧾 Ver carrito", callback_data: "OPEN:CART" }]);

  await sendMessage(chatId, "¿Cómo querés recibir tu pedido? 👇", { reply_markup: { inline_keyboard: rows } });
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
  await sendMessage(chatId, "📞 Tu <b>teléfono</b> (solo números, con código de área).", { parse_mode: "HTML" });
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
  const msgPendiente = pick(cfg, "MensajeTransferencia", "Perfecto 😊 Transferí y pegá acá el comprobante (texto o captura).");

  let text = `🏦 <b>Transferencia</b>\n\n`;
  if (alias) text += `Alias: <b>${escapeHtml(alias)}</b>\n`;
  const cbu = pick(cfg, "CBUPago", "");
  if (cbu) text += `CBU: <b>${escapeHtml(cbu)}</b>\n`;
  text += `\n${escapeHtml(msgPendiente)}\n`;

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
  const aviso = pick(cfg, "TextoAvisoVendedor", "Tenés un pedido para confirmar ✅");
  const payload = `VCONF:${st.checkout.orderId}:${chatId}`;

  await sendMessage(vendorChat, `🧑‍💼 <b>${escapeHtml(aviso)}</b>\n\n${text}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Confirmar", callback_data: `${payload}:OK` }],
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

// Confirmación del vendedor
async function vendorConfirm(orderId, buyerChatId, ok) {
  const cfg = await getConfig();
  const st = getState(buyerChatId);
  const u = getUser(buyerChatId);

  if (!st.checkout || st.checkout.orderId !== orderId) {
    await sendMessage(buyerChatId, ok ? "✅ Pedido confirmado." : "❌ No pudimos confirmar. Escribinos y lo resolvemos.", {
      reply_markup: replyMenu(cfg),
    });
    return;
  }

  if (!ok) {
    await sendMessage(buyerChatId, `❌ No pudimos confirmar el pedido <b>${escapeHtml(orderId)}</b>. Escribinos y lo resolvemos.`, {
      parse_mode: "HTML",
      reply_markup: replyMenu(cfg),
    });
    st.checkout = null;
    return;
  }

  // ✅ Sumar sellos cuando el vendedor CONFIRMA
  const montoPorSello = Number(String(pick(cfg, "MontoPorSello", "10000")).replace(",", "."));
  const total = cartTotal(st) + (st.checkout.delivery === "HOME" ? shippingCost(cfg) : 0);

  let earned = 0;
  if (isFinite(montoPorSello) && montoPorSello > 0) {
    earned = Math.floor(Number(total) / montoPorSello);
  }

  // opcional: mínimo 1 sello por compra confirmada (si Config dice SI)
  if (earned <= 0 && yes(cfg, "SellosMinimoUno")) earned = 1;

  if (earned > 0) addSellos(buyerChatId, earned);

  // Bonus referido (1 vez)
  const bonus = Number(String(pick(cfg, "BonusSellosShare", "0")).replace(",", "."));
  if (bonus > 0 && u.referredBy && !u.rewardedReferrer) {
    addSellos(u.referredBy, bonus);
    u.rewardedReferrer = true;
    saveData(db);

    await sendMessage(u.referredBy, `🎉 ¡Un referido compró desde tu link! Sumaste <b>${bonus}</b> sello(s) ✅`, {
      parse_mode: "HTML",
    });
  }

  const confirmText = pick(cfg, "TextoConfirmacionPedido", "¡Gracias! Tu pedido fue confirmado y está en preparación ✅");
  const ticket = buildTicketText(cfg, st).text;

  await sendMessage(buyerChatId, `✅ <b>${escapeHtml(confirmText)}</b>\n\n${ticket}`, {
    parse_mode: "HTML",
    reply_markup: replyMenu(cfg),
  });

  st.cart = new Map();
  st.awaitingQty = null;
  st.checkout = null;
}

// ---------------- Sellos ----------------
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
    // Mensajes
    if (update.message) {
      const chatId = update.message.chat.id;
      const txt = safe(update.message.text);
      const t = txt.toLowerCase();
      const st = getState(chatId);
      const cfg = await getConfig();

      // /start
      if (t.startsWith("/start")) {
        const payload = safe(txt.split(" ")[1] || "");
        await sendWelcome(chatId, payload);
        return;
      }

      // esperando cantidad
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
          const hint = unit === "kg" ? "Cantidad inválida. Ej: 200 (gramos) o 0.5 (kg)." : "Cantidad inválida. Ej: 1, 2, 3.";
          await sendMessage(chatId, hint, { reply_markup: replyMenu(cfg) });
          return;
        }

        let qty = n;
        if (unit === "kg") {
          if (n >= 100) qty = n / 1000; // gramos -> kg
        }

        await addToCart(chatId, prod, qty);
        return;
      }

      // checkout pasos texto
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
          // llegó el comprobante
          st.checkout.proofText = txt;
          st.checkout.awaitingProof = false;

          // 1 solo mensaje (no repetir confirmaciones)
          await sendMessage(chatId, "✅ Comprobante recibido. Lo revisamos y te confirmamos enseguida 🙌", {
            reply_markup: replyMenu(cfg),
          });

          // avisar al vendedor con comprobante
          const vendorChat = pick(cfg, "ChatIdVendedor", "");
          if (vendorChat) {
            const aviso = pick(cfg, "TextoAvisoVendedor", "Tenés un pedido para confirmar ✅");
            const { text } = buildTicketText(cfg, st);
            const payload = `VCONF:${st.checkout.orderId}:${chatId}`;

            await sendMessage(vendorChat, `📎 <b>Comprobante recibido</b>\n<b>${escapeHtml(aviso)}</b>\n\n<b>Pedido:</b>\n${text}\n\n<b>Comprobante:</b>\n${escapeHtml(txt)}`, {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ Confirmar", callback_data: `${payload}:OK` }],
                  [{ text: "❌ Rechazar", callback_data: `${payload}:NO` }],
                ],
              },
            });
          }

          // NO reenviar otro resumen acá (evita duplicado)
          return;
        }
      }

      // Menú principal (solo 4)
      if (t === "hola" || t === "buen día" || t === "buen dia" || t === "buenas") {
        await sendWelcome(chatId, "");
        return;
      }

      if (txt === "🛍️ Catálogo") {
        await openCategories(chatId, true);
        return;
      }
      if (txt === "🎫 Sellos") {
        await showStamps(chatId);
        return;
      }
      if (txt === "📣 Compartir bot") {
        await sendShareBot(chatId);
        return;
      }
      if (txt === "🆘 Ayuda") {
        await sendHelp(chatId);
        return;
      }

      await sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: replyMenu(cfg) });
      return;
    }

    // Callbacks
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = safe(cb.data);
      if (!chatId) return;

      await answerCallbackQuery(cb.id);

      const cfg = await getConfig();
      const st = getState(chatId);

      if (data === "OPEN:CATS") {
        await openCategories(chatId, false);
        return;
      }
      if (data === "OPEN:CART") {
        await showCart(chatId);
        return;
      }
      if (data === "OPEN:SELLOS") {
        await showStamps(chatId);
        return;
      }
      if (data === "OPEN:SHAREBOT") {
        await sendShareBot(chatId);
        return;
      }
      if (data === "OPEN:SISTEMA") {
        await sendSystemInfo(chatId);
        return;
      }

      // paginado categorías
      if (data === "CATPAGE:PREV" || data === "CATPAGE:NEXT") {
        const all = await getCatalog();
        const cats = uniqueCategories(all);
        const pageSize = 6;
        const totalPages = Math.max(1, Math.ceil(cats.length / pageSize));

        if (data === "CATPAGE:PREV") st.catPage = Math.max(0, (st.catPage || 0) - 1);
        if (data === "CATPAGE:NEXT") st.catPage = Math.min(totalPages - 1, (st.catPage || 0) + 1);

        await sendMessage(chatId, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
          parse_mode: "HTML",
          reply_markup: categoriesKeyboardPaged(cfg, cats, st.catPage),
        });
        return;
      }
      if (data === "CATPAGE:NOOP") return;

      // categorías
      if (data.startsWith("CAT:")) {
        const f = data.slice(4);
        st.catFilter = f === "ALL" ? "ALL" : decodeURIComponent(f);
        st.index = 0;
        st.messageId = null;
        st.messageIsPhoto = false;
        await renderCarousel(chatId, true);
        return;
      }

      // carrusel
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

      // Checkout
      if (data === "CHECKOUT:START") {
        await startCheckout(chatId);
        return;
      }

      if (data.startsWith("DELIVERY:")) {
        const mode = data.split(":")[1]; // HOME / PICKUP
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
        if (mode === "HOME") await checkoutAskAddress(chatId);
        else {
          st.checkout.address = "";
          await checkoutAskName(chatId);
        }
        return;
      }

      if (data.startsWith("PAY:")) {
        const pm = data.split(":")[1]; // CASH / TRANSFER
        if (!st.checkout) return;
        st.checkout.payMethod = pm;

        if (pm === "TRANSFER") {
          await checkoutSendTransferInfo(chatId);
          return;
        }

        // CASH: pedido pendiente, avisar al vendedor una vez
        await checkoutFinishPending(chatId);
        return;
      }

      // Confirmación vendedor
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
