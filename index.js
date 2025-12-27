/**
 * TODO_QUESO - Bot Telegram + Catálogo carrusel + Compartir con Referidos + Carrito + Sellos
 *
 * ENV obligatorias:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL              ej: https://ezerbot-system.onrender.com
 * - SHEET_CSV_URL           CSV de Catalogo
 * - CONFIG_CSV_URL          CSV de Config (CLAVE,VALOR)  <<< ESTO habilita logo/horarios/tarjeta/alias/etc
 *
 * ENV opcionales:
 * - BOT_USERNAME            ej: Ezer_IA_Bot
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const CONFIG_CSV_URL = process.env.CONFIG_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace("@", "");

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");
if (!CONFIG_CSV_URL) console.error("Falta ENV CONFIG_CSV_URL (sin esto NO hay logo/horarios/tarjeta/config real)");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

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
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function enc(s) {
  return encodeURIComponent(String(s || ""));
}
function normalizeUrl(u) {
  if (!u) return "";
  const m = String(u).match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return String(u).trim();
}

// CSV básico
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (cur.length || row.length) {
        row.push(cur);
        rows.push(row);
      }
      cur = "";
      row = [];
      if (c === "\r" && next === "\n") i++;
      continue;
    }
    cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// ---------------- Config (dinámico) ----------------
let configCache = { at: 0, data: null };

const DEFAULT_CONFIG = {
  negocio_nombre: "Todo Queso",
  negocio_slogan: "Compras por Telegram",
  negocio_direccion: "",
  negocio_horario: "",
  negocio_logo_url: "",
  logo_url: "",
  tarjeta_sellos_url: "",
  tarjeta_virtual_url: "",
  tarjeta_url: "",
};

function pickCfg(cfg, ...keys) {
  for (const k of keys) {
    const v = (cfg?.[k] || "").toString().trim();
    if (v) return v;
  }
  return "";
}

async function loadConfig() {
  const now = Date.now();
  if (configCache.data && now - configCache.at < 30_000) return configCache.data;

  const res = await fetch(CONFIG_CSV_URL, { method: "GET" });
  const csv = await res.text();
  const rows = parseCSV(csv);
  const data = { ...DEFAULT_CONFIG };

  // Formato esperado: CLAVE,VALOR
  for (let r = 0; r < rows.length; r++) {
    const k = (rows[r]?.[0] || "").trim();
    const v = (rows[r]?.[1] || "").trim();
    if (!k) continue;
    data[k] = v;
  }

  data.negocio_logo_url = normalizeUrl(data.negocio_logo_url);
  data.logo_url = normalizeUrl(data.logo_url);
  data.tarjeta_sellos_url = normalizeUrl(data.tarjeta_sellos_url);
  data.tarjeta_virtual_url = normalizeUrl(data.tarjeta_virtual_url);
  data.tarjeta_url = normalizeUrl(data.tarjeta_url);

  configCache = { at: now, data };
  return data;
}

// ---------------- Catalog ----------------
let catalogCache = { at: 0, items: [], categories: [] };

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 30_000) return catalogCache;

  const res = await fetch(SHEET_CSV_URL, { method: "GET" });
  const csv = await res.text();
  const rows = parseCSV(csv);
  if (!rows.length) throw new Error("CSV vacío");

  const headers = rows[0].map((h) => (h || "").trim().toUpperCase());
  const idx = (name) => headers.indexOf(name);

  const I = {
    CODIGO: idx("CODIGO"),
    NOMBRE: idx("NOMBRE"),
    PRECIO: idx("PRECIO"),
    UNIDAD: idx("UNIDAD"),
    DESCRIPCION: idx("DESCRIPCION"),
    IMAGEN: idx("IMAGEN"),
    CATEGORIA: idx("CATEGORIA"),
  };

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const nombre = (row[I.NOMBRE] || "").trim();
    if (!nombre) continue;

    items.push({
      codigo: (row[I.CODIGO] || "").trim() || `ROW${r}`,
      nombre,
      precio: (row[I.PRECIO] || "").trim(),
      unidad: (row[I.UNIDAD] || "").trim(),
      descripcion: (row[I.DESCRIPCION] || "").trim(),
      imagen: normalizeUrl((row[I.IMAGEN] || "").trim()),
      categoria: (row[I.CATEGORIA] || "").trim() || "Sin categoría",
    });
  }

  const categories = [...new Set(items.map((x) => x.categoria))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );

  catalogCache = { at: now, items, categories };
  return catalogCache;
}

// ---------------- State (por chat) ----------------
const userState = new Map();

/**
 * refBy: id del cliente que lo refirió (si entró con start REF_x)
 * referralsPaid: Set de ids de referidos ya premiados (para no sumar 1000 sellos)
 */
