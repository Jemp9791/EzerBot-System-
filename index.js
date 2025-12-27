/**
 * Todo_Queso - index.js
 * ✅ Catálogo carrusel (editMessageMedia) + Compartir Bot + Compartir Producto (deep link)
 *
 * ENV (NO CAMBIAR NOMBRES):
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL        (ej: https://ezerbot-system.onrender.com)  SIN slash final
 * - SHEET_CSV_URL     (CSV publicado del sheet "Catalogo")
 * - BOT_USERNAME      (ej: Ezer_IA_Bot)  SIN @
 * - SYSTEM_EMAIL      (ej: ezerbot.assistant@gmail.com)
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
const enc = (s) => encodeURIComponent(String(s || ""));

// ---------------- Telegram API helpers ----------------
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
async function answerCb(id) {
  return tgCall("answerCallbackQuery", { callback_query_id: id }).catch(() => {});
}

// ---------------- CSV parse (simple + quotes) ----------------
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

// ---------------- Catalog cache ----------------
let catalogCache = { at: 0, items: [], categories: [] };

function normalizeUrl(u) {
  if (!u) return "";
  // limpia markdown [x](url) o [url]
  const m = String(u).match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1].trim();
  return String(u).replace(/^\[|\]$/g, "").trim();
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------------- Share helpers ----------------
function botStartLink(param = "") {
  // deep link a telegram con start
  const p = param ? `?start=${enc(param)}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

function shareTextForBot() {
  return `🧀 Mirá el catálogo de Todo Queso y comprá por acá:\n${botStartLink("")}\n\n💼 Si querés este sistema para tu negocio, escribinos: ${SYSTEM_EMAIL}`;
}

function shareTextForProduct(item) {
  const p = item?.codigo ? `prod_${item.codigo}` : "";
  const link = botStartLink(p);
  const nombre = item?.nombre || "Producto";
  const precio = item?.precio ? `$ ${item.precio}` : "";
  return `🧀 ${nombre} ${precio}\nCompralo directo en el bot 👇\n${link}`;
}

function shareMenuKeyboard(textToShare, includeSystemCta = true) {
  const wa = `https://wa.me/?text=${enc(textToShare)}`;
  const tg = `https://t.me/share/url?url=${enc(botStartLink(""))}&text=${enc(textToShare)}`;
  const mailSubject = includeSystemCta ? "Todo Queso + Sistema EzerBot" : "Todo Queso";
  const mail = `mailto:?subject=${enc(mailSubject)}&body=${enc(textToShare)}`;

  const rows = [
    [
      { text: "📲 WhatsApp", url: wa },
      { text: "✈️ Telegram", url: tg },
    ],
    [{ text: "📧 Email", url: mail }],
  ];

  if (includeSystemCta) {
    const ctaMail = `mailto:${enc(SYSTEM_EMAIL)}?subject=${enc("Quiero este sistema para mi negocio")}&body=${enc(
      "Hola! Me interesa el sistema tipo Todo Queso (catálogo + pedidos + fidelización). ¿Me cuentan cómo lo implementamos?"
    )}`;
    rows.push([{ text: "💼 Quiero este sistema", url: ctaMail }]);
  }

  return { inline_keyboard: rows };
}

// ---------------- UI: Menú principal (teclado abajo) ----------------
function bottomKeyboard() {
  // Reply keyboard (la “botonera” fija de abajo)
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🏷️ Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ---------------- Inline: categorías + carrusel ----------------
function categoriesKeyboard(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT_${enc(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT_${enc(b)}` });
    rows.push(row);
  }
  rows.unshift([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "MENU_HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const codigo = item.codigo ? `\n🔖 <i>${escapeHtml(item.codigo)}</i>` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${codigo}${desc}`;
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Anterior", callback_data: "PROD_PREV" }, { text: "➡️ Siguiente", callback_data: "PROD_NEXT" }],
      [{ text: "🟢 Quiero este", callback_data: "PROD_ADD" }, { text: "📤 Compartir", callback_data: "PROD_SHARE" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---------------- State (por usuario) ----------------
const userState = new Map(); // chatId -> { mode, categoryLabel, list, index, messageId }

// ---------------- Carrusel: enviar 1 vez y luego editar ----------------
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productNavKeyboard();

  if (!item.imagen || !item.imagen.startsWith("http")) {
    // fallback sin foto (pero NO llena chat: 1 solo mensaje inicial)
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return msg?.result?.message_id || null;
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
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
    await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      reply_markup: kb,
    });
  }
}

// ---------------- Handlers ----------------
async function handleStart(chat_id, startParam = "") {
  // Si llega por link compartido: /start prod_<CODIGO>
  if (startParam && startParam.startsWith("prod_")) {
    const code = startParam.replace("prod_", "").trim();
    const { items } = await loadCatalog();
    const found = items.find((x) => String(x.codigo || "").trim() === code);

    if (found) {
      // mostrás el producto y el botón para compartir/comprar
      const caption = productCaption(found, 1, 1) + "\n\n✅ Tocá <b>Quiero este</b> para pedirlo.";
      const kb = {
        inline_keyboard: [
          [{ text: "🟢 Quiero este", callback_data: "PROD_ADD_DIRECT" }, { text: "📤 Compartir", callback_data: "PROD_SHARE_DIRECT" }],
          [{ text: "📚 Ver catálogo", callback_data: "MENU_CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU_HOME" }],
        ],
      };

      // guardamos state “directo”
      userState.set(chat_id, { mode: "DIRECT", directItem: found });

      if (found.imagen && found.imagen.startsWith("http")) {
        await sendPhoto(chat_id, found.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
      } else {
        await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
      }
      return;
    }

    await sendMessage(chat_id, "No encontré ese producto (quizás cambió el código). Te muestro el catálogo:", {
      reply_markup: bottomKeyboard(),
    });
    return handleCatalogMenu(chat_id);
  }

  // Start normal
  const text =
    "🧀 <b>Todo Queso</b>\n\n" +
    "Qué bueno verte por acá 😊\n" +
    "Explorá el catálogo, agregá lo que te guste y pedí por acá.\n\n" +
    "👇 Usá los botones de abajo.";

  await sendMessage(chat_id, text, { parse_mode: "HTML", reply_markup: bottomKeyboard() });
}

async function handleShareBot(chat_id) {
  const txt = shareTextForBot();
  await sendMessage(chat_id, "📣 <b>Compartir Todo Queso</b>\nElegí cómo querés compartir:", {
    parse_mode: "HTML",
    reply_markup: shareMenuKeyboard(txt, true),
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
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: bottomKeyboard() });
    return;
  }

  const state = {
    mode: "CATALOG",
    categoryLabel: label,
    list,
    index: 0,
    messageId: null,
  };

  state.messageId = await showProductCarousel(chat_id, list, 0);
  userState.set(chat_id, state);
}

// ---------------- Callback handler ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  // siempre cerramos el “loading”
  await answerCb(cb.id);

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data.startsWith("CAT_")) {
    const cat = decodeURIComponent(data.slice(4));
    return handleCategory(chat_id, cat);
  }
  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");

  // Carrusel navegación
  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;

    const total = state.list.length;
    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }

  // Compartir producto (desde carrusel)
  if (data === "PROD_SHARE") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;

    const txt = shareTextForProduct(item);
    const buyLink = botStartLink(`prod_${item.codigo}`);

    const kb = {
      inline_keyboard: [
        [
          { text: "📲 WhatsApp", url: `https://wa.me/?text=${enc(txt)}` },
          { text: "✈️ Telegram", url: `https://t.me/share/url?url=${enc(buyLink)}&text=${enc(txt)}` },
        ],
        [{ text: "📧 Email", url: `mailto:?subject=${enc("Todo Queso - Producto")}&body=${enc(txt)}` }],
        [{ text: "🛒 Comprar en el bot", url: buyLink }],
      ],
    };

    return sendMessage(chat_id, "📤 <b>Compartir este producto</b>\nElegí una opción:", { parse_mode: "HTML", reply_markup: kb });
  }

  // Compartir producto (desde link directo /start prod_)
  if (data === "PROD_SHARE_DIRECT") {
    const st = userState.get(chat_id);
    const item = st?.directItem;
    if (!item) return;

    const txt = shareTextForProduct(item);
    const buyLink = botStartLink(`prod_${item.codigo}`);

    const kb = {
      inline_keyboard: [
        [
          { text: "📲 WhatsApp", url: `https://wa.me/?text=${enc(txt)}` },
          { text: "✈️ Telegram", url: `https://t.me/share/url?url=${enc(buyLink)}&text=${enc(txt)}` },
        ],
        [{ text: "📧 Email", url: `mailto:?subject=${enc("Todo Queso - Producto")}&body=${enc(txt)}` }],
        [{ text: "🛒 Comprar en el bot", url: buyLink }],
      ],
    };

    return sendMessage(chat_id, "📤 <b>Compartir este producto</b>\nElegí una opción:", { parse_mode: "HTML", reply_markup: kb });
  }

  // “Quiero este” (no tocamos tu carrito real; confirmación simple)
  if (data === "PROD_ADD") {
    const state = userState.get(chat_id);
    const item = state?.list?.[state?.index];
    if (!item) return;

    return sendMessage(
      chat_id,
      `✅ <b>Elegiste:</b> ${escapeHtml(item.nombre)}\n\n(Esto no toca el flujo de compra actual. Solo confirma selección.)`,
      { parse_mode: "HTML", reply_markup: bottomKeyboard() }
    );
  }

  if (data === "PROD_ADD_DIRECT") {
    const st = userState.get(chat_id);
    const item = st?.directItem;
    if (!item) return;

    return sendMessage(
      chat_id,
      `✅ <b>Elegiste:</b> ${escapeHtml(item.nombre)}\n\nAhora podés seguir comprando desde el catálogo o tu flujo habitual.`,
      { parse_mode: "HTML", reply_markup: bottomKeyboard() }
    );
  }
}

// ---------------- Message handler (para botonera de abajo) ----------------
async function handleTextMessage(chat_id, text, rawStartParam = "") {
  const t = (text || "").trim();

  if (t === "/start" || t.toLowerCase() === "start") {
    return handleStart(chat_id, rawStartParam);
  }

  // Botonera de abajo (Reply Keyboard)
  if (t === "🛍️ Catálogo" || t.toLowerCase() === "catalogo" || t.toLowerCase() === "catálogo") return handleCatalogMenu(chat_id);

  if (t === "📣 Compartir bot" || t.toLowerCase().includes("compartir")) return handleShareBot(chat_id);

  // Los demás los dejamos como están en tu sistema (no tocamos)
  if (t === "🧾 Carrito" || t === "✅ Finalizar compra" || t === "🏷️ Tarjeta de sellos") {
    return sendMessage(chat_id, "✅ (Este botón se mantiene para tu flujo actual. No lo modifico acá.)", { reply_markup: bottomKeyboard() });
  }

  // Default: menú
  return handleStart(chat_id);
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - Todo_Queso LIVE"));
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

      // /start con parámetro
      const entities = update.message.entities || [];
      let startParam = "";
      // Telegram manda "/start xxxxx" en el mismo texto
      if (text.startsWith("/start")) {
        const parts = text.split(" ").map((x) => x.trim()).filter(Boolean);
        if (parts.length >= 2) startParam = parts[1];
      }

      return handleTextMessage(chat_id, text, startParam);
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
  console.log("✅ Webhook:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
  console.log("✅ Bot username:", BOT_USERNAME ? `@${BOT_USERNAME}` : "(BOT_USERNAME vacío)");
});
