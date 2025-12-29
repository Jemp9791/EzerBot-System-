/**
 * TODO_QUESO — Telegram Bot (Render)
 * - Catálogo carrusel con IMÁGENES (robusto) + categorías
 * - No ensucia chat: navega con editMessageMedia / editMessageCaption
 * - Compartir producto / compartir bot (SIN EMAIL)
 * - Ayuda + saludo humano desde Config
 *
 * ENV:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL (sin barra final)  ej: https://tu-app.onrender.com
 * - SHEET_CSV_URL   (CSV publicado de la hoja "Catalogo")
 * - CONFIG_CSV_URL  (CSV publicado de la hoja "Config")
 * - BOT_USERNAME (opcional, sin @) si no está se detecta con getMe
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
async function editMessageText(chat_id, message_id, text, extra = {}) {
  return tgCall("editMessageText", { chat_id, message_id, text, ...extra });
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

// ------------------ Utils ------------------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function urlEncode(s) {
  return encodeURIComponent(String(s || ""));
}

// Normaliza links (Drive, HYPERLINK, (url), etc.)
function normalizeUrl(u) {
  const t = String(u || "").trim();
  if (!t) return "";

  // =HYPERLINK("url","texto")
  const m1 = t.match(/HYPERLINK\("([^"]+)"/i);
  if (m1?.[1]) return normalizeUrl(m1[1]);

  // (https://...)
  const m2 = t.match(/\((https?:\/\/[^)]+)\)/);
  if (m2?.[1]) return normalizeUrl(m2[1]);

  // limpiar corchetes
  const cleaned = t.replace(/^\[|\]$/g, "").trim();

  // convertir Drive a link directo
  return driveToDirect(cleaned);
}

function driveToDirect(url) {
  const u = String(url || "").trim();
  if (!u) return "";

  // file/d/FILEID/
  const mA = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (mA?.[1]) return `https://drive.google.com/uc?export=view&id=${mA[1]}`;

  // open?id=FILEID
  const mB = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (mB?.[1] && u.includes("drive.google.com")) {
    return `https://drive.google.com/uc?export=view&id=${mB[1]}`;
  }

  return u;
}

// ------------------ Robust image validation (con cache) ------------------
const imageOkCache = new Map(); // url -> { ok:boolean, at:number }
async function isImageUrl(url) {
  const u = String(url || "").trim();
  if (!u || !u.startsWith("http")) return false;

  const cached = imageOkCache.get(u);
  const now = Date.now();
  if (cached && now - cached.at < 60 * 60 * 1000) return cached.ok; // 1h cache

  // 1) HEAD
  try {
    const r = await fetch(u, { method: "HEAD" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ok = ct.startsWith("image/");
    imageOkCache.set(u, { ok, at: now });
    if (ok) return true;
  } catch {}

  // 2) GET (rango corto)
  try {
    const r = await fetch(u, {
      method: "GET",
      headers: { Range: "bytes=0-1024" },
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ok = ct.startsWith("image/");
    imageOkCache.set(u, { ok, at: now });
    return ok;
  } catch {
    imageOkCache.set(u, { ok: false, at: now });
    return false;
  }
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

// ------------------ Sellos (memoria simple, para no romper) ------------------
const stamps = new Map(); // chatId -> number
function addStamp(chatId, n = 1) {
  const cur = stamps.get(chatId) || 0;
  stamps.set(chatId, cur + n);
}
function getStamps(chatId) {
  return stamps.get(chatId) || 0;
}

// ------------------ Estado carrusel ------------------
const userState = new Map(); // chatId -> { mode, categoryLabel, list, index, messageId, isPhoto, shareMode }

// ------------------ UI (teclados) ------------------
function mainMenuKeyboardReply() {
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

function productCaption(item, pos, total, label = "") {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = label ? `\n📂 <i>${escapeHtml(label)}</i>` : "";
  return (
    `🧀 <b>${escapeHtml(item.nombre)}</b>\n` +
    `💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(unidadTxt)}\n` +
    `📌 <i>${pos} de ${total}</i>${cat}${desc}\n\n` +
    `✅ <b>Para pedir:</b> tocá <b>🟢 Quiero éste</b>`
  );
}

function productNavKeyboardClean() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "P:PREV" },
        { text: "➡️ Siguiente", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero éste", callback_data: "P:BUY" }],
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
  };
}

function shareTextForProduct(item) {
  const payload = `P_${(item.codigo || "").slice(0, 30)}`;
  const link = botStartLink(payload);
  return (
    `🧀 Todo Queso — Mirá esto:\n` +
    `${item.nombre}\n` +
    `💰 $ ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrí el bot y pedilo acá 👉 ${link}`
  );
}

function shareTextForBot() {
  const link = botStartLink("B");
  return `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá 👉 ${link}`;
}

// ------------------ Texto humano (saludo / ayuda) ------------------
async function handleStart(chat_id, payload = "") {
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();

  const negocio = cfg.BUSINESS_NAME || cfg.NOMBRE_NEGOCIO || "Todo Queso";
  const direccion = cfg.ADDRESS || cfg.DIRECCION || "";
  const horarios = cfg.HOURS || cfg.HORARIOS || "";
  const telefono = cfg.WHATSAPP || cfg.TELEFONO || "";
  const insta = cfg.INSTAGRAM || cfg.IG || "";
  const logo = normalizeUrl(cfg.LOGO_URL || cfg.LOGO || "");

  const estado = (cfg.STATUS || cfg.ESTADO || "").toLowerCase();
  const vaca = (cfg.VACACIONES || "").toLowerCase() === "si";
  const desde = cfg.CERRADO_DESDE || cfg.VACACIONES_DESDE || "";
  const hasta = cfg.CERRADO_HASTA || cfg.VACACIONES_HASTA || "";

  let estadoTxt = "";
  if (vaca || estado.includes("vac")) {
    estadoTxt = `🚫 <b>Hoy estamos cerrados</b>${desde || hasta ? ` (desde ${escapeHtml(desde)} hasta ${escapeHtml(hasta)})` : ""}`;
  } else if (estado.includes("cerr")) {
    estadoTxt = `🚫 <b>Ahora estamos cerrados</b>`;
  } else if (estado.includes("ab")) {
    estadoTxt = `✅ <b>Estamos atendiendo</b>`;
  }

  const info = [
    `👋 <b>¡Hola!</b> Soy el bot de <b>${escapeHtml(negocio)}</b> 🧀`,
    `Qué bueno verte por acá 😊`,
    "",
    estadoTxt,
    direccion ? `📍 ${escapeHtml(direccion)}` : "",
    horarios ? `🕒 ${escapeHtml(horarios)}` : "",
    telefono ? `📲 ${escapeHtml(telefono)}` : "",
    insta ? `📸 ${escapeHtml(insta)}` : "",
    "",
    `👉 Tocá <b>🛍️ Catálogo</b> para ver productos con foto.`,
    `👉 Tocá <b>🏷️ Sellos</b> para ver tus beneficios.`,
    `👉 Si necesitás una mano, tocá <b>🆘 Ayuda</b>.`,
  ]
    .filter(Boolean)
    .join("\n");

  // Si entra por link de producto
  if (payload && payload.startsWith("P_")) {
    await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }

  // Link del bot (payload B): saludo normal
  if (logo && logo.startsWith("http")) {
    await sendPhoto(chat_id, logo, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  } else {
    await sendMessage(chat_id, info, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }
}

async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const telefono = cfg.WHATSAPP || cfg.TELEFONO || "";
  const direccion = cfg.ADDRESS || cfg.DIRECCION || "";
  const horarios = cfg.HOURS || cfg.HORARIOS || "";

  const txt =
    `🆘 <b>Ayuda</b>\n\n` +
    `• Para ver productos con foto: tocá <b>🛍️ Catálogo</b>\n` +
    `• Para avanzar/volver: <b>Anterior / Siguiente</b>\n` +
    `• Para pedir: tocá <b>🟢 Quiero éste</b> y te guiamos\n\n` +
    (telefono ? `📲 Si querés hablar con una persona del local: <b>${escapeHtml(telefono)}</b>\n` : "") +
    (direccion ? `📍 Dirección: ${escapeHtml(direccion)}\n` : "") +
    (horarios ? `🕒 Horarios: ${escapeHtml(horarios)}\n` : "") +
    `\n😊 Estoy acá para ayudarte.`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ------------------ Sellos ------------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const tarjeta = normalizeUrl(cfg.CARD_URL || cfg.TARJETA_URL || cfg.TARJETA_VIRTUAL || "");
  const n = getStamps(chat_id);

  const txt =
    `🏷️ <b>Tu tarjeta de sellos</b>\n\n` +
    `Sellos acumulados: <b>${n}</b>\n\n` +
    `👉 Los sellos se suman con compras (esto queda conectado al finalizar compra).`;

  if (tarjeta && tarjeta.startsWith("http") && (await isImageUrl(tarjeta))) {
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

async function showProductCarousel(chat_id, state) {
  const { list, index, categoryLabel } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, categoryLabel);
  const kb = productNavKeyboardClean();

  const img = item.imagen;
  const okImg = img && img.startsWith("http") && (await isImageUrl(img));

  if (okImg) {
    const msg = await sendPhoto(chat_id, img, caption, { parse_mode: "HTML", reply_markup: kb });
    state.messageId = msg?.result?.message_id || null;
    state.isPhoto = true;
    userState.set(chat_id, state);
    return;
  }

  const msg = await sendMessage(
    chat_id,
    caption + `\n\n⚠️ <i>Este producto no tiene imagen válida.</i>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
  state.messageId = msg?.result?.message_id || null;
  state.isPhoto = false;
  userState.set(chat_id, state);
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId, categoryLabel } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, categoryLabel);
  const kb = productNavKeyboardClean();

  const img = item.imagen;
  const okImg = img && img.startsWith("http") && (await isImageUrl(img));

  // si no hay messageId, crear
  if (!messageId) return showProductCarousel(chat_id, state);

  // Caso 1: mensaje actual es foto y el nuevo item tiene imagen -> edit media
  if (state.isPhoto && okImg) {
    await editMessageMedia(chat_id, messageId, img, caption, { reply_markup: kb });
    state.isPhoto = true;
    userState.set(chat_id, state);
    return;
  }

  // Caso 2: mensaje actual es foto pero nuevo item NO tiene imagen -> editar caption (mantiene foto anterior, no ideal)
  // Para evitar confusión, reemplazamos por texto editando caption + aviso y dejamos los botones.
  if (state.isPhoto && !okImg) {
    await editMessageCaption(chat_id, messageId, caption + `\n\n⚠️ <i>Este producto no tiene imagen válida.</i>`, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    state.isPhoto = true;
    userState.set(chat_id, state);
    return;
  }

  // Caso 3: mensaje actual es texto y nuevo item tiene imagen -> no se puede convertir texto->foto por edición
  // En este caso, mandamos UN solo mensaje nuevo (solo la primera vez) y seguimos editando ese.
  if (!state.isPhoto && okImg) {
    await showProductCarousel(chat_id, state);
    return;
  }

  // Caso 4: texto -> texto
  await editMessageText(chat_id, messageId, caption + `\n\n⚠️ <i>Este producto no tiene imagen válida.</i>`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
  state.isPhoto = false;
  userState.set(chat_id, state);
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

  // Si ya hay carrusel activo, lo reciclamos (no ensucia)
  const prev = userState.get(chat_id);
  const state = {
    mode: "CATALOG",
    categoryLabel: label,
    list,
    index: 0,
    messageId: prev?.messageId || null,
    isPhoto: prev?.isPhoto || false,
    shareMode: false,
  };

  userState.set(chat_id, state);
  return updateCarousel(chat_id, state);
}

// ------------------ Compartir producto (submenú) ------------------
async function openShareMenu(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;
  st.shareMode = true;
  userState.set(chat_id, st);
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

  if (kind === "WA") {
    return sendMessage(chat_id, `📣 Compartir por WhatsApp:\n\n${text}`, {
      reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: links.wa }]] },
    });
  }
  if (kind === "TG") {
    return sendMessage(chat_id, `✈️ Compartir por Telegram:\n\n${text}`, {
      reply_markup: { inline_keyboard: [[{ text: "Compartir en Telegram", url: links.tg }]] },
    });
  }
}

// ------------------ Compartir bot ------------------
async function handleShareBot(chat_id) {
  const text = shareTextForBot();
  const links = shareLinksForText(text);

  return sendMessage(chat_id, `📣 <b>Compartir el bot</b>\n\n${escapeHtml(text)}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📣 WhatsApp", url: links.wa },
          { text: "✈️ Telegram", url: links.tg },
        ],
      ],
    },
  });
}

// ------------------ Producto compartido al receptor ------------------
async function showSharedProduct(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => (x.codigo || "").toLowerCase() === (code || "").toLowerCase());

  if (!item) {
    return sendMessage(
      chat_id,
      "🧀 Te compartieron un producto, pero no lo encontré. Tocá 🛍️ Catálogo para verlo completo.",
      { reply_markup: mainMenuKeyboardReply() }
    );
  }

  const caption =
    `🎁 <b>Te compartieron este producto</b>\n\n` +
    productCaption(item, 1, 1, "") +
    `\n\n✅ Si querés pedirlo, tocá <b>🟢 Quiero éste</b>`;

  const img = item.imagen;
  const okImg = img && img.startsWith("http") && (await isImageUrl(img));

  if (okImg) {
    return sendPhoto(chat_id, img, caption, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }]],
      },
    });
  }

  return sendMessage(chat_id, caption + `\n\n⚠️ <i>Sin imagen válida.</i>`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }]],
    },
  });
}

// ------------------ Callback Handler ------------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  const message_id = cb.message?.message_id;

  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id);

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
    // (no rompemos nada) — solo guiamos
    // Podés sumar sello acá cuando conectemos “finalizar compra”
    return sendMessage(
      chat_id,
      "🟢 Perfecto 😊\nDecime la cantidad así lo preparo:\n• Ej: <b>200g</b>\n• o <b>2</b> (unidades)",
      { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
    );
  }

  // compartir (submenú)
  if (data === "P:SHARE_MENU") return openShareMenu(chat_id);
  if (data === "SH:BACK") return closeShareMenu(chat_id);
  if (data === "SH:WA") return handleShareOption(chat_id, "WA");
  if (data === "SH:TG") return handleShareOption(chat_id, "TG");

  if (message_id) return;
}

// ------------------ Mensajes (reply keyboard) ------------------
async function handleTextMessage(chat_id, text) {
  const t = (text || "").trim();

  if (t === "/start") return handleStart(chat_id, "");
  if (t.startsWith("/start ")) {
    const payload = t.split(" ")[1] || "";
    return handleStart(chat_id, payload);
  }

  if (t === "🛍️ Catálogo") return handleCatalogMenu(chat_id);
  if (t === "🏷️ Sellos") return handleSellos(chat_id);
  if (t === "📣 Compartir bot") return handleShareBot(chat_id);
  if (t === "🆘 Ayuda") return handleHelp(chat_id);

  if (t === "🧾 Carrito") {
    return sendMessage(chat_id, "🧾 Carrito: lo dejamos preparado para conectarlo sin ensuciar pantallas 😉", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // Respuesta a “cantidad”
  const isQty = /^[0-9]+(\s?)(g|gr|gramos|kg)?$/i.test(t);
  if (isQty) {
    // (placeholder) acá después conectamos carrito y cálculo real
    // addStamp(chat_id, 1); // si querés sumar sello por cada compra confirmada (cuando esté el checkout real)
    return sendMessage(chat_id, `✅ Listo 😊\nAnoté: <b>${escapeHtml(t)}</b>\n\nAhora tocá 🛍️ Catálogo para seguir agregando o escribime otra cantidad.`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  return sendMessage(
    chat_id,
    "👋 Estoy acá 😊\nTocá <b>🛍️ Catálogo</b> para ver productos con foto o <b>🆘 Ayuda</b> si necesitás una mano.",
    { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
  );
}

// ------------------ Routes ------------------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO BOT LIVE"));

app.get("/debug", async (req, res) => {
  const cfg = await loadConfig().catch(() => ({}));
  const cat = await loadCatalog().catch(() => ({ items: [], categories: [] }));
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      hasConfigCsvUrl: Boolean(CONFIG_CSV_URL),
      botUsername: BOT_USERNAME || null,
    },
    configKeysSample: Object.keys(cfg).slice(0, 30),
    catalogSample: {
      items: cat.items.slice(0, 3),
      categories: cat.categories.slice(0, 10),
    },
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

  // test Config/Catálogo
  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG cargada. Keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ Error leyendo CONFIG_CSV_URL:", String(e?.message || e));
  }
  try {
    const cat = await loadCatalog();
    console.log("✅ CATÁLOGO cargado. Items:", cat.items.length, "Categorías:", cat.categories.length);
  } catch (e) {
    console.log("❌ Error leyendo SHEET_CSV_URL:", String(e?.message || e));
  }
}

app.listen(PORT, boot);
