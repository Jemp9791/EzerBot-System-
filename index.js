/**
 * TODO_QUESO - Bot Telegram + Catálogo carrusel + Compartir + Carrito + Sellos (simple)
 *
 * ENV (los que YA tenés):
 * - TELEGRAM_TOKEN   (obligatorio)
 * - PUBLIC_URL       (obligatorio) ej: https://ezerbot-system.onrender.com
 * - SHEET_CSV_URL    (obligatorio) CSV de Catalogo
 * - BOT_USERNAME     (opcional pero recomendado) ej: Ezer_IA_Bot
 * - SYSTEM_EMAIL     (opcional) ej: ezerbot.assistant@gmail.com
 *
 * ENV OPCIONAL (si querés Config 100% dinámico desde Sheets):
 * - CONFIG_CSV_URL   (CSV de hoja Config)
 *
 * Webhook: POST "/"   (tu webhook actual ya apunta bien)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const CONFIG_CSV_URL = process.env.CONFIG_CSV_URL || ""; // opcional
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

// ---------------- Config (opcional, si hay CONFIG_CSV_URL) ----------------
let configCache = { at: 0, data: null };

const DEFAULT_CONFIG = {
  negocio_nombre: "Todo Queso",
  negocio_slogan: "Compras por Telegram",
  negocio_direccion: "",
  negocio_horario: "",
  negocio_logo_url: "", // si querés, lo dejás en Config
  whatsapp_numero: "",  // ej: 5491122538102 (opcional)
  alias_transferencia: "",
  envio_texto: "",
  promo_texto: "",
};

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
  if (!rows.length) {
    configCache = { at: now, data: DEFAULT_CONFIG };
    return DEFAULT_CONFIG;
  }

  // Espera formato: CLAVE, VALOR (en filas)
  // Ej: negocio_nombre, Todo Queso
  const data = { ...DEFAULT_CONFIG };
  for (let r = 0; r < rows.length; r++) {
    const k = (rows[r]?.[0] || "").trim();
    const v = (rows[r]?.[1] || "").trim();
    if (!k) continue;
    data[k] = v;
  }

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
/*
state = {
  mode: "HOME" | "CATALOG" | "ASK_QTY",
  category: "__ALL__" | "x",
  categoryLabel: "Todas" | "x",
  list: [],
  index: 0,
  messageId: number,
  cart: [{codigo, nombre, precio, unidad, qtyText}],
  stamps: number,
  refBy: string|null,
  lastShare: { text, link, photoUrl, payloadStart }
}
*/

function getOrInitState(chat_id) {
  if (!userState.has(chat_id)) {
    userState.set(chat_id, {
      mode: "HOME",
      category: "__ALL__",
      categoryLabel: "Todas",
      list: [],
      index: 0,
      messageId: null,
      cart: [],
      stamps: 0,
      refBy: null,
      lastShare: null,
    });
  }
  return userState.get(chat_id);
}

// ---------------- Keyboards (LIMPIO) ----------------
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

function productCaption(cfg, item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ Para pedir: escribí <b>QUIERO</b>`;
}

function productKeyboard() {
  // ✅ super limpio: nav + quiero + compartir + menú
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

// ---------------- Carrusel (1 mensaje, luego edit) ----------------
async function showProductCarousel(chat_id, state) {
  const cfg = await loadConfig();
  const list = state.list;
  const index = state.index;

  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total);

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
  const cfg = await loadConfig();
  const list = state.list;
  const index = state.index;

  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total);

  if (!state.messageId) return showProductCarousel(chat_id, state);

  // Si hay imagen, editamos media (mantiene chat limpio)
  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, state.messageId, item.imagen, caption, { reply_markup: productKeyboard() });
  } else {
    await editMessageCaption(chat_id, state.messageId, caption + "\n\n⚠️ (Sin imagen)", { reply_markup: productKeyboard() });
  }
}

// ---------------- Compartir (producto) ----------------
function buildProductShare(state, item) {
  // deep link para que el receptor caiga en ese producto
  // payload corto: P_<CODIGO>
  const payload = `P_${item.codigo}`;
  const startLink = `https://t.me/${BOT_USERNAME}?start=${enc(payload)}`;

  const text = `🧀 Todo Queso\nMirá este producto:\n${item.nombre} - $ ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\nAbrí el bot y pedilo acá 👇`;

  return { payload, startLink, text };
}