function getOrInitState(chat_id) {
  if (!userState.has(chat_id)) {
    userState.set(chat_id, {
      mode: "HOME",
      category: "__ALL__",
      list: [],
      index: 0,
      messageId: null,
      cart: [],
      stamps: 0,

      refBy: null,
      referralsPaid: new Set(), // quiénes ya generaron un sello al referidor
      pendingItem: null,
    });
  }
  return userState.get(chat_id);
}

// ---------------- Keyboards ----------------
function homeKeyboard() {
  return {
    keyboard: [
      ["🛍️ Catálogo", "🧾 Carrito"],
      ["🏷️ Sellos", "📣 Compartir bot"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT_${enc(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT_${enc(b)}` });
    rows.push(row);
  }
  rows.unshift([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "MENU_HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ Para pedir: escribí <b>QUIERO</b>`;
}

function productKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "PROD_PREV" },
        { text: "➡️", callback_data: "PROD_NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "PROD_WANT" }],
      [{ text: "📣 Compartir", callback_data: "PROD_SHARE_MENU" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

function shareMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", callback_data: "SHARE_WA" },
        { text: "✈️ Telegram", callback_data: "SHARE_TG" },
      ],
      [{ text: "✉️ Email", callback_data: "SHARE_EMAIL" }],
      [{ text: "⬅️ Volver", callback_data: "PROD_SHARE_BACK" }],
    ],
  };
}

function shareBotKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", callback_data: "BOTSHARE_WA" },
        { text: "✈️ Telegram", callback_data: "BOTSHARE_TG" },
      ],
      [{ text: "✉️ Email", callback_data: "BOTSHARE_EMAIL" }],
    ],
  };
}

// ---------------- Carrusel ----------------
async function showProductCarousel(chat_id, state) {
  const list = state.list;
  const index = state.index;

  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen)", { parse_mode: "HTML", reply_markup: kb });
    state.messageId = msg?.result?.message_id || null;
    return;
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  state.messageId = msg?.result?.message_id || null;
}

async function updateCarousel(chat_id, state) {
  const item = state.list[state.index];
  const caption = productCaption(item, state.index + 1, state.list.length);

  if (!state.messageId) return showProductCarousel(chat_id, state);

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, state.messageId, item.imagen, caption, { reply_markup: productKeyboard() });
  } else {
    // si no hay imagen, no rompemos; solo mantenemos caption cambiando botones
    await editMessageReplyMarkup(chat_id, state.messageId, productKeyboard());
  }
}

// ---------------- Compartir (con referido) ----------------
function waLink(text, url) {
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}
function tgShareLink(text, url) {
  return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
}
function gmailComposeLink(subject, body) {
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(subject)}&body=${enc(body)}`;
}

function buildBotShare(referrerChatId) {
  const startLink = `https://t.me/${BOT_USERNAME}?start=${enc(`REF_${referrerChatId}`)}`;
  const text = `🧀 Todo Queso\nCompras por Telegram\n\nAbrí el bot acá 👇`;
  return { startLink, text };
}

function buildProductShare(item, referrerChatId) {
  const payload = `P_${item.codigo}_REF_${referrerChatId}`;
  const startLink = `https://t.me/${BOT_USERNAME}?start=${enc(payload)}`;
  const text = `🧀 Todo Queso\nMirá este producto:\n${item.nombre} - $ ${item.precio || "-"} ${
    item.unidad ? `(${item.unidad})` : ""
  }\n\nAbrí el bot y pedilo acá 👇`;
  return { startLink, text };
}

// ---------------- Sellos ----------------
function addStamp(chat_id, n = 1) {
  const st = getOrInitState(chat_id);
  st.stamps = Math.max(0, (st.stamps || 0) + n);
  userState.set(chat_id, st);
}

