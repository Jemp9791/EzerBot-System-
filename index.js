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

async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
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

// ---------- Normalización robusta ----------
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------- CSV ----------
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

// ---------- Cache catálogo ----------
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

// ---------- Estado ----------
const userState = new Map(); // chatId -> { list, index, messageId }

// ---------- Teclados ----------
function replyMenuKeyboard() {
  // ESTE es el “menú fijo” que ves abajo en Telegram (como en tus capturas)
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🏷️ Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
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
  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "📣 Compartir bot", callback_data: "SHARE_BOT" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }],
    ],
  };
}

// ---------- Compartir ----------
function makeBotLink() {
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "";
}

function shareKeyboard() {
  const botLink = makeBotLink() || "https://t.me/";
  const msg = encodeURIComponent(
    `🧀 Mirá el catálogo de Todo Queso y comprá por el bot:\n${botLink}\n\nSi querés este sistema para tu negocio: ${EZERBOT_EMAIL}`
  );
  const subject = encodeURIComponent("Quiero el sistema EzerBot para mi negocio");
  const body = encodeURIComponent(`Hola! Me interesa el sistema.\n\nLink del bot: ${botLink}`);

  return {
    inline_keyboard: [
      [{ text: "🤖 Abrir bot", url: botLink }],
      [{ text: "📲 Compartir por WhatsApp", url: `https://wa.me/?text=${msg}` }],
      [{ text: "✉️ Pedir el sistema (Email)", url: `mailto:${EZERBOT_EMAIL}?subject=${subject}&body=${body}` }],
    ],
  };
}

async function handleShareBot(chat_id) {
  console.log("🟣 SHARE TRIGGERED for chat:", chat_id);
  const botLink = makeBotLink();
  const text =
    `📣 <b>Compartí Todo Queso</b>\n\n` +
    `🔗 Bot: ${botLink || "(aún sin username detectado)"}\n\n` +
    `📩 ¿Querés este sistema para tu negocio?\n` +
    `Escribinos a: <b>${EZERBOT_EMAIL}</b>`;

  return sendMessage(chat_id, text, { parse_mode: "HTML", reply_markup: shareKeyboard() });
}

// ---------- Catálogo carrusel ----------
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb }).catch(async () => {
    // Si falla la imagen, mandamos texto para no trabar el flujo
    return sendMessage(chat_id, caption + "\n\n⚠️ Imagen no válida", { parse_mode: "HTML", reply_markup: kb });
  });

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

  await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb }).catch(async () => {
    await tgCall("editMessageCaption", {
      chat_id,
      message_id: messageId,
      caption: caption + "\n\n⚠️ Imagen no válida",
      parse_mode: "HTML",
      reply_markup: kb,
    });
  });
}

// ---------- Handlers base ----------
async function handleStart(chat_id) {
  return sendMessage(
    chat_id,
    "🧀 <b>Todo Queso</b>\n\nElegí una opción del menú de abajo 👇",
    { parse_mode: "HTML", reply_markup: replyMenuKeyboard() }
  );
}

async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos 👇", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();
  let list = items;
  if (category && category !== "__ALL__") list = items.filter((x) => x.categoria === category);

  if (!list.length) return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: replyMenuKeyboard() });

  const state = { list, index: 0, messageId: null };
  const created = await showProductCarousel(chat_id, list, 0);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

// ---------- Callback handler ----------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);
  if (data === "SHARE_BOT") return handleShareBot(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) {
    const cat = decodeURIComponent(data.slice(4));
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

// ---------- Rutas ----------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    botUsername: BOT_USERNAME || null,
    env: { hasToken: !!TOKEN, hasPublicUrl: !!PUBLIC_URL, hasSheetCsvUrl: !!SHEET_CSV_URL },
  });
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  // LOG mínimo para ver si llega algo cuando apretás “Compartir”
  try {
    if (update?.message?.text) {
      console.log("📩 MSG:", update.message.text);
    }
    if (update?.callback_query?.data) {
      console.log("🧷 CB:", update.callback_query.data);
    }
  } catch {}

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const textRaw = update.message.text || "";
      const t = normText(textRaw);

      if (String(textRaw).trim().startsWith("/start") || t === "start") return handleStart(chat_id);

      // ✅ Detecta “Compartir bot” venga como venga (teclado fijo)
      if (t.includes("compartir")) return handleShareBot(chat_id);

      // Menú fijo
      if (t.includes("catalogo")) return handleCatalogMenu(chat_id);

      // default
      return handleStart(chat_id);
    }

    if (update.callback_query) return handleCallback(update.callback_query);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---------- Init ----------
async function initBotInfo() {
  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) {
    BOT_USERNAME = me.result.username;
    console.log("✅ Bot username:", BOT_USERNAME);
  }
}

app.listen(PORT, async () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
  await initBotInfo();
});