function waLink(text, url) {
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}
function tgShareLink(text, url) {
  return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
}
function gmailComposeLink(subject, body) {
  // ✅ https => Telegram lo acepta como botón URL
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(subject)}&body=${enc(body)}`;
}

// ---------------- Sellos ----------------
function addStamp(chat_id, n = 1) {
  const st = getOrInitState(chat_id);
  st.stamps = Math.max(0, (st.stamps || 0) + n);
  userState.set(chat_id, st);
}

// ---------------- Handlers ----------------
async function handleStart(chat_id, startPayloadRaw = "") {
  const cfg = await loadConfig();
  const st = getOrInitState(chat_id);

  // Captación por referidor: /start REF_xxxx
  if (startPayloadRaw?.startsWith("REF_")) {
    const ref = startPayloadRaw.slice(4);
    st.refBy = ref;

    // Si querés, en tu “ref” ponés el chat_id del referidor.
    // Como no lo tenemos persistido acá, dejamos el mecanismo listo
    // y el “ref” lo usás más adelante cuando conectemos persistencia.
  }

  // Si entra por producto /start P_codigo → le mostramos ese producto directo
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

      await sendMessage(chat_id, `👋 Bienvenido/a a <b>${escapeHtml(cfg.negocio_nombre)}</b>`, {
        parse_mode: "HTML",
        reply_markup: { keyboard: homeKeyboard().keyboard, resize_keyboard: true },
      });
      await showProductCarousel(chat_id, st);
      return;
    }
  }

  // Inicio normal
  const header =
    `🧀 <b>${escapeHtml(cfg.negocio_nombre)}</b>\n` +
    (cfg.negocio_slogan ? `${escapeHtml(cfg.negocio_slogan)}\n` : "") +
    (cfg.negocio_horario ? `🕒 ${escapeHtml(cfg.negocio_horario)}\n` : "") +
    (cfg.negocio_direccion ? `📍 ${escapeHtml(cfg.negocio_direccion)}\n` : "") +
    `\nElegí una opción:`;

  await sendMessage(chat_id, header, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  st.mode = "HOME";
  userState.set(chat_id, st);
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
  let label = "Todas";
  if (category && category !== "__ALL__") {
    label = category;
    list = items.filter((x) => x.categoria === category);
  }

  if (!list.length) return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: homeKeyboard() });

  st.mode = "CATALOG";
  st.category = category;
  st.categoryLabel = label;
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
  const lines = st.cart.map((it, i) => {
    const price = parseFloat(String(it.precio || "0").replace(",", ".")) || 0;
    total += price * (it.qtyNum || 1);
    return `• <b>${escapeHtml(it.nombre)}</b> — ${escapeHtml(it.qtyText || "1")} — $ ${escapeHtml(it.precio || "-")}`;
  });

  return sendMessage(
    chat_id,
    `🧾 <b>Tu carrito</b>\n\n${lines.join("\n")}\n\n<b>Total estimado:</b> $ ${escapeHtml(total.toFixed(0))}\n\n✅ Para finalizar: escribí <b>FINALIZAR</b>`,
    { parse_mode: "HTML", reply_markup: homeKeyboard() }
  );
}

async function handleSellos(chat_id) {
  const st = getOrInitState(chat_id);
  return sendMessage(
    chat_id,
    `🏷️ <b>Tarjeta de sellos</b>\n\nSellos acumulados: <b>${escapeHtml(st.stamps || 0)}</b>\n\n📣 Tip: compartí el bot para sumar sellos.`,
    { parse_mode: "HTML", reply_markup: homeKeyboard() }
  );
}

async function handleShareBot(chat_id) {
  // suma sello por acción de compartir bot
  addStamp(chat_id, 1);

  const botLink = `https://t.me/${BOT_USERNAME}`;
  const text = `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá:\n${botLink}`;

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

  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) return handleCategory(chat_id, decodeURIComponent(data.slice(4)));

  // Navegación carrusel
  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    if (!st.list?.length) return;
    const total = st.list.length;
    if (data === "PROD_NEXT") st.index = (st.index + 1) % total;
    if (data === "PROD_PREV") st.index = (st.index - 1 + total) % total;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  // Quiero este -> pide cantidad
  if (data === "PROD_WANT") {
    const item = st.list?.[st.index];
    if (!item) return;

    st.mode = "ASK_QTY";
    st.pendingItem = item;
    userState.set(chat_id, st);

    // Mensaje corto (1) y listo
    return sendMessage(
      chat_id,
      `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nEscribí la cantidad:\n• Ej: <b>1</b> (unidad)\n• Ej: <b>200g</b> / <b>0.5kg</b>\n\n(Después escribí <b>QUIERO</b> o seguí navegando)`,
      { parse_mode: "HTML" }
    );
  }

  // Compartir -> abre menú en el MISMO mensaje (sin ensuciar chat)
  if (data === "PROD_SHARE_MENU") {
    if (!msg_id) return;
    return editMessageReplyMarkup(chat_id, msg_id, shareMenuKeyboard());
  }
  if (data === "PROD_SHARE_BACK") {
    if (!msg_id) return;
    return editMessageReplyMarkup(chat_id, msg_id, productKeyboard());
  }

  // Compartir opciones (producto)
  if (data === "SHARE_WA" || data === "SHARE_TG" || data === "SHARE_EMAIL") {
    const item = st.list?.[st.index];
    if (!item) return;

    const { startLink, text } = buildProductShare(st, item);
    st.lastShare = { text, link: startLink, photoUrl: item.imagen || "" };
    userState.set(chat_id, st);

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

    // Email: lo dejamos “usable” sin mailto (gmail compose https)
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
        reply_markup: {
          inline_keyboard: [[{ text: "📣 Abrir WhatsApp", url: waLink(text, botLink) }]],
        },
      });
    }
    if (data === "BOTSHARE_TG") {
      return sendMessage(chat_id, "✈️ Telegram:", {
        reply_markup: {
          inline_keyboard: [[{ text: "✈️ Compartir en Telegram", url: tgShareLink("Todo Queso", botLink) }]],
        },
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

  // si está esperando cantidad
  if (st.mode === "ASK_QTY" && st.pendingItem) {
    const item = st.pendingItem;

    const qtyText = t;
    let qtyNum = 1;

    // parse simple: "2", "200g", "0.5kg"
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

  // comandos por texto
  if (t.toLowerCase() === "catalogo" || t === "🛍️ Catálogo") return handleCatalogMenu(chat_id);
  if (t.toLowerCase() === "carrito" || t === "🧾 Carrito") return handleCarrito(chat_id);
  if (t.toLowerCase() === "sellos" || t === "🏷️ Sellos") return handleSellos(chat_id);
  if (t.toLowerCase().includes("compartir bot") || t === "📣 Compartir bot") return handleShareBot(chat_id);

  if (t.toLowerCase() === "finalizar" || t.toLowerCase() === "finalizar compra") {
    // checkout básico (no rompe nada): muestra resumen
    if (!st.cart?.length) return sendMessage(chat_id, "Tu carrito está vacío. Agregá productos desde el catálogo.", { reply_markup: homeKeyboard() });

    const lines = st.cart.map((it) => `• ${it.nombre} — ${it.qtyText || "1"} — $ ${it.precio || "-"}`);
    return sendMessage(
      chat_id,
      `🧾 <b>Pedido (resumen)</b>\n\n${escapeHtml(lines.join("\n"))}\n\n✅ Próximo paso: (lo unimos después) envío / pago / comprobante.`,
      { parse_mode: "HTML", reply_markup: homeKeyboard() }
    );
  }

  // fallback: vuelve a menú
  return sendMessage(chat_id, "Elegí una opción del menú 👇", { reply_markup: homeKeyboard() });
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
        // /start payload
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
