/**
 * EZER BOT - SOLO: Compartir BOT + Compartir Producto + Carrusel catálogo (book)
 * Webhook: POST /
 * Health:  GET /
 * Debug:   GET /debug
 *
 * ENV requeridas:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL          (ej: https://ezerbot-system.onrender.com)  (sin / final)
 * - SHEET_CSV_URL       (link CSV del sheet Catalogo)
 * - BOT_USERNAME        (ej: Todo_Queso)
 * - SYSTEM_EMAIL        (ej: ezerbot.assistant@gmail.com)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "Todo_Queso";
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("❌ Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("❌ Falta ENV SHEET_CSV_URL");

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

// ---------------- CSV parse simple ----------------
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
    <<<<<<< HEAD
    .replaceAll(">", "&gt;");
}
=======
    .replaceAll(">", "&gt;");
}
>>>>>>> master

// ---------------- Catálogo cache ----------------
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

// ---------------- State por usuario (solo catálogo) ----------------
const userState = new Map(); // chatId -> { list, index, messageId, categoryLabel }

function mainMenu() {
  // Reply Keyboard (botones grandes)
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "📣 Compartir bot" }],
      [{ text: "🏠 Menú" }],
    ],
    resize_keyboard: true,
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
  // ✅ OJO: acá está lo “compartir producto” SIN callback raro.
  // El botón "📤 Compartir producto" es callback y nosotros respondemos con URL buttons (correcto).
  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "📤 Compartir producto", callback_data: "PROD_SHARE" }],
    ],
  };
}

// ---------------- Compartir (la parte clave, sin trabas) ----------------
function botDeepLink() {
  return `https://t.me/${BOT_USERNAME}`;
}

function shareKeyboardWithText(textToShare) {
  const botLink = botDeepLink();
  const txt = encodeURIComponent(textToShare);

  return {
    inline_keyboard: [
      [{ text: "📲 WhatsApp", url: `https://wa.me/?text=${txt}%20${botLink}` }],
      [{ text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${txt}` }],
      [{ text: "📧 Email", url: `mailto:?subject=Todo%20Queso&body=${txt}%20${botLink}` }],
      [{ text: "💼 Quiero este sistema", url: `mailto:${SYSTEM_EMAIL}?subject=Quiero%20EzerBot&body=${encodeURIComponent("Hola, quiero el sistema EzerBot para mi negocio.")}` }],
    ],
  };
}

async function sendShareBot(chat_id) {
  const text = "🧀 Mirá el catálogo de Todo Queso y comprá directo desde el bot:";
  return sendMessage(chat_id, "📣 <b>Compartir bot</b>\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: shareKeyboardWithText(text),
  });
}

async function sendShareProduct(chat_id, item) {
  const price = item.precio ? `$ ${item.precio}` : "";
  const text = `🧀 Promo/Producto: ${item.nombre} ${price}\nCompralo directo acá:`;
  return sendMessage(chat_id, `📤 <b>Compartir producto</b>\n<b>${escapeHtml(item.nombre)}</b>\nElegí una opción:`, {
    parse_mode: "HTML",
    reply_markup: shareKeyboardWithText(text),
  });
}

// ---------------- Catálogo carrusel (book) ----------------
async function showProductCarousel(chat_id, list, index, label) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen válida)", {
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
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "Catálogo");
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  } else {
    await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Sin imagen válida)", { reply_markup: kb });
  }
}

// ---------------- Flujos ----------------
async function handleStart(chat_id) {
  await sendMessage(chat_id, "🧀 <b>Todo Queso</b>\n\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: mainMenu(),
  });
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
  let label = "Todas";

  if (category && category !== "__ALL__") {
    label = category;
    list = items.filter((x) => x.categoria === category);
  }
  if (!list.length) {
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenu() });
    return;
  }

  const state = { list, index: 0, messageId: null, categoryLabel: label };
  const created = await showProductCarousel(chat_id, list, 0, label);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data.startsWith("CAT_")) {
    const cat = decodeURIComponent(data.slice(4));
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

  if (data === "PROD_SHARE") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;
    return sendShareProduct(chat_id, item);
  }
}

// ---------------- Web routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - EZER BOT LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      botUsername: BOT_USERNAME,
      systemEmail: SYSTEM_EMAIL,
    },
  });
});

// Webhook Telegram
app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = (update.message.text || "").trim();

      if (text === "/start" || text.toLowerCase() === "start" || text === "🏠 Menú") {
        return handleStart(chat_id);
      }
      if (text === "📣 Compartir bot") {
        return sendShareBot(chat_id);
      }
      if (text === "🛍️ Catálogo") {
        return handleCatalogMenu(chat_id);
      }

      // fallback
      return handleStart(chat_id);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// Start server
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});
