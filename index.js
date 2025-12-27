/**
 * Todo_Queso - Carrusel + Compartir limpio + "Quiero este" con cantidad (sin ensuciar chat)
 * ENV:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL (sin / final)  ej: https://ezerbot-system.onrender.com
 * - SHEET_CSV_URL (CSV del Catalogo)
 * - BOT_USERNAME (ej: Ezer_IA_Bot)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");

if (!TOKEN) console.error("❌ Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("❌ Falta ENV SHEET_CSV_URL");
if (!BOT_USERNAME) console.error("❌ Falta ENV BOT_USERNAME");

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
async function editMessageCaption(chat_id, message_id, caption, reply_markup) {
  return tgCall("editMessageCaption", {
    chat_id,
    message_id,
    caption,
    parse_mode: "HTML",
    reply_markup,
  });
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeUrl(u) {
  if (!u) return "";
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
}

function enc(s) {
  return encodeURIComponent(String(s || ""));
}

// ---------------- Catalog cache ----------------
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

// ---------------- State ----------------
const userState = new Map(); // chatId -> { mode, list, index, messageId, categoryLabel, lastProductCode }
const carts = new Map();     // chatId -> [{codigo,nombre,cantidad,unidad,precio}...]

// ---------------- Keyboards ----------------
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [{ text: "🧾 Carrito", callback_data: "MENU_CARRITO" }],
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
  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${unidadTxt}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ Para pedir: escribí <b>QUIERO</b>`;
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "PROD_PREV" },
        { text: "➡️", callback_data: "PROD_NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "PROD_BUY" }],
      [{ text: "📣 Compartir", callback_data: "PROD_SHARE" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

/**
 * Menú de compartir: NO envía mensajes nuevos.
 * Se muestra editando los botones del mismo mensaje.
 */
function shareMenuKeyboard(shareText, deepLink) {
  const wa = `https://wa.me/?text=${enc(shareText + "\n" + deepLink)}`;
  const tg = `https://t.me/share/url?url=${enc(deepLink)}&text=${enc(shareText)}`;
  const mail = `mailto:?subject=${enc("Todo Queso - Promo / Producto")}&body=${enc(shareText + "\n\n" + deepLink)}`;

  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", url: wa },
        { text: "✈️ Telegram", url: tg },
      ],
      [{ text: "✉️ Email", url: mail }],
      [{ text: "⬅️ Volver", callback_data: "SHARE_BACK" }],
    ],
  };
}

/**
 * Menú de cantidad: sin ensuciar chat
 * - Si el producto es “kg” o “kilo” => gramos
 * - Si es “unidad” u otra cosa => unidades
 */
function qtyKeyboard(isWeight) {
  if (isWeight) {
    return {
      inline_keyboard: [
        [
          { text: "100g", callback_data: "QTY_G_100" },
          { text: "200g", callback_data: "QTY_G_200" },
          { text: "500g", callback_data: "QTY_G_500" },
          { text: "1kg", callback_data: "QTY_G_1000" },
        ],
        [{ text: "⬅️ Volver", callback_data: "BUY_BACK" }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "1", callback_data: "QTY_U_1" },
        { text: "2", callback_data: "QTY_U_2" },
        { text: "3", callback_data: "QTY_U_3" },
        { text: "5", callback_data: "QTY_U_5" },
      ],
      [{ text: "⬅️ Volver", callback_data: "BUY_BACK" }],
    ],
  };
}

// ---------------- Carrusel ----------------
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ Sin imagen válida", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return msg?.result?.message_id || null;
  }
  const msg = await sendPhoto(chat_id, item.imagen, caption, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
  return msg?.result?.message_id || null;
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!messageId) {
    state.messageId = await showProductCarousel(chat_id, list, index);
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  } else {
    await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ Sin imagen válida", kb);
  }
}

