/**
 * index.js — TODO_QUESO (1 solo script)
 * ✅ Catálogo tipo “book” con carrusel (editMessageMedia)
 * ✅ Botón "📣 Compartir bot" (Reply Keyboard) -> abre menú INLINE con WhatsApp/Telegram/Email
 * ✅ Compartir PRODUCTO (desde el carrusel) con link directo para que la otra persona abra el bot y vea ese producto
 * ✅ NO toca Carrito / Finalizar compra / Sellos (solo responde “se mantiene tu flujo actual”)
 *
 * ENV (Render > Environment):
 * - TELEGRAM_TOKEN   = (tu token)
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com     (sin barra final)
 * - SHEET_CSV_URL    = (CSV público del sheet "Catalogo")
 * - BOT_USERNAME     = Todo_Queso    (SIN @)
 * - SYSTEM_EMAIL     = ezerbot.assistant@gmail.com
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---------- Telegram API helpers ----------
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

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeUrl(u) {
  if (!u) return "";
  // soporta: [url](url) o link directo
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1].trim();
  return u.replace(/^\[|\]$/g, "").trim();
}

// ---------- CSV parse (simple) ----------
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

// ---------- Catalog cache ----------
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

function findProductByCode(code) {
  if (!code) return null;
  const c = String(code).trim();
  return catalogCache.items.find((x) => x.codigo === c) || null;
}

// ---------- State ----------
const userState = new Map(); // chatId -> { mode, categoryLabel, list, index, messageId }

// ---------- Keyboards ----------
function replyMenuKeyboard() {
  // Estos son los botones violetas de abajo (Reply Keyboard).
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🏷️ Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
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
  rows.push([{ text: "🏠 Menú", callback_data: "MENU_HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total, categoryLabel) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = categoryLabel ? `\n📁 <i>${escapeHtml(categoryLabel)}</i>` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${cat}${desc}`;
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "🟢 Quiero este", callback_data: "PROD_ADD" }],
      [{ text: "📣 Compartir este producto", callback_data: "PROD_SHARE" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---------- Share builders ----------
function buildBotShareText() {
  return (
    "🧀 *Todo Queso* — Mirá el catálogo y comprá directo por el bot 👇\n\n" +
    `https://t.me/${BOT_USERNAME}\n\n` +
    "💼 ¿Querés este sistema para tu negocio?\n" +
    `📧 ${SYSTEM_EMAIL}`
  );
}

function buildProductShareText(item) {
  const deep = item?.codigo ? `https://t.me/${BOT_USERNAME}?start=BUY_${encodeURIComponent(item.codigo)}` : `https://t.me/${BOT_USERNAME}`;
  return (
    `🧀 *Todo Queso* — Producto recomendado:\n` +
    `• ${item?.nombre || "Producto"}\n` +
    (item?.precio ? `• Precio: $ ${item.precio}\n` : "") +
    "\n🛒 Abrilo acá para ver y comprar:\n" +
    `${deep}\n\n` +
    "💼 ¿Querés este sistema para tu negocio?\n" +
    `📧 ${SYSTEM_EMAIL}`
  );
}

function buildShareInlineKeyboard(textToShare) {
  const t = encodeURIComponent(textToShare);
  const botUrl = `https://t.me/${BOT_USERNAME}`;
  const botUrlEnc = encodeURIComponent(botUrl);

  return {
    inline_keyboard: [
      [
        { text: "📲 WhatsApp", url: `https://wa.me/?text=${t}` },
        { text: "✈️ Telegram", url: `https://t.me/share/url?url=${botUrlEnc}&text=${t}` },
      ],
      [{ text: "📧 Email", url: `mailto:?subject=Todo%20Queso&body=${t}` }],
      [{ text: "💼 Quiero este sistema", url: `mailto:${SYSTEM_EMAIL}?subject=Quiero%20el%20sistema%20EzerBot` }],
    ],
  };
}

// ---------- Core screens ----------
async function handleStart(chat_id, payload = "") {
  // Si viene deep-link para producto:
  // /start BUY_TQ01  -> mostrar directo ese producto
  const pay = String(payload || "").trim();
  if (pay.startsWith("BUY_")) {
    const code = decodeURIComponent(pay.slice(4));
    await loadCatalog();
    const item = findProductByCode(code);
    if (item) {
      const list = [item];
      const state = { mode: "CATALOG", categoryLabel: "Producto", list, index: 0, messageId: null };
      const created = await showProductCarousel(chat_id, list, 0, "Producto");
      state.messageId = created.messageId;
      userState.set(chat_id, state);
      return;
    }
  }

  await sendMessage(
    chat_id,
    "🧀 <b>Todo Queso</b>\n\nElegí una opción:",
    { parse_mode: "HTML", reply_markup: replyMenuKeyboard() }
  );
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
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: replyMenuKeyboard() });
    return;
  }

  const state = {
    mode: "CATALOG",
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
  };

  const created = await showProductCarousel(chat_id, list, 0, label);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

// ---------- Carrusel ----------
async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, categoryLabel);
  const kb = productNavKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(
      chat_id,
      caption + "\n\n⚠️ (Este producto no tiene imagen válida)",
      { parse_mode: "HTML", reply_markup: kb }
    );
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return { messageId: msg?.result?.message_id || null, isPhoto: true };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId, categoryLabel } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total, categoryLabel);
  const kb = productNavKeyboard();

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, categoryLabel);
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

// ---------- Share actions ----------
async function handleShareBot(chat_id) {
  const text = buildBotShareText();
  const kb = buildShareInlineKeyboard(text);

  await sendMessage(chat_id, "📣 <b>Compartir Todo Queso</b>\nElegí cómo querés compartir:", {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function handleShareProduct(chat_id) {
  const state = userState.get(chat_id);
  const item = state?.list?.[state?.index];
  if (!item) return;

  const text = buildProductShareText(item);
  const kb = buildShareInlineKeyboard(text);

  await sendMessage(chat_id, `📣 <b>Compartir producto</b>\n<b>${escapeHtml(item.nombre)}</b>`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

// ---------- Callback handler ----------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) {
    const cat = decodeURIComponent(data.slice(4));
    return handleCategory(chat_id, cat);
  }

  // Carrusel nav
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
    return handleShareProduct(chat_id);
  }

  if (data === "PROD_ADD") {
    // NO conectamos carrito acá para no romper nada: solo confirmación.
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;
    return sendMessage(chat_id, `✅ Listo. Elegiste: <b>${escapeHtml(item.nombre)}</b>\n\n(El carrito/checkout se mantiene como lo tenías).`, {
      parse_mode: "HTML",
      reply_markup: replyMenuKeyboard(),
    });
  }
}

// ---------- Message handler (Reply Keyboard) ----------
async function handleText(chat_id, text) {
  const t = String(text || "").trim();

  // /start con payload
  if (t.startsWith("/start")) {
    const parts = t.split(" ");
    const payload = parts[1] || "";
    return handleStart(chat_id, payload);
  }

  if (t === "🛍️ Catálogo" || t.toLowerCase().includes("catálogo") || t.toLowerCase().includes("catalogo")) {
    return handleCatalogMenu(chat_id);
  }

  if (t === "📣 Compartir bot" || t.toLowerCase().includes("compartir bot") || t === "📣 Compartir") {
    return handleShareBot(chat_id);
  }

  // Estos se mantienen: NO los tocamos
  if (t === "🧾 Carrito" || t.toLowerCase().includes("carrito")) {
    return sendMessage(chat_id, "✅ (Este botón se mantiene para tu flujo actual. No lo modifico acá.)", {
      reply_markup: replyMenuKeyboard(),
    });
  }
  if (t === "✅ Finalizar compra" || t.toLowerCase().includes("finalizar")) {
    return sendMessage(chat_id, "✅ (Este botón se mantiene para tu flujo actual. No lo modifico acá.)", {
      reply_markup: replyMenuKeyboard(),
    });
  }
  if (t === "🏷️ Tarjeta de sellos" || t.toLowerCase().includes("sellos")) {
    return sendMessage(chat_id, "✅ (Este botón se mantiene para tu flujo actual. No lo modifico acá.)", {
      reply_markup: replyMenuKeyboard(),
    });
  }

  // fallback
  return handleStart(chat_id);
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("OK - TODO_QUESO LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      botUsername: BOT_USERNAME || null,
      systemEmail: SYSTEM_EMAIL || null,
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
      return handleText(chat_id, text);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ Webhook debe ser:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
  console.log("✅ BOT_USERNAME:", BOT_USERNAME ? BOT_USERNAME : "(vacío)");
});