// ---------------- /start ----------------
async function handleStart(chat_id, payload = "") {
  const cfg = await loadConfig();
  const st = getOrInitState(chat_id);

  // payloads posibles:
  // REF_<id>
  // P_<codigo>_REF_<id>
  if (payload.startsWith("REF_")) {
    const ref = payload.slice(4).trim();
    if (ref && ref !== String(chat_id)) st.refBy = ref;
  }

  if (payload.startsWith("P_")) {
    // P_<codigo>_REF_<id>
    const parts = payload.split("_");
    const code = parts[1] || "";
    const refIdx = parts.findIndex((x) => x === "REF");
    if (refIdx >= 0 && parts[refIdx + 1]) {
      const ref = parts[refIdx + 1];
      if (ref && ref !== String(chat_id)) st.refBy = ref;
    }

    const { items } = await loadCatalog();
    const idx = items.findIndex((x) => String(x.codigo) === String(code));
    userState.set(chat_id, st);

    await sendWarmWelcome(chat_id, cfg);
    if (idx >= 0) {
      st.mode = "CATALOG";
      st.list = items;
      st.index = idx;
      st.messageId = null;
      userState.set(chat_id, st);
      await showProductCarousel(chat_id, st);
      return;
    }
    return;
  }

  userState.set(chat_id, st);
  await sendWarmWelcome(chat_id, cfg);
}

async function sendWarmWelcome(chat_id, cfg) {
  const nombre = pickCfg(cfg, "negocio_nombre") || "Todo Queso";
  const slogan = pickCfg(cfg, "negocio_slogan");
  const horario = pickCfg(cfg, "negocio_horario");
  const direccion = pickCfg(cfg, "negocio_direccion");
  const logo = pickCfg(cfg, "negocio_logo_url", "logo_url");

  const texto =
    `👋 Hola! Bienvenido/a a <b>${escapeHtml(nombre)}</b> 🧀\n` +
    (slogan ? `${escapeHtml(slogan)}\n` : "") +
    (horario ? `🕒 <b>Horario:</b> ${escapeHtml(horario)}\n` : "") +
    (direccion ? `📍 <b>Dirección:</b> ${escapeHtml(direccion)}\n` : "") +
    `\n✨ ¿Qué te preparo hoy?\n` +
    `• Tocá <b>Catálogo</b> para ver productos con foto\n` +
    `• Mirá <b>Sellos</b> para tus beneficios\n` +
    `• O <b>Compartí el bot</b> para invitar a alguien 😉`;

  if (logo && logo.startsWith("http")) {
    return sendPhoto(chat_id, logo, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }
  return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
}

// ---------------- Menús ----------------
async function handleCatalogMenu(chat_id) {
  const st = getOrInitState(chat_id);
  const { categories } = await loadCatalog();
  st.mode = "CATALOG";
  userState.set(chat_id, st);

  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const st = getOrInitState(chat_id);
  const { items } = await loadCatalog();

  let list = items;
  if (category && category !== "__ALL__") list = items.filter((x) => x.categoria === category);

  if (!list.length) return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: homeKeyboard() });

  st.mode = "CATALOG";
  st.list = list;
  st.index = 0;
  st.messageId = null;

  userState.set(chat_id, st);
  await showProductCarousel(chat_id, st);
}

async function handleCarrito(chat_id) {
  const st = getOrInitState(chat_id);

  if (!st.cart?.length) {
    return sendMessage(chat_id, "🧾 <b>Carrito vacío</b>\n\nAgregá productos desde el catálogo.", {
      parse_mode: "HTML",
      reply_markup: homeKeyboard(),
    });
  }

  let total = 0;
  const lines = st.cart.map((it) => {
    const price = parseFloat(String(it.precio || "0").replace(",", ".")) || 0;
    total += price * (it.qtyNum || 1);
    return `• <b>${escapeHtml(it.nombre)}</b> — ${escapeHtml(it.qtyText || "1")} — $ ${escapeHtml(it.precio || "-")}`;
  });

  return sendMessage(
    chat_id,
    `🧾 <b>Tu carrito</b>\n\n${lines.join("\n")}\n\n<b>Total estimado:</b> $ ${escapeHtml(
      total.toFixed(0)
    )}\n\n✅ Para finalizar: escribí <b>FINALIZAR</b>`,
    { parse_mode: "HTML", reply_markup: homeKeyboard() }
  );
}

async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const st = getOrInitState(chat_id);

  const cardUrl = pickCfg(cfg, "tarjeta_sellos_url", "tarjeta_virtual_url", "tarjeta_url");

  const texto =
    `🏷️ <b>Tu tarjeta de sellos</b>\n\n` +
    `Sellos acumulados: <b>${escapeHtml(st.stamps || 0)}</b>\n\n` +
    `💡 Tip: por cada compra sumás sellos. Si alguien compra por tu link compartido, sumás 1 sello extra.`;

  if (cardUrl && cardUrl.startsWith("http")) {
    return sendPhoto(chat_id, cardUrl, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }
  return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
}

async function handleShareBot(chat_id) {
  return sendMessage(chat_id, "📣 <b>Compartir el bot</b>\nElegí dónde:", {
    parse_mode: "HTML",
    reply_markup: shareBotKeyboard(),
  });
}

