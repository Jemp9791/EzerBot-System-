/**
 * TODO_QUESO - Bot Telegram + Catálogo carrusel + Compartir + Carrito + Sellos
 *
 * ENV:
 * - TELEGRAM_TOKEN   (obligatorio)
 * - PUBLIC_URL       (obligatorio) ej: https://ezerbot-system.onrender.com
 * - SHEET_CSV_URL    (obligatorio) CSV de Catalogo
 * - BOT_USERNAME     (opcional recomendado) ej: Ezer_IA_Bot
 * - SYSTEM_EMAIL     (opcional) ej: ezerbot.assistant@gmail.com
 *
 * OPCIONAL (Config dinámico):
 * - CONFIG_CSV_URL   CSV de hoja Config (CLAVE,VALOR)
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
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---------------- Telegram API ----------------
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
  return tgCall("editMessageCaption", { chat_id, message_id, caption, parse_mode: "HTML", ...extra });
}
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}

// ---------------- Utils ----------------
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
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
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

// ---------------- Config ----------------
let configCache = { at: 0, data: null };

const DEFAULT_CONFIG = {
  negocio_nombre: "Todo Queso",
  negocio_slogan: "Compras por Telegram",
  negocio_direccion: "",
  negocio_horario: "",
  // soportamos varios nombres posibles (por si en tu Config se llaman distinto)
  negocio_logo_url: "",
  logo_url: "",
  tarjeta_sellos_url: "",
  tarjeta_virtual_url: "",
  tarjeta_url: "",
  whatsapp_numero: "",
  alias_transferencia: "",
  envio_texto: "",
  promo_texto: "",
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
  if (configCache.data && now - configCache.at < 60_000) return configCache.data;

  if (!CONFIG_CSV_URL) {
    configCache = { at: now, data: DEFAULT_CONFIG };
    return DEFAULT_CONFIG;
  }

  const res = await fetch(CONFIG_CSV_URL, { method: "GET" });
  const csv = await res.text();
  const rows = parseCSV(csv);
  const data = { ...DEFAULT_CONFIG };

  // Espera formato: CLAVE, VALOR
  for (let r = 0; r < rows.length; r++) {
    const k = (rows[r]?.[0] || "").trim();
    const v = (rows[r]?.[1] || "").trim();
    if (!k) continue;
    data[k] = v;
  }

  // normalizamos urls por si vienen con formato raro
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
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache;

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
    if (!row || row.length < 2) continue;

    const nombre = (row[I.NOMBRE] || "").trim();
    if (!nombre) continue;

    const item = {
      codigo: (row[I.CODIGO] || "").trim() || `ROW${r}`,
      nombre,
      precio: (row[I.PRECIO] || "").trim(),
      unidad: (row[I.UNIDAD] || "").trim(),
      descripcion: (row[I.DESCRIPCION] || "").trim(),
      imagen: normalizeUrl((row[I.IMAGEN] || "").trim()),
      categoria: (row[I.CATEGORIA] || "").trim() || "Sin categoría",
    };
    items.push(item);
  }

  const categories = [...new Set(items.map((x) => x.categoria))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );

  catalogCache = { at: now, items, categories };
  return catalogCache;
}

// ---------------- State (por chat) ----------------
const userState = new Map();

function getOrInitState(chat_id) {
  if (!userState.has(chat_id)) {
    userState.set(chat_id, {
      mode: "HOME",
      category: "__ALL__",
      categoryLabel: "Todas",
      list: [],
      index: 0,
      messageId: null,
      messageIsPhoto: false,
      cart: [],
      stamps: 0,
      refBy: null,
      lastShare: null,
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
    state.messageIsPhoto = false;
    return;
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  state.messageId = msg?.result?.message_id || null;
  state.messageIsPhoto = true;
}

async function updateCarousel(chat_id, state) {
  const list = state.list;
  const index = state.index;

  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);

  if (!state.messageId) return showProductCarousel(chat_id, state);

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, state.messageId, item.imagen, caption, { reply_markup: productKeyboard() });
  } else {
    await editMessageCaption(chat_id, state.messageId, caption + "\n\n⚠️ (Sin imagen)", { reply_markup: productKeyboard() });
  }
}

// ---------------- Compartir links ----------------
function buildProductShare(item) {
  const payload = `P_${item.codigo}`;
  const startLink = `https://t.me/${BOT_USERNAME}?start=${enc(payload)}`;
  const text = `🧀 Todo Queso\nMirá este producto:\n${item.nombre} - $ ${item.precio || "-"} ${
    item.unidad ? `(${item.unidad})` : ""
  }\n\nAbrí el bot y pedilo acá 👇`;
  return { payload, startLink, text };
}

function waLink(text, url) {
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}
function tgShareLink(text, url) {
  return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
}
function gmailComposeLink(subject, body) {
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(subject)}&body=${enc(body)}`;
}

// ---------------- Sellos ----------------
function addStamp(chat_id, n = 1) {
  const st = getOrInitState(chat_id);
  st.stamps = Math.max(0, (st.stamps || 0) + n);
  userState.set(chat_id, st);
}

// ---------------- Flujos ----------------
async function handleStart(chat_id, startPayloadRaw = "") {
  const cfg = await loadConfig();
  const st = getOrInitState(chat_id);

  // Referido: /start REF_xxx
  if (startPayloadRaw?.startsWith("REF_")) {
    st.refBy = startPayloadRaw.slice(4);
  }

  // Entrar directo a producto: /start P_codigo
  if (startPayloadRaw?.startsWith("P_")) {
    const code = startPayloadRaw.slice(2);
    const { items } = await loadCatalog();
    const idx = items.findIndex((x) => String(x.codigo) === String(code));
    if (idx >= 0) {
      st.mode = "CATALOG";
      st.category = "__ALL__";
      st.categoryLabel = "Todas";
      st.list = items;
      st.index = idx;
      st.messageId = null;
      userState.set(chat_id, st);

      // saludo cálido (igual)
      await sendWarmWelcome(chat_id, cfg);
      await showProductCarousel(chat_id, st);
      return;
    }
  }

  // Inicio normal
  await sendWarmWelcome(chat_id, cfg);
  st.mode = "HOME";
  userState.set(chat_id, st);
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
    `• O <b>Compartí el bot</b> y sumás sellos 😉`;

  if (logo && logo.startsWith("http")) {
    return sendPhoto(chat_id, logo, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }
  return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
}

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
  st.category = category;
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
    `📣 Tip: compartí el bot o una promo para sumar sellos.`;

  // ✅ AHORA SÍ: muestra la tarjeta virtual (imagen) si está en Config
  if (cardUrl && cardUrl.startsWith("http")) {
    return sendPhoto(chat_id, cardUrl, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }
  return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: homeKeyboard() });
}

async function handleShareBot(chat_id) {
  // ✅ suma sello por compartir bot (la acción de entrar a compartir)
  addStamp(chat_id, 1);

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

  // ✅ Compartir producto/promo: suma sello cuando elige canal
  if (data === "SHARE_WA" || data === "SHARE_TG" || data === "SHARE_EMAIL") {
    const item = st.list?.[st.index];
    if (!item) return;

    addStamp(chat_id, 1);

    const { startLink, text } = buildProductShare(item);

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

  // Compartir BOT (desde menú principal)
  if (data === "BOTSHARE_WA" || data === "BOTSHARE_TG" || data === "BOTSHARE_EMAIL") {
    const botLink = `https://t.me/${BOT_USERNAME}`;
    const text = `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá:\n${botLink}`;

    if (data === "BOTSHARE_WA") {
      return sendMessage(chat_id, "📣 WhatsApp:", {
        reply_markup: { inline_keyboard: [[{ text: "📣 Abrir WhatsApp", url: waLink(text, botLink) }]] },
      });
    }
    if (data === "BOTSHARE_TG") {
      return sendMessage(chat_id, "✈️ Telegram:", {
        reply_markup: { inline_keyboard: [[{ text: "✈️ Compartir en Telegram", url: tgShareLink("Todo Queso", botLink) }]] },
      });
    }
    if (data === "BOTSHARE_EMAIL") {
      const subject = "Todo Queso - Bot";
      const body = text;
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

  // ✅ Compra: sumo sello al finalizar (por ahora, hasta que unamos pagos/confirmación)
  if (t.toLowerCase() === "finalizar" || t.toLowerCase() === "finalizar compra") {
    if (!st.cart?.length) return sendMessage(chat_id, "Tu carrito está vacío. Agregá productos desde el catálogo.", { reply_markup: homeKeyboard() });

    addStamp(chat_id, 1);

    const lines = st.cart.map((it) => `• ${it.nombre} — ${it.qtyText || "1"} — $ ${it.precio || "-"}`);
    return sendMessage(
      chat_id,
      `🧾 <b>Pedido (resumen)</b>\n\n${escapeHtml(lines.join("\n"))}\n\n✅ Próximo paso: envío / pago / comprobante (lo unimos después sin romper nada).`,
      { parse_mode: "HTML", reply_markup: homeKeyboard() }
    );
  }

  return sendMessage(chat_id, "😊 Elegí una opción del menú de abajo 👇", { reply_markup: homeKeyboard() });
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO LIVE"));

app.get("/debug", async (req, res) => {
  const cfg = await loadConfig();
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME,
      systemEmail: SYSTEM_EMAIL,
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

// Start
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});
