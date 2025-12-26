/**
 * EZER_IA_BOT - Telegram bot (Webhook root "/") + Catálogo con carrusel (editMessageMedia)
 * Requisitos (ENV en Render):
 * - TELEGRAM_TOKEN   = 8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA
 * - PUBLIC_URL       = https://TU-SERVICIO.onrender.com   (sin barra final)
 * - SHEET_CSV_URL    = link CSV del sheet "Catalogo" (ver más abajo)
 *
 * Start command: /start
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

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
  if (!data?.ok) {
    console.error("Telegram API error:", method, data);
  }
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

// ---- CSV parse (simple) ----
function parseCSV(text) {
  // CSV básico con comillas
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
      // saltar \r\n
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
let catalogCache = {
  at: 0,
  items: [],
  categories: [],
};

function normalizeUrl(u) {
  if (!u) return "";
  // si viene en markdown [url](url) o con corchetes, limpiamos
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache; // 1 min cache

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
    PRECIOPORKILO: idx("PRECIOPORKILO"),
    CODIGOBARRAS: idx("CODIGOBARRAS"),
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
      codigo: (row[I.CODIGO] || "").trim(),
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

// ---- State (por usuario) ----
const userState = new Map(); // key: chatId -> { mode, category, list, index, messageId }

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [{ text: "🧾 Carrito", callback_data: "MENU_CARRITO" }],
      [{ text: "🏷️ Tarjeta de sellos", callback_data: "MENU_SELLOS" }],
    ],
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  // 2 por fila
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
  // Nota: usamos HTML para negrita
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}`;
}

function productNavKeyboard(categoryLabel, index, total) {
  const prev = { text: "⬅️ Anterior", callback_data: "PROD_PREV" };
  const next = { text: "➡️ Siguiente", callback_data: "PROD_NEXT" };
  const cat = { text: "📁 Categorías", callback_data: "MENU_CATALOGO" };

  return {
    inline_keyboard: [
      [prev, next],
      [{ text: "🟢 Quiero este", callback_data: "PROD_ADD" }],
      [cat, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---- Carrusel: enviar 1 vez y luego editar ----
async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard(categoryLabel, index, total);

  // Si no hay imagen válida, igual mandamos mensaje (pero sin foto)
  // Peeero como vos querés sí o sí imágenes, acá hacemos fallback a sendMessage con aviso.
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
  const kb = productNavKeyboard(state.categoryLabel || "Catálogo", index, total);

  // Si ya existe messageId, editamos (NO mandamos mensajes nuevos)
  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, state.categoryLabel || "Catálogo");
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    // Editar foto + caption
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  } else {
    // Si no hay imagen, al menos editamos botones y texto (dejando la última imagen)
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
  await sendMessage(
    chat_id,
    "🧀 <b>Todo Queso</b>\n\nElegí una opción:",
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
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

  // Enviamos 1 sola vez (foto con inline) y luego siempre editamos
  const created = await showProductCarousel(chat_id, list, 0, label);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  // quitar “loading…” del botón
  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data.startsWith("CAT_")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }
  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");

  // Navegación carrusel
  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;

    const total = state.list.length;
    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }

  if (data === "PROD_ADD") {
    // Por ahora: solo confirmación. (No tocamos carrito todavía.)
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;
    return sendMessage(chat_id, `✅ Agregado (demo): ${item.nombre}\n\n(Después conectamos carrito real sin romper lo que funciona)`, {
      reply_markup: { inline_keyboard: [[{ text: "📚 Seguir viendo", callback_data: "MENU_CATALOGO" }]] },
    });
  }

  // placeholders (no tocamos lo que funciona de tu sistema todavía)
  if (data === "MENU_CARRITO") {
    return sendMessage(chat_id, "🧾 Carrito (demo): lo conectamos después. Ahora estamos dejando el carrusel perfecto.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
  if (data === "MENU_SELLOS") {
    return sendMessage(chat_id, "🏷️ Tarjeta de sellos (demo): lo conectamos después. Ahora el foco es carrusel.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
}

// ---- Web routes ----
app.get("/", (req, res) => res.status(200).send("OK - EZER_IA_BOT LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    info: "Si ves esto, el server está vivo. El bot responde por POST / (webhook).",
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
    },
  });
});

app.post("/", async (req, res) => {
  // Telegram necesita 200 rápido
  res.sendStatus(200);

  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";

      if (text === "/start" || text === "start") {
        return handleStart(chat_id);
      }

      
      // si escribe algo, lo llevamos al menú (simple)
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
