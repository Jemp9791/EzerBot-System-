/**
 * TODO_QUESO - Bot Telegram + Config (saludo vendedor) + Catálogo carrusel + Compartir (limpio)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = ...
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com   (sin barra final)
 * - SHEET_CSV_URL    = CSV del sheet "Catalogo" (productos)
 * - CONFIG_CSV_URL   = CSV del sheet "Config" (clave/valor)
 * - BOT_USERNAME     = Ezer_IA_Bot   (sin @)  (opcional, si no está lo toma de getMe al iniciar)
 *
 * Nota: sellos quedan en memoria (no persistente) para no romper nada.
 * Luego lo conectamos a Sheets cuando todo esté estable.
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const CONFIG_CSV_URL = process.env.CONFIG_CSV_URL || "";
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");
if (!CONFIG_CSV_URL) console.error("Falta ENV CONFIG_CSV_URL");

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

// ------------------ CSV Parser ------------------
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

function normalizeUrl(u) {
  if (!u) return "";
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function urlEncode(s) {
  return encodeURIComponent(String(s || ""));
}

// ------------------ Cache Config / Catalog ------------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, items: [], categories: [] };

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 60_000) return configCache.data;

  const res = await fetch(CONFIG_CSV_URL, { method: "GET" });
  const csv = await res.text();
  const rows = parseCSV(csv);
  if (!rows.length) return {};

  // Esperado: KEY, VALUE (o similares)
  const headers = rows[0].map((h) => (h || "").trim().toUpperCase());
  const idxKey = headers.indexOf("KEY") >= 0 ? headers.indexOf("KEY") : headers.indexOf("CLAVE");
  const idxVal = headers.indexOf("VALUE") >= 0 ? headers.indexOf("VALUE") : headers.indexOf("VALOR");

  const out = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const k = (r[idxKey] || "").trim();
    const v = (r[idxVal] || "").trim();
    if (!k) continue;
    out[k] = v;
  }

  configCache = { at: now, data: out };
  return out;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache;

  const res = await fetch(SHEET_CSV_URL, { method: "GET" });
  const csv = await res.text();
  const rows = parseCSV(csv);
  if (!rows.length) throw new Error("CSV Catálogo vacío");

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

    items.push({
      codigo: (row[I.CODIGO] || "").trim(),
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

// ------------------ Sellos (memoria) ------------------
const stamps = new Map(); // chatId -> number

function addStamp(chatId, n = 1) {
  const cur = stamps.get(chatId) || 0;
  stamps.set(chatId, cur + n);
}
function getStamps(chatId) {
  return stamps.get(chatId) || 0;
}

// ------------------ Estado carrusel ------------------
const userState = new Map(); // chatId -> { mode, categoryLabel, list, index, messageId, shareMode }

// ------------------ UI (teclados) ------------------
function mainMenuKeyboardReply() {
  // botones grandes (no ensucian, están abajo)
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
    ],
    resize_keyboard: true,
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.unshift([{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ <b>Para pedir:</b> escribí <b>QUIERO</b>`;
}

function productNavKeyboardClean() {
  // SOLO 1 botón Compartir (abre submenú)
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "P:PREV" },
        { text: "➡️", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE_MENU" }],
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function shareOptionsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", callback_data: "SH:WA" },
        { text: "✈️ Telegram", callback_data: "SH:TG" },
      ],
      [{ text: "✉️ Email", callback_data: "SH:EM" }],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

// ------------------ Links compartir ------------------
function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function shareLinksForText(text) {
  const t = urlEncode(text);
  return {
    wa: `https://wa.me/?text=${t}`,
    tg: `https://t.me/share/url?url=${t}`,
    em: `mailto:?subject=${urlEncode("Todo Queso")}&body=${t}`,
  };
}

function shareTextForProduct(item) {
  // link abre bot y muestra el producto al receptor
  const payload = `P_${(item.codigo || "").slice(0, 30)}`; // corto
  const link = botStartLink(payload);
  const txt =
    `🧀 Todo Queso — Mirá este producto:\n` +
    `${item.nombre}\n` +
    `💰 $ ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrí el bot y pedilo acá 👉 ${link}`;
  return txt;
}

function shareTextForBot() {
  const link = botStartLink("B");
  return `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá 👉 ${link}`;
}

// ------------------ Mostrar saludo vendedor ------------------
async function handleStart(chat_id, payload = "") {
  // asegurar username si no está
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();

  const negocio = cfg.BUSINESS_NAME || cfg.NOMBRE_NEGOCIO || "Todo Queso";
  const direccion = cfg.ADDRESS || cfg.DIRECCION || "";
  const horarios = cfg.HOURS || cfg.HORARIOS || "";
  const telefono = cfg.WHATSAPP || cfg.TELEFONO || "";
  const logo = normalizeUrl(cfg.LOGO_URL || cfg.LOGO || "");
  const estado = (cfg.STATUS || cfg.ESTADO || "").toLowerCase();
  const vaca = (cfg.VACACIONES || "").toLowerCase() === "si";
  const desde = cfg.CERRADO_DESDE || cfg.VACACIONES_DESDE || "";
  const hasta = cfg.CERRADO_HASTA || cfg.VACACIONES_HASTA || "";

  let estadoTxt = "";
  if (vaca || estado.includes("vac")) {
    estadoTxt = `🚫 <b>Hoy estamos cerrados</b>${desde || hasta ? ` (desde ${escapeHtml(desde)} hasta ${escapeHtml(hasta)})` : ""}\n`;
  } else if (estado.includes("cerr")) {
    estadoTxt = `🚫 <b>Ahora estamos cerrados</b>\n`;
  } else if (estado.includes("ab")) {
    estadoTxt = `✅ <b>Estamos atendiendo</b>\n`;
  }

  const info = [
    `👋 <b>¡Hola!</b> Bienvenido/a a <b>${escapeHtml(negocio)}</b> 🧀`,
    `✨ ¿Qué te preparo hoy?`,
    "",
    estadoTxt ? estadoTxt.trim() : "",
    direccion ? `📍 ${escapeHtml(direccion)}` : "",
    horarios ? `🕒 ${escapeHtml(horarios)}` : "",
    telefono ? `📲 ${escapeHtml(telefono)}` : "",
    "",
    `👉 Tocá <b>Catálogo</b> para ver productos con foto.`,
    `👉 Mirá <b>Sellos</b> para tus beneficios.`,
    `👉 O <b>Compartí el bot</b> para invitar a alguien 😉`,
  ]
    .filter(Boolean)
    .join("\n");

  // Si hay payload de producto compartido
  if (payload && payload.startsWith("P_")) {
    // saludito corto + producto
    await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }

  // payload "B" solo muestra saludo normal (el link era del bot)
  if (logo && logo.startsWith("http")) {
    await sendPhoto(chat_id, logo, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  } else {
    await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }
}

// ------------------ Sellos (mostrar tarjeta virtual) ------------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const tarjeta = normalizeUrl(cfg.CARD_URL || cfg.TARJETA_URL || cfg.TARJETA_VIRTUAL || "");
  const n = getStamps(chat_id);

  const txt =
    `🏷️ <b>Tu tarjeta de sellos</b>\n\n` +
    `Sellos acumulados: <b>${n}</b>\n\n` +
    `📣 Tip: compartí una promo o el bot para invitar a alguien.\n` +
    `✅ Los sellos “reales” se suman con compras (y luego conectamos el tracking de referidos).`;

  if (tarjeta && tarjeta.startsWith("http")) {
    return sendPhoto(chat_id, tarjeta, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }
  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ------------------ Catálogo / Carrusel ------------------
async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboardClean();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return { messageId: msg?.result?.message_id || null, isPhoto: true };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "Catálogo");
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: productNavKeyboardClean() });
  } else {
    await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: productNavKeyboardClean(),
    });
  }
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

  const state = {
    mode: "CATALOG",
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
    shareMode: false,
  };

  const created = await showProductCarousel(chat_id, list, 0, label);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

// ------------------ Compartir producto (submenú limpio, sin ensuciar chat) ------------------
async function openShareMenu(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;

  st.shareMode = true;
  userState.set(chat_id, st);

  // Cambiamos SOLO los botones del mensaje (no mandamos mensajes nuevos)
  return editMessageReplyMarkup(chat_id, st.messageId, shareOptionsKeyboard());
}

async function closeShareMenu(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;

  st.shareMode = false;
  userState.set(chat_id, st);

  return editMessageReplyMarkup(chat_id, st.messageId, productNavKeyboardClean());
}

async function handleShareOption(chat_id, kind) {
  const st = userState.get(chat_id);
  const item = st?.list?.[st?.index];
  if (!item) return;

  const text = shareTextForProduct(item);
  const links = shareLinksForText(text);

  // Enviar 1 solo mensaje con 2 botones: Abrir app + Abrir bot
  // (esto no ensucia porque es 1 mensaje por compartir)
  if (kind === "WA") {
    return sendMessage(chat_id, `📣 Compartir por WhatsApp:\n\n${text}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Abrir WhatsApp", url: links.wa }],
          [{ text: "🧀 Abrir bot", url: botStartLink() }],
        ],
      },
    });
  }
  if (kind === "TG") {
    return sendMessage(chat_id, `✈️ Compartir por Telegram:\n\n${text}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Compartir en Telegram", url: links.tg }],
          [{ text: "🧀 Abrir bot", url: botStartLink() }],
        ],
      },
    });
  }
  if (kind === "EM") {
    return sendMessage(chat_id, `✉️ Compartir por Email:\n\n${text}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Abrir Email", url: links.em }],
          [{ text: "🧀 Abrir bot", url: botStartLink() }],
        ],
      },
    });
  }
}

// ------------------ Bot share (menú principal) ------------------
async function handleShareBot(chat_id) {
  const text = shareTextForBot();
  const links = shareLinksForText(text);

  // Opción: sumar 1 sello SOLO por compartir (si querés desactivarlo, comentá la línea)
  // addStamp(chat_id, 1);

  return sendMessage(chat_id, `📣 <b>Compartir el bot</b>\n\n${escapeHtml(text)}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📣 WhatsApp", url: links.wa },
          { text: "✈️ Telegram", url: links.tg },
        ],
        [{ text: "✉️ Email", url: links.em }],
      ],
    },
  });
}

// ------------------ Producto compartido al receptor (cuando entra por link) ------------------
async function showSharedProduct(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => (x.codigo || "").toLowerCase() === (code || "").toLowerCase());

  if (!item) {
    return sendMessage(chat_id, "🧀 Te compartieron un producto, pero no lo encontré en el catálogo. Probá entrando a Catálogo.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const caption =
    `🎁 <b>Te compartieron este producto</b>\n\n` +
    productCaption(item, 1, 1) +
    `\n\n✅ Si querés pedirlo, escribí <b>QUIERO</b>`;

  if (item.imagen && item.imagen.startsWith("http")) {
    return sendPhoto(chat_id, item.imagen, caption, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
          [{ text: "🟢 Quiero este", callback_data: "SHARED_BUY" }],
        ],
      },
    });
  }

  return sendMessage(chat_id, caption, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
        [{ text: "🟢 Quiero este", callback_data: "SHARED_BUY" }],
      ],
    },
  });
}

// ------------------ Callback Handler ------------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  const message_id = cb.message?.message_id;

  if (!chat_id) return;

  // quitar loading
  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id);

  // categorías
  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat === "__ALL__" ? "__ALL__" : cat);
  }

  // carrusel
  if (data === "P:NEXT" || data === "P:PREV") {
    const st = userState.get(chat_id);
    if (!st?.list?.length) return;
    const total = st.list.length;

    if (data === "P:NEXT") st.index = (st.index + 1) % total;
    if (data === "P:PREV") st.index = (st.index - 1 + total) % total;

    st.shareMode = false;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  if (data === "P:BUY") {
    // acá después conectamos carrito + pregunta gramos/unidades
    return sendMessage(chat_id, "🟢 Perfecto. Escribí <b>QUIERO</b> y te pregunto cantidad (unidades o gramos).", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // compartir limpio (submenú)
  if (data === "P:SHARE_MENU") return openShareMenu(chat_id);
  if (data === "SH:BACK") return closeShareMenu(chat_id);
  if (data === "SH:WA") return handleShareOption(chat_id, "WA");
  if (data === "SH:TG") return handleShareOption(chat_id, "TG");
  if (data === "SH:EM") return handleShareOption(chat_id, "EM");

  if (data === "SHARED_BUY") {
    return sendMessage(chat_id, "🟢 Genial. Escribí <b>QUIERO</b> y empezamos el pedido 😉", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // fallback
  if (message_id) {
    // no hacemos nada
    return;
  }
}

// ------------------ Mensajes (reply keyboard) ------------------
async function handleTextMessage(chat_id, text) {
  const t = (text || "").trim();

  // menú principal
  if (t === "/start") return handleStart(chat_id, "");
  if (t.startsWith("/start ")) {
    const payload = t.split(" ")[1] || "";
    return handleStart(chat_id, payload);
  }

  if (t === "🛍️ Catálogo") return handleCatalogMenu(chat_id);
  if (t === "🏷️ Sellos") return handleSellos(chat_id);
  if (t === "📣 Compartir bot") return handleShareBot(chat_id);

  // carrito placeholder (no rompemos)
  if (t === "🧾 Carrito") {
    return sendMessage(chat_id, "🧾 Carrito: ya lo conectamos en el próximo paso sin ensuciar pantallas.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // intención de compra simple
  if (t.toUpperCase() === "QUIERO") {
    return sendMessage(chat_id, "✅ Dale. Decime:\n• ¿Cuántas <b>unidades</b>?\n• o ¿cuántos <b>gramos</b>?\n\nEj: <b>200g</b> o <b>2</b>", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // fallback amable
  return sendMessage(chat_id, "👋 Estoy acá 😊\nTocá <b>Catálogo</b> para ver productos o <b>Sellos</b> para tus beneficios.", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboardReply(),
  });
}

// ------------------ Routes ------------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO BOT LIVE"));

app.get("/debug", async (req, res) => {
  const cfg = await loadConfig().catch(() => ({}));
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      hasConfigCsvUrl: Boolean(CONFIG_CSV_URL),
      botUsername: BOT_USERNAME || null,
    },
    configKeysSample: Object.keys(cfg).slice(0, 20),
  });
});

// Webhook root "/"
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

  // test Config
  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG cargada. Keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ Error leyendo CONFIG_CSV_URL:", String(e?.message || e));
  }
}

app.listen(PORT, boot);