// ---------------- Start / Catalog ----------------
async function handleStart(chat_id, startPayload = "") {
  // Si viene deep-link start=P_CODIGO => mostrar ese producto
  if (startPayload && startPayload.startsWith("P_")) {
    const code = startPayload.slice(2);
    const { items } = await loadCatalog();
    const found = items.find((x) => String(x.codigo).trim() === String(code).trim());
    if (found) {
      const state = {
        mode: "CATALOG",
        list: [found],
        index: 0,
        messageId: null,
        categoryLabel: "Compartido",
        lastProductCode: found.codigo,
      };
      state.messageId = await showProductCarousel(chat_id, state.list, 0);
      userState.set(chat_id, state);
      return;
    }
  }

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

  if (category && category !== "__ALL__") list = items.filter((x) => x.categoria === category);

  if (!list.length) {
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const state = {
    mode: "CATALOG",
    list,
    index: 0,
    messageId: null,
    categoryLabel: category === "__ALL__" ? "Todas" : category,
    lastProductCode: list[0]?.codigo,
  };

  state.messageId = await showProductCarousel(chat_id, list, 0);
  userState.set(chat_id, state);
}

// ---------------- Cart helpers ----------------
function addToCart(chat_id, item, qty, unitLabel) {
  const cart = carts.get(chat_id) || [];
  cart.push({
    codigo: item.codigo,
    nombre: item.nombre,
    cantidad: qty,
    unidad: unitLabel,
    precio: item.precio || "",
  });
  carts.set(chat_id, cart);
}

function cartText(chat_id) {
  const cart = carts.get(chat_id) || [];
  if (!cart.length) return "🧾 Carrito vacío.";
  let t = "🧾 <b>Tu carrito</b>\n\n";
  cart.forEach((x, i) => {
    t += `${i + 1}) <b>${escapeHtml(x.nombre)}</b> — ${escapeHtml(x.cantidad)} ${escapeHtml(x.unidad)}\n`;
  });
  t += "\n✅ Para pedir: escribí <b>QUIERO</b>";
  return t;
}

// ---------------- Callbacks ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data.startsWith("CAT_")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }
  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");

  // Carrito
  if (data === "MENU_CARRITO") {
    return sendMessage(chat_id, cartText(chat_id), { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
  }

  // Carrusel nav
  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;

    const total = state.list.length;
    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    state.lastProductCode = state.list[state.index]?.codigo;
    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }

  // BUY flow
  if (data === "PROD_BUY") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item || !state?.messageId) return;

    const unidad = (item.unidad || "").toLowerCase();
    const isWeight = unidad.includes("kg") || unidad.includes("kilo");

    const caption = productCaption(item, state.index + 1, state.list.length) + "\n\n<b>¿Cuánto querés?</b>";
    await editMessageCaption(chat_id, state.messageId, caption, qtyKeyboard(isWeight));
    return;
  }

  if (data === "BUY_BACK") {
    const state = userState.get(chat_id);
    if (!state?.messageId) return;
    const item = state.list[state.index];
    const caption = productCaption(item, state.index + 1, state.list.length);
    await editMessageCaption(chat_id, state.messageId, caption, productNavKeyboard());
    return;
  }

  // Qty selected
  if (data.startsWith("QTY_")) {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item || !state?.messageId) return;

    let qty = 0;
    let unitLabel = "u";

    if (data.startsWith("QTY_G_")) {
      qty = Number(data.replace("QTY_G_", "")) || 0;
      unitLabel = "g";
    } else if (data.startsWith("QTY_U_")) {
      qty = Number(data.replace("QTY_U_", "")) || 0;
      unitLabel = "u";
    }

    if (qty > 0) addToCart(chat_id, item, qty, unitLabel);

    // Volver al carrusel sin mandar mensajes nuevos
    const caption =
      productCaption(item, state.index + 1, state.list.length) +
      `\n\n✅ <b>Agregado al carrito:</b> ${escapeHtml(qty)} ${escapeHtml(unitLabel)}`;

    await editMessageCaption(chat_id, state.messageId, caption, productNavKeyboard());
    return;
  }

  // SHARE flow (limpio)
  if (data === "PROD_SHARE") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item || !state?.messageId) return;

    // Deep-link: el receptor entra y ve el mismo producto (foto + datos)
    const deepLink = `https://t.me/${BOT_USERNAME}?start=${enc("P_" + item.codigo)}`;

    const shareText = `🧀 Todo Queso — Mirá este producto:\n${item.nombre} — $ ${item.precio || "-"} ${item.unidad ? "(" + item.unidad + ")" : ""}\n\nAbrí el bot y pedilo ahí 👇`;

    // NO mandamos mensaje: editamos SOLO botones del mismo mensaje
    await editMessageReplyMarkup(chat_id, state.messageId, shareMenuKeyboard(shareText, deepLink));
    return;
  }

  if (data === "SHARE_BACK") {
    const state = userState.get(chat_id);
    if (!state?.messageId) return;
    await editMessageReplyMarkup(chat_id, state.messageId, productNavKeyboard());
    return;
  }
}

// ---------------- Web routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - Todo_Queso LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
    },
  });
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";

      // /start con payload de deep link
      if (text.startsWith("/start")) {
        const payload = text.split(" ")[1] || "";
        return handleStart(chat_id, payload);
      }

      // simple: si escribe QUIERO => mostrar carrito (sin romper)
      if (text.trim().toUpperCase() === "QUIERO") {
        return sendMessage(chat_id, cartText(chat_id), { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
      }

      return handleStart(chat_id);
    }

    if (update.callback_query) return handleCallback(update.callback_query);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, async () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook URL:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
});
