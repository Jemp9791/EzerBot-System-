/**
 * TODO_QUESO BOT - Carrusel + Compartir Bot + Compartir Producto (deep link)
 * Webhook: POST "/" (root)
 *
 * ENV en Render:
 * - TELEGRAM_TOKEN = 8130447159:....
 * - PUBLIC_URL     = https://tu-servicio.onrender.com     (sin / final)
 * - SHEET_CSV_URL  = CSV export del sheet "Catalogo"
 * - BOT_USERNAME   = Todo_Queso   (SIN @)
 * - SYSTEM_EMAIL   = ezerbot.assistant@gmail.com
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();
const SYSTEM_EMAIL = (process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com").trim();

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME (sin @)");

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

// ---- Helpers ----
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function normalizeUrl(u) {
  if (!u) return "";
  // si viene como [url](url)
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1].trim();
  return String(u).trim();
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

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache;

  const res = await fetch(SHEET_CSV_URL);
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

// ---- State (por usuario) ----
const userState = new Map(); // chatId -> { mode, categoryLabel, list, index, messageId }

// ---- Menús ----
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [{ text: "📣 Compartir bot", callback_data: "MENU_SHARE_BOT" }],
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

function shareBotKeyboard() {
  const botLink = `https://t.me/${BOT_USERNAME}`;
  const waText = encodeURIComponent(`🧀 Mirá el bot de pedidos de Todo Queso:\n${botLink}\n\n¿Querés uno así para tu negocio? Escribí a: ${SYSTEM_EMAIL}`);
  const emailSubject = encodeURIComponent("Quiero el sistema EzerBot para mi negocio");
  const emailBody = encodeURIComponent(`Hola! Vi el bot ${botLink} y quiero implementar EzerBot.\n\nMi negocio es:\nMi ciudad es:\nMi WhatsApp es:\n\nGracias!`);

  return {
    inline_keyboard: [
      [{ text: "📲 Compartir por WhatsApp", url: `https://wa.me/?text=${waText}` }],
      [{ text: "✈️ Compartir por Telegram", url: botLink }],
      [{ text: "📧 Pedir el sistema por Email", url: `mailto:${SYSTEM_EMAIL}?subject=${emailSubject}&body=${emailBody}` }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---- Producto: caption + teclado ----
function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${unidadTxt}\n📌 <i>${pos} de ${total}</i>${desc}`;
}

function productDeepLink(item) {
  // abre chat con bot y le manda /p CODIGO
  const code = encodeURIComponent(item.codigo || "");
  return `https://t.me/${BOT_USERNAME}?start=p_${code}`;
}

function productNavKeyboard(state) {
  const { list, index } = state;
  const item = list[index];
  const deepLink = productDeepLink(item);
  const shareText = encodeURIComponent(`🧀 Mirá este producto en Todo Queso:\n${deepLink}`);
  const waShare = `https://wa.me/?text=${shareText}`;

  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "📲 Compartir este producto", url: waShare }],
      [{ text: "🧀 Abrir en el bot", url: deepLink }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---- Carrusel: enviar 1 vez y luego editar ----
async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard({ list, index, categoryLabel, messageId: null });

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, {
    parse_mode: "HTML",
    reply_markup: kb,
  });

  return { messageId: msg?.result?.message_id || null, isPhoto: true };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard(state);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "Catálogo");
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
      caption: caption + "\n\n⚠️ (Sin imagen válida)",
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
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const state = {
    mode: "CATALOG",
    category: category,
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
  };

  const created = await showProductCarousel(chat_id, list, 0, label);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

async function showProductByCode(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "").trim() === String(code || "").trim());
  if (!item) return sendMessage(chat_id, "⚠️ No encontré ese producto.", { reply_markup: mainMenuKeyboard() });

  const list = [item];
  const state = { mode: "ONE", categoryLabel: "Producto", list, index: 0, messageId: null };
  const created = await showProductCarousel(chat_id, list, 0, "Producto");
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

async function handleShareBot(chat_id) {
  await sendMessage(
    chat_id,
    "📣 <b>Compartir Todo Queso</b>\n\nPodés compartir el bot o pedir el sistema para tu negocio:",
    { parse_mode: "HTML", reply_markup: shareBotKeyboard() }
  );
}

async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);
  if (data === "MENU_SHARE_BOT") return handleShareBot(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }

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

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = (update.message.text || "").trim();

      // Deep link /start p_CODE
      if (text.startsWith("/start")) {
        const parts = text.split(" ").map((x) => x.trim()).filter(Boolean);
        const param = parts[1] || "";

        if (param.startsWith("p_")) {
          const code = decodeURIComponent(param.slice(2));
          return showProductByCode(chat_id, code);
        }
        return handleStart(chat_id);
      }

      // también permitimos /p CODIGO
      if (text.startsWith("/p ")) {
        const code = text.slice(3).trim();
        return showProductByCode(chat_id, code);
      }

      return handleStart(chat_id);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
});
