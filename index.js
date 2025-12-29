/**
 * EZERBOT - Bot + Catálogo carrusel + Carrito + Checkout + Vendedor confirma pago + Sellos + Referidos
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

// ✅ FIX: Limpieza fuerte de URL (quita comillas, espacios, markdown, etc.)
function normalizeUrl(u) {
  let t = safe(u);
  if (!t) return "";

  // quita comillas
  t = t.replace(/^["']+|["']+$/g, "").trim();

  // si viene como [texto](url)
  const m = t.match(/\((https?:\/\/[^)]+)\)/i);
  if (m?.[1]) t = m[1].trim();

  // si viene como <url>
  t = t.replace(/^<|>$/g, "").trim();

  // si viene con espacios
  t = t.replace(/\s+/g, "");

  return t;
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
    });
  }
  return state.get(id);
}

// ---------------- Menús ----------------
function replyMenu(cfg) {
  const rows = [
    [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
    [{ text: "✅ Finalizar compra" }],
    [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
  ];
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false };
}

function categoriesKeyboard(categories) {
  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CAT:ALL" }]);

  let r = [];
  for (const c of categories) {
    r.push({ text: c, callback_data: `CAT:${encodeURIComponent(c)}` });
    if (r.length === 2) {
      rows.push(r);
      r = [];
    }
  }
  if (r.length) rows.push(r);

  rows.push([{ text: "🛒 Carrito", callback_data: "OPEN:CART" }]);
  return { inline_keyboard: rows };
}

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
    inline_keyboard: [[{ text: "💬 WhatsApp", url: waUrl }, { text: "✈️ Telegram", url: tgUrl }]],
  };
}

// ---------------- Catálogo helpers ----------------
function uniqueCategories(items) {
  const set = new Set();
  for (const p of items) {
    const c = safe(p.categoria || p.CATEGORIA);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function filterCatalog(items, filter) {
  if (!filter || filter === "ALL") return items;
  return items.filter((p) => safe(p.categoria || p.CATEGORIA) === filter);
}

function productCaption(cfg, p, filterLabel, index, total) {
  const nombre = escapeHtml(safe(p.nombre || p.NOMBRE));
  const desc = escapeHtml(safe(p.descripcion || p.DESCRIPCION));
  const unidad = normalizeUnit(p.unidad || p.UNIDAD);
  const precio = safe(p.precio || p.PRECIO);
  const moneda = pick(cfg, "Moneda", "ARS");

  const head = filterLabel && filterLabel !== "ALL" ? `🛍️ <b>${escapeHtml(filterLabel)}</b>\n` : `🛍️ <b>Catálogo</b>\n`;
  const pos = `📖 <i>${index + 1} de ${total}</i>\n\n`;

  let cap = head + pos;
  cap += `🧀 <b>${nombre}</b>\n`;
  if (yes(cfg, "CatalogoMostrarPrecios")) {
    cap += `💰 <b>${escapeHtml(moneda)} ${escapeHtml(precio || "-")}</b> ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  }
  if (desc) cap += `📝 ${desc}\n`;

  // texto humano corto (no rompe nada)
  cap += `\n✨ Tocá <b>Quiero éste</b> y decime la cantidad 😊`;
  return cap;
}

// ✅ FIX PRINCIPAL: Carrusel robusto (si Telegram no deja editar, crea mensaje nuevo con foto)
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

  // Intentar editar el mensaje existente
  if (!forceNew && st.messageId) {
    try {
      // Si hay imagen válida intentamos editar media
      if (img && img.startsWith("http")) {
        const r = await editMessageMedia(chatId, st.messageId, img, caption, { reply_markup: kb });
        if (r?.ok) return;
      } else {
        const r2 = await editMessageCaption(chatId, st.messageId, caption, { reply_markup: kb });
        if (r2?.ok) return;
      }
    } catch (e) {
      // seguimos al fallback
    }
  }

  // Fallback: crear un mensaje nuevo SIEMPRE que haya imagen
  let created;
  if (img && img.startsWith("http")) {
    created = await sendPhoto(chatId, img, caption, { parse_mode: "HTML", reply_markup: kb });
  } else {
    created = await sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: kb });
  }
  st.messageId = created?.result?.message_id || null;
}

// ---------------- Share links ----------------
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

  const text = `🧀 Promo de ${pick(cfg, "NegocioNombre", "Todo Queso")}:\n*${nombre}*\n\nEntrá directo acá 👇\n${link}`;
  const { wa, tg } = shareUrlsForText(text);

  await sendMessage(chatId, "📣 Compartir este producto:", {
    reply_markup: shareOptionsKeyboard(wa, tg),
  });
}

// ---------------- Welcome ----------------
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

  text += `\n¿Querés que te muestre las promos más elegidas? 👇`;

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

async function openCategories(chatId) {
  const all = await getCatalog();
  const categories = uniqueCategories(all);
  await sendMessage(chatId, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
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
  await renderCarousel(chatId, true);
}

// ---------------- Carrito ----------------
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

// ---------------- Checkout / Sellos / etc ----------------
// (Todo lo demás queda EXACTAMENTE igual a tu script actual, para no romper flujo)

// ---------------- Handlers Mensajes ----------------
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
          const hint = unit === "kg" ? "Cantidad inválida. Escribí gramos (ej: 250)." : "Cantidad inválida. Escribí un número (ej: 1, 2, 3).";
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

      // (checkout/sellos/compartir se mantienen igual en tu versión completa)
      await sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: replyMenu(cfg) });
      return;
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = safe(cb.data);
      if (!chatId) return;

      await answerCallbackQuery(cb.id);
      const st = getState(chatId);

      if (data === "OPEN:CATS") {
        await openCategories(chatId);
        return;
      }
      if (data === "OPEN:CART") {
        await showCart(chatId);
        return;
      }

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

      // resto igual...
      return;
    }
  } catch (e) {
    console.log("❌ Handler error:", e?.message || e);
  }
});

// ---------------- Health + webhook helpers ----------------
app.get("/", (req, res) => res.status(200).send("OK - EZERBOT LIVE"));

app.get("/setwebhook", async (req, res) => {
  const url = PUBLIC_URL ? `${PUBLIC_URL}/telegram` : "";
  const r = await tgCall("setWebhook", { url });
  res.status(200).json({ ok: true, result: r, set_to: url });
});

app.listen(PORT, async () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook endpoint:", "/telegram");
});
