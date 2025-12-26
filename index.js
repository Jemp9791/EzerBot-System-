/**
 * EZER_IA_BOT - Telegram bot (Webhook root "/") + Catálogo con carrusel
 * ENV en Render:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL (sin barra final)
 * - SHEET_CSV_URL (CSV de Catalogo)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

const EZERBOT_EMAIL = "ezerbot.assistant@gmail.com";
let BOT_USERNAME = "";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---- Utils: Telegram API ----
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

// ---- CSV parse (simple) ----
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

// ---- Catalog cache ----
let catalogCache = { at: 0, items: [], categories: [] };

function normalizeUrl(u) {
  if (!u) return "";
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
}

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

// ---- State ----
const userState = new Map();

// ---- Helpers ----
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Normaliza texto para detectar botones tipo teclado (con emojis)
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // sin tildes
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // fuera emojis/símbolos → espacio
    .replace(/\s+/g, " ")
    .trim();
}

function makeBotLink() {
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "";
}

function shareText() {
  const botLink = makeBotLink();
  return (
    `📣 <b>Compartí Todo Queso</b>\n\n` +
    `✅ Catálogo con fotos + compra\n` +
    (botLink ? `🔗 Abrir bot: ${botLink}\n\n` : "\n") +
    `📩 ¿Querés este sistema para tu negocio?\n` +
    `Escribinos a: <b>${EZERBOT_EMAIL}</b>`
  );
}

function shareKeyboard() {
  const botLink = makeBotLink() || "https://t.me/";
  const msg = encodeURIComponent(
    `🧀 Mirá el catálogo de Todo Queso y comprá por el bot:\n${botLink}\n\nSi querés este sistema para tu negocio: ${EZERBOT_EMAIL}`
  );
  const subject = encodeURIComponent("Quiero el sistema EzerBot para mi negocio");
  const body = encodeURIComponent(
    `Hola! Me interesa el sistema tipo bot+catálogo+compra.\n\nQuiero más info.\n\nLink del bot: ${botLink}`
  );

  return {
    inline_keyboard: [
      [{ text: "🤖 Abrir bot", url: botLink }],
      [{ text: "📲 Compartir por WhatsApp", url: `https://wa.me/?text=${msg}` }],
      [{ text: "✉️ Pedir el sistema (Email)", url: `mailto:${EZERBOT_EMAIL}?subject=${subject}&body=${body}` }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---- Keyboards ----
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [{ text: "📣 Compartir bot", callback_data: "SHARE_BOT" }],
    ],
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT_${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT_${encodeURIComponent(b)}` });
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
  )}\n📌 <i>${pos} de ${total}</i>${desc}`;
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "📣 Compartir bot", callback_data: "SHARE_BOT" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---- Carrusel ----
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return { messageId: msg?.result?.message_id || null };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index);
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  } else {
    await tgCall("editMessageCaption", {
      chat_id,
      message_id: messageId,
      caption: caption + "\n\n⚠️ (Este producto no tiene imagen válida)",
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

// ---- Handlers ----
async function handleStart(chat_id) {
  await sendMessage(chat_id, "🧀 <b>Todo Queso</b>\n\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleShareBot(chat_id) {
  return sendMessage(chat_id, shareText(), { parse_mode: "HTML", reply_markup: shareKeyboard() });
}

async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  await sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();
  let list = items;

  if (category && category !== "__ALL__") {
    list = items.filter((x) => x.categoria === category);
  }

  if (!list.length) {
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const state = { mode: "CATALOG", category, list, index: 0, messageId: null };
  const created = await showProductCarousel(chat_id, list, 0);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);
  if (data === "SHARE_BOT") return handleShareBot(chat_id);

  if (data.startsWith("CAT_")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }
  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");

  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;

    const total = state.list.length;
    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }
}

// ---- Web routes ----
app.get("/", (req, res) => res.status(200).send("OK - EZER_IA_BOT LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    info: "Server vivo. Bot responde por POST / (webhook).",
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      botUsername: BOT_USERNAME || null,
    },
  });
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const textRaw = update.message.text || "";
      const t = normText(textRaw);

      // /start con o sin payload
      if (t.startsWith("start") || String(textRaw).trim().startsWith("/start")) return handleStart(chat_id);

      // ✅ CLAVE: cualquier variante que contenga "compartir"
      if (t.includes("compartir")) return handleShareBot(chat_id);
      if (String(textRaw).trim().startsWith("/share")) return handleShareBot(chat_id);

      // default
      return handleStart(chat_id);
    }

    if (update.callback_query) return handleCallback(update.callback_query);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---- Start server ----
async function initBotInfo() {
  try {
    const me = await tgCall("getMe", {});
    if (me?.ok && me?.result?.username) {
      BOT_USERNAME = me.result.username;
      console.log("✅ Nombre de usuario del bot:", BOT_USERNAME);
    }
  } catch (e) {
    console.log("⚠️ getMe error:", e?.message || e);
  }
}

app.listen(PORT, async () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
  await initBotInfo();
}); 