// ---------------- Callbacks ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const msg_id = cb.message?.message_id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  const st = getOrInitState(chat_id);

  if (data === "MENU_HOME") return handleStart(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) return handleCategory(chat_id, decodeURIComponent(data.slice(4)));

  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    if (!st.list?.length) return;
    const total = st.list.length;
    if (data === "PROD_NEXT") st.index = (st.index + 1) % total;
    if (data === "PROD_PREV") st.index = (st.index - 1 + total) % total;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  if (data === "PROD_WANT") {
    const item = st.list?.[st.index];
    if (!item) return;

    st.mode = "ASK_QTY";
    st.pendingItem = item;
    userState.set(chat_id, st);

    return sendMessage(
      chat_id,
      `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nEscribí la cantidad:\n• Ej: <b>1</b>\n• Ej: <b>200g</b> / <b>0.5kg</b>`,
      { parse_mode: "HTML" }
    );
  }

  if (data === "PROD_SHARE_MENU") {
    if (!msg_id) return;
    return editMessageReplyMarkup(chat_id, msg_id, shareMenuKeyboard());
  }
  if (data === "PROD_SHARE_BACK") {
    if (!msg_id) return;
    return editMessageReplyMarkup(chat_id, msg_id, productKeyboard());
  }

  // Compartir PRODUCTO (NO suma sellos acá)
  if (data === "SHARE_WA" || data === "SHARE_TG" || data === "SHARE_EMAIL") {
    const item = st.list?.[st.index];
    if (!item || !msg_id) return;

    const { startLink, text } = buildProductShare(item, chat_id);

    if (data === "SHARE_WA") {
      return editMessageReplyMarkup(chat_id, msg_id, {
        inline_keyboard: [
          [{ text: "📣 Abrir WhatsApp", url: waLink(text, startLink) }],
          [{ text: "🟢 Abrir bot", url: startLink }],
          [{ text: "⬅️ Volver", callback_data: "PROD_SHARE_BACK" }],
        ],
      });
    }

    if (data === "SHARE_TG") {
      return editMessageReplyMarkup(chat_id, msg_id, {
        inline_keyboard: [
          [{ text: "✈️ Compartir en Telegram", url: tgShareLink(text, startLink) }],
          [{ text: "🟢 Abrir bot", url: startLink }],
          [{ text: "⬅️ Volver", callback_data: "PROD_SHARE_BACK" }],
        ],
      });
    }

    if (data === "SHARE_EMAIL") {
      const subject = "Todo Queso - Producto";
      const body = `${text}\n\n${startLink}`;
      const gmailUrl = gmailComposeLink(subject, body);

      return editMessageReplyMarkup(chat_id, msg_id, {
        inline_keyboard: [
          [{ text: "✉️ Abrir Email", url: gmailUrl }],
          [{ text: "🟢 Abrir bot", url: startLink }],
          [{ text: "⬅️ Volver", callback_data: "PROD_SHARE_BACK" }],
        ],
      });
    }
  }

  // Compartir BOT (NO suma sellos acá)
  if (data === "BOTSHARE_WA" || data === "BOTSHARE_TG" || data === "BOTSHARE_EMAIL") {
    const { startLink, text } = buildBotShare(chat_id);

    if (data === "BOTSHARE_WA") {
      return sendMessage(chat_id, "📣 WhatsApp:", {
        reply_markup: { inline_keyboard: [[{ text: "📣 Abrir WhatsApp", url: waLink(text, startLink) }]] },
      });
    }

    if (data === "BOTSHARE_TG") {
      return sendMessage(chat_id, "✈️ Telegram:", {
        reply_markup: { inline_keyboard: [[{ text: "✈️ Compartir en Telegram", url: tgShareLink("Todo Queso", startLink) }]] },
      });
    }

    if (data === "BOTSHARE_EMAIL") {
      const subject = "Todo Queso - Bot";
      const body = `${text}\n${startLink}`;
      const gmailUrl = gmailComposeLink(subject, body);
      return sendMessage(chat_id, "✉️ Email:", {
        reply_markup: { inline_keyboard: [[{ text: "✉️ Abrir Email", url: gmailUrl }]] },
      });
    }
  }
}

