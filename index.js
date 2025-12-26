/**
 * EZER_IA_BOT - Catálogo con carrusel "book" (1 solo mensaje editable)
 * Node + Express + node-telegram-bot-api
 *
 * ENV requeridas en Render:
 * - BOT_TOKEN
 * - PUBLIC_URL   (ej: https://ezerbot-system.onrender.com)
 * - SHEET_CSV_URL (CSV publicado de la hoja "Catalogo")
 */

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// Node 18+ trae fetch. Si tu build no lo tiene, Render sí lo trae normalmente.
const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;        // https://tu-app.onrender.com
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;  // link CSV publicado

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!PUBLIC_URL) throw new Error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) throw new Error("Falta ENV SHEET_CSV_URL");

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
bot.setWebHook(`${PUBLIC_URL}/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("OK - EZER_IA_BOT online"));

// ============================
// Helpers CSV -> objetos
// ============================
function csvSplitLine(line) {
  // CSV simple con comillas (maneja comas dentro de "...")
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' ) {
      if (inQuotes && line[i + 1] === '"') { // escape ""
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];

  const headers = csvSplitLine(lines[0]).map(h => h.trim().toUpperCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = csvSplitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (cols[idx] ?? "").trim());
    rows.push(obj);
  }
  return rows;
}

// Limpia links tipo [url](url) y deja SOLO el directo
function normalizeImageUrl(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  // markdown [x](y) => toma y
  const md = s.match(/\((https?:\/\/[^)]+)\)/i);
  if (md && md[1]) s = md[1].trim();

  // si viene entre corchetes [https://...]
  s = s.replace(/^\[|\]$/g, "").trim();

  // fuera espacios
  s = s.replace(/\s/g, "");
  return s;
}

// ============================
// Cache de catálogo
// ============================
let catalogCache = {
  ts: 0,
  items: [],
  categories: []
};

async function loadCatalog() {
  // cache 60s
  const now = Date.now();
  if (catalogCache.items.length && (now - catalogCache.ts) < 60_000) return catalogCache;

  const r = await fetch(SHEET_CSV_URL);
  if (!r.ok) throw new Error(`No pude leer CSV: ${r.status}`);
  const csv = await r.text();
  const rows = parseCSV(csv);

  // normalizar campos esperados
  const items = rows.map(r => ({
    CODIGO: r.CODIGO || "",
    NOMBRE: r.NOMBRE || "",
    PRECIO: r.PRECIO || "",
    UNIDAD: r.UNIDAD || "",
    PRECIOPORKILO: r.PRECIOPORKILO || "",
    CODIGOBARRAS: r.CODIGOBARRAS || "",
    DESCRIPCION: r.DESCRIPCION || "",
    IMAGEN: normalizeImageUrl(r.IMAGEN || ""),
    CATEGORIA: (r.CATEGORIA || "Sin categoría").trim()
  })).filter(x => x.NOMBRE);

  const categories = Array.from(new Set(items.map(x => x.CATEGORIA))).sort((a,b)=>a.localeCompare(b));

  catalogCache = { ts: now, items, categories };
  return catalogCache;
}

// ============================
// Carrusel "book" (1 solo msg)
// ============================
const catalogUI = new Map();
/*
catalogUI.get(chatId) = {
  msgId: number,
  items: array,
  idx: number,
  title: string
}
*/

function buildProductCaption(item, idx, total, title) {
  const name = item.NOMBRE || "Producto";
  const price = item.PRECIO ? `$ ${item.PRECIO}` : "";
  const unit = item.UNIDAD ? `(${item.UNIDAD})` : "";
  const desc = item.DESCRIPCION ? `${item.DESCRIPCION}` : "";

  return `🛍️ ${title}\n📖 Producto ${idx + 1} de ${total}\n\n` +
         `🧀 ${name}\n💰 ${price} ${unit}\n📝 ${desc}`;
}

async function showCatalogPage(chatId) {
  const st = catalogUI.get(chatId);
  if (!st || !st.items || !st.items.length) {
    await bot.sendMessage(chatId, "No hay productos para mostrar.");
    return;
  }

  const total = st.items.length;
  st.idx = Math.max(0, Math.min(st.idx || 0, total - 1));

  const item = st.items[st.idx];
  const caption = buildProductCaption(item, st.idx, total, st.title || "Catálogo");
  const imageUrl = item.IMAGEN;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "CAT_PREV" },
        { text: "🟢 Quiero éste", callback_data: "CAT_BUY" },
        { text: "➡️ Siguiente", callback_data: "CAT_NEXT" },
      ],
      [
        { text: "📁 Categorías", callback_data: "CAT_CATEGORIES" },
        { text: "🛒 Carrito", callback_data: "OPEN_CART" },
      ],
    ],
  };

  // Mensaje inicial (1 sola vez)
  if (!st.msgId) {
    if (imageUrl) {
      const msg = await bot.sendPhoto(chatId, imageUrl, {
        caption,
        reply_markup: keyboard,
      });
      st.msgId = msg.message_id;
      catalogUI.set(chatId, st);
      return;
    } else {
      const msg = await bot.sendMessage(chatId, caption, { reply_markup: keyboard });
      st.msgId = msg.message_id;
      catalogUI.set(chatId, st);
      return;
    }
  }

  // ✅ Edición (NO ensucia el chat)
  try {
    if (imageUrl) {
      await bot.editMessageMedia(
        { type: "photo", media: imageUrl, caption },
        { chat_id: chatId, message_id: st.msgId, reply_markup: keyboard }
      );
    } else {
      await bot.editMessageCaption(caption, {
        chat_id: chatId,
        message_id: st.msgId,
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    // Si Telegram no deja editar, recrea una vez
    st.msgId = null;
    catalogUI.set(chatId, st);
    await showCatalogPage(chatId);
  }
}

function startCatalogCarousel(chatId, items, title) {
  catalogUI.set(chatId, { msgId: null, items, idx: 0, title });
}

// ============================
// UI principal (simple, limpia)
// ============================
function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
      ],
      resize_keyboard: true,
    },
  };
}

async function sendWelcome(chatId) {
  const text =
`🧀 ¡Bienvenida/o a Todo Queso!
Elegí "🛍️ Catálogo" para ver productos con fotos (tipo book).`;

  await bot.sendMessage(chatId, text, mainKeyboard());
}

// ============================
// Handlers
// ============================
bot.onText(/\/start/i, async (msg) => {
  await sendWelcome(msg.chat.id);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const t = (msg.text || "").trim();

  if (t === "🛍️ Catálogo") {
    const { categories } = await loadCatalog();

    // Si hay muchas categorías, las mostramos en inline (no ensucia)
    const buttons = [];
    // "Todas" primero
    buttons.push([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);

    // categorías de a 2 por fila
    for (let i = 0; i < categories.length; i += 2) {
      const row = [];
      row.push({ text: categories[i], callback_data: `CAT_CAT:${categories[i]}` });
      if (categories[i + 1]) row.push({ text: categories[i + 1], callback_data: `CAT_CAT:${categories[i + 1]}` });
      buttons.push(row);
    }

    await bot.sendMessage(chatId, "📁 Elegí una categoría:", {
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  if (t === "🛒 Carrito") {
    // Placeholder - NO tocamos carrito todavía
    await bot.sendMessage(chatId, "🛒 Carrito: (por ahora solo estamos arreglando el carrusel de imágenes).", mainKeyboard());
    return;
  }
});

// Botones inline (carrusel + categorías)
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  try {
    // Carrusel
    const st = catalogUI.get(chatId);

    if (data === "CAT_NEXT" && st) {
      st.idx = (st.idx + 1) % st.items.length;
      catalogUI.set(chatId, st);
      await showCatalogPage(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CAT_PREV" && st) {
      st.idx = (st.idx - 1 + st.items.length) % st.items.length;
      catalogUI.set(chatId, st);
      await showCatalogPage(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CAT_CATEGORIES") {
      // reabre selector de categorías
      const { categories } = await loadCatalog();
      const buttons = [];
      buttons.push([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);
      for (let i = 0; i < categories.length; i += 2) {
        const row = [];
        row.push({ text: categories[i], callback_data: `CAT_CAT:${categories[i]}` });
        if (categories[i + 1]) row.push({ text: categories[i + 1], callback_data: `CAT_CAT:${categories[i + 1]}` });
        buttons.push(row);
      }
      await bot.sendMessage(chatId, "📁 Elegí una categoría:", { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CAT_ALL") {
      const { items } = await loadCatalog();
      startCatalogCarousel(chatId, items, "Catálogo — Todas");
      await showCatalogPage(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith("CAT_CAT:")) {
      const cat = data.split("CAT_CAT:")[1] || "";
      const { items } = await loadCatalog();
      const filtered = items.filter(x => (x.CATEGORIA || "") === cat);
      startCatalogCarousel(chatId, filtered, `Catálogo — ${cat}`);
      await showCatalogPage(chatId);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CAT_BUY") {
      // Placeholder (NO tocamos compra todavía)
      await bot.answerCallbackQuery(q.id, { text: "OK (después conectamos compra).", show_alert: false });
      return;
    }

    if (data === "OPEN_CART") {
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, "🛒 Carrito: (todavía no tocamos esto, estamos dejando perfecto el carrusel).", mainKeyboard());
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    try { await bot.answerCallbackQuery(q.id, { text: "Error. Reintentá.", show_alert: false }); } catch {}
  }
});

// Puerto Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook:", `${PUBLIC_URL}/bot${BOT_TOKEN}`);
});
