/**
 * EZER_IA_BOT - Telegram bot (Webhook "/")
 * ENV (Render) — USAMOS LAS QUE YA TENÉS:
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL
 * - SHEET_CSV_URL
 * - BOT_USERNAME        (opcional: si no está, usa getMe)
 * - SYSTEM_EMAIL        (ej: ezerbot.assistant@gmail.com)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME_ENV = (process.env.BOT_USERNAME || "").replace(/^@/, "");
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

// ---------------- CSV parse ----------------
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

// ---------------- Bot username / links ----------------
let botUsernameCache = "";
async function getBotUsername() {
  if (BOT_USERNAME_ENV) return BOT_USERNAME_ENV;
  if (botUsernameCache) return botUsernameCache;
  const me = await tgCall("getMe", {});
  botUsernameCache = me?.result?.username || "";
  return botUsernameCache;
}
async function botLink() {
  const u = await getBotUsername();
  return u ? `https://t.me/${u}` : "";
}
async function productStartLink(code) {
  const u = await getBotUsername();
  return u ? `https://t.me/${u}?start=${encodeURIComponent("prod_" + code)}` : "";
}

// ---------------- Catalog cache ----------------
let catalogCache = { at: 0, items: [], categories: [] };

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache;

  const res = await fetch(SHEET_CSV_URL, { method: "GET" });
  const csv = await res.text();

  const rows = parseCSV(csv);
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

// ---------------- State per chat ----------------
const userState = new Map(); // chatId -> { list, index, messageId, categoryLabel }

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
  rows.push([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);

  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT_${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT_${encodeURIComponent(b)}` });
    rows.push(row);
  }

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

function productNavKeyboard(item) {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "PROD_PREV" },
        { text: "➡️ Siguiente", callback_data: "PROD_NEXT" },
      ],
      [
        { text: "🟢 Quiero este", callback_data: `BUY_${encodeURIComponent(item.codigo)}` },
        { text: "📣 Compartir producto", callback_data: `SHARE_PROD_${encodeURIComponent(item.codigo)}` },
      ],
      [
        { text: "📁 Categorías", callback_data: "MENU_CATALOGO" },
        { text: "📣 Compartir bot", callback_data: "SHARE_BOT" },
      ],
    ],
  };
}

async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard(item);

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, {
    parse_mode: "HTML",
    reply_markup: kb,
  });

  return { messageId: msg?.result?.message_id || null };
}

async function updateCarousel(chat_id, st) {
  const { list, index, messageId } = st;
  const item = list[index];
  const caption = productCaption(item, index + 1, list.length);
  const kb = productNavKeyboard(item);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, st.categoryLabel || "Catálogo");
    st.messageId = created.messageId;
    userState.set(chat_id, st);
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

// ---------------- Share flows ----------------
async function handleShareBot(chat_id) {
  const link = await botLink();

  const text = `🧀 Pedí por acá en Todo Queso:\n${link}\n\n💼 ¿Querés este sistema para tu negocio?\nEscribinos: ${SYSTEM_EMAIL}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Pedí en Todo Queso 🧀")}`;
  const mail = `mailto:?subject=${encodeURIComponent("Te paso el bot de Todo Queso")}&body=${encodeURIComponent(text)}`;

  const sysMail = `mailto:${SYSTEM_EMAIL}?subject=${encodeURIComponent(
    "Quiero el sistema EzerBot"
  )}&body=${encodeURIComponent("Hola! Quiero este sistema para mi negocio.\n\nNegocio:\nCiudad:\nWhatsApp:\n")}`;

  return sendMessage(chat_id, "📣 Elegí cómo querés compartir el bot:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 WhatsApp", url: wa }],
        [{ text: "✈️ Telegram", url: tgShare }],
        [{ text: "📧 Email", url: mail }],
        [{ text: "💼 Quiero este sistema", url: sysMail }],
      ],
    },
  });
}

async function handleShareProduct(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => x.codigo === code);
  if (!item) return sendMessage(chat_id, "No encontré ese producto.");

  const link = await productStartLink(code);
  const text = `🧀 ${item.nombre}\n💰 $${item.precio} (${item.unidad})\n\nCompralo acá 👇\n${link}`;

  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(item.nombre)}`;
  const mail = `mailto:?subject=${encodeURIComponent("Producto recomendado: " + item.nombre)}&body=${encodeURIComponent(text)}`;

  return sendMessage(chat_id, "📣 Elegí cómo querés compartir este producto:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 WhatsApp", url: wa }],
        [{ text: "✈️ Telegram", url: tgShare }],
        [{ text: "📧 Email", url: mail }],
      ],
    },
  });
}

// ---------------- Handlers ----------------
async function handleStart(chat_id, text) {
  // payload /start prod_TQ01
  const m = String(text || "").match(/^\/start\s+(.+)$/i);
  if (m && m[1].startsWith("prod_")) {
    const code = m[1].slice("prod_".length);
    const { items } = await loadCatalog();
    const item = items.find((x) => x.codigo === code);
    if (item) {
      // abrir su categoría y posicionar
      const category = item.categoria || "__ALL__";
      await handleCategory(chat_id, category === "__ALL__" ? "__ALL__" : category);

      const st = userState.get(chat_id);
      if (st?.list?.length) {
        const idx = st.list.findIndex((x) => x.codigo === code);
        if (idx >= 0) st.index = idx;
        userState.set(chat_id, st);
        await updateCarousel(chat_id, st);
      }

      return sendMessage(chat_id, "✅ Te abrí el producto que te compartieron. Tocá 🟢 Quiero este.", {
        reply_markup: mainMenuKeyboard(),
      });
    }
  }

  return sendMessage(chat_id, "🧀 <b>Todo Queso</b>\n\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
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
    return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
  }

  const st = { list, index: 0, messageId: null, categoryLabel: label };
  const created = await showProductCarousel(chat_id, list, 0, label);
  st.messageId = created.messageId;
  userState.set(chat_id, st);
}

// ---------------- Callback handler ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id, "/start");
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data === "SHARE_BOT") return handleShareBot(chat_id);

  if (data.startsWith("CAT_")) {
    const cat = decodeURIComponent(data.slice(4));
    return handleCategory(chat_id, cat);
  }
  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");

  const st = userState.get(chat_id);

  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    if (!st?.list?.length) return;
    const total = st.list.length;
    if (data === "PROD_NEXT") st.index = (st.index + 1) % total;
    if (data === "PROD_PREV") st.index = (st.index - 1 + total) % total;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  if (data.startsWith("SHARE_PROD_")) {
    const code = decodeURIComponent(data.slice("SHARE_PROD_".length));
    return handleShareProduct(chat_id, code);
  }

  if (data.startsWith("BUY_")) {
    const code = decodeURIComponent(data.slice(4));
    const { items } = await loadCatalog();
    const item = items.find((x) => x.codigo === code);
    if (!item) return sendMessage(chat_id, "Ese producto no está disponible.");
    return sendMessage(chat_id, `✅ Elegiste: <b>${escapeHtml(item.nombre)}</b>\n\n(Después conectamos carrito/checkout sin tocar lo que funciona)`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
  }
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - EZER_IA_BOT LIVE"));
app.get("/debug", async (req, res) => {
  const me = await tgCall("getMe", {});
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      botUsername: BOT_USERNAME_ENV || me?.result?.username || null,
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
      const text = update.message.text || "";

      if (text.startsWith("/start") || text === "start") return handleStart(chat_id, text);

      // Si manda texto cualquiera, volvemos al menú (no rompe nada)
      return sendMessage(chat_id, "Elegí una opción:", { reply_markup: mainMenuKeyboard() });
    }

    if (update.callback_query) return handleCallback(update.callback_query);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
});