// ---------------- Text messages ----------------
async function handleTextMessage(chat_id, text) {
  const st = getOrInitState(chat_id);
  const t = (text || "").trim();

  // Cantidad para carrito
  if (st.mode === "ASK_QTY" && st.pendingItem) {
    const item = st.pendingItem;

    const qtyText = t;
    let qtyNum = 1;

    const mKg = t.toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*kg$/);
    const mG = t.toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*g$/);
    const mN = t.toLowerCase().match(/^(\d+(?:[.,]\d+)?)$/);

    if (mKg) qtyNum = parseFloat(mKg[1].replace(",", ".")) || 1;
    else if (mG) qtyNum = (parseFloat(mG[1].replace(",", ".")) || 0) / 1000 || 1;
    else if (mN) qtyNum = parseFloat(mN[1].replace(",", ".")) || 1;

    st.cart = st.cart || [];
    st.cart.push({ ...item, qtyText, qtyNum });

    st.mode = "CATALOG";
    st.pendingItem = null;
    userState.set(chat_id, st);

    return sendMessage(chat_id, `✅ Agregado al carrito: <b>${escapeHtml(item.nombre)}</b>\nCantidad: <b>${escapeHtml(qtyText)}</b>`, {
      parse_mode: "HTML",
      reply_markup: homeKeyboard(),
    });
  }

  // Menú
  if (t.toLowerCase() === "catalogo" || t === "🛍️ Catálogo") return handleCatalogMenu(chat_id);
  if (t.toLowerCase() === "carrito" || t === "🧾 Carrito") return handleCarrito(chat_id);
  if (t.toLowerCase() === "sellos" || t === "🏷️ Sellos") return handleSellos(chat_id);
  if (t.toLowerCase().includes("compartir bot") || t === "📣 Compartir bot") return handleShareBot(chat_id);

  // FINALIZAR: aquí es donde corresponde dar sellos por compra
  if (t.toLowerCase() === "finalizar" || t.toLowerCase() === "finalizar compra") {
    if (!st.cart?.length) {
      return sendMessage(chat_id, "Tu carrito está vacío. Agregá productos desde el catálogo.", { reply_markup: homeKeyboard() });
    }

    // ✅ Sello por compra (por ahora 1 base; luego lo conectamos a reglas reales de Config)
    addStamp(chat_id, 1);

    // ✅ Premio por referido SOLO si el comprador entró por link REF_x y aún no se premió ese referido
    if (st.refBy && String(st.refBy).trim()) {
      const refId = String(st.refBy).trim();
      // evitamos dar premio infinito: solo 1 vez por cada comprador referido
      // (es decir: si ese usuario compra 100 veces, ya lo afinamos después con reglas reales,
      // pero hoy lo dejamos "1 sola vez" para que sea justo y no explote)
      const buyerId = String(chat_id);
      if (!st.referralsPaid.has("PAID")) {
        // marcamos en el comprador que ya generó premio al referidor
        st.referralsPaid.add("PAID");
        userState.set(chat_id, st);

        // sumamos 1 sello al referidor si existe su estado
        const refSt = getOrInitState(refId);
        addStamp(refId, 1);

        // aviso opcional (no ensucia)
        await sendMessage(refId, `🎉 ¡Sumaste 1 sello!\nUn cliente compró desde tu link compartido ✅`, { reply_markup: homeKeyboard() }).catch(() => {});
      }
    }

    const lines = st.cart.map((it) => `• ${it.nombre} — ${it.qtyText || "1"} — $ ${it.precio || "-"}`);
    return sendMessage(
      chat_id,
      `🧾 <b>Pedido confirmado (resumen)</b>\n\n${escapeHtml(lines.join("\n"))}\n\n✅ Ya sumaste sellos por tu compra.\n📦 Próximo: envío / pago / comprobante (lo unimos después sin romper nada).`,
      { parse_mode: "HTML", reply_markup: homeKeyboard() }
    );
  }

  return sendMessage(chat_id, "😊 Elegí una opción del menú de abajo 👇", { reply_markup: homeKeyboard() });
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO LIVE"));

app.get("/debug", async (req, res) => {
  let cfg = null;
  try {
    cfg = await loadConfig();
  } catch (e) {
    cfg = { error: "No pude leer CONFIG_CSV_URL", detail: String(e?.message || e) };
  }
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      hasConfigCsvUrl: Boolean(CONFIG_CSV_URL),
    },
    configPreview: cfg,
  });
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};
  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";
      const isStart = text.startsWith("/start");

      if (isStart) {
        const parts = text.split(" ");
        const payload = (parts[1] || "").trim();
        return handleStart(chat_id, payload);
      }
      return handleTextMessage(chat_id, text);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  console.log("✅ CONFIG_CSV_URL:", CONFIG_CSV_URL ? "OK" : "FALTA");
});
