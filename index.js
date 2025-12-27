/**
 * EZER_IA_BOT - Telegram bot (Webhook "/")
 * - Catálogo con carrusel (editMessageMedia)
 * - Compartir PRODUCTO (WhatsApp + Email) usando deep-link /start prod_CODIGO
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = ...
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com   (sin barra final)
 * - SHEET_CSV_URL    = CSV del sheet "Catalogo"
 * - BOT_USERNAME     = Ezer_IA_Bot (opcional; si no, se usa este default)
 * - SYSTEM_EMAIL     = ezerbot.assistant@gmail.com (opcional)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;
const botLink = () => `https://t.me/${BOT_USERNAME}`;

// -------------------- Utils --------------------
const enc = (s) => encodeURIComponent(String(s ?? ""));

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Deep-link a un producto
function productDeepLink(code) {
  // Telegram espera /start con un parámetro sin espacios
  return `https://t.me/${BOT_USERNAME}?start=prod_${encodeURIComponent(code)}`;
}

function waShareUrl(text, url) {
  // WhatsApp share universal
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}

function emailShareUrl(subject, body) {
  return `mailto:?subject=${enc(subject)}&body=${enc(body)}`;
}

// -------------------- Telegram API --------------------
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

// -------------------- CSV parse --------------------
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

// -------------------- Catalog cache --------------------
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

// -------------------- State --------------------
const userState = new Map(); // chatId -> {mode, categoryLabel, list, index, messageId}

// -------------------- Keyboards --------------------
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
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
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ Para pedir: escribí <b>QUIERO</b>`;
}

// ✅ ACA está “Compartir este producto”
function productNavKeyboard(item) {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "PROD_PREV" },
        { text: "➡️ Siguiente", callback_data: "PROD_NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "PROD_WANT" }],
      [
        { text: "📣 Compartir (WhatsApp)", callback_data: "SHARE_WA" },
        { text: "✉️ Compartir (Email)", callback_data: "SHARE_EMAIL" },
      ],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// -------------------- Carrusel --------------------
async function showProductCarousel(chat_id, list, index) {
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

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard(item);

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
      caption: caption + "\n\n⚠️ (Sin imagen válida)",
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

// -------------------- Handlers --------------------
async function handleStart(chat_id, startPayload = "") {
  // Si viene /start prod_TQ01 => mostrar ese producto directo
  if (startPayload?.startsWith("prod_")) {
    const code = startPayload.slice(5);
    const { items } = await loadCatalog();
    const item = items.find((x) => (x.codigo || "") === code);

    if (item) {
      const caption =
        `🎁 <b>PROMO / PRODUCTO COMPARTIDO</b>\n\n` +
        `🛍️ <b>${escapeHtml(item.nombre)}</b>\n` +
        `💰 <b>$ ${escapeHtml(item.precio || "-")}</b> (${escapeHtml(item.unidad || "unidad")})\n` +
        (item.descripcion ? `📝 ${escapeHtml(item.descripcion)}\n` : "") +
        `\n✅ Para pedir: escribí <b>QUIERO</b>\n\n` +
        `🧀 Volvé al bot: ${escapeHtml(botLink())}`;

      const kb = {
        inline_keyboard: [
          [{ text: "🟢 Quiero este", callback_data: "PROD_WANT_SHARED" }],
          [{ text: "🛍️ Ver Catálogo", callback_data: "MENU_CATALOGO" }],
          [
            { text: "📣 Compartir (WhatsApp)", url: waShareUrl(`Mirá esto en Todo Queso: ${item.nombre}`, productDeepLink(item.codigo)) },
            { text: "✉️ Compartir (Email)", url: emailShareUrl(`Promo Todo Queso: ${item.nombre}`, `Mirá este producto:\n${item.nombre}\n${productDeepLink(item.codigo)}`) },
          ],
          [{ text: "💼 Quiero este sistema", url: emailShareUrl("Quiero el sistema EzerBot", `Hola, quiero el sistema para mi negocio.\nMi contacto: \n\nEnviado desde ${botLink()}`) }],
        ],
      };

      if (item.imagen && item.imagen.startsWith("http")) {
        await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
      } else {
        await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
      }
      return;
    }
    // Si no existe el código, cae al menú normal
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
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
  };

  const created = await showProductCarousel(chat_id, list, 0);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

// -------------------- Callback handler --------------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  // sacar “loading…”
  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat);
  }

  // NAV
  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;

    const total = state.list.length;
    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }

  // QUIERO
  if (data === "PROD_WANT" || data === "PROD_WANT_SHARED") {
    return sendMessage(chat_id, "✅ Genial. Escribí <b>QUIERO</b> y te tomo el pedido.", { parse_mode: "HTML" });
  }

  // ✅ COMPARTIR PRODUCTO (se genera link con deep-link y se responde con URLs clickeables)
  if (data === "SHARE_WA" || data === "SHARE_EMAIL") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;

    const url = productDeepLink(item.codigo);
    const text = `🧀 Todo Queso — ${item.nombre}\n💰 $${item.precio} (${item.unidad || "unidad"})\n\nAbrí y comprá acá:`;

    if (data === "SHARE_WA") {
      const wa = waShareUrl(text, url);
      return sendMessage(chat_id, "📣 Compartir por WhatsApp:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: wa }], [{ text: "🛍️ Abrir bot", url: botLink() }]] },
      });
    }

    if (data === "SHARE_EMAIL") {
      const em = emailShareUrl(`Todo Queso: ${item.nombre}`, `${text}\n${url}\n\nSi querés este sistema para tu negocio, escribinos a ${SYSTEM_EMAIL}`);
      return sendMessage(chat_id, "✉️ Compartir por Email:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir Email", url: em }], [{ text: "🛍️ Abrir bot", url: botLink() }]] },
      });
    }
  }
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.status(200).send("OK - EZER_IA_BOT LIVE"));

app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
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

      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const payload = (parts[1] || "").trim();
        return handleStart(chat_id, payload);
      }

      // Si escriben QUIERO, lo dejamos básico (no rompe tu flujo)
      if ((text || "").toUpperCase().includes("QUIERO")) {
        return sendMessage(chat_id, "✅ Listo. Decime: ¿retiro o envío? (y tu dirección si es envío)");
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

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
});
